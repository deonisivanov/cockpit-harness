#!/usr/bin/env node
// Stand-in for the herdr CLI, selected with COCKPIT_HERDR_BIN. It answers the subcommands
// HerdrClient uses with the shapes `herdr api schema` documents, and records every call so a test
// can assert what would have reached the real socket. COCKPIT_FAKE_HERDR_DOWN=1 plays a stopped
// server; COCKPIT_FAKE_HERDR_PROTOCOL overrides the protocol it claims to speak.

import { appendFileSync } from "node:fs"

const argv = process.argv.slice(2)
const log = process.env.COCKPIT_FAKE_HERDR_LOG
if (log !== undefined) appendFileSync(log, `${JSON.stringify(argv)}\n`)

const answer = (body) => {
  process.stdout.write(`${JSON.stringify(body)}\n`)
  process.exit(0)
}

if (argv[0] === "status") {
  answer(
    process.env.COCKPIT_FAKE_HERDR_DOWN === "1"
      ? { status: "stopped", running: false }
      : {
          status: "running",
          running: true,
          version: "0.7.5",
          protocol: Number(process.env.COCKPIT_FAKE_HERDR_PROTOCOL ?? 17),
        },
  )
}

if (argv[0] === "tab" && argv[1] === "create") {
  answer({
    id: "cli:tab:create",
    result: {
      type: "tab_created",
      tab: { tab_id: "w1:t9", workspace_id: "w1" },
      root_pane: { pane_id: "w1:t9:p1" },
    },
  })
}

if (argv[0] === "agent" && argv[1] === "start") {
  if (process.env.COCKPIT_FAKE_HERDR_START_FAIL === "1") {
    process.stderr.write("no agent was detected in pane w1:t9:p1 before the timeout\n")
    process.exit(1)
  }
  answer({ id: "cli:agent:start", result: { type: "ok", status: "idle" } })
}

process.stderr.write(`fake herdr: unexpected ${argv.join(" ")}\n`)
process.exit(2)
