import { RunRow } from "@cockpit/core"
import { Effect } from "effect"
import { existsSync, readFileSync } from "node:fs"
import * as NodePath from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  Api,
  json,
  makeRepo,
  startRun,
  tagged,
  tempDir,
  waitFor,
  withApi,
  writeScript,
} from "./harness.js"

const twoMinutes = 120_000

interface Handoff {
  readonly opened: true
  readonly mode: "herdr" | "ghostty"
  readonly fallback?: string
  readonly sessionId: string
  readonly warning?: string
  readonly briefPath?: string
}

const fakeEnv = ["COCKPIT_FAKE_HERDR_LOG", "COCKPIT_FAKE_HERDR_DOWN", "COCKPIT_FAKE_OPEN_FAIL"]
afterEach(() => fakeEnv.forEach((name) => delete process.env[name]))

const herdrLog = () => {
  const path = process.env.COCKPIT_FAKE_HERDR_LOG
  return path === undefined || !existsSync(path)
    ? []
    : readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as ReadonlyArray<string>)
}

const analyzerPicksTask = () =>
  writeScript({
    analyzer: {
      output: { templateId: "task", params: { focus: "the parser" }, rationale: "fixture" },
    },
    "agent-task": { output: { summary: "done" } },
    "verify-output": { output: { passed: true, findings: [] } },
  })

/** Stops at the plan gate: plan §10 offers the terminal while the run is still executing. */
const atTheGate = (client: Api, repoPath: string) =>
  Effect.gen(function* () {
    const project = yield* Effect.map(
      client.post("/api/projects", { name: "sample", repoPath }),
      json<{ readonly id: string }>,
    )
    const { runId } = yield* startRun(client, project.id, "rename the parser field")
    yield* waitFor(runId, (found) => tagged(found, "ApprovalRequested").length > 0)
    return runId
  })

it(
  "opens the run's canonical session in a herdr tab",
  async () => {
    analyzerPicksTask()
    process.env.COCKPIT_FAKE_HERDR_LOG = NodePath.join(
      await tempDir("cockpitd-herdr-"),
      "calls.jsonl",
    )

    const opened = await withApi((client) =>
      Effect.gen(function* () {
        const runId = yield* atTheGate(client, makeRepo())
        const answer = yield* client.post(`/api/runs/${runId}/terminal`)
        const detail = yield* Effect.map(
          client.get(`/api/runs/${runId}`),
          json<{ readonly run: RunRow }>,
        )
        return { status: answer.status, handoff: json<Handoff>(answer), run: detail.run }
      }),
    )

    expect(opened.status).toBe(200)
    expect(opened.handoff.opened).toBe(true)
    expect(opened.handoff.mode).toBe("herdr")
    expect(opened.handoff.fallback).toBeUndefined()
    expect(opened.handoff.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(opened.run.canonicalSessionId).toBe(opened.handoff.sessionId)
    expect(readFileSync(opened.handoff.briefPath!, "utf8")).toContain("rename the parser field")

    const calls = herdrLog()
    expect(calls[0]).toEqual(["status", "server", "--json"])
    expect(calls[1]).toEqual([
      "tab",
      "create",
      "--cwd",
      opened.run.worktreePath,
      "--label",
      "rename the parser field",
      "--focus",
    ])
    expect(calls[2]).toEqual([
      "agent",
      "start",
      "cockpit-w1-t9-p1",
      "--kind",
      "claude",
      "--pane",
      "w1:t9:p1",
      "--timeout",
      "30000",
      "--",
      "--session-id",
      opened.handoff.sessionId,
      "--",
      `Read ${opened.handoff.briefPath} — it is Cockpit's full brief for the task already executed in this worktree. Then wait for my instructions.`,
    ])
  },
  twoMinutes,
)

it(
  "reports the terminal it could not open instead of pretending it did",
  async () => {
    analyzerPicksTask()
    process.env.COCKPIT_FAKE_HERDR_DOWN = "1"
    process.env.COCKPIT_FAKE_OPEN_FAIL = "1"

    const answer = await withApi((client) =>
      Effect.gen(function* () {
        const runId = yield* atTheGate(client, makeRepo())
        return yield* client.post(`/api/runs/${runId}/terminal`)
      }),
    )

    expect(answer.status).toBe(502)
    expect(json<{ readonly error: string; readonly detail: string }>(answer)).toMatchObject({
      error: "could not open a terminal",
      detail: expect.stringContaining("Ghostty.app"),
    })
  },
  twoMinutes,
)

it("404s a terminal request for a run that does not exist", async () => {
  const answer = await withApi((client) => client.post("/api/runs/nope/terminal"))

  expect(answer.status).toBe(404)
  expect(json<{ readonly error: string }>(answer).error).toBe("not found")
})
