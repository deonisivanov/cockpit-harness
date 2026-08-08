#!/usr/bin/env node
// Stand-in for macOS `open`, selected with COCKPIT_OPEN_BIN, so the Ghostty fallback can be
// asserted without a window ever appearing. COCKPIT_FAKE_OPEN_FAIL=1 plays a missing Ghostty.

import { appendFileSync } from "node:fs"

const argv = process.argv.slice(2)
const log = process.env.COCKPIT_FAKE_OPEN_LOG
if (log !== undefined) appendFileSync(log, `${JSON.stringify(argv)}\n`)

if (process.env.COCKPIT_FAKE_OPEN_FAIL === "1") {
  process.stderr.write("Unable to find application named 'Ghostty.app'\n")
  process.exit(1)
}
