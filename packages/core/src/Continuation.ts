import { FileSystem } from "@effect/platform"
import { Chunk, Config, Context, Effect, Layer, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import * as NodePath from "node:path"
import { ArtifactStore } from "./ArtifactStore.js"
import { renderTaskBrief } from "./brief.js"
import { CartridgeLoader } from "./CartridgeLoader.js"
import { claudeBinary } from "./ClaudeCodeProvider.js"
import { codexBinary } from "./CodexProvider.js"
import { HerdrError, JournalError, WorkspaceError } from "./errors.js"
import { JournalEvent } from "./events.js"
import { HerdrClient, TerminalMode } from "./Herdr.js"
import { EventSeq, RunId, SessionId } from "./ids.js"
import { Journal } from "./Journal.js"
import { ProviderName } from "./Provider.js"
import { ProjectRow, RunRow, Store } from "./Store.js"
import { clip, oneLine } from "./text.js"
import { CheckpointService, Workspace, WorkspaceManager } from "./Workspace.js"

const briefBudgetChars = 40_000
const titleChars = 48
const detailChars = 500
const eventPage = 1_000

/**
 * codex assigns its own session ids and only surfaces them inside the TUI, so Cockpit has none to
 * record (settled in Phase 3). `codex resume --last` run in the worktree names that same session —
 * the picker filters by cwd and skips non-interactive runs — so the handle stored for a codex run
 * is that command rather than an id codex never handed over.
 */
const codexCanonicalSession = SessionId.make("codex:resume-last")

/** Why the press could not simply resume what the run left behind. */
export type ContinuationFallback = "fresh-session" | "fresh-worktree"

export interface OpenedContinuation {
  readonly mode: TerminalMode
  readonly fallback?: ContinuationFallback
  readonly sessionId: SessionId
  /** Set when herdr was unreachable and Ghostty took the handoff instead. */
  readonly warning?: string
  /** Set when this press seeded a session; a resume reuses the brief that session already read. */
  readonly briefPath?: string
}

/** One canonical session per run (ADR-008), created on the first press and resumed after it. */
export class ContinuationService extends Context.Tag("cockpit/ContinuationService")<
  ContinuationService,
  {
    readonly open: (
      runId: RunId,
    ) => Effect.Effect<OpenedContinuation, JournalError | WorkspaceError | HerdrError>
  }
>() {}

const claudeConfigDir = Config.string("CLAUDE_CONFIG_DIR").pipe(
  Config.withDefault(NodePath.join(homedir(), ".claude")),
)

/** claude keys a session's transcript by the escaped absolute cwd it was started in. */
const claudeSessionFile = (configDir: string, cwd: string, sessionId: SessionId) =>
  NodePath.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`)

const pointerPrompt = (briefPath: string) =>
  `Read ${briefPath} — it is Cockpit's full brief for the task already executed in this worktree. Then wait for my instructions.`

/** `--` keeps the pointer an operand, the same argv guard the headless providers use. */
const seedArgv = (
  provider: ProviderName,
  binary: string,
  sessionId: SessionId,
  briefPath: string,
): readonly [string, ...ReadonlyArray<string>] =>
  provider === "codex"
    ? [binary, "--", pointerPrompt(briefPath)]
    : [binary, "--session-id", sessionId, "--", pointerPrompt(briefPath)]

const resumeArgv = (
  provider: ProviderName,
  binary: string,
  sessionId: SessionId,
): readonly [string, ...ReadonlyArray<string>] =>
  provider === "codex" ? [binary, "resume", "--last"] : [binary, "--resume", sessionId]

/**
 * A session belongs to the CLI that opened it — claude cannot resume a codex thread and the codex
 * handle is not a uuid — so an existing handle, not the run's latest block, decides the provider.
 */
const providerOfHandle = (sessionId: SessionId): ProviderName =>
  sessionId === codexCanonicalSession ? "codex" : "claude-code"

const providerOf = (events: ReadonlyArray<JournalEvent>): ProviderName => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index].payload
    if (payload._tag === "PluginResolved") return payload.provider.name
  }
  return "claude-code"
}

/** The newest checkpoint a block confirmed; a salvage commit only stands in when there is none. */
const lastCheckpoint = (events: ReadonlyArray<JournalEvent>) => {
  let salvage: string | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index].payload
    if (payload._tag !== "CheckpointCreated") continue
    if (payload.kind === "success") return payload.checkpointId
    salvage ??= payload.checkpointId
  }
  return salvage
}

export const ContinuationServiceLive = Layer.effect(
  ContinuationService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* Store
    const journal = yield* Journal
    const artifacts = yield* ArtifactStore
    const workspaces = yield* WorkspaceManager
    const checkpoints = yield* CheckpointService
    const cartridges = yield* CartridgeLoader
    const herdr = yield* HerdrClient
    const claude = yield* claudeBinary
    const codex = yield* codexBinary
    const configDir = yield* claudeConfigDir

    const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false))

    const allEvents = (
      runId: RunId,
      after: EventSeq,
    ): Effect.Effect<ReadonlyArray<JournalEvent>, JournalError> =>
      Effect.gen(function* () {
        const page = Chunk.toReadonlyArray(
          yield* Stream.runCollect(journal.eventsFrom(runId, after, eventPage)),
        )
        const last = page[page.length - 1]
        return last === undefined || page.length < eventPage
          ? page
          : [...page, ...(yield* allEvents(runId, last.seq))]
      })

    /**
     * A cartridge that no longer loads must not stand between the user and their terminal, so the
     * brief goes without the project's checks rather than the press failing.
     */
    const healthChecks = (repoPath: string) =>
      Effect.gen(function* () {
        const config = NodePath.join(repoPath, ".cockpit", "cockpit.config.ts")
        if (!(yield* exists(config))) return []
        const loaded = yield* cartridges.load(repoPath).pipe(Effect.orElseSucceed(() => undefined))
        return loaded?.config.environment?.healthChecks ?? []
      })

    const canResume = (provider: ProviderName, sessionId: SessionId, worktreePath: string) =>
      provider === "codex"
        ? Effect.succeed(true)
        : Effect.gen(function* () {
            // The probe reads claude's private layout, so it only gets a vote when that layout is
            // where it is expected; anything else resumes optimistically rather than discarding a
            // session that is probably still there.
            if (!(yield* exists(NodePath.join(configDir, "projects")))) return true
            const real = yield* fs
              .realPath(worktreePath)
              .pipe(Effect.orElseSucceed(() => worktreePath))
            return yield* exists(claudeSessionFile(configDir, real, sessionId))
          })

    const seed = (input: {
      readonly run: RunRow
      readonly project: ProjectRow
      readonly workspace: Workspace
      readonly provider: ProviderName
      readonly events: ReadonlyArray<JournalEvent>
    }) =>
      Effect.gen(function* () {
        const { events, project, run, workspace } = input
        // Evidence, not a precondition: a git that cannot answer costs the brief one section.
        const changedFiles =
          run.baseCommit === null
            ? []
            : yield* checkpoints
                .changedFiles(workspace, run.baseCommit)
                .pipe(Effect.orElseSucceed(() => []))

        const brief = renderTaskBrief({
          run,
          projectName: project.name,
          repoPath: project.repoPath,
          worktreePath: workspace.path,
          events,
          blocks: yield* store.blocks(run.id),
          changedFiles,
          healthChecks: yield* healthChecks(project.repoPath),
          maxChars: briefBudgetChars,
        })
        const artifact = yield* artifacts.write({
          runId: run.id,
          kind: "task-brief",
          name: "task-brief.md",
          content: brief,
        })

        // Nothing is persisted here: until a terminal actually takes the session, the run has no
        // canonical one, and the next press must be free to seed again.
        return {
          sessionId:
            input.provider === "codex" ? codexCanonicalSession : SessionId.make(randomUUID()),
          briefPath: artifact.path,
        }
      })

    // ponytail: one lock across every run. Two presses race over the same canonical id, and a
    // press is a human action — make it per-run if that ever costs anything.
    const lock = yield* Effect.makeSemaphore(1)

    return {
      open: (runId) =>
        Effect.gen(function* () {
          const run = yield* store.run(runId)
          if (run === undefined) {
            return yield* new JournalError({ op: "openSession", detail: `unknown run ${runId}` })
          }
          const project = yield* store.project(run.projectId)
          if (project === undefined) {
            return yield* new JournalError({
              op: "openSession",
              detail: `run ${runId} names unknown project ${run.projectId}`,
            })
          }

          // A resume needs neither the journal nor a brief, so the read is deferred to the paths
          // that do: a vanished worktree, and seeding.
          const events = yield* Effect.cached(allEvents(runId, EventSeq.make(0)))

          const recorded = run.worktreePath
          const present = recorded !== null && (yield* exists(recorded))
          let fallback: ContinuationFallback | undefined
          let workspace: Workspace
          if (present) {
            workspace = {
              projectId: run.projectId,
              runId,
              repoPath: project.repoPath,
              path: recorded,
              branch: run.branch ?? `cockpit/run-${runId}`,
              baseCommit: run.baseCommit ?? "HEAD",
            }
          } else {
            // The run's work lives in the branch's commits, so the checkout starts from the last
            // checkpoint it confirmed rather than from where it originally branched.
            workspace = yield* workspaces.restore({
              projectId: run.projectId,
              repoPath: project.repoPath,
              branch: run.branch ?? `cockpit/run-${runId}`,
              commit: lastCheckpoint(yield* events) ?? run.baseCommit ?? "HEAD",
              runId,
            })
            fallback = "fresh-worktree"
          }

          const canonical = run.canonicalSessionId
          const resumable =
            canonical !== null &&
            (yield* canResume(providerOfHandle(canonical), canonical, workspace.path))
              ? canonical
              : undefined
          // A fresh session belongs to whichever provider the run last used; a resumed one to the
          // provider that opened it, whatever the run has moved on to since.
          const provider =
            resumable === undefined ? providerOf(yield* events) : providerOfHandle(resumable)
          const binary = provider === "codex" ? codex : claude

          if (resumable === undefined && canonical !== null) fallback ??= "fresh-session"
          // `briefPath` is what tells the two apart from here on: only a seeded session has one.
          const { briefPath, sessionId } =
            resumable === undefined
              ? yield* seed({ run, project, workspace, provider, events: yield* events })
              : { briefPath: undefined, sessionId: resumable }

          const tab = yield* herdr.openTab({
            title: oneLine(run.prompt, titleChars),
            cwd: workspace.path,
            command:
              briefPath === undefined
                ? resumeArgv(provider, binary, sessionId)
                : seedArgv(provider, binary, sessionId, briefPath),
          })

          // Journaled only once a terminal has the session: a press that opened nothing must
          // leave the run exactly as it found it.
          if (briefPath === undefined) {
            yield* journal.append({ runId, payload: { _tag: "SessionResumed", sessionId } })
          } else {
            if (canonical !== null) {
              yield* journal.append({
                runId,
                payload: {
                  _tag: "AgentActivity",
                  activity: "canonical-session-archived",
                  detail: canonical,
                },
              })
            }
            yield* journal.openCanonicalSession(runId, sessionId)
          }

          yield* journal.append({
            runId,
            payload: {
              _tag: "AgentActivity",
              activity: `terminal:${tab.mode}`,
              detail: clip(tab.detail, detailChars),
            },
          })

          return { mode: tab.mode, fallback, sessionId, warning: tab.warning, briefPath }
        }).pipe(lock.withPermits(1)),
    }
  }),
)
