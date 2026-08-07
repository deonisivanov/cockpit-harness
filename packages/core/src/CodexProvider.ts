import { Config, Context, Effect, Layer, Stream } from "effect"
import { SessionId } from "./ids.js"
import {
  activity,
  jsonLine,
  LineParser,
  malformed,
  PermissionProfile,
  Provider,
  ProviderRunOptions,
  record,
  runProvider,
  str,
} from "./Provider.js"
import { ProcessSupervisor } from "./ProcessSupervisor.js"

const codexBinary = Config.string("COCKPIT_CODEX_BIN").pipe(Config.withDefault("codex"))

const sandbox = (profile: PermissionProfile) =>
  profile === "read-only" ? "read-only" : "workspace-write"

export const codexArgv = (
  binary: string,
  options: ProviderRunOptions,
): readonly [string, ...ReadonlyArray<string>] => [
  binary,
  "exec",
  ...(options.resumeSessionId !== undefined ? ["resume", options.resumeSessionId] : []),
  "--json",
  "--skip-git-repo-check",
  // `exec resume` accepts neither -s nor -C, so the sandbox rides the config override both forms
  // share, and the workspace comes from the cwd the supervisor spawns into.
  "-c",
  `sandbox_mode=${sandbox(options.permissionProfile)}`,
  // The sandbox mode itself has no network variant; the workspace-write policy carries the switch.
  ...(options.permissionProfile === "workspace-write-network"
    ? ["-c", "sandbox_workspace_write.network_access=true"]
    : []),
  // Everything after `--` is the prompt operand, so a prompt opening with `-` stays data.
  "--",
  options.prompt,
]

/** `codex exec --json` has no question protocol, so QuestionAsked is never surfaced here. */
export const codexParse: LineParser = (state, raw) => {
  const line = jsonLine(raw)
  if (line === undefined) return malformed(state, raw)

  const type = str(line.type) ?? "unknown"
  if (type === "thread.started") {
    const threadId = str(line.thread_id)
    if (threadId !== undefined) {
      const session = SessionId.make(threadId)
      return [
        [{ _tag: "SessionStarted", sessionId: session, raw }],
        { ...state, sessionId: session },
      ]
    }
  }
  if (type === "item.completed") {
    const item = record(line.item)
    const itemType = str(item?.type) ?? "unknown"
    if (itemType === "agent_message") {
      const text = str(item?.text) ?? ""
      return [
        [{ _tag: "OutputChunk", streamKind: "assistant", text, raw }],
        { ...state, text: state.text + text },
      ]
    }
    if (itemType === "error") {
      return [[{ _tag: "ErrorRaised", message: str(item?.message) ?? raw, raw }], state]
    }
    return [[activity(`item:${itemType}`, raw, str(item?.id))], state]
  }
  if (type === "turn.completed" || type === "turn.failed") {
    const failed = type === "turn.failed"
    const result = {
      sessionId: state.sessionId,
      isError: failed,
      // turn.completed carries only usage counters, so the verdict text is what the agent said.
      text: failed ? (str(record(line.error)?.message) ?? raw) : state.text,
    }
    return [[{ _tag: "ResultProduced", result, raw }], { ...state, result }]
  }
  return [[activity(type, raw)], state]
}

export class CodexProvider extends Context.Tag("cockpit/CodexProvider")<
  CodexProvider,
  Provider
>() {}

export const CodexProviderLive = Layer.effect(
  CodexProvider,
  Effect.gen(function* () {
    const binary = yield* codexBinary
    const supervisor = yield* ProcessSupervisor
    return {
      name: "codex" as const,
      run: (options: ProviderRunOptions) =>
        runProvider({
          argv: codexArgv(binary, options),
          cwd: options.cwd,
          env: options.env,
          timeoutMs: options.timeoutMs,
          parse: codexParse,
        }).pipe(Stream.provideService(ProcessSupervisor, supervisor)),
    }
  }),
)
