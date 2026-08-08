import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { shellLine } from "../src/index.js"

const sh = promisify(execFile)

// `herdr pane run` hands this line to an interactive shell, so the proof is a real shell reading
// it back — a fake receiving argv over execve can never observe a tokenization bug.
it("round-trips a hostile argv through a real shell byte-identically", async () => {
  const words = [
    "Cockpit's",
    "two words",
    "$HOME",
    "`whoami`",
    "a;b",
    '"double"',
    "back\\slash",
    "*glob?",
  ]
  const { stdout } = await sh("sh", ["-c", shellLine(["printf", "%s\\n", ...words])])
  expect(stdout).toBe(words.map((word) => `${word}\n`).join(""))
})
