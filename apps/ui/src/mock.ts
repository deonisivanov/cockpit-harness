import type {
  ArtifactBody,
  EventPayload,
  Insight,
  JournalEvent,
  Project,
  Run,
  RunDetail,
  RunStatus,
  WorkflowNode,
} from "./model.js"
import type { Source } from "./api.js"

export const MOCK_STATES = [
  "idle",
  "analyzing",
  "awaiting-start",
  "approval",
  "running",
  "retry",
  "question",
  "finished",
  "cancelled",
  "recovery",
  "insights",
] as const
export type MockState = (typeof MOCK_STATES)[number]

export const isMockState = (v: string | null): v is MockState =>
  v !== null && (MOCK_STATES as readonly string[]).includes(v)

const RUN = "run_7f2a91"
const PROJECT = "prj_interview"
const ESC = ""

const PROJECTS: readonly Project[] = [
  { id: PROJECT, name: "ai-interview-assistant", repoPath: "~/src/ai-interview-assistant" },
]

const TREE: WorkflowNode = {
  _tag: "Sequence",
  children: [
    { _tag: "Block", id: "explore", def: "codex" },
    {
      _tag: "Loop",
      policy: "single-attempt",
      kind: "semantic-retry",
      body: { _tag: "Block", id: "reproduce", def: "issue-reproduce" },
    },
    { _tag: "Block", id: "plan", def: "omc:plan" },
    {
      _tag: "Gate",
      id: "plan-approval",
      payload: {
        title: "plan-approval",
        summary: "Approve the implementation plan before the worktree is touched.",
        artifacts: ["art_plan"],
      },
    },
    {
      _tag: "Loop",
      policy: "corrective",
      kind: "corrective",
      feedbackRoute: { from: "verify", to: "implement" },
      body: {
        _tag: "Sequence",
        children: [
          { _tag: "Block", id: "implement", def: "implement" },
          { _tag: "Block", id: "verify", def: "verify" },
        ],
      },
    },
    {
      _tag: "Condition",
      predicate: { _tag: "Eq", path: ["visual"], value: true },
      onTrue: { _tag: "Block", id: "visual-after", def: "visual-reproduce-after" },
    },
    { _tag: "Block", id: "code-review", def: "local-duo-review" },
    { _tag: "Block", id: "finalize", def: "finalize" },
  ],
}

const ARTIFACTS: Record<string, Omit<ArtifactBody, "id">> = {
  art_plan: {
    kind: "markdown",
    path: ".cockpit-run/plan.md",
    bytes: 812,
    text: `# Plan · fix interview recovery after reconnect

1. persist the transcript cursor on every event, not every 25th flush
2. clear the memoized cursor in \`InterviewRecovery#resume\`
3. replay strictly after the cursor, deduplicating by event id
4. add a spec that kills the socket mid-stream and reconnects
5. keep the public API of \`InterviewRecovery\` unchanged

### risk

Writing the cursor per event adds one UPDATE per transcript row. Measured at 0.4 ms on the dev
dataset; behind \`ENV["CURSOR_STRICT"]\` if it regresses.

### files

\`\`\`
app/services/interview_recovery.rb
lib/transcript/stream.rb
spec/services/interview_recovery_spec.rb
\`\`\`
`,
  },
  art_prompt_impl: {
    kind: "markdown",
    path: ".cockpit-run/prompts/implement-2.md",
    bytes: 604,
    text: `## implement — attempt 2 of 3

Apply step 3 of the plan: the transcript cursor must advance with every persisted event, not every
25th flush.

### feedback from attempt 1

- attempt 1 moved the write into the channel; the spec still failed because the recovery path reads
  a memoized value
- clear the memo in \`InterviewRecovery#resume\`
`,
  },
  art_patch: {
    kind: "diff",
    path: ".cockpit-run/patches/implement-2.patch",
    bytes: 486,
    text: `--- a/app/services/interview_recovery.rb
+++ b/app/services/interview_recovery.rb
@@ -34,9 +34,14 @@ def resume(session)
     def resume(session)
       return unless session.reconnectable?

-      cursor = session.cursor
+      cursor = session.reload.cursor || last_persisted_cursor(session)
+
+      @memoized_cursor = nil

       replay_from(cursor)
     end
`,
  },
  art_packet: {
    kind: "json",
    path: ".cockpit-run/feedback/attempt-1.json",
    bytes: 412,
    text: `{
  "failed_check": "interview_recovery_spec:34",
  "expected": 8814,
  "actual": 8802,
  "hypothesis": "resume() reads a memoized cursor set before the flush",
  "keep": ["app/services/interview_recovery.rb:41"],
  "avoid": ["moving the write into InterviewChannel — tried in attempt 1"]
}`,
  },
  art_rg: {
    kind: "terminal",
    path: ".cockpit-run/output/rg.txt",
    bytes: 340,
    text: [
      `${ESC}[36mapp/channels/interview_channel.rb${ESC}[0m:${ESC}[33m48${ESC}[0m:  def handle_reconnect(data)`,
      `${ESC}[36mapp/services/interview_recovery.rb${ESC}[0m:${ESC}[33m34${ESC}[0m:    # reconnect resumes from the last persisted cursor`,
      `${ESC}[36mapp/services/interview_recovery.rb${ESC}[0m:${ESC}[33m41${ESC}[0m:      cursor = session.cursor`,
      `${ESC}[36mlib/transcript/stream.rb${ESC}[0m:${ESC}[33m112${ESC}[0m:  # NOTE: cursor is written every 25 events`,
    ].join("\r\n"),
  },
  art_rspec_fail: {
    kind: "terminal",
    path: ".cockpit-run/output/rspec-1.txt",
    bytes: 720,
    text: [
      `$ bundle exec rspec spec/services/interview_recovery_spec.rb`,
      `Randomized with seed 41922`,
      `${ESC}[32m..${ESC}[0m${ESC}[31mF${ESC}[0m${ESC}[32m...${ESC}[0m`,
      ``,
      `${ESC}[31mFailures:${ESC}[0m`,
      ``,
      `  1) InterviewRecovery#resume restores the transcript cursor after reconnect`,
      `     ${ESC}[31mFailure/Error: expect(session.cursor).to eq(last_event.id)${ESC}[0m`,
      ``,
      `       ${ESC}[32mexpected: 8814${ESC}[0m`,
      `            ${ESC}[31mgot: 8802${ESC}[0m`,
      ``,
      `${ESC}[31m6 examples, 1 failure${ESC}[0m`,
    ].join("\r\n"),
  },
  art_rspec_pass: {
    kind: "terminal",
    path: ".cockpit-run/output/rspec-2.txt",
    bytes: 380,
    text: [
      `$ bundle exec rspec spec/services/interview_recovery_spec.rb`,
      `Randomized with seed 41922`,
      `${ESC}[32m......${ESC}[0m`,
      ``,
      `Finished in 18.6 seconds (files took 3.1 seconds to load)`,
      `${ESC}[32m6 examples, 0 failures${ESC}[0m`,
    ].join("\r\n"),
  },
  art_repro: {
    kind: "markdown",
    path: ".cockpit-run/repro/interview_recovery_reconnect.md",
    bytes: 402,
    text: `# Reproduction

- start an interview, stream 30 transcript events
- kill the websocket at event 28
- reconnect → transcript replays from event 25, losing 3

\`\`\`
expected: cursor == last_event.id   got: cursor == last_flushed.id
\`\`\`
`,
  },
  art_result: {
    kind: "json",
    path: ".cockpit-run/results/implement-2.json",
    bytes: 214,
    text: `{
  "summary": "cursor now advances on every persisted transcript event",
  "files_changed": 2,
  "tests": "6 examples, 0 failures"
}`,
  },
  art_method: {
    kind: "code",
    path: "app/services/interview_recovery.rb",
    bytes: 240,
    text: `def resume(session)
  return unless session.reconnectable?

  cursor = session.reload.cursor || last_persisted_cursor(session)
  @memoized_cursor = nil

  replay_from(cursor) # emits every event after the cursor
end`,
  },
}

const START = Date.parse("2026-08-08T11:04:02.000Z")

class Builder {
  private seq = 0
  readonly events: JournalEvent[] = []

  push(payload: EventPayload, blockId?: string, attemptId?: string): void {
    this.seq += 1
    this.events.push({
      seq: this.seq,
      ts: new Date(START + this.seq * 7_000).toISOString(),
      runId: RUN,
      ...(blockId ? { blockId } : {}),
      ...(attemptId ? { attemptId } : {}),
      payload,
    })
  }
}

const PROMPT = "Fix interview recovery after reconnect"

/** The prototype's shared prelude: session, analysis, explore, reproduce, plan, checkpoint. */
function prelude(b: Builder): void {
  b.push({ _tag: "RunCreated", projectId: PROJECT, prompt: PROMPT })
  b.push({ _tag: "RunStarted" })
  b.push({
    _tag: "TreeAnalyzed",
    templateId: "bugfix-with-reproduction",
    rationale:
      "The issue body contains a stack trace and a user-visible symptom, and the repo has an rspec suite with a reproduction harness.",
    decision: { template: "bugfix-with-reproduction", visualBlocks: true, reviewLoop: true },
    fallback: false,
  })
  b.push({ _tag: "TreeValidated", errors: [] })

  b.push({ _tag: "BlockStarted", defId: "codex", kind: "agent" }, "explore")
  b.push({ _tag: "AttemptStarted", number: 1, sessionId: "sess_7f2a91c4" }, "explore", "at_ex1")
  b.push({ _tag: "SessionStarted", sessionId: "sess_7f2a91c4" }, "explore", "at_ex1")
  b.push(
    {
      _tag: "PluginResolved",
      provider: { name: "codex", version: "0.42.0" },
      plugin: { name: "omc:explore", version: "0.9.4" },
      entry: { kind: "skill", name: "explore" },
      capabilities: ["read", "search"],
    },
    "explore",
    "at_ex1",
  )
  b.push({ _tag: "AgentActivity", activity: "explore", detail: "map reconnect path" }, "explore", "at_ex1")
  b.push(
    {
      _tag: "CommandExecuted",
      argv: ["rg", "-n", "reconnect", "app/", "lib/"],
      exitCode: 0,
      timedOut: false,
      durationMs: 412,
      success: true,
    },
    "explore",
    "at_ex1",
  )
  b.push({ _tag: "OutputChunk", streamKind: "stdout", excerpt: "4 matches in 3 files", ref: "art_rg" }, "explore", "at_ex1")
  b.push({ _tag: "AttemptFinished", verdict: "success" }, "explore", "at_ex1")
  b.push({ _tag: "BlockFinished", status: "succeeded" }, "explore")

  b.push({ _tag: "BlockStarted", defId: "issue-reproduce", kind: "agent" }, "reproduce")
  b.push({ _tag: "AttemptStarted", number: 1, sessionId: "sess_a10c3f" }, "reproduce", "at_rp1")
  b.push(
    { _tag: "ArtifactCreated", artifactId: "art_repro", kind: "markdown", path: ARTIFACTS.art_repro!.path, bytes: 402 },
    "reproduce",
    "at_rp1",
  )
  b.push({ _tag: "AttemptFinished", verdict: "success" }, "reproduce", "at_rp1")
  b.push({ _tag: "BlockFinished", status: "succeeded" }, "reproduce")

  b.push({ _tag: "BlockStarted", defId: "omc:plan", kind: "agent" }, "plan")
  b.push({ _tag: "AttemptStarted", number: 1, sessionId: "sess_c41b70" }, "plan", "at_pl1")
  b.push(
    {
      _tag: "PluginResolved",
      provider: { name: "claude-code", version: "2.1.0" },
      plugin: { name: "omc:plan", version: "0.9.4" },
      entry: { kind: "slash", name: "plan" },
      capabilities: ["plan"],
    },
    "plan",
    "at_pl1",
  )
  b.push(
    { _tag: "ArtifactCreated", artifactId: "art_plan", kind: "markdown", path: ARTIFACTS.art_plan!.path, bytes: 812 },
    "plan",
    "at_pl1",
  )
  b.push({ _tag: "AttemptFinished", verdict: "success" }, "plan", "at_pl1")
  b.push({ _tag: "BlockFinished", status: "succeeded" }, "plan")
  b.push({ _tag: "CheckpointCreated", checkpointId: "4f2a91c", kind: "success" }, "plan")
}

function approvalGate(b: Builder, decided: boolean): void {
  b.push({ _tag: "ApprovalRequested", gateId: "plan-approval", payloadRef: "art_plan" }, "plan-approval")
  if (decided)
    b.push(
      { _tag: "ApprovalDecided", gateId: "plan-approval", approved: true, note: "ship it" },
      "plan-approval",
    )
}

function implementAttempt(
  b: Builder,
  attemptId: string,
  number: number,
  sessionId: string,
  outcome: "pass" | "fail" | "open",
): void {
  b.push({ _tag: "AttemptStarted", number, sessionId }, "implement", attemptId)
  b.push({ _tag: "SessionStarted", sessionId }, "implement", attemptId)
  b.push({ _tag: "PromptComposed", promptRef: "art_prompt_impl" }, "implement", attemptId)
  b.push(
    { _tag: "AgentActivity", activity: "implement", detail: "persist cursor on every flush" },
    "implement",
    attemptId,
  )
  b.push(
    { _tag: "ArtifactCreated", artifactId: "art_patch", kind: "diff", path: ARTIFACTS.art_patch!.path, bytes: 486 },
    "implement",
    attemptId,
  )
  b.push(
    { _tag: "ArtifactCreated", artifactId: "art_method", kind: "code", path: ARTIFACTS.art_method!.path, bytes: 240 },
    "implement",
    attemptId,
  )
  if (outcome === "open") return

  const pass = outcome === "pass"
  b.push(
    {
      _tag: "CommandExecuted",
      argv: ["bundle", "exec", "rspec", "spec/services/interview_recovery_spec.rb"],
      exitCode: pass ? 0 : 1,
      timedOut: false,
      durationMs: pass ? 18_600 : 17_900,
      success: pass,
    },
    "verify",
    attemptId,
  )
  b.push(
    {
      _tag: "OutputChunk",
      streamKind: "stdout",
      excerpt: pass ? "6 examples, 0 failures" : "6 examples, 1 failure",
      ref: pass ? "art_rspec_pass" : "art_rspec_fail",
    },
    "verify",
    attemptId,
  )
  b.push(
    {
      _tag: "VerificationReported",
      criteria: [
        { criterion: "rspec suite green", passed: pass, evidenceRef: pass ? "art_rspec_pass" : "art_rspec_fail" },
        { criterion: "rubocop clean", passed: true },
        { criterion: "reproduction replay loses no events", passed: pass },
      ],
    },
    "verify",
    attemptId,
  )
  if (pass) {
    b.push({ _tag: "ResultProduced", outputRef: "art_result" }, "implement", attemptId)
    b.push({ _tag: "AttemptFinished", verdict: "success" }, "implement", attemptId)
  } else {
    b.push(
      {
        _tag: "ErrorRaised",
        class: "semantic",
        signature: "interview_recovery_spec:34",
        message:
          "Attempt 1 failed verification: the reconnect spec still replays from a stale cursor. The patch moved the write, but resume() reads a value memoized before the flush.",
      },
      "implement",
      attemptId,
    )
    b.push({ _tag: "AttemptFinished", verdict: "semantic-failure" }, "implement", attemptId)
    b.push({ _tag: "FailureFeedbackForwarded", packetRef: "art_packet" }, "implement", attemptId)
    b.push({ _tag: "RetryScheduled", class: "semantic", nextAttempt: number + 1, delayMs: 500 }, "implement", attemptId)
  }
}

interface Fixture {
  readonly events: readonly JournalEvent[]
  readonly status: RunStatus
  /** Events beyond this index arrive over the socket, exercising the live stream. */
  readonly streamFrom: number
}

function fixture(state: MockState): Fixture {
  const b = new Builder()
  if (state === "idle") return { events: [], status: "created", streamFrom: 0 }

  if (state === "analyzing") {
    b.push({ _tag: "RunCreated", projectId: PROJECT, prompt: PROMPT })
    b.push({ _tag: "RunStarted" })
    b.push({
      _tag: "TreeAnalyzed",
      templateId: "bugfix-with-reproduction",
      rationale:
        "The issue body contains a stack trace and a user-visible symptom, and the repo has an rspec suite with a reproduction harness.",
      decision: { template: "bugfix-with-reproduction" },
      fallback: false,
    })
    b.push({ _tag: "BlockStarted", defId: "codex", kind: "agent" }, "explore")
    b.push({ _tag: "AttemptStarted", number: 1, sessionId: "sess_7f2a91c4" }, "explore", "at_ex1")
    // Only RunCreated is backfilled; RunStarted streams in, flipping the run to `running`.
    return { events: b.events, status: "running", streamFrom: 1 }
  }

  if (state === "awaiting-start") {
    b.push({ _tag: "RunCreated", projectId: PROJECT, prompt: PROMPT })
    b.push({
      _tag: "TreeAnalyzed",
      templateId: "bugfix-with-reproduction",
      rationale:
        "The issue body contains a stack trace and a user-visible symptom, and the repo has an rspec suite with a reproduction harness.",
      decision: { template: "bugfix-with-reproduction", visualBlocks: true, reviewLoop: true },
      fallback: false,
    })
    b.push({ _tag: "TreeValidated", errors: [] })
    b.push({ _tag: "RunAwaitingStart" })
    return { events: b.events, status: "awaiting-start", streamFrom: b.events.length }
  }

  prelude(b)

  if (state === "approval") {
    approvalGate(b, false)
    return { events: b.events, status: "running", streamFrom: b.events.length }
  }

  approvalGate(b, true)
  b.push({ _tag: "BlockStarted", defId: "implement", kind: "agent" }, "implement")

  if (state === "running") {
    const before = b.events.length
    implementAttempt(b, "at_im2", 2, "sess_9c14e2", "open")
    return { events: b.events, status: "running", streamFrom: before }
  }

  if (state === "question") {
    implementAttempt(b, "at_im2", 2, "sess_9c14e2", "open")
    b.push(
      {
        _tag: "QuestionAsked",
        question:
          "The reproduction harness and the production channel disagree on cursor ownership. Which one should own the write after this fix? (a) InterviewRecovery — single writer, harness follows it. (b) Transcript::Stream — keeps the channel dumb, needs a migration.",
      },
      "implement",
      "at_im2",
    )
    return { events: b.events, status: "running", streamFrom: b.events.length }
  }

  if (state === "retry") {
    implementAttempt(b, "at_im1", 1, "sess_31b0aa", "fail")
    const before = b.events.length
    implementAttempt(b, "at_im2", 2, "sess_9c14e2", "open")
    return { events: b.events, status: "running", streamFrom: before }
  }

  if (state === "recovery") {
    implementAttempt(b, "at_im2", 2, "sess_9c14e2", "open")
    b.push({ _tag: "RunRecovered", lastCheckpoint: "4f2a91c" })
    return { events: b.events, status: "running", streamFrom: b.events.length }
  }

  if (state === "cancelled") {
    implementAttempt(b, "at_im2", 2, "sess_9c14e2", "open")
    b.push({ _tag: "AttemptInterrupted" }, "implement", "at_im2")
    b.push({ _tag: "BlockFinished", status: "interrupted" }, "implement")
    b.push({ _tag: "RunCancelled" })
    return { events: b.events, status: "cancelled", streamFrom: b.events.length }
  }

  implementAttempt(b, "at_im1", 1, "sess_31b0aa", "fail")
  implementAttempt(b, "at_im2", 2, "sess_9c14e2", "pass")
  b.push({ _tag: "BlockFinished", status: "succeeded" }, "implement")
  b.push({ _tag: "BlockFinished", status: "succeeded" }, "verify")
  b.push({ _tag: "BlockSkipped", reason: "no visual surface touched" }, "visual-after")
  b.push({ _tag: "BlockStarted", defId: "local-duo-review", kind: "agent" }, "code-review")
  b.push({ _tag: "BlockFinished", status: "succeeded" }, "code-review")
  b.push({ _tag: "BlockStarted", defId: "finalize", kind: "agent" }, "finalize")
  b.push({ _tag: "CheckpointCreated", checkpointId: "b91d0f7", kind: "success" }, "finalize")
  b.push({ _tag: "BlockFinished", status: "succeeded" }, "finalize")
  b.push({ _tag: "RunFinished", status: "succeeded" })
  return { events: b.events, status: "succeeded", streamFrom: b.events.length }
}

const INSIGHTS: readonly Insight[] = [
  {
    id: "ins_1",
    target: "core",
    title: "Retry context is too large to be read",
    body: "The second attempt was handed a **12 KB** failure packet and repeated the first attempt's hypothesis anyway.\n\nBudget the packet down to the findings, or route only the verifier's own words.",
    evidence: [
      { kind: "artifact", ref: "~/.cockpit/runs/run_7f2a91/art_packet-attempt-2-feedback.md" },
      { kind: "block", ref: "implement" },
    ],
    occurrences: 3,
    firstSeenRun: "run_b4",
    lastSeenRun: RUN,
    lastSeenAt: new Date(START + 634_000).toISOString(),
  },
  {
    id: "ins_2",
    target: "cartridge",
    title: "The reproduction block runs after the fix, not before it",
    body: "`issue-reproduce` is scheduled inside the corrective loop, so the first implement attempt has no failing test to aim at.",
    evidence: [{ kind: "block", ref: "reproduce" }],
    occurrences: 1,
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    lastSeenAt: new Date(START + 634_000).toISOString(),
  },
]

const STREAM_INTERVAL_MS = 500

export function mockSource(state: MockState): Source {
  const { events, status, streamFrom } = fixture(state)
  const listeners = new Set<(e: readonly JournalEvent[]) => void>()
  let extraSeq = events.at(-1)?.seq ?? 0

  const emit = (payload: EventPayload, blockId?: string, attemptId?: string) => {
    extraSeq += 1
    const e: JournalEvent = {
      seq: extraSeq,
      ts: new Date().toISOString(),
      runId: RUN,
      ...(blockId ? { blockId } : {}),
      ...(attemptId ? { attemptId } : {}),
      payload,
    }
    listeners.forEach((l) => l([e]))
  }

  const run: Run = {
    id: RUN,
    projectId: PROJECT,
    prompt: PROMPT,
    status,
    createdAt: new Date(START).toISOString(),
    finishedAt:
      status === "succeeded" || status === "cancelled"
        ? new Date(START + 634_000).toISOString()
        : null,
  }

  const siblings: readonly Run[] = [
    run,
    { id: "run_b2", projectId: PROJECT, prompt: "Add AI provider connection status", status: "running", createdAt: new Date(START - 720_000).toISOString() },
    { id: "run_b3", projectId: PROJECT, prompt: "Fix live transcript auto-scrolling", status: "failed", createdAt: new Date(START - 3_600_000).toISOString() },
    { id: "run_b4", projectId: PROJECT, prompt: "Refactor interview mode configuration", status: "succeeded", createdAt: new Date(START - 10_800_000).toISOString() },
    { id: "run_b5", projectId: PROJECT, prompt: "Add Codex fallback for provider outages", status: "succeeded", createdAt: new Date(START - 18_000_000).toISOString() },
    { id: "run_b6", projectId: PROJECT, prompt: "Interview export: include speaker labels", status: "cancelled", createdAt: new Date(START - 90_000_000).toISOString() },
  ]

  const planned: RunDetail = {
    run,
    tree: { runId: RUN, templateId: "bugfix-with-reproduction", root: TREE },
    retryPolicies: { "single-attempt": { maxAttempts: 1 }, corrective: { maxAttempts: 3 } },
  }
  // Analyzing starts before planning settles: the first fetch has no tree, the refetch does.
  let planningSettled = state !== "analyzing"
  let projects = PROJECTS

  return {
    projects: async () => projects,
    createProject: async (name, repoPath) => {
      const created = { id: `prj_${name}`, name, repoPath }
      projects = [...projects, created]
      return created
    },
    runs: async () => (state === "idle" ? siblings.slice(1) : siblings),
    run: async () => {
      if (!planningSettled) {
        planningSettled = true
        return { run }
      }
      return planned
    },
    createRun: async () => ({ runId: RUN }),
    start: async () => {
      emit({ _tag: "RunStarted" })
    },
    regenerate: async () => {
      emit({
        _tag: "TreeAnalyzed",
        templateId: "quickfix",
        rationale: "Regenerated: the task reads as a small, local change after all.",
        decision: { template: "quickfix" },
        fallback: false,
      })
    },
    artifact: async (id) => {
      const a = ARTIFACTS[id]
      if (!a) throw new Error(`unknown artifact ${id}`)
      return { id, ...a }
    },
    decideGate: async (_runId, gateId, approved, note) => {
      emit({ _tag: "ApprovalDecided", gateId, approved, note }, "plan-approval")
      if (approved) emit({ _tag: "BlockStarted", defId: "implement", kind: "agent" }, "implement")
    },
    answer: async (_runId, blockId, text) => {
      emit({ _tag: "QuestionAnswered", answer: text }, blockId, "at_im2")
    },
    cancel: async () => {
      emit({ _tag: "RunCancelled" })
    },
    stop: async () => {
      emit({ _tag: "RunStopped" })
    },
    skipBlock: async (_runId, blockId) => {
      emit({ _tag: "BlockSkipRequested", nodeId: blockId })
    },
    resume: async () => {
      emit({ _tag: "RunResumed" })
    },
    insights: async (target) =>
      target === undefined ? INSIGHTS : INSIGHTS.filter((row) => row.target === target),
    openTerminal: async () => ({
      opened: true,
      mode: "herdr",
      sessionId: "8f1c0f5e-6a0e-4f2f-9d6a-2f0f7b3a1c44",
      briefPath: "/Users/you/.cockpit/runs/run_a1/task-brief.md",
    }),
    fetchEvents: async (_runId, from) => events.filter((e) => e.seq > from).slice(0, streamFrom),
    subscribe: (_runId, from, onEvents) => {
      listeners.add(onEvents)
      const queue = events.filter((e) => e.seq > from)
      let i = 0
      const timer = setInterval(() => {
        if (i >= queue.length) {
          clearInterval(timer)
          return
        }
        onEvents([queue[i]!])
        i += 1
      }, STREAM_INTERVAL_MS)
      return () => {
        clearInterval(timer)
        listeners.delete(onEvents)
      }
    },
  }
}
