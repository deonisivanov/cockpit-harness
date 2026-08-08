import { defineCartridge } from "@cockpit/cartridge-kit"
import { implement } from "./blocks/implement.js"
import { lint } from "./blocks/lint.js"
import { houseStyle, lintFix } from "./templates.js"
import { appendLint } from "./transforms.js"
import { noNestedLoops } from "./validators.js"

export default defineCartridge({
  name: "sample",
  environment: {
    healthChecks: [{ argv: ["node", "--version"], timeoutMs: 30_000 }],
  },
  blocks: [lint, implement],
  templates: [lintFix],
  prompts: { house: "Match the surrounding code; comments only where a why is not obvious." },
  commands: { lint: { argv: ["node", "--version"] } },
  transforms: [{ name: "append-lint", apply: appendLint }],
  validators: [{ name: "no-nested-loops", check: noNestedLoops }],
  bindings: [houseStyle],
  rules: { comments: "as few as possible", language: "English" },
})
