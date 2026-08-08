import { SqlClient, SqlError } from "@effect/sql"
import { Clock, Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { JournalError } from "./errors.js"
import { AttemptVerdict, BlockKind, BlockStatus, RunStatus } from "./events.js"
import { ArtifactId, AttemptId, BlockId, RunId, SessionId } from "./ids.js"

export interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly repoPath: string
  readonly cartridgeHash: string | null
  readonly createdAt: string
}

export interface RunRow {
  readonly id: RunId
  readonly projectId: string
  readonly prompt: string
  readonly status: RunStatus
  readonly baseCommit: string | null
  readonly worktreePath: string | null
  readonly branch: string | null
  readonly targetBranch: string | null
  readonly cartridgeHash: string | null
  readonly canonicalSessionId: SessionId | null
  readonly createdAt: string
  readonly finishedAt: string | null
}

export interface BlockRow {
  readonly id: BlockId
  readonly runId: RunId
  readonly defId: string
  readonly kind: BlockKind
  readonly status: BlockStatus
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export interface AttemptRow {
  readonly id: AttemptId
  readonly runId: RunId
  readonly blockId: BlockId
  readonly number: number
  readonly sessionId: SessionId | null
  readonly verdict: AttemptVerdict | null
  /** Reserved by contracts §10; the engine keeps results in artifacts and ResultProduced events. */
  readonly resultJson: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

export interface ArtifactRow {
  readonly id: ArtifactId
  readonly runId: RunId
  readonly kind: string
  readonly path: string
  readonly bytes: number
  readonly createdAt: string
}

/**
 * The read side of the journal's tables, for the API. Writes stay with Journal — projects are the
 * exception, being registration rather than run state, so no event narrates them.
 */
export class Store extends Context.Tag("cockpit/Store")<
  Store,
  {
    readonly projects: Effect.Effect<ReadonlyArray<ProjectRow>, JournalError>
    readonly project: (id: string) => Effect.Effect<ProjectRow | undefined, JournalError>
    readonly addProject: (input: {
      readonly name: string
      readonly repoPath: string
    }) => Effect.Effect<ProjectRow, JournalError>
    readonly runs: (projectId: string) => Effect.Effect<ReadonlyArray<RunRow>, JournalError>
    readonly run: (id: RunId) => Effect.Effect<RunRow | undefined, JournalError>
    readonly blocks: (runId: RunId) => Effect.Effect<ReadonlyArray<BlockRow>, JournalError>
    readonly attempts: (
      runId: RunId,
      blockId: BlockId,
    ) => Effect.Effect<ReadonlyArray<AttemptRow>, JournalError>
    readonly attempt: (id: AttemptId) => Effect.Effect<AttemptRow | undefined, JournalError>
    readonly artifact: (id: ArtifactId) => Effect.Effect<ArtifactRow | undefined, JournalError>
    /** The newest artifact of a kind, which is how a run's instantiated tree is found. */
    readonly latestArtifact: (
      runId: RunId,
      kind: string,
    ) => Effect.Effect<ArtifactRow | undefined, JournalError>
  }
>() {}

const asJournalError = (op: string) => (error: SqlError.SqlError) =>
  new JournalError({ op, detail: error.message })

export const StoreLive = Layer.effect(
  Store,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const projectColumns = sql`id, name, repo_path AS "repoPath",
      cartridge_hash AS "cartridgeHash", created_at AS "createdAt"`

    const runColumns = sql`id, project_id AS "projectId", prompt, status,
      base_commit AS "baseCommit", worktree_path AS "worktreePath", branch,
      target_branch AS "targetBranch",
      cartridge_hash AS "cartridgeHash", canonical_session_id AS "canonicalSessionId",
      created_at AS "createdAt", finished_at AS "finishedAt"`

    const attemptColumns = sql`id, run_id AS "runId", block_id AS "blockId", number,
      session_id AS "sessionId", verdict, result_json AS "resultJson",
      started_at AS "startedAt", finished_at AS "finishedAt"`

    const artifactColumns = sql`id, run_id AS "runId", kind, path, bytes,
      created_at AS "createdAt"`

    return {
      projects: sql<ProjectRow>`
        SELECT ${projectColumns} FROM projects ORDER BY created_at DESC`.pipe(
        Effect.mapError(asJournalError("projects")),
      ),

      project: (id) =>
        sql<ProjectRow>`SELECT ${projectColumns} FROM projects WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.mapError(asJournalError("project")),
        ),

      addProject: (input) =>
        Effect.gen(function* () {
          const row: ProjectRow = {
            id: randomUUID(),
            name: input.name,
            repoPath: input.repoPath,
            cartridgeHash: null,
            createdAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
          }
          yield* sql`
            INSERT INTO projects (id, name, repo_path, created_at)
            VALUES (${row.id}, ${row.name}, ${row.repoPath}, ${row.createdAt})`
          return row
        }).pipe(Effect.mapError(asJournalError("addProject"))),

      runs: (projectId) =>
        sql<RunRow>`
          SELECT ${runColumns} FROM runs WHERE project_id = ${projectId}
          ORDER BY created_at DESC, rowid DESC`.pipe(Effect.mapError(asJournalError("runs"))),

      run: (id) =>
        sql<RunRow>`SELECT ${runColumns} FROM runs WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.mapError(asJournalError("run")),
        ),

      blocks: (runId) =>
        sql<BlockRow>`
          SELECT id, run_id AS "runId", def_id AS "defId", kind, status,
            started_at AS "startedAt", finished_at AS "finishedAt"
          FROM blocks WHERE run_id = ${runId} ORDER BY rowid`.pipe(
          Effect.mapError(asJournalError("blocks")),
        ),

      attempts: (runId, blockId) =>
        sql<AttemptRow>`
          SELECT ${attemptColumns} FROM attempts
          WHERE run_id = ${runId} AND block_id = ${blockId}
          ORDER BY number`.pipe(Effect.mapError(asJournalError("attempts"))),

      attempt: (id) =>
        sql<AttemptRow>`SELECT ${attemptColumns} FROM attempts WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.mapError(asJournalError("attempt")),
        ),

      artifact: (id) =>
        sql<ArtifactRow>`SELECT ${artifactColumns} FROM artifacts WHERE id = ${id}`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.mapError(asJournalError("artifact")),
        ),

      latestArtifact: (runId, kind) =>
        sql<ArtifactRow>`
          SELECT ${artifactColumns} FROM artifacts
          WHERE run_id = ${runId} AND kind = ${kind}
          ORDER BY rowid DESC LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]),
          Effect.mapError(asJournalError("latestArtifact")),
        ),
    }
  }),
)
