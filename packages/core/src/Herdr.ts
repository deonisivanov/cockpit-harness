import { Config, Context, Effect, Layer, Stream } from "effect"
import { HerdrError } from "./errors.js"
import { ProcessSupervisor } from "./ProcessSupervisor.js"
import { record, str } from "./Provider.js"

const herdrBinary = Config.string("COCKPIT_HERDR_BIN").pipe(Config.withDefault("herdr"))

/**
 * Ghostty refuses to launch its emulator from its own binary on macOS ("only actions are
 * supported") and points at `open -na Ghostty.app --args ...` instead, so that is the fallback.
 */
const openBinary = Config.string("COCKPIT_OPEN_BIN").pipe(Config.withDefault("open"))

/** The herdr socket protocol the CLI surface below was verified against (plan §18). */
const herdrProtocol = 17

const cliTimeoutMs = 15_000

/** `agent start`'s own readiness window; its spawn guard must outlive it (see the exec below). */
const agentStartTimeoutMs = 30_000

export type TerminalMode = "herdr" | "ghostty"

export interface OpenTabInput {
  readonly title: string
  readonly cwd: string
  /**
   * The full argv, binary first — what Ghostty execs. The herdr path drops the binary and hands
   * the rest to `agent start --kind`, which runs the canonical executable for `agentKind`: typing
   * a quoted line into the pane's shell was abandoned because no one quoting is correct for both
   * POSIX shells and fish, and `pane run` exits 0 whether or not anything ran.
   */
  readonly command: readonly [string, ...ReadonlyArray<string>]
  readonly agentKind: "claude" | "codex"
}

export interface OpenedTab {
  readonly mode: TerminalMode
  /** What the preflight saw, journaled with the handoff: herdr's protocol, or Ghostty's argv. */
  readonly detail: string
  /** Why herdr was passed over; set only when Ghostty took the tab instead. */
  readonly warning?: string
}

/**
 * The herdr CLI, not the raw socket: `herdr tab`/`herdr pane` are the documented surface over the
 * same API, and they track the protocol the installed server speaks.
 */
export class HerdrClient extends Context.Tag("cockpit/HerdrClient")<
  HerdrClient,
  { readonly openTab: (input: OpenTabInput) => Effect.Effect<OpenedTab, HerdrError> }
>() {}

type HerdrOp = typeof HerdrError.Type.op

export const HerdrClientLive = Layer.effect(
  HerdrClient,
  Effect.gen(function* () {
    const supervisor = yield* ProcessSupervisor
    const herdr = yield* herdrBinary
    const open = yield* openBinary

    const exec = (
      op: HerdrOp,
      cwd: string,
      argv: readonly [string, ...ReadonlyArray<string>],
      timeoutMs = cliTimeoutMs,
    ) =>
      Effect.gen(function* () {
        const child = yield* supervisor.spawn({ argv, cwd, timeoutMs })
        // Both pipes drain alongside the exit wait, or a chatty CLI fills one and hangs.
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(child.stdout)),
            Stream.mkString(Stream.decodeText(child.stderr)),
            Effect.either(child.exitCode),
          ],
          { concurrency: 3 },
        )
        if (exitCode._tag === "Left" || exitCode.right !== 0) {
          const reason =
            exitCode._tag === "Left" ? exitCode.left.detail : `exit ${exitCode.right}`
          return yield* new HerdrError({
            op,
            detail: `${argv.join(" ")}: ${reason}${stderr.trim() === "" ? "" : ` — ${stderr.trim()}`}`,
          })
        }
        return stdout
      }).pipe(
        Effect.scoped,
        Effect.catchTag("ProcessError", (cause) =>
          Effect.fail(new HerdrError({ op, detail: `${argv.join(" ")}: ${cause.detail}` })),
        ),
      )

    const parse = (op: HerdrOp, argv: ReadonlyArray<string>, text: string) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () =>
          new HerdrError({ op, detail: `${argv.join(" ")} answered with non-JSON: ${text.trim()}` }),
      })

    /** The server has to be up before a tab request means anything; its protocol rides along. */
    const preflight = (cwd: string) =>
      Effect.gen(function* () {
        const argv = [herdr, "status", "server", "--json"] as const
        const status = record(yield* parse("connect", argv, yield* exec("connect", cwd, argv)))
        if (status?.running !== true) {
          return yield* new HerdrError({ op: "connect", detail: "herdr server is not running" })
        }
        const protocol = typeof status.protocol === "number" ? status.protocol : undefined
        return protocol === herdrProtocol
          ? `herdr protocol ${protocol}`
          : `herdr protocol ${protocol ?? "unknown"} (verified against ${herdrProtocol})`
      })

    const viaHerdr = (input: OpenTabInput) =>
      Effect.gen(function* () {
        const preflighted = yield* preflight(input.cwd)
        const createArgv = [
          herdr,
          "tab",
          "create",
          "--cwd",
          input.cwd,
          "--label",
          input.title,
          "--focus",
        ] as const
        const created = record(
          yield* parse("tab", createArgv, yield* exec("tab", input.cwd, createArgv)),
        )
        const result = record(created?.result)
        const paneId = str(record(result?.root_pane)?.pane_id)
        if (paneId === undefined) {
          return yield* new HerdrError({
            op: "tab",
            detail: `${createArgv.join(" ")} returned no root pane`,
          })
        }
        const tabId = str(record(result?.tab)?.tab_id) ?? "unknown"
        // Success is herdr's own criterion: the agent was detected in that pane and is ready for
        // input. The canonical-executable caveat: `--kind` decides what runs, so a
        // COCKPIT_{CLAUDE,CODEX}_BIN override only reaches the Ghostty path — and a herdr
        // environment that cannot resolve the bare binary fails here without falling through to
        // Ghostty, since the tab is already on screen.
        yield* exec(
          "agent",
          input.cwd,
          [
            herdr,
            "agent",
            "start",
            // Names must match ^[a-z][a-z0-9_-]{0,31}$; real pane ids carry uppercase.
            `cockpit-${paneId.replaceAll(":", "-").toLowerCase()}`.slice(0, 32),
            "--kind",
            input.agentKind,
            "--pane",
            paneId,
            "--timeout",
            String(agentStartTimeoutMs),
            "--",
            ...input.command.slice(1),
          ],
          agentStartTimeoutMs + 5_000,
        ).pipe(
          // The tab is already on the user's screen; naming it is what lets them close it.
          Effect.mapError(
            (cause) =>
              new HerdrError({
                op: "agent",
                detail: `${cause.detail} — tab ${tabId} is open but has no agent`,
              }),
          ),
        )
        return { mode: "herdr", detail: `${preflighted}, pane ${paneId}` } satisfies OpenedTab
      })

    /** `-e` is Ghostty's "run this command"; the cwd is a config key, so it rides `--args`. */
    const viaGhostty = (input: OpenTabInput, warning: string) => {
      const argv = [
        open,
        "-na",
        "Ghostty.app",
        "--args",
        `--working-directory=${input.cwd}`,
        "-e",
        ...input.command,
      ] as const
      return exec("tab", input.cwd, argv).pipe(
        Effect.as({ mode: "ghostty", detail: argv.join(" "), warning } satisfies OpenedTab),
        // Both terminals are gone at this point, so the error has to name both reasons.
        Effect.mapError(
          (cause) => new HerdrError({ op: "tab", detail: `${cause.detail}; herdr: ${warning}` }),
        ),
      )
    }

    return {
      openTab: (input) =>
        viaHerdr(input).pipe(
          // A herdr that never got as far as a tab falls through to Ghostty rather than leaving
          // the user without a terminal. A failed `pane run` does not: the tab exists, and a
          // second window would leave the user two terminals for one session.
          Effect.catchIf(
            (cause) => cause.op !== "agent",
            (cause) => viaGhostty(input, cause.detail),
          ),
        ),
    }
  }),
)
