import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { ArtifactStore, Journal, RunId, Store } from "../src/index.js"
import { runEngine, tempHome } from "./helpers.js"

const runId = RunId.make("run-artifact-binary")

const seed = Effect.gen(function* () {
  const store = yield* Store
  const journal = yield* Journal
  const project = yield* store.addProject({ name: "sample", repoPath: "/tmp/sample" })
  yield* journal.createRun({ runId, projectId: project.id, prompt: "attach things" })
})

it("writes binary content byte-identical and keeps a placeholder excerpt", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f])
  const home = await tempHome()
  const { ref, row } = await runEngine(
    home,
    Effect.gen(function* () {
      yield* seed
      const artifacts = yield* ArtifactStore
      const ref = yield* artifacts.write({
        runId,
        kind: "attachment",
        name: "shot.png",
        content: bytes,
      })
      const store = yield* Store
      return { ref, row: yield* store.artifact(ref.id) }
    }),
  )
  expect(new Uint8Array(readFileSync(ref.path))).toEqual(bytes)
  expect(ref.bytes).toBe(bytes.byteLength)
  expect(ref.excerpt).toBe(`[binary ${bytes.byteLength} bytes]`)
  expect(row?.bytes).toBe(bytes.byteLength)
})

it("keeps string content behavior unchanged", async () => {
  const home = await tempHome()
  const ref = await runEngine(
    home,
    Effect.gen(function* () {
      yield* seed
      const artifacts = yield* ArtifactStore
      return yield* artifacts.write({
        runId,
        kind: "note",
        name: "note.md",
        content: "# hello",
      })
    }),
  )
  expect(readFileSync(ref.path, "utf8")).toBe("# hello")
  expect(ref.excerpt).toBe("# hello")
})
