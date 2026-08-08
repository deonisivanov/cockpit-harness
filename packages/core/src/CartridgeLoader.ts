import { FileSystem } from "@effect/platform"
import { Context, Duration, Effect, Layer, Ref, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { glob, readFile, realpath } from "node:fs/promises"
import { createJiti } from "jiti"
import * as NodePath from "node:path"
import { Cartridge } from "./cartridge.js"
import { CartridgeError } from "./errors.js"
import { BlockDef } from "./workflow.js"

const cartridgeDir = ".cockpit"
const cartridgeFile = "cockpit.config.ts"

/**
 * Catches a load that stalls on something asynchronous. It is not the enforcement of "a cartridge
 * does no IO while loading" (contracts §11): synchronous IO or a busy loop blocks the fiber and
 * runs to completion regardless. Cartridge code runs with the daemon's own privileges by design
 * (ADR-007), so that rule is upheld by review, not by this timeout.
 */
const loadTimeout = Duration.seconds(10)

export interface LoadedCartridge {
  readonly config: Cartridge
  /**
   * sha256 over every source under `.cockpit`, recorded with every run for reproducibility. A
   * cartridge that imports from outside `.cockpit` is neither hashed nor watched through it.
   */
  readonly hash: string
  readonly path: string
}

export class CartridgeLoader extends Context.Tag("cockpit/CartridgeLoader")<
  CartridgeLoader,
  { readonly load: (repoPath: string) => Effect.Effect<LoadedCartridge, CartridgeError> }
>() {}

const decode = Schema.decodeUnknown(Cartridge, { errors: "all" })

const failed = (stage: "load" | "validate", path: string, detail: string) =>
  new CartridgeError({ stage, detail: `${path}: ${detail}` })

const escapes = (root: string, file: string) => !file.startsWith(root + NodePath.sep)

/**
 * Core does the reading: cartridge code performs no IO at load time (ADR-007). Containment is
 * checked on the real paths too, so a symlink out of `.cockpit` is refused rather than read from
 * somewhere neither hashed nor watched.
 */
const resolvePrompt = (dir: string, path: string, block: BlockDef) => {
  if (block.promptFile === undefined) return Effect.succeed(block)
  const { promptFile, ...rest } = block
  return Effect.tryPromise({
    try: async (): Promise<BlockDef> => {
      const file = NodePath.resolve(dir, promptFile)
      // Lexically first, so a path that both escapes and does not exist is reported as the escape
      // it is rather than as a missing file.
      if (escapes(dir, file)) throw new Error(`escapes ${cartridgeDir}`)
      const [root, real] = await Promise.all([realpath(dir), realpath(file)])
      if (escapes(root, real)) throw new Error(`escapes ${cartridgeDir} through a symlink`)
      return { ...rest, promptTemplate: await readFile(real, "utf8") }
    },
    catch: (cause) =>
      failed(
        "validate",
        path,
        `promptFile ${promptFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  })
}

const resolvePrompts = (dir: string, path: string, config: Cartridge) =>
  config.blocks === undefined
    ? Effect.succeed(config)
    : Effect.forEach(config.blocks, (block) => resolvePrompt(dir, path, block)).pipe(
        Effect.map((blocks): Cartridge => ({ ...config, blocks })),
      )

export const CartridgeLoaderLive = Layer.scoped(
  CartridgeLoader,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    // The watchers outlive any single load, so they are forked into the layer's scope and torn
    // down with the daemon rather than with whoever happened to ask first.
    const scope = yield* Effect.scope
    const cached = yield* Ref.make(new Map<string, LoadedCartridge>())
    const stale = yield* Ref.make(new Set<string>())
    const watched = yield* Ref.make(new Set<string>())

    const markStale = (repoPath: string, dirty: boolean) =>
      Ref.update(stale, (paths) => {
        const next = new Set(paths)
        if (dirty) next.add(repoPath)
        else next.delete(repoPath)
        return next
      })

    // Reload is lazy: the watcher only marks the path dirty, so a burst of editor writes costs one
    // reload on the next access instead of one per event.
    const watch = (dir: string, repoPath: string) =>
      Effect.gen(function* () {
        const already = yield* Ref.getAndUpdate(watched, (paths) => new Set(paths).add(dir))
        if (already.has(dir)) return
        // A watch that never started, or that died, gives its claim back, so the next load arms it
        // again instead of serving a cache nothing will ever mark stale.
        const release = Ref.update(watched, (paths) => {
          const next = new Set(paths)
          next.delete(dir)
          return next
        })
        yield* fs
          .watch(dir, { recursive: true })
          .pipe(
            Stream.runForEach(() => markStale(repoPath, true)),
            Effect.ignoreLogged,
            Effect.ensuring(release),
            Effect.forkIn(scope),
          )
      })

    /**
     * Every file under `.cockpit`, sorted, so the digest is reproducible: a cartridge is a
     * directory, and an edited prompt changes what a run does as much as an edited block.
     * `node_modules` is where the kit is linked, and an installed tree there would put a package
     * manifest in every run's digest.
     */
    const hashSources = (dir: string) =>
      Effect.tryPromise({
        try: async () => {
          const sources: string[] = []
          for await (const entry of glob("**/*", {
            cwd: dir,
            withFileTypes: true,
            exclude: (entry) => entry.name === "node_modules",
          }))
            // Not `isFile`: readdir reports a symlinked source as a link, and readFile follows it.
            if (!entry.isDirectory())
              sources.push(NodePath.relative(dir, NodePath.join(entry.parentPath, entry.name)))
          sources.sort()
          const digest = createHash("sha256")
          for (const source of sources) {
            const content = await readFile(NodePath.join(dir, source))
            // Length-prefixed: concatenating path and content lets one file's bytes imitate the
            // next file's name, so two different cartridges could digest the same.
            digest.update(`${source}\0${content.byteLength}\0`)
            digest.update(content)
          }
          return digest.digest("hex")
        },
        catch: (cause) => failed("load", dir, String(cause)),
      })

    const evaluate = (path: string) =>
      Effect.tryPromise({
        // moduleCache off so a reload after an edit re-evaluates instead of returning the value
        // jiti already has in memory.
        try: () =>
          createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(path, {
            default: true,
          }),
        catch: (cause) =>
          failed("load", path, cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.timeoutFail({
          duration: loadTimeout,
          onTimeout: () =>
            failed(
              "load",
              path,
              `did not finish loading within ${Duration.toMillis(loadTimeout)}ms; a cartridge is expected to be data and pure functions, not work`,
            ),
        }),
      )

    const loadFresh = (repoPath: string, dir: string, path: string) =>
      Effect.gen(function* () {
        // Cleared before the read rather than after it: an edit landing mid-load marks the path
        // again, so the next access reloads instead of serving a cartridge that never matched the
        // directory it was hashed from. A load that fails re-marks it for the same reason.
        yield* markStale(repoPath, false)
        const exported = yield* evaluate(path)
        const decoded = yield* decode(exported).pipe(
          Effect.mapError((error) => failed("validate", path, error.message)),
        )
        const config = yield* resolvePrompts(dir, path, decoded)
        const loaded: LoadedCartridge = { config, hash: yield* hashSources(dir), path }
        yield* Ref.update(cached, (entries) => new Map(entries).set(repoPath, loaded))
        return loaded
      }).pipe(Effect.tapError(() => markStale(repoPath, true)))

    return {
      load: (repoPath: string) =>
        Effect.gen(function* () {
          const dir = NodePath.join(repoPath, cartridgeDir)
          // Armed before the read, so an edit landing mid-load is not lost in the gap between them.
          yield* watch(dir, repoPath)
          const entry = (yield* Ref.get(cached)).get(repoPath)
          const dirty = (yield* Ref.get(stale)).has(repoPath)
          return entry !== undefined && !dirty
            ? entry
            : yield* loadFresh(repoPath, dir, NodePath.join(dir, cartridgeFile))
        }),
    }
  }),
)
