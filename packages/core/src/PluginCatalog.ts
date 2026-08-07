import { Config, Context, Effect, Layer, Ref } from "effect"
import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import * as NodePath from "node:path"
import { promisify } from "node:util"
import { PreflightError } from "./errors.js"
import { PluginEntry } from "./events.js"
import { ProviderName, record } from "./Provider.js"
import { PluginBinding } from "./workflow.js"

const run = promisify(execFile)

const claudeConfigDir = Config.string("CLAUDE_CONFIG_DIR").pipe(
  Config.withDefault(NodePath.join(homedir(), ".claude")),
)

const claudeBinary = Config.string("COCKPIT_CLAUDE_BIN").pipe(Config.withDefault("claude"))
const codexBinary = Config.string("COCKPIT_CODEX_BIN").pipe(Config.withDefault("codex"))

const versionProbeMs = 10_000

export interface InstalledPlugin {
  readonly name: string
  readonly marketplace: string
  readonly version: string
  readonly installPath: string
  readonly enabled: boolean
  /** Entry ids the install directory actually provides, as `slash:name` / `skill:name` / `agent:name`. */
  readonly capabilities: ReadonlyArray<string>
}

/** Contracts §5: what is recorded on the run so a result can be reproduced. */
export interface PreflightResult {
  readonly provider: { readonly name: ProviderName; readonly version?: string }
  readonly plugin?: { readonly name: string; readonly version: string }
  readonly entry?: PluginEntry
  readonly capabilities: ReadonlyArray<string>
}

export class PluginCatalog extends Context.Tag("cockpit/PluginCatalog")<
  PluginCatalog,
  {
    readonly plugins: Effect.Effect<ReadonlyArray<InstalledPlugin>>
    readonly providerVersion: (provider: ProviderName) => Effect.Effect<string | undefined>
    readonly preflight: (input: {
      readonly provider: ProviderName
      readonly binding?: PluginBinding
    }) => Effect.Effect<PreflightResult, PreflightError>
  }
>() {}

const capabilityId = (entry: PluginEntry) => `${entry.kind}:${entry.name}`

/**
 * Numeric-segment comparison, which is what plugin versions on this machine actually look like
 * (`4.15.6`, `1.0.0`). A version that carries no digits — some marketplaces install by commit sha —
 * cannot be ordered, and a binding that demands a minimum is refused rather than guessed at.
 * Prereleases sort below the release they lead to, but not against each other: `1.0.0-beta` is
 * under `1.0.0`, while `1.0.0-alpha` and `1.0.0-beta` are treated as the same version.
 */
export const atLeastVersion = (installed: string, minimum: string) => {
  const parse = (value: string) => {
    const [release = "", ...prerelease] = value.split("-")
    return {
      parts: release.split(/[^0-9]+/).flatMap((part) => (part === "" ? [] : [Number(part)])),
      released: prerelease.length === 0,
    }
  }
  const left = parse(installed)
  const right = parse(minimum)
  if (left.parts.length === 0 || right.parts.length === 0) return false
  for (let index = 0; index < Math.max(left.parts.length, right.parts.length); index += 1) {
    const a = left.parts[index] ?? 0
    const b = right.parts[index] ?? 0
    if (a !== b) return a > b
  }
  return left.released || !right.released
}

const fields = (value: unknown) => record(value) ?? {}

/** A config file Cockpit does not own: unreadable or malformed reads as "nothing installed". */
const json = async (path: string) => {
  try {
    return fields(JSON.parse(await readFile(path, "utf8")))
  } catch {
    return {}
  }
}

const entries = async (dir: string, kind: "file" | "dir") => {
  try {
    const found = await readdir(dir, { withFileTypes: true })
    return found.flatMap((item) =>
      kind === "dir"
        ? item.isDirectory()
          ? [item.name]
          : []
        : item.isFile() && item.name.endsWith(".md")
          ? [item.name.slice(0, -".md".length)]
          : [],
    )
  } catch {
    return []
  }
}

/**
 * Best-effort against the layout Claude Code 2.x keeps on disk: top-level `commands/*.md`,
 * `skills/<name>/` and `agents/*.md` inside each install directory. Nested command namespaces are
 * not walked, so a binding to one fails preflight as a missing entry rather than being accepted.
 */
const capabilitiesOf = async (installPath: string) => {
  const [slash, skill, agent] = await Promise.all([
    entries(NodePath.join(installPath, "commands"), "file"),
    entries(NodePath.join(installPath, "skills"), "dir"),
    entries(NodePath.join(installPath, "agents"), "file"),
  ])
  return [
    ...slash.map((name) => capabilityId({ kind: "slash", name })),
    ...skill.map((name) => capabilityId({ kind: "skill", name })),
    ...agent.map((name) => capabilityId({ kind: "agent", name })),
  ]
}

const discover = async (configDir: string): Promise<ReadonlyArray<InstalledPlugin>> => {
  const installed = fields(
    (await json(NodePath.join(configDir, "plugins", "installed_plugins.json"))).plugins,
  )
  const enabled = fields((await json(NodePath.join(configDir, "settings.json"))).enabledPlugins)

  const found = await Promise.all(
    Object.entries(installed).map(async ([key, value]) => {
      // One plugin can be installed at several scopes; only the first is read, which is the one
      // Claude Code itself resolves to.
      const install = fields(Array.isArray(value) ? value[0] : value)
      const installPath = install.installPath
      const version = install.version
      if (typeof installPath !== "string" || typeof version !== "string") return []
      const [name, marketplace = ""] = key.split("@")
      return [
        {
          name,
          marketplace,
          version,
          installPath,
          enabled: enabled[key] !== false,
          capabilities: await capabilitiesOf(installPath),
        } satisfies InstalledPlugin,
      ]
    }),
  )
  return found.flat()
}

export const PluginCatalogLive = Layer.effect(
  PluginCatalog,
  Effect.gen(function* () {
    const configDir = yield* claudeConfigDir
    const claudeBin = yield* claudeBinary
    const codexBin = yield* codexBinary

    // Both scans are cached for the daemon's lifetime (plan §6): a probe per block would spawn a
    // process per block, and neither the installed set nor the CLI version moves under a daemon.
    const installs = yield* Effect.cached(Effect.promise(() => discover(configDir)))
    const versions = yield* Ref.make(new Map<ProviderName, string | undefined>())

    const probe = (provider: ProviderName) =>
      Effect.gen(function* () {
        const known = yield* Ref.get(versions)
        if (known.has(provider)) return known.get(provider)
        const binary = provider === "codex" ? codexBin : claudeBin
        const version = yield* Effect.tryPromise(() =>
          run(binary, ["--version"], { timeout: versionProbeMs }),
        ).pipe(
          Effect.map(({ stdout }) => stdout.trim().split("\n")[0]?.trim()),
          Effect.orElseSucceed(() => undefined),
        )
        yield* Ref.update(versions, (current) => new Map(current).set(provider, version))
        return version
      })

    // A binding names a plugin the way a user does. `name@marketplace` picks one install exactly;
    // a bare name matches on the name alone and takes the first enabled install that carries it.
    const find = (name: string) =>
      Effect.map(installs, (all) => {
        const enabled = all.filter((plugin) => plugin.enabled)
        return (
          enabled.find((plugin) => `${plugin.name}@${plugin.marketplace}` === name) ??
          enabled.find((plugin) => plugin.name === name)
        )
      })

    const preflight = (input: {
      readonly provider: ProviderName
      readonly binding?: PluginBinding
    }) =>
      Effect.gen(function* () {
        const version = yield* probe(input.provider)
        if (version === undefined) {
          return yield* new PreflightError({
            reason: "provider-unavailable",
            detail: `${input.provider} did not answer --version; the CLI must be installed and authorized`,
          })
        }
        const provider = { name: input.provider, version }
        const { binding } = input
        if (binding === undefined) {
          return { provider, capabilities: [] } satisfies PreflightResult
        }

        // A binding without a plugin is a bare provider session with an instruction, so there is
        // no catalog entry to resolve against.
        if (binding.plugin === undefined) {
          return { provider, entry: binding.entry, capabilities: [] } satisfies PreflightResult
        }

        const plugin = yield* find(binding.plugin)
        if (plugin === undefined) {
          return yield* new PreflightError({
            reason: "plugin-missing",
            detail: `plugin ${binding.plugin} is not installed or not enabled`,
          })
        }
        if (binding.minVersion !== undefined && !atLeastVersion(plugin.version, binding.minVersion)) {
          return yield* new PreflightError({
            reason: "version-incompatible",
            detail: `plugin ${plugin.name} is ${plugin.version}, which does not satisfy the required ${binding.minVersion}`,
          })
        }
        const wanted = capabilityId(binding.entry)
        if (!plugin.capabilities.includes(wanted)) {
          return yield* new PreflightError({
            reason: "entry-missing",
            detail: `plugin ${plugin.name} ${plugin.version} provides no ${binding.entry.kind} named ${binding.entry.name}`,
          })
        }
        const missing = binding.requiredCapabilities.filter(
          (capability) => !plugin.capabilities.includes(capability),
        )
        if (missing.length > 0) {
          return yield* new PreflightError({
            reason: "permission-missing",
            detail: `plugin ${plugin.name} ${plugin.version} is missing required capabilities: ${missing.join(", ")}`,
          })
        }

        return {
          provider,
          plugin: { name: plugin.name, version: plugin.version },
          entry: binding.entry,
          capabilities: [wanted, ...binding.requiredCapabilities],
        } satisfies PreflightResult
      })

    return { plugins: installs, providerVersion: probe, preflight }
  }),
)
