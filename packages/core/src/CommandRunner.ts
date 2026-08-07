import { Clock, Context, Effect, Either, Layer, Schema, Stream } from "effect"
import { glob } from "node:fs/promises"
import * as NodePath from "node:path"
import { JournalError, ProcessError } from "./errors.js"
import { AttemptId, BlockId, RunId } from "./ids.js"
import { Journal } from "./Journal.js"
import { ProcessSupervisor } from "./ProcessSupervisor.js"
import { clip, outputBudget } from "./text.js"

const RegexSource = Schema.String.pipe(
  Schema.filter(
    (source) => {
      try {
        new RegExp(source)
        return true
      } catch {
        return false
      }
    },
    { message: () => "must be a valid regular expression" },
  ),
)

export const OutputRule = Schema.Union(
  Schema.TaggedStruct("StdoutMatches", { pattern: RegexSource, required: Schema.Boolean }),
  Schema.TaggedStruct("StderrMatches", { pattern: RegexSource, required: Schema.Boolean }),
  Schema.TaggedStruct("ArtifactExists", { glob: Schema.String, required: Schema.Boolean }),
)
export type OutputRule = typeof OutputRule.Type

export const CommandSpec = Schema.Struct({
  argv: Schema.NonEmptyArray(Schema.String),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  successRules: Schema.optional(Schema.Array(OutputRule)),
})
export type CommandSpec = typeof CommandSpec.Type

export interface RuleResult {
  readonly rule: OutputRule
  readonly passed: boolean
}

export interface CommandResult {
  /** `null` when the child was killed or lost before it could report a status. */
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly durationMs: number
  readonly ruleResults: ReadonlyArray<RuleResult>
  readonly success: boolean
}

export interface RunCommandInput {
  readonly runId: RunId
  readonly blockId?: BlockId
  readonly attemptId?: AttemptId
  readonly cwd: string
  readonly command: CommandSpec
  readonly timeoutMs: number
}

export class CommandRunner extends Context.Tag("cockpit/CommandRunner")<
  CommandRunner,
  {
    readonly execute: (
      input: RunCommandInput,
    ) => Effect.Effect<CommandResult, ProcessError | JournalError>
  }
>() {}

interface Captured {
  readonly text: string
  readonly truncated: boolean
}

const capture = (stream: Stream.Stream<Uint8Array, ProcessError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold({ text: "", truncated: false } as Captured, (acc, chunk) => {
      const room = outputBudget - acc.text.length
      if (room <= 0) return { text: acc.text, truncated: true }
      return chunk.length <= room
        ? { text: acc.text + chunk, truncated: acc.truncated }
        : { text: acc.text + clip(chunk, room), truncated: true }
    }),
  )

export const escapesWorktree = (pattern: string) =>
  NodePath.isAbsolute(pattern) || pattern.split(/[/\\]/).includes("..")

export const artifactExists = (cwd: string, pattern: string) =>
  escapesWorktree(pattern)
    ? Effect.fail(
        new ProcessError({
          kind: "io",
          detail: `artifact glob must stay inside the worktree: ${pattern}`,
        }),
      )
    : Effect.tryPromise({
        try: async () => {
          for await (const match of glob(pattern, { cwd })) {
            if (!NodePath.relative(cwd, NodePath.resolve(cwd, match)).startsWith("..")) return true
          }
          return false
        },
        catch: (cause) =>
          new ProcessError({ kind: "io", detail: `glob ${pattern} in ${cwd}: ${String(cause)}` }),
      })

// ponytail: rules run on the stock backtracking engine, so a pathological pattern can stall the
// block it belongs to. Accepted for v1 — one local user, and the cartridge is their own code
// (ADR-007). Swap in a bounded engine if runs ever become multi-tenant.
const matchesPattern = (pattern: string, text: string) =>
  Effect.try({
    try: () => new RegExp(pattern).test(text),
    catch: (cause) =>
      new ProcessError({ kind: "io", detail: `invalid rule pattern ${pattern}: ${String(cause)}` }),
  })

const evaluate = (
  rule: OutputRule,
  cwd: string,
  stdout: string,
  stderr: string,
): Effect.Effect<RuleResult, ProcessError> =>
  Effect.map(
    rule._tag === "ArtifactExists"
      ? artifactExists(cwd, rule.glob)
      : matchesPattern(rule.pattern, rule._tag === "StdoutMatches" ? stdout : stderr),
    (passed) => ({ rule, passed }),
  )

export const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const supervisor = yield* ProcessSupervisor
    const journal = yield* Journal

    return {
      execute: (input: RunCommandInput) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis
          const child = yield* supervisor.spawn({
            argv: input.command.argv,
            cwd: input.cwd,
            env: input.command.env,
            timeoutMs: input.timeoutMs,
          })
          // Both pipes must drain alongside the exit wait, or a chatty command fills one and hangs.
          // The wait is kept as an Either so a deadline that kills the child still yields whatever
          // it printed first — that output is usually the only evidence of why it stalled.
          const [stdout, stderr, outcome] = yield* Effect.all(
            [capture(child.stdout), capture(child.stderr), Effect.either(child.exitCode)],
            { concurrency: 3 },
          )
          const durationMs = (yield* Clock.currentTimeMillis) - startedAt
          const exitCode = Either.getOrNull(outcome)
          const timedOut = Either.isLeft(outcome) && outcome.left.kind === "timeout"

          const ruleResults = yield* Effect.forEach(input.command.successRules ?? [], (rule) =>
            evaluate(rule, input.cwd, stdout.text, stderr.text),
          )
          const success =
            exitCode === 0 && ruleResults.every(({ rule, passed }) => passed || !rule.required)

          yield* journal.append({
            runId: input.runId,
            blockId: input.blockId,
            attemptId: input.attemptId,
            payload: {
              _tag: "CommandExecuted",
              argv: input.command.argv,
              exitCode,
              timedOut,
              durationMs,
              success,
            },
          })

          return {
            exitCode,
            timedOut,
            stdout: stdout.text,
            stderr: stderr.text,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            durationMs,
            ruleResults,
            success,
          }
        }).pipe(Effect.scoped),
    }
  }),
)
