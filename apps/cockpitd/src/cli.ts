#!/usr/bin/env node
import type { ProjectRow } from "@cockpit/core"
import * as NodePath from "node:path"
import { parseArgs } from "node:util"

const usage = `Usage:
  cockpit add [path] [--name <name>]   register a project with the running daemon
  cockpit projects                     list registered projects

Environment:
  COCKPIT_PORT   daemon port (default 4177)
`

// Function declarations, not const arrows: only these let TS's control-flow analysis treat a
// call to a "never"-returning function as terminating the branch, which the callers below rely on.
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function failUsage(message: string): never {
  console.error(message)
  console.error()
  console.error(usage.trimEnd())
  process.exit(1)
}

const rawPort = process.env.COCKPIT_PORT ?? "4177"
const port = Number(rawPort)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  fail(`error: invalid COCKPIT_PORT "${rawPort}"`)
}
const base = `http://127.0.0.1:${port}`

const requestTimeoutMs = 10_000

interface Problem {
  readonly error: string
  readonly detail?: string
}

const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
  try {
    return await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  } catch (cause) {
    // AbortSignal.timeout throws a DOMException, not the TypeError a socket-level failure wraps.
    if (cause instanceof Error && cause.name === "TimeoutError") {
      fail(`daemon at ${base} did not respond within ${requestTimeoutMs / 1000}s`)
    }
    const code = (cause as { cause?: { code?: string } }).cause?.code
    if (code === "ECONNREFUSED") {
      fail("daemon is not running — start it with `pnpm start`")
    }
    // Catch-all so no fetch failure (ECONNRESET, a bad address, …) escapes as an uncaught rejection.
    fail(`cannot reach the daemon at ${base}: ${code ?? (cause as Error).message}`)
  }
}

const problem = (body: Problem) => `error: ${body.error}${body.detail === undefined ? "" : ` — ${body.detail}`}`

const add = async (args: ReadonlyArray<string>) => {
  const parsed = (() => {
    try {
      return parseArgs({ args, options: { name: { type: "string" } }, allowPositionals: true })
    } catch (cause) {
      return failUsage(`error: ${(cause as Error).message}`)
    }
  })()
  const { values, positionals } = parsed
  if (positionals.length > 1) {
    fail(`error: expected at most one path, got ${positionals.length}`)
  }
  const repoPath = NodePath.resolve(positionals[0] ?? process.cwd())
  const name = values.name ?? NodePath.basename(repoPath)

  const response = await request("POST", "/api/projects", { name, repoPath })
  const body = (await response.json()) as ProjectRow | Problem
  if (!response.ok) fail(problem(body as Problem))
  const project = body as ProjectRow
  console.log(`added ${project.name} (${project.id}) at ${project.repoPath}`)
}

const projects = async () => {
  const response = await request("GET", "/api/projects")
  const body = (await response.json()) as ReadonlyArray<ProjectRow> | Problem
  if (!response.ok) fail(problem(body as Problem))
  const rows = body as ReadonlyArray<ProjectRow>
  if (rows.length === 0) {
    console.log("no projects registered")
    return
  }
  const idWidth = Math.max(2, ...rows.map((row) => row.id.length))
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length))
  console.log(`${"id".padEnd(idWidth)}  ${"name".padEnd(nameWidth)}  repoPath`)
  for (const row of rows) {
    console.log(`${row.id.padEnd(idWidth)}  ${row.name.padEnd(nameWidth)}  ${row.repoPath}`)
  }
}

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case undefined:
    failUsage("error: a command is required")
    break
  case "--help":
  case "-h":
  case "help":
    console.log(usage)
    break
  case "add":
    await add(rest)
    break
  case "projects":
    await projects()
    break
  default:
    failUsage(`error: unknown command: ${command}`)
}
