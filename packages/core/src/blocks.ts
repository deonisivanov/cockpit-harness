import { BlockDef, RetryPolicy } from "./workflow.js"

const minute = 60_000

/** One attempt: for blocks a template wraps in its own loop, and for anything not worth retrying. */
export const singleAttemptPolicy: RetryPolicy = {
  id: "single-attempt",
  maxAttempts: 1,
  loopTimeoutMs: 10 * minute,
  retryable: ["technical"],
  nonRetryable: [],
  backoff: { initialMs: 500, factor: 2, maxMs: 10_000 },
  noProgress: { sameFailureSignatureLimit: 2 },
  checkpointEachAttempt: true,
  onRetry: "continue",
  contextBudgetChars: 8_000,
}

/** The implement/verify shape: keep the worktree, feed the next attempt what the last one broke. */
export const correctivePolicy: RetryPolicy = {
  ...singleAttemptPolicy,
  id: "corrective",
  maxAttempts: 3,
  loopTimeoutMs: 30 * minute,
}

export const agentTask: BlockDef = {
  id: "agent-task",
  kind: "agent",
  title: "Carry out the task in the worktree",
  input: [],
  output: [{ name: "summary", type: "string", required: true }],
  provider: "claude-code",
  sessionPolicy: "fresh",
  retryPolicy: singleAttemptPolicy.id,
  timeoutMs: 10 * minute,
  permissionProfile: "workspace-write",
  workspaceAccess: "write",
  successCriteria: [],
  fallback: { _tag: "Fail" },
}

export const verifyOutput: BlockDef = {
  id: "verify-output",
  kind: "agent",
  title: "Verify the work against the task",
  input: [{ name: "summary", type: "string", required: true }],
  output: [
    { name: "passed", type: "boolean", required: true },
    { name: "findings", type: "array", required: true },
  ],
  provider: "claude-code",
  sessionPolicy: "fresh",
  retryPolicy: singleAttemptPolicy.id,
  timeoutMs: 10 * minute,
  permissionProfile: "read-only",
  workspaceAccess: "read",
  successCriteria: [
    {
      id: "verification-passed",
      description: "the verifier reports that the work satisfies the task",
      path: ["passed"],
      comparator: "eq",
      value: true,
    },
  ],
  fallback: { _tag: "Fail" },
}

/** The argv belongs to whoever knows the project, so every use overrides it. */
export const runCommand: BlockDef = {
  id: "run-command",
  kind: "command",
  title: "Run a project command",
  input: [],
  output: [
    { name: "success", type: "boolean", required: true },
    { name: "exitCode", type: "number", required: false },
  ],
  sessionPolicy: "fresh",
  retryPolicy: singleAttemptPolicy.id,
  timeoutMs: 5 * minute,
  permissionProfile: "workspace-write",
  workspaceAccess: "write",
  successCriteria: [],
  fallback: { _tag: "Fail" },
}

export const coreBlocks: ReadonlyArray<BlockDef> = [agentTask, verifyOutput, runCommand]

export const coreRetryPolicies: ReadonlyArray<RetryPolicy> = [singleAttemptPolicy, correctivePolicy]
