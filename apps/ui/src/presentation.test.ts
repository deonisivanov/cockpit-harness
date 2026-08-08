import { describe, expect, it } from "vitest"
import type { EventPayload, JournalEvent } from "./model.js"
import { buildRows, describe as describeEvent, filterRows, fmtDuration, parseDiff } from "./presentation.js"
import { applyEvents, emptyRunState } from "./store.js"

let seq = 0
const ev = (payload: EventPayload, blockId?: string, attemptId?: string): JournalEvent => ({
  seq: ++seq,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  runId: "run_1",
  ...(blockId ? { blockId } : {}),
  ...(attemptId ? { attemptId } : {}),
  payload,
})

const rowsOf = (...events: JournalEvent[]) => buildRows(applyEvents(emptyRunState(), events))

describe("describe", () => {
  it("summarises a command by its argv and marks a failure red", () => {
    const ok = describeEvent({
      _tag: "CommandExecuted",
      argv: ["rspec", "spec/"],
      exitCode: 0,
      timedOut: false,
      durationMs: 18_600,
      success: true,
    })
    expect(ok).toMatchObject({ tag: "bash", tone: "slate", summary: "rspec spec/", dur: "18.6s" })

    const failed = describeEvent({
      _tag: "CommandExecuted",
      argv: ["rspec"],
      exitCode: 1,
      timedOut: false,
      durationMs: 100,
      success: false,
    })
    expect(failed.tone).toBe("red")
  })

  it("counts passing criteria in a verification summary", () => {
    const view = describeEvent({
      _tag: "VerificationReported",
      criteria: [
        { criterion: "a", passed: true },
        { criterion: "b", passed: false },
      ],
    })
    expect(view.summary).toBe("verification 1/2 passed")
    expect(view.tone).toBe("red")
  })

  it("flags an analyzer fallback", () => {
    const view = describeEvent({
      _tag: "TreeAnalyzed",
      templateId: "generic",
      rationale: "",
      decision: {},
      fallback: true,
    })
    expect(view.tone).toBe("amber")
    expect(view.summary).toContain("fallback")
  })
})

describe("buildRows", () => {
  it("renders an approval gate as a card and carries its later decision", () => {
    const rows = rowsOf(
      ev({ _tag: "ApprovalRequested", gateId: "plan-approval", payloadRef: "art_plan" }, "plan-approval"),
      ev({ _tag: "ApprovalDecided", gateId: "plan-approval", approved: true, note: "ok" }, "plan-approval"),
    )
    const approval = rows.find((r) => r.kind === "approval")
    expect(approval).toBeDefined()
    expect(approval?.kind === "approval" && approval.decision).toEqual({ approved: true, note: "ok" })
  })

  it("turns a failed attempt into a failure card carrying the forwarded packet", () => {
    const rows = rowsOf(
      ev({ _tag: "AttemptStarted", number: 1 }, "implement", "at1"),
      ev(
        { _tag: "ErrorRaised", class: "semantic", signature: "spec:34", message: "stale cursor" },
        "implement",
        "at1",
      ),
      ev({ _tag: "AttemptFinished", verdict: "semantic-failure" }, "implement", "at1"),
      ev({ _tag: "FailureFeedbackForwarded", packetRef: "art_packet" }, "implement", "at1"),
    )
    const failure = rows.find((r) => r.kind === "failure")
    expect(failure?.kind === "failure" && failure.packetRef).toBe("art_packet")
    expect(failure?.kind === "failure" && failure.title).toBe("stale cursor")
  })

  it("does not emit a failure card for a successful attempt", () => {
    const rows = rowsOf(
      ev({ _tag: "AttemptStarted", number: 1 }, "implement", "at1"),
      ev({ _tag: "AttemptFinished", verdict: "success" }, "implement", "at1"),
    )
    expect(rows.some((r) => r.kind === "failure")).toBe(false)
  })

  it("labels an attempt header with the loop ceiling when one is known", () => {
    const state = applyEvents(emptyRunState(), [
      ev({ _tag: "AttemptStarted", number: 2 }, "implement", "at2"),
    ])
    const withMax = buildRows(state, new Map([["implement", 3]])).find((r) => r.kind === "attempt")
    expect(withMax?.kind === "attempt" && withMax.title).toBe("Attempt 2 of 3 — implement")

    const withoutMax = buildRows(state).find((r) => r.kind === "attempt")
    expect(withoutMax?.kind === "attempt" && withoutMax.title).toBe("Attempt 2 — implement")
  })

  it("renders run completion and cancellation as summary cards", () => {
    expect(rowsOf(ev({ _tag: "RunFinished", status: "succeeded" }))[0]).toMatchObject({
      kind: "summary",
      status: "succeeded",
    })
    expect(rowsOf(ev({ _tag: "RunCancelled" }))[0]).toMatchObject({
      kind: "summary",
      status: "cancelled",
    })
  })

  it("hides run and block bookkeeping the other panels already show", () => {
    const rows = rowsOf(
      ev({ _tag: "RunCreated", projectId: "p", prompt: "x" }),
      ev({ _tag: "RunStarted" }),
      ev({ _tag: "BlockStarted", defId: "codex", kind: "agent" }, "explore"),
      ev({ _tag: "BlockFinished", status: "succeeded" }, "explore"),
      ev({ _tag: "SessionStarted", sessionId: "sess_a" }, "explore", "at1"),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind === "event" && rows[0].view.tag).toBe("session")
  })

  it("keeps a question visible with the answer it received", () => {
    const rows = rowsOf(
      ev({ _tag: "QuestionAsked", question: "which owner?" }, "implement", "at1"),
      ev({ _tag: "QuestionAnswered", answer: "InterviewRecovery" }, "implement", "at1"),
    )
    expect(rows).toHaveLength(1)
    const q = rows[0]
    expect(q?.kind === "question" && q.answer).toBe("InterviewRecovery")
    expect(q?.kind === "question" && q.pending).toBe(false)
  })

  it("pairs interleaved answers with their own block, not by arrival order", () => {
    // Qa Qb Ab Aa — global ordinal pairing would hand Qa the answer meant for Qb.
    const rows = rowsOf(
      ev({ _tag: "QuestionAsked", question: "question a" }, "implement", "at1"),
      ev({ _tag: "QuestionAsked", question: "question b" }, "verify", "at2"),
      ev({ _tag: "QuestionAnswered", answer: "answer b" }, "verify", "at2"),
      ev({ _tag: "QuestionAnswered", answer: "answer a" }, "implement", "at1"),
    )
    const byBlock = new Map(
      rows.filter((r) => r.kind === "question").map((r) => [r.event.blockId, r]),
    )
    const a = byBlock.get("implement")
    const b = byBlock.get("verify")
    expect(a?.kind === "question" && a.answer).toBe("answer a")
    expect(b?.kind === "question" && b.answer).toBe("answer b")
  })

  it("reuses row objects for events whose rendering did not change", () => {
    const first = applyEvents(emptyRunState(), [
      ev({ _tag: "SessionStarted", sessionId: "sess_a" }, "explore", "at1"),
      ev({ _tag: "AttemptStarted", number: 1 }, "implement", "at2"),
    ])
    const before = buildRows(first)

    const after = buildRows(
      applyEvents(first, [ev({ _tag: "CheckpointCreated", checkpointId: "abc", kind: "success" })]),
    )
    expect(after).toHaveLength(before.length + 1)
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
  })

  it("rebuilds a row whose derived content actually changed", () => {
    const asked = applyEvents(emptyRunState(), [
      ev({ _tag: "QuestionAsked", question: "which owner?" }, "implement", "at1"),
    ])
    const before = buildRows(asked)
    const after = buildRows(
      applyEvents(asked, [ev({ _tag: "QuestionAnswered", answer: "ok" }, "implement", "at1")]),
    )
    expect(after[0]).not.toBe(before[0])
    expect(after[0]?.kind === "question" && after[0].answer).toBe("ok")
  })

  it("leaves an unanswered question pending", () => {
    const rows = rowsOf(ev({ _tag: "QuestionAsked", question: "which owner?" }, "implement", "at1"))
    const q = rows[0]
    expect(q?.kind === "question" && q.pending).toBe(true)
    expect(q?.kind === "question" && q.answer).toBeUndefined()
  })

  it("renders a recovery banner", () => {
    const rows = rowsOf(ev({ _tag: "RunRecovered", lastCheckpoint: "4f2a91c" }))
    expect(rows[0]?.kind).toBe("banner")
    expect(rows[0]?.kind === "banner" && rows[0].title).toContain("4f2a91c")
  })
})

describe("filterRows", () => {
  it("keeps only the selected block's rows and restores everything on clear", () => {
    const rows = rowsOf(
      ev({ _tag: "SessionStarted", sessionId: "a" }, "explore", "at1"),
      ev({ _tag: "SessionStarted", sessionId: "b" }, "implement", "at2"),
    )
    expect(filterRows(rows, "implement")).toHaveLength(1)
    expect(filterRows(rows, null)).toHaveLength(2)
  })
})

describe("parseDiff", () => {
  it("classifies unified diff lines", () => {
    const lines = parseDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n context\n-old\n+new")
    expect(lines.map((l) => l.kind)).toEqual(["file", "file", "hunk", "ctx", "del", "add"])
  })

  it("emphasises only the differing middle of a changed line pair", () => {
    const lines = parseDiff("-      cursor = session.cursor\n+      cursor = session.reload.cursor")
    const del = lines[0]!
    const add = lines[1]!
    expect(add.emphasis).toBeDefined()
    expect(add.text.slice(add.emphasis![0], add.emphasis![1])).toBe("reload.")
    expect(del.text.slice(del.emphasis![0], del.emphasis![1])).toBe("")
  })

  it("leaves an unchanged pair unemphasised", () => {
    const lines = parseDiff("-same\n+same")
    expect(lines[0]!.emphasis).toBeUndefined()
  })
})

describe("fmtDuration", () => {
  it("scales from milliseconds to minutes", () => {
    expect(fmtDuration(412)).toBe("412ms")
    expect(fmtDuration(18_600)).toBe("18.6s")
    expect(fmtDuration(192_000)).toBe("3m12")
  })
})
