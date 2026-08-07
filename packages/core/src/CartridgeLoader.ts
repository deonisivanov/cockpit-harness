import { FileSystem } from "@effect/platform"
import { Context, Duration, Effect, Layer, Ref, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { glob, readFile } from "node:fs/promises"
import { createJiti } from "jiti"
import * as NodePath from "node:path"
import { Cartridge } from "./cartridge.js"
import { CartridgeError } from "./errors.js"

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
   * sha256 over every `.cockpit/**\/*.ts` file, recorded with every run for reproducibility. A
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
            Stream.runForEach(() => Ref.update(stale, (paths) => new Set(paths).add(repoPath))),
            Effect.ignoreLogged,
            Effect.ensuring(release),
            Effect.forkIn(scope),
          )
      })

    /** Every source the cartridge is built from, in a stable order, so the digest is reproducible. */
    const hashSources = (dir: string) =>
      Effect.tryPromise({
        try: async () => {
          const sources: string[] = []
          for await (const match of glob("**/*.ts", { cwd: dir })) sources.push(match)
          sources.sort()
          const digest = createHash("sha256")
          for (const source of sources) {
            digest.update(source)
            digest.update(await readFile(NodePath.join(dir, source)))
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
        const exported = yield* evaluate(path)
        const config = yield* decode(exported).pipe(
          Effect.mapError((error) => failed("validate", path, error.message)),
        )
        const loaded: LoadedCartridge = { config, hash: yield* hashSources(dir), path }
        yield* Ref.update(cached, (entries) => new Map(entries).set(repoPath, loaded))
        yield* Ref.update(stale, (paths) => {
          const next = new Set(paths)
          next.delete(repoPath)
          return next
        })
        return loaded
      })

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
