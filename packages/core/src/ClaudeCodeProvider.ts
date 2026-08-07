import { Config, Context, Effect, Layer, Stream } from "effect"
import { SessionId } from "./ids.js"
import {
  activity,
  jsonLine,
  LineParser,
  malformed,
  ParseState,
  PermissionProfile,
  Provider,
  ProviderEvent,
  ProviderRunOptions,
  record,
  runProvider,
  str,
} from "./Provider.js"
import { ProcessSupervisor } from "./ProcessSupervisor.js"

const claudeBinary = Config.string("COCKPIT_CLAUDE_BIN").pipe(
  Config.withDefault("claude"),
)

/**
 * Every mode is claude-side policy, not an OS sandbox: plan refuses edits but the deny list is
 * what actually withholds the write and exec tools, and acceptEdits needs its tools allowed because
 * a headless run has nobody to answer a permission prompt. Neither mode scopes network.
 * `read-plus-output` cannot be plan mode: plan withholds Write, and Write is the one thing such a
 * block must do. The deny list is what keeps it out of the repository instead.
 */
const permissionArgs = (profile: PermissionProfile): ReadonlyArray<string> => {
  switch (profile) {
    case "read-only":
      return ["--permission-mode", "plan", "--disallowedTools", "Write,Edit,NotebookEdit,Bash"]
    case "read-plus-output":
      return [
        "--permission-mode",
        "acceptEdits",
        "--disallowedTools",
        "Edit,NotebookEdit,Bash",
        "--allowedTools",
        "Write",
      ]
    default:
      return ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"]
  }
}

export const claudeArgv = (
  binary: string,
  options: ProviderRunOptions,
): readonly [string, ...ReadonlyArray<string>] => [
  binary,
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  ...(options.resumeSessionId !== undefined
    ? ["--resume", options.resumeSessionId]
    : options.sessionId !== undefined
      ? ["--session-id", options.sessionId]
      : []),
  ...permissionArgs(options.permissionProfile),
  // The result file lives outside the worktree, so its directory has to be reachable on top of it.
  ...(options.outputDir === undefined ? [] : ["--add-dir", options.outputDir]),
  // Everything after `--` is the prompt operand, so a prompt opening with `-` stays data.
  "--",
  options.prompt,
]

/** Claude surfaces a headless question as an AskUserQuestion tool call; nothing else marks one. */
const askedQuestion = (input: unknown): string | undefined => {
  const fields = record(input)
  if (fields === undefined) return undefined
  const questions = fields.questions
  const first = Array.isArray(questions) ? record(questions[0]) : undefined
  return str(first?.question)
}

const contentEvents = (
  state: ParseState,
  content: unknown,
  raw: string,
): readonly [ReadonlyArray<ProviderEvent>, ParseState] => {
  if (!Array.isArray(content)) return [[activity("assistant", raw)], state]
  const events: ProviderEvent[] = []
  let text = state.text
  for (const entry of content) {
    const block = record(entry)
    const kind = str(block?.type)
    if (kind === "text") {
      const chunk = str(block?.text) ?? ""
      text += chunk
      events.push({ _tag: "OutputChunk", streamKind: "assistant", text: chunk, raw })
    } else if (kind === "tool_use") {
      const name = str(block?.name) ?? "unknown"
      const question = name === "AskUserQuestion" ? askedQuestion(block?.input) : undefined
      events.push(
        question === undefined
          ? activity(`tool:${name}`, raw, str(block?.id))
          : { _tag: "QuestionAsked", question, raw },
      )
    } else {
      events.push(activity(`content:${kind ?? "unknown"}`, raw))
    }
  }
  return [events, { ...state, text }]
}

export const claudeParse: LineParser = (state, raw) => {
  const line = jsonLine(raw)
  if (line === undefined) return malformed(state, raw)

  const type = str(line.type) ?? "unknown"
  if (type === "system") {
    const subtype = str(line.subtype)
    const sessionId = str(line.session_id)
    if (subtype === "init" && sessionId !== undefined) {
      const session = SessionId.make(sessionId)
      return [
        [{ _tag: "SessionStarted", sessionId: session, raw }],
        { ...state, sessionId: session },
      ]
    }
    return [[activity(`system:${subtype ?? "unknown"}`, raw)], state]
  }
  if (type === "assistant") {
    return contentEvents(state, record(line.message)?.content, raw)
  }
  if (type === "result") {
    const result = {
      sessionId: state.sessionId,
      isError: line.is_error === true,
      text: str(line.result) ?? state.text,
    }
    return [[{ _tag: "ResultProduced", result, raw }], { ...state, result }]
  }
  return [[activity(type, raw)], state]
}

export class ClaudeCodeProvider extends Context.Tag("cockpit/ClaudeCodeProvider")<
  ClaudeCodeProvider,
  Provider
>() {}

export const ClaudeCodeProviderLive = Layer.effect(
  ClaudeCodeProvider,
  Effect.gen(function* () {
    const binary = yield* claudeBinary
    const supervisor = yield* ProcessSupervisor
    return {
      name: "claude-code" as const,
      run: (options: ProviderRunOptions) =>
        runProvider({
          argv: claudeArgv(binary, options),
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeoutMs,
          parse: claudeParse,
        }).pipe(Stream.provideService(ProcessSupervisor, supervisor)),
    }
  }),
)
