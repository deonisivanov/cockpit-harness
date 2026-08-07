import { Command, CommandExecutor } from "@effect/platform"
import { Config, Context, Effect, Fiber, Layer, Ref, Scope, Stream } from "effect"
import { ProcessError } from "./errors.js"

export interface SpawnOptions {
  readonly argv: readonly [string, ...ReadonlyArray<string>]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface Child {
  readonly pid: number
  readonly stdout: Stream.Stream<Uint8Array, ProcessError>
  readonly stderr: Stream.Stream<Uint8Array, ProcessError>
  /** Resolves once both pipes are drained; fails with "timeout" when the deadline killed the group. */
  readonly exitCode: Effect.Effect<number, ProcessError>
}

export class ProcessSupervisor extends Context.Tag("cockpit/ProcessSupervisor")<
  ProcessSupervisor,
  {
    readonly spawn: (
      options: SpawnOptions,
    ) => Effect.Effect<Child, ProcessError, Scope.Scope>
  }
>() {}

const killGraceMillis = Config.integer("COCKPIT_KILL_GRACE_MS").pipe(
  Config.withDefault(5_000),
)

export const ProcessSupervisorLive = Layer.effect(
  ProcessSupervisor,
  Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor
    const grace = yield* killGraceMillis

    /** Falls back to signalling: a runaway child costs more than one redundant signal. */
    const stillRunning = (child: CommandExecutor.Process) =>
      Effect.orElseSucceed(child.isRunning, () => true)

    /**
     * `Process.kill` signals the whole group — the executor spawns detached, so plugin
     * subagents and shells started by the child share its group and die with it. Each signal
     * waits for the exit, and scope finalizers are uninterruptible, so Effect's own timeout
     * could never fire here: only a plain timer still escalates while that wait is pending.
     * The guard keeps a signal off a pid the OS may already have handed to someone else.
     */
    const killTree = (child: CommandExecutor.Process) =>
      Effect.suspend(() => {
        let escalated: Fiber.RuntimeFiber<void> | undefined
        const escalation = setTimeout(() => {
          escalated = Effect.runFork(Effect.ignore(child.kill("SIGKILL")))
        }, grace)
        return child.kill("SIGTERM").pipe(
          Effect.ignore,
          Effect.ensuring(
            Effect.suspend(() => {
              clearTimeout(escalation)
              // interruptFork, not interrupt: awaiting a kill that is itself awaiting the exit
              // would hand the finalizer back the hang the timer exists to break.
              return escalated === undefined ? Effect.void : Fiber.interruptFork(escalated)
            }),
          ),
        )
      }).pipe(Effect.whenEffect(stillRunning(child)), Effect.asVoid)

    const spawn = (options: SpawnOptions) =>
      Effect.gen(function* () {
        const [executable, ...args] = options.argv
        const rendered = options.argv.join(" ")

        const child = yield* Command.start(
          Command.make(executable, ...args).pipe(
            Command.workingDirectory(options.cwd),
            // Layered over the daemon's own environment, never replacing it: provider CLIs read
            // subscription credentials from it, and a cartridge's commands are the user's own
            // code running locally (ADR-007), so they inherit it too.
            Command.env(options.env ?? {}),
            // A pipe nobody writes to never reaches EOF, and a CLI that also reads stdin
            // (codex exec does) would wait forever for input Cockpit is never going to send.
            Command.stdin(Stream.empty),
          ),
        ).pipe(
          Effect.mapError(
            (cause) => new ProcessError({ kind: "spawn", detail: `${rendered}: ${cause.message}` }),
          ),
        )

        // Registered after Command.start, so on scope close it unwinds first: the executor's own
        // release only sends SIGTERM and then waits forever for an exit that may never come.
        yield* Effect.addFinalizer(() => killTree(child))

        const timedOut = yield* Ref.make(false)
        if (options.timeoutMs !== undefined) {
          yield* Effect.forkScoped(
            Effect.sleep(options.timeoutMs).pipe(
              Effect.zipRight(
                // Guarded together: a child that exits just as the deadline lands finished on its
                // own, and must not be reported as timed out.
                Ref.set(timedOut, true).pipe(
                  Effect.zipRight(killTree(child)),
                  Effect.whenEffect(stillRunning(child)),
                ),
              ),
            ),
          )
        }

        const failed = (detail: string) => new ProcessError({ kind: "io", detail })

        return {
          pid: Number(child.pid),
          stdout: Stream.mapError(child.stdout, (cause) =>
            failed(`${rendered} stdout: ${cause.message}`),
          ),
          stderr: Stream.mapError(child.stderr, (cause) =>
            failed(`${rendered} stderr: ${cause.message}`),
          ),
          exitCode: Effect.gen(function* () {
            const outcome = yield* Effect.either(child.exitCode)
            // Checked first: the kill that ended the process is why it has no clean exit status.
            if (yield* Ref.get(timedOut)) {
              return yield* new ProcessError({
                kind: "timeout",
                detail: `${rendered} exceeded ${options.timeoutMs}ms`,
              })
            }
            return outcome._tag === "Left"
              ? yield* failed(`${rendered}: ${outcome.left.message}`)
              : Number(outcome.right)
          }),
        }
      }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor))

    return { spawn }
  }),
)
