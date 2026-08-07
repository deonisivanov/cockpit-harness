#!/usr/bin/env node
// Spawns a grandchild into its own process group (inherited, not detached) and reports both pids.
// Neither process answers SIGTERM, so only a SIGKILL to the whole group ends them.
import { spawn } from "node:child_process"

const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  // Inheriting stdout would hold the pipe open past our own death and stall the reader.
  { stdio: "ignore" },
)

process.on("SIGTERM", () => {})
process.stdout.write(`${process.pid} ${grandchild.pid}\n`)
setInterval(() => {}, 1000)
