#!/usr/bin/env node
import type { ProjectRow } from "@cockpit/core"
import * as NodePath from "node:path"
import { parseArgs } from "node:util"

const port = Number(process.env.COCKPIT_PORT ?? 4177)
const base = `http://127.0.0.1:${port}`

const usage = `Usage:
  cockpit add [path] [--name <name>]   register a project with the running daemon
  cockpit projects                     list registered projects

Environment:
  COCKPIT_PORT   daemon port (default 4177)
`

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

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
    })
  } catch (cause) {
    const code = (cause as { cause?: { code?: string } }).cause?.code
    if (code === "ECONNREFUSED") {
      fail("daemon is not running — start it with `pnpm start`")
    }
    throw cause
  }
}

const problem = (body: Problem) => `error: ${body.error}${body.detail === undefined ? "" : ` — ${body.detail}`}`

const add = async (args: ReadonlyArray<string>) => {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: "string" } },
    allowPositionals: true,
  })
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
    console.log(usage)
    process.exit(1)
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
    console.error(`unknown command: ${command}`)
    console.log(usage)
    process.exit(1)
}
