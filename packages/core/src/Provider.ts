import { Effect, Option, Ref, Schema, Stream } from "effect"
import { ProcessError, ProviderError } from "./errors.js"
import { SessionId } from "./ids.js"
import { ProcessSupervisor } from "./ProcessSupervisor.js"

export const PermissionProfile = Schema.Literal(
  "read-only",
  "workspace-write",
  "workspace-write-network",
)
export type PermissionProfile = typeof PermissionProfile.Type

export const ProviderName = Schema.Literal("claude-code", "codex")
export type ProviderName = typeof ProviderName.Type

export interface ProviderResult {
  readonly sessionId?: SessionId
  readonly isError: boolean
  readonly text: string
}

/**
 * Normalized from provider-native stream events. `raw` carries the source line verbatim;
 * Phase 4 moves it behind an artifact reference.
 */
export type ProviderEvent =
  | { readonly _tag: "SessionStarted"; readonly sessionId: SessionId; readonly raw: string }
  | {
      readonly _tag: "AgentActivity"
      readonly activity: string
      readonly detail?: string
      readonly raw: string
    }
  | {
      readonly _tag: "OutputChunk"
      readonly streamKind: "assistant" | "stderr"
      readonly text: string
      readonly raw: string
    }
  | { readonly _tag: "QuestionAsked"; readonly question: string; readonly raw: string }
  | { readonly _tag: "ResultProduced"; readonly result: ProviderResult; readonly raw: string }
  | { readonly _tag: "ErrorRaised"; readonly message: string; readonly raw: string }

export interface ProviderRunOptions {
  readonly prompt: string
  readonly cwd: string
  /** Claude only: Cockpit assigns the session id up front. Codex generates its own. */
  readonly sessionId?: SessionId
  readonly resumeSessionId?: SessionId
  readonly permissionProfile: PermissionProfile
  readonly timeoutMs: number
  readonly env?: Readonly<Record<string, string>>
}

export interface Provider {
  readonly name: ProviderName
  /**
   * Emits exactly one `ResultProduced` unless it fails; stderr chunks are merged in as they
   * arrive and may land after it. The stream must be drained — the child's exit is only
   * awaited once both pipes are closed.
   */
  readonly run: (options: ProviderRunOptions) => Stream.Stream<ProviderEvent, ProviderError>
}

export interface ParseState {
  readonly sessionId?: SessionId
  readonly text: string
  readonly result?: ProviderResult
}

export type LineParser = (
  state: ParseState,
  line: string,
) => readonly [ReadonlyArray<ProviderEvent>, ParseState]

/** Fails with a parse ProviderError when the run ends without ever emitting a ResultProduced. */
export const runToResult = (
  events: Stream.Stream<ProviderEvent, ProviderError>,
  onEvent: (event: ProviderEvent) => Effect.Effect<void>,
) =>
  events.pipe(
    Stream.tap(onEvent),
    Stream.runFold(Option.none<ProviderResult>(), (last, event) =>
      event._tag === "ResultProduced" ? Option.some(event.result) : last,
    ),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          new ProviderError({ kind: "parse", detail: "run produced no result event" }),
        onSome: Effect.succeed<ProviderResult>,
      }),
    ),
  )

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

export const jsonLine = (raw: string): Record<string, unknown> | undefined => {
  try {
    return record(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** A line the CLI never promised: reported, then the stream carries on. */
export const malformed = (
  state: ParseState,
  raw: string,
): readonly [ReadonlyArray<ProviderEvent>, ParseState] => [
  [{ _tag: "ErrorRaised", message: "unparseable stream line", raw }],
  state,
]

export const activity = (activity: string, raw: string, detail?: string): ProviderEvent => ({
  _tag: "AgentActivity",
  activity,
  detail,
  raw,
})

const fromProcessError = (cause: ProcessError, sessionId?: SessionId) =>
  new ProviderError({
    kind: cause.kind === "io" ? "crash" : cause.kind,
    detail: cause.detail,
    sessionId,
  })

const lineBudgetChars = 4 * 1024 * 1024

/**
 * `splitLines` buffers until a newline arrives, so a child that streams forever without one
 * would grow the buffer unbounded. Counting decoded characters since the last newline caps it.
 */
const boundLines = <E>(stream: Stream.Stream<string, E>) =>
  Stream.mapAccumEffect(stream, 0, (pending, chunk) => {
    const lastBreak = chunk.lastIndexOf("\n")
    const carried = lastBreak === -1 ? pending + chunk.length : chunk.length - lastBreak - 1
    return carried > lineBudgetChars
      ? new ProcessError({
          kind: "io",
          detail: `stream line exceeded ${lineBudgetChars} characters`,
        })
      : Effect.succeed([carried, chunk] as const)
  })

export const runProvider = (options: {
  readonly argv: readonly [string, ...ReadonlyArray<string>]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly parse: LineParser
}): Stream.Stream<ProviderEvent, ProviderError, ProcessSupervisor> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const supervisor = yield* ProcessSupervisor
      const child = yield* supervisor.spawn(options)
      const state = yield* Ref.make<ParseState>({ text: "" })

      const withSession = (cause: ProcessError) =>
        Effect.flatMap(Ref.get(state), ({ sessionId }) =>
          Effect.fail(fromProcessError(cause, sessionId)),
        )

      const lines = (stream: Stream.Stream<Uint8Array, ProcessError>) =>
        stream.pipe(
          Stream.decodeText(),
          boundLines,
          Stream.splitLines,
          Stream.filter((line) => line.trim() !== ""),
          Stream.catchAll((cause) => Stream.fromEffect(withSession(cause))),
        )

      const parsed = lines(child.stdout).pipe(
        Stream.mapEffect((line) => Ref.modify(state, (current) => options.parse(current, line))),
        Stream.flattenIterables,
      )

      const diagnostics = lines(child.stderr).pipe(
        Stream.map(
          (line): ProviderEvent => ({
            _tag: "OutputChunk",
            streamKind: "stderr",
            text: line,
            raw: line,
          }),
        ),
      )

      const settle = Effect.gen(function* () {
        const code = yield* Effect.catchTag(child.exitCode, "ProcessError", withSession)
        const { result, sessionId } = yield* Ref.get(state)
        // The CLI's own verdict wins when it produced one, so a reported semantic failure is
        // not re-labelled as a crashed process.
        if (result !== undefined) return
        return yield* new ProviderError({
          kind: code === 0 ? "parse" : "crash",
          detail:
            code === 0
              ? `${options.argv.join(" ")} exited cleanly without a result event`
              : `${options.argv.join(" ")} exited with code ${code}`,
          sessionId,
        })
      })

      return Stream.merge(parsed, diagnostics).pipe(Stream.concat(Stream.execute(settle)))
    }).pipe(Effect.mapError(fromProcessError)),
  )
