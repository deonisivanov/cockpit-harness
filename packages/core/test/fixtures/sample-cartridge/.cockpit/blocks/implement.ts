import { type BlockDef } from "@cockpit/cartridge-kit"

export const implement: BlockDef = {
  id: "sample-implement",
  kind: "agent",
  title: "Fix what the linter reported",
  input: [],
  output: [{ name: "summary", type: "string", required: true }],
  provider: "claude-code",
  // Resolved against `.cockpit`, not against this file.
  promptFile: "./prompts/implement.md",
  sessionPolicy: "fresh",
  retryPolicy: "single-attempt",
  timeoutMs: 600_000,
  permissionProfile: "workspace-write",
  workspaceAccess: "write",
  successCriteria: [],
  fallback: { _tag: "Fail" },
}
