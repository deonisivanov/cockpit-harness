import { describe, expect, it } from "vitest"
import type { EventPayload, JournalEvent, RunDetail, WorkflowNode } from "./model.js"
import { applyEvents, emptyRunState } from "./store.js"
import { flattenTree, loopIndicator, maxAttemptsByBlock } from "./treeModel.js"

let seq = 0
const ev = (payload: EventPayload, blockId?: string, attemptId?: string): JournalEvent => ({
  seq: ++seq,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  runId: "run_1",
  ...(blockId ? { blockId } : {}),
  ...(attemptId ? { attemptId } : {}),
  payload,
})

const ROOT: WorkflowNode = {
  _tag: "Sequence",
  children: [
    { _tag: "Block", id: "explore", def: "codex" },
    { _tag: "Gate", id: "plan-approval", payload: { title: "plan-approval", summary: "" } },
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
      predicate: { _tag: "Eq", path: ["visual"] },
      onTrue: { _tag: "Block", id: "visual-after", def: "visual" },
    },
  ],
}

const detail: RunDetail = {
  run: {
    id: "run_1",
    projectId: "p",
    prompt: "x",
    status: "running",
    createdAt: new Date(0).toISOString(),
  },
  tree: { runId: "run_1", templateId: "t", root: ROOT },
}

describe("flattenTree", () => {
  it("flattens nested nodes into indented rows", () => {
    const rows = flattenTree(ROOT)
    expect(rows.map((r) => r.kind)).toEqual([
      "block",
      "gate",
      "loop",
      "block",
      "block",
      "condition",
      "block",
    ])
    expect(rows.filter((r) => r.kind === "block").map((r) => r.depth)).toEqual([0, 1, 1, 1])
  })

  it("gives a loop the block ids of its whole body", () => {
    const loop = flattenTree(ROOT).find((r) => r.kind === "loop")
    expect(loop?.kind === "loop" && loop.bodyBlockIds).toEqual(["implement", "verify"])
    expect(loop?.kind === "loop" && loop.feedback).toBe(true)
  })

  it("gives every row a stable unique key", () => {
    const keys = flattenTree(ROOT).map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("loopIndicator", () => {
  const loopRow = flattenTree(ROOT).find((r) => r.kind === "loop")!
  const policies = { corrective: { maxAttempts: 3 } }

  it("reports 0 attempts before the loop runs", () => {
    const i = loopIndicator(loopRow as never, emptyRunState(), policies)
    expect(i).toEqual({ current: 0, max: 3, ticks: [] })
  })

  it("counts a failed attempt then the live one, as the 2/3 indicator", () => {
    const state = applyEvents(emptyRunState(), [
      ev({ _tag: "BlockStarted", defId: "implement", kind: "agent" }, "implement"),
      ev({ _tag: "AttemptStarted", number: 1 }, "implement", "at1"),
      ev({ _tag: "AttemptFinished", verdict: "semantic-failure" }, "implement", "at1"),
      ev({ _tag: "AttemptStarted", number: 2 }, "implement", "at2"),
    ])
    const i = loopIndicator(loopRow as never, state, policies)
    expect(i.current).toBe(2)
    expect(i.max).toBe(3)
    expect(i.ticks).toEqual(["fail", "run"])
  })

  it("leaves max undefined while the policies have not arrived", () => {
    expect(loopIndicator(loopRow as never, emptyRunState(), undefined).max).toBeUndefined()
  })

  it("looks a derived per-loop policy id up verbatim, suffix and all", () => {
    const derived = { ...(loopRow as { policy: string }), policy: "corrective@implement:5" }
    const i = loopIndicator(derived as never, emptyRunState(), {
      "corrective@implement:5": { maxAttempts: 5 },
      corrective: { maxAttempts: 3 },
    })
    expect(i.max).toBe(5)
  })
})

describe("maxAttemptsByBlock", () => {
  it("maps every block in a loop body to that loop's ceiling", () => {
    const m = maxAttemptsByBlock(flattenTree(ROOT), { corrective: { maxAttempts: 3 } })
    expect(m.get("implement")).toBe(3)
    expect(m.get("verify")).toBe(3)
    expect(m.get("explore")).toBeUndefined()
  })

  it("is empty when the policies are absent", () => {
    expect(maxAttemptsByBlock(flattenTree(ROOT), undefined).size).toBe(0)
  })
})

describe("a run detail without a tree", () => {
  it("flattens to nothing, so the panel can show its pending state", () => {
    const pending: RunDetail = { run: detail.run }
    expect(pending.tree).toBeUndefined()
    expect(pending.tree ? flattenTree(pending.tree.root) : []).toEqual([])
  })
})
