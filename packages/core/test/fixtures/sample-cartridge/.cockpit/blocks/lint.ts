import { type BlockDef } from "@cockpit/cartridge-kit"

export const lint: BlockDef = {
  id: "sample-lint",
  kind: "command",
  title: "Run the project linter",
  input: [],
  output: [{ name: "success", type: "boolean", required: true }],
  command: { argv: ["node", "--version"] },
  sessionPolicy: "fresh",
  retryPolicy: "single-attempt",
  timeoutMs: 60_000,
  permissionProfile: "workspace-write",
  workspaceAccess: "write",
  successCriteria: [],
  fallback: { _tag: "Fail" },
}
