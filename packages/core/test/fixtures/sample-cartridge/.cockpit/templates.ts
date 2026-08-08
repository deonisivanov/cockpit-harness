import { blockId, type PluginBinding, type WorkflowTemplate } from "@cockpit/cartridge-kit"
import { implement } from "./blocks/implement.js"
import { lint } from "./blocks/lint.js"

export const houseStyle: PluginBinding = {
  entry: { kind: "slash", name: "review" },
  requiredCapabilities: [],
  managesInternalRetries: false,
  cancellation: "kill-tree",
}

export const lintFix: WorkflowTemplate = {
  id: "lint-fix",
  description: "Fix the lint failures the project's linter reports, then run it again.",
  tree: {
    _tag: "Loop",
    body: {
      _tag: "Sequence",
      children: [
        { _tag: "Block", id: blockId("implement"), def: implement.id },
        { _tag: "Block", id: blockId("lint-check"), def: lint.id },
      ],
    },
    policy: "corrective",
    kind: "corrective",
    feedbackRoute: { from: blockId("lint-check"), to: blockId("implement") },
  },
  params: [],
  optionalBlocks: [],
  allowedBindings: { implement: [houseStyle] },
  retryBounds: { implement: { min: 1, max: 3 } },
}
