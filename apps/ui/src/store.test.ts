import { describe, expect, it } from "vitest"
import type { EventPayload, JournalEvent } from "./model.js"
import { applyEvents, attemptsOf, currentBlockId, emptyRunState } from "./store.js"

let seq = 0
const ev = (payload: EventPayload, blockId?: string, attemptId?: string): JournalEvent => ({
  seq: ++seq,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  runId: "run_1",
  ...(blockId ? { blockId } : {}),
  ...(attemptId ? { attemptId } : {}),
  payload,
})

const fold = (...events: JournalEvent[]) => applyEvents(emptyRunState(), events)

describe("applyEvents", () => {
  it("tracks the run lifecycle", () => {
    const s = fold(
      ev({ _tag: "RunCreated", projectId: "p", prompt: "fix it" }),
      ev({ _tag: "RunStarted" }),
      ev({ _tag: "RunFinished", status: "succeeded" }),
    )
    expect(s.runStatus).toBe("succeeded")
    expect(s.events).toHaveLength(3)
  })

  it("takes the run's start from RunStarted, since the runs row has no start column", () => {
    const created = ev({ _tag: "RunCreated", projectId: "p", prompt: "fix it" })
    const started = ev({ _tag: "RunStarted" })
    const recovered = ev({ _tag: "RunRecovered", lastCheckpoint: "abc" })

    expect(applyEvents(emptyRunState(), [created]).startedAt).toBeUndefined()

    const s = applyEvents(emptyRunState(), [created, started, recovered])
    expect(s.startedAt).toBe(started.ts)
  })

  it("holds a recovered run at interrupted until a resume re-opens it", () => {
    const recovered = fold(
      ev({ _tag: "RunStarted" }),
      ev({ _tag: "RunRecovered", lastCheckpoint: "abc" }),
    )
    expect(recovered.runStatus).toBe("interrupted")

    const resumed = applyEvents(recovered, [ev({ _tag: "RunResumed" })])
    expect(resumed.runStatus).toBe("running")
  })

  it("holds a stopped run at interrupted, the same state a resume accepts", () => {
    const stopped = fold(ev({ _tag: "RunStarted" }), ev({ _tag: "RunStopped" }))
    expect(stopped.runStatus).toBe("interrupted")

    const resumed = applyEvents(stopped, [ev({ _tag: "RunResumed" })])
    expect(resumed.runStatus).toBe("running")
  })

  it("marks a cancelled run cancelled even after blocks were running", () => {
    const s = fold(
      ev({ _tag: "RunStarted" }),
      ev({ _tag: "BlockStarted", defId: "impl", kind: "agent" }, "implement"),
      ev({ _tag: "RunCancelled" }),
    )
    expect(s.runStatus).toBe("cancelled")
    expect(s.blocks.get("implement")?.status).toBe("running")
  })

  it("derives block status from the lifecycle events", () => {
    const s = fold(
      ev({ _tag: "BlockStarted", defId: "codex", kind: "agent" }, "explore"),
      ev({ _tag: "BlockFinished", status: "succeeded" }, "explore"),
      ev({ _tag: "BlockStarted", defId: "impl", kind: "agent" }, "implement"),
      ev({ _tag: "BlockSkipped", reason: "nothing visual" }, "visual"),
    )
    expect(s.blocks.get("explore")?.status).toBe("succeeded")
    expect(s.blocks.get("explore")?.finishedAt).toBeDefined()
    expect(s.blocks.get("implement")?.status).toBe("running")
    expect(s.blocks.get("visual")?.status).toBe("skipped")
    expect(s.blocks.get("visual")?.skipReason).toBe("nothing visual")
    expect(currentBlockId(s)).toBe("implement")
  })

  it("links attempts to their block and folds verdicts", () => {
    const s = fold(
      ev({ _tag: "BlockStarted", defId: "impl", kind: "agent" }, "implement"),
      ev({ _tag: "AttemptStarted", number: 1, sessionId: "sess_a" }, "implement", "at1"),
      ev({ _tag: "AttemptFinished", verdict: "semantic-failure" }, "implement", "at1"),
      ev({ _tag: "AttemptStarted", number: 2, sessionId: "sess_b" }, "implement", "at2"),
      ev({ _tag: "AttemptFinished", verdict: "success" }, "implement", "at2"),
    )
    const attempts = attemptsOf(s, "implement")
    expect(attempts.map((a) => a.number)).toEqual([1, 2])
    expect(attempts[0]!.status).toBe("failed")
    expect(attempts[0]!.sessionId).toBe("sess_a")
    expect(attempts[1]!.status).toBe("succeeded")
  })

  it("treats a cancelled attempt as interrupted, not failed", () => {
    const s = fold(
      ev({ _tag: "AttemptStarted", number: 1 }, "implement", "at1"),
      ev({ _tag: "AttemptFinished", verdict: "cancelled" }, "implement", "at1"),
    )
    expect(s.attempts.get("at1")?.status).toBe("interrupted")
  })

  it("holds a gate open until it is decided", () => {
    const requested = fold(
      ev({ _tag: "ApprovalRequested", gateId: "plan-approval", payloadRef: "art_1" }, "plan-approval"),
    )
    expect(requested.gates.get("plan-approval")?.payloadRef).toBe("art_1")

    const decided = applyEvents(requested, [
      ev({ _tag: "ApprovalDecided", gateId: "plan-approval", approved: true }, "plan-approval"),
    ])
    expect(decided.gates.size).toBe(0)
  })

  it("keeps every parked gate, so parallel branches do not evict each other", () => {
    const s = fold(
      ev({ _tag: "ApprovalRequested", gateId: "gate-a", payloadRef: "art_a" }, "gate-a"),
      ev({ _tag: "ApprovalRequested", gateId: "gate-b", payloadRef: "art_b" }, "gate-b"),
      ev({ _tag: "ApprovalDecided", gateId: "gate-b", approved: true }, "gate-b"),
    )
    expect([...s.gates.keys()]).toEqual(["gate-a"])
  })

  it("keeps every parked question, keyed by block", () => {
    const asked = fold(
      ev({ _tag: "QuestionAsked", question: "which owner?" }, "implement", "at1"),
      ev({ _tag: "QuestionAsked", question: "which fixture?" }, "verify", "at2"),
    )
    expect(asked.questions.get("implement")?.question).toBe("which owner?")
    expect(asked.questions.get("verify")?.question).toBe("which fixture?")

    const resolved = applyEvents(asked, [
      ev({ _tag: "QuestionAnswered", answer: "InterviewRecovery" }, "implement", "at1"),
    ])
    expect(resolved.questions.has("implement")).toBe(false)
    expect(resolved.questions.has("verify")).toBe(true)
  })

  it("ignores heartbeat frames, which carry no seq and no payload", () => {
    const ping = { type: "ping" } as unknown as JournalEvent
    const started = ev({ _tag: "RunStarted" })

    expect(() => applyEvents(emptyRunState(), [ping])).not.toThrow()
    expect(applyEvents(emptyRunState(), [ping])).toEqual(emptyRunState())

    const s = applyEvents(emptyRunState(), [ping, started, ping])
    expect(s.events).toHaveLength(1)
    expect(s.lastSeq).toBe(started.seq)
    expect(s.runStatus).toBe("running")
  })

  it("survives a payload tag it has never seen", () => {
    const unknown = {
      ...ev({ _tag: "RunStarted" }),
      payload: { _tag: "SomethingNew" },
    } as unknown as JournalEvent
    const s = applyEvents(emptyRunState(), [unknown])
    expect(s.events).toHaveLength(1)
    expect(s.runStatus).toBe("created")
  })

  it("drops an event that has a seq but no payload", () => {
    const broken = {
      seq: 900,
      ts: new Date().toISOString(),
      runId: "run_1",
    } as unknown as JournalEvent
    expect(() => applyEvents(emptyRunState(), [broken])).not.toThrow()
    expect(applyEvents(emptyRunState(), [broken])).toEqual(emptyRunState())
  })

  it("dedupes events already seen, so a reconnect overlap is harmless", () => {
    const first = fold(
      ev({ _tag: "RunStarted" }),
      ev({ _tag: "BlockStarted", defId: "codex", kind: "agent" }, "explore"),
    )
    const overlap = applyEvents(first, [...first.events])
    expect(overlap).toBe(first)
    expect(overlap.events).toHaveLength(2)
  })

  it("keeps events ordered when a batch arrives out of order", () => {
    const base = emptyRunState()
    const a = ev({ _tag: "RunStarted" })
    const b = ev({ _tag: "BlockStarted", defId: "codex", kind: "agent" }, "explore")
    const s = applyEvents(base, [b, a])
    expect(s.events.map((e) => e.seq)).toEqual([a.seq, b.seq])
    expect(s.lastSeq).toBe(b.seq)
  })

  it("advances lastSeq so the next subscribe resumes past the backfill", () => {
    const first = fold(ev({ _tag: "RunStarted" }))
    const next = applyEvents(first, [ev({ _tag: "RunFinished", status: "failed" })])
    expect(next.lastSeq).toBeGreaterThan(first.lastSeq)
    expect(next.runStatus).toBe("failed")
  })
})
