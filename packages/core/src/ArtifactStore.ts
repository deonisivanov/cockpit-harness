import { Context, Effect, Layer } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import * as NodePath from "node:path"
import { cockpitHome } from "./config.js"
import { JournalError } from "./errors.js"
import { ArtifactId, AttemptId, BlockId, RunId } from "./ids.js"
import { Journal } from "./Journal.js"
import { clip } from "./text.js"
import { ArtifactRef } from "./workflow.js"

const excerptChars = 2_000

export interface WriteArtifactInput {
  readonly runId: RunId
  readonly blockId?: BlockId
  readonly attemptId?: AttemptId
  readonly kind: string
  /** File name suffix; the artifact id keeps two writes of the same name apart. */
  readonly name: string
  readonly content: string
}

export class ArtifactStore extends Context.Tag("cockpit/ArtifactStore")<
  ArtifactStore,
  {
    readonly write: (input: WriteArtifactInput) => Effect.Effect<ArtifactRef, JournalError>
    readonly runDir: (runId: RunId) => Effect.Effect<string, JournalError>
  }
>() {}

export const ArtifactStoreLive = Layer.effect(
  ArtifactStore,
  Effect.gen(function* () {
    const home = yield* cockpitHome
    const journal = yield* Journal
    const root = NodePath.join(home, "runs")

    /** A run id is only ever one path segment; one that climbs out of the root must never be written to. */
    const runDir = (runId: RunId) => {
      const dir = NodePath.resolve(root, runId)
      return dir.startsWith(root + NodePath.sep)
        ? Effect.succeed(dir)
        : Effect.fail(new JournalError({ op: "runDir", detail: `run ${runId} escapes ${root}` }))
    }

    return {
      runDir,

      write: (input) =>
        Effect.gen(function* () {
          const artifactId = ArtifactId.make(randomUUID())
          const dir = yield* runDir(input.runId)
          const path = NodePath.join(dir, `${artifactId}-${input.name}`)
          const bytes = Buffer.byteLength(input.content)

          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(dir, { recursive: true })
              await writeFile(path, input.content)
            },
            catch: (cause) =>
              new JournalError({ op: "writeArtifact", detail: `${path}: ${String(cause)}` }),
          })

          yield* journal.recordArtifact({
            artifactId,
            runId: input.runId,
            blockId: input.blockId,
            attemptId: input.attemptId,
            kind: input.kind,
            path,
            bytes,
          })

          return {
            id: artifactId,
            path,
            kind: input.kind,
            bytes,
            excerpt: clip(input.content, excerptChars),
          } satisfies ArtifactRef
        }),
    }
  }),
)
