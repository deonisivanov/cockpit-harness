import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import {
  claudeParse,
  codexParse,
  LineParser,
  ParseState,
  ProviderEvent,
  SessionId,
} from "../src/index.js"
import { fixturePath } from "./helpers.js"

// Recorded from claude 2.1.224 and codex-cli 0.146.0 by scripts/refresh-fixtures.sh, with the
// recorder's settings and plugins suppressed. Assertions here stay on the shape both CLIs
// guarantee; anything a machine or account can add or remove is pinned with synthetic lines below.
const fixture = (name: string) =>
  readFileSync(fixturePath(`fixtures/${name}`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")

const replay = (parse: LineParser, lines: ReadonlyArray<string>) => {
  let state: ParseState = { text: "" }
  const events: ProviderEvent[] = []
  for (const line of lines) {
    const [emitted, next] = parse(state, line)
    events.push(...emitted)
    state = next
  }
  return { events, state }
}

const tags = (events: ReadonlyArray<ProviderEvent>) => events.map((event) => event._tag)

const activities = (events: ReadonlyArray<ProviderEvent>) =>
  events.flatMap((event) => (event._tag === "AgentActivity" ? [event.activity] : []))

const sessionOf = (events: ReadonlyArray<ProviderEvent>) =>
  events.find((event) => event._tag === "SessionStarted")

it("extracts the assigned session id from the recorded claude stream", () => {
  const { events, state } = replay(claudeParse, fixture("claude-stream.jsonl"))
  const started = events.filter((event) => event._tag === "SessionStarted")

  expect(started).toHaveLength(1)
  expect(state.sessionId).toBe(sessionOf(events)?.sessionId)
  expect(state.sessionId).toMatch(/^[0-9a-f-]{36}$/)
})

it("normalizes the recorded claude stream into one result and one assistant chunk", () => {
  const { events, state } = replay(claudeParse, fixture("claude-stream.jsonl"))
  const results = events.filter((event) => event._tag === "ResultProduced")

  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({
    result: { isError: false, text: "ok", sessionId: state.sessionId },
  })
  expect(tags(events).at(-1)).toBe("ResultProduced")
  expect(
    events.filter(
      (event) => event._tag === "OutputChunk" && event.streamKind === "assistant",
    ),
  ).toMatchObject([{ text: "ok" }])
  expect(events.every((event) => event.raw.length > 0)).toBe(true)
})

// Synthetic, not recorded: hooks depend on the machine's settings and rate limit events on the
// account's plan, so neither is something a recording can be relied on to contain.
it("keeps claude chatter visible as activity without mistaking it for output", () => {
  const { events } = replay(claudeParse, [
    '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}',
    '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"}]}}',
    '{"type":"invented_by_a_future_cli"}',
  ])

  expect(activities(events)).toEqual([
    "system:hook_started",
    "rate_limit_event",
    "content:thinking",
    "invented_by_a_future_cli",
  ])
  expect(events.some((event) => event._tag === "OutputChunk")).toBe(false)
})

it("captures the codex-generated session id from the recorded stream", () => {
  const { events, state } = replay(codexParse, fixture("codex-stream.jsonl"))
  const started = events.filter((event) => event._tag === "SessionStarted")

  expect(started).toHaveLength(1)
  expect(state.sessionId).toBe(sessionOf(events)?.sessionId)
  expect(state.sessionId).toMatch(/^[0-9a-f-]{36}$/)
})

it("normalizes the recorded codex stream into one result", () => {
  const { events, state } = replay(codexParse, fixture("codex-stream.jsonl"))

  expect(tags(events).at(-1)).toBe("ResultProduced")
  expect(events.filter((event) => event._tag === "ResultProduced")).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({
    result: { isError: false, text: "ok", sessionId: state.sessionId },
  })
  expect(
    events.filter(
      (event) => event._tag === "OutputChunk" && event.streamKind === "assistant",
    ),
  ).toMatchObject([{ text: "ok" }])
})

it("keeps a codex error item out of the verdict", () => {
  const { events } = replay(codexParse, [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"skills truncated"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
  ])

  expect(tags(events)).toEqual(["SessionStarted", "ErrorRaised", "OutputChunk", "ResultProduced"])
  expect(events.at(-1)).toMatchObject({ result: { isError: false, text: "ok" } })
})

it("maps turn.failed onto an errored result", () => {
  const { events } = replay(codexParse, [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"turn.failed","error":{"message":"sandbox denied"}}',
  ])
  expect(events.at(-1)).toMatchObject({
    _tag: "ResultProduced",
    result: { isError: true, text: "sandbox denied", sessionId: "t-1" },
  })
})

it.each([
  ["claude", claudeParse, '{"type":"system","subtype":"init","session_id":"s-1"}'],
  ["codex", codexParse, '{"type":"thread.started","thread_id":"s-1"}'],
])("keeps parsing %s after a malformed line", (_name, parse, opening) => {
  const { events, state } = replay(parse, [opening, "not json at all", "{broken", opening])

  expect(tags(events)).toEqual([
    "SessionStarted",
    "ErrorRaised",
    "ErrorRaised",
    "SessionStarted",
  ])
  expect(events[1]).toMatchObject({ message: "unparseable stream line", raw: "not json at all" })
  // The bad lines must not reset what the stream has already established.
  expect(state.sessionId).toBe(SessionId.make("s-1"))
})

it("surfaces a claude AskUserQuestion tool call as a question", () => {
  const { events } = replay(claudeParse, [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "AskUserQuestion",
            input: { questions: [{ question: "Which database?" }] },
          },
        ],
      },
    }),
  ])
  expect(events).toMatchObject([{ _tag: "QuestionAsked", question: "Which database?" }])
})

it("treats any other claude tool call as activity, not a question", () => {
  const { events } = replay(claudeParse, [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: {} }] },
    }),
  ])
  expect(events).toMatchObject([{ _tag: "AgentActivity", activity: "tool:Bash", detail: "toolu_2" }])
})
