import type { WorkflowNode } from "./model.js"
import { attemptsOf, type RunState } from "./store.js"

export type TreeRow =
  | { readonly kind: "block"; readonly key: string; readonly id: string; readonly def: string; readonly depth: number }
  | { readonly kind: "gate"; readonly key: string; readonly id: string; readonly depth: number; readonly title: string }
  | {
      readonly kind: "loop"
      readonly key: string
      readonly depth: number
      readonly policy: string
      readonly bodyBlockIds: readonly string[]
      readonly feedback: boolean
    }
  | { readonly kind: "condition"; readonly key: string; readonly depth: number; readonly label: string }
  | { readonly kind: "parallel"; readonly key: string; readonly depth: number; readonly branches: number }

const blockIdsIn = (node: WorkflowNode, out: string[] = []): string[] => {
  switch (node._tag) {
    case "Block":
      out.push(node.id)
      break
    case "Gate":
      out.push(node.id)
      break
    case "Sequence":
      node.children.forEach((c) => blockIdsIn(c, out))
      break
    case "Parallel":
      node.branches.forEach((b) => blockIdsIn(b.node, out))
      break
    case "Condition":
      blockIdsIn(node.onTrue, out)
      if (node.onFalse) blockIdsIn(node.onFalse, out)
      break
    case "Loop":
      blockIdsIn(node.body, out)
      break
  }
  return out
}

const predicateLabel = (p: unknown): string => {
  if (p && typeof p === "object" && "_tag" in p) {
    const tag = String((p as { _tag: unknown })._tag)
    const path = "path" in p && Array.isArray((p as { path: unknown[] }).path)
      ? (p as { path: string[] }).path.join(".")
      : ""
    return path ? `${tag} ${path}` : tag
  }
  return "condition"
}

export function flattenTree(root: WorkflowNode, depth = 0, path = "r"): TreeRow[] {
  switch (root._tag) {
    case "Block":
      return [{ kind: "block", key: `${path}:${root.id}`, id: root.id, def: root.def, depth }]
    case "Gate":
      return [
        { kind: "gate", key: `${path}:${root.id}`, id: root.id, depth, title: root.payload.title },
      ]
    case "Sequence":
      return root.children.flatMap((c, i) => flattenTree(c, depth, `${path}.${i}`))
    case "Parallel":
      return [
        { kind: "parallel", key: `${path}:par`, depth, branches: root.branches.length },
        ...root.branches.flatMap((b, i) => flattenTree(b.node, depth + 1, `${path}.${i}`)),
      ]
    case "Condition":
      return [
        { kind: "condition", key: `${path}:cond`, depth, label: predicateLabel(root.predicate) },
        ...flattenTree(root.onTrue, depth + 1, `${path}.t`),
        ...(root.onFalse ? flattenTree(root.onFalse, depth + 1, `${path}.f`) : []),
      ]
    case "Loop":
      return [
        {
          kind: "loop",
          key: `${path}:loop`,
          depth,
          policy: root.policy,
          bodyBlockIds: blockIdsIn(root.body),
          feedback: root.feedbackRoute !== undefined,
        },
        ...flattenTree(root.body, depth + 1, `${path}.b`),
      ]
  }
}

export type Tick = "ok" | "fail" | "run"

export interface LoopIndicator {
  readonly current: number
  readonly max?: number
  readonly ticks: readonly Tick[]
}

export type RetryPolicies = Readonly<Record<string, { readonly maxAttempts: number }>>

/** `2/3` plus one tick per attempt, mirroring the prototype's loop row. */
export function loopIndicator(
  row: Extract<TreeRow, { kind: "loop" }>,
  state: RunState,
  policies?: RetryPolicies,
): LoopIndicator {
  const attempts = row.bodyBlockIds
    .flatMap((id) => attemptsOf(state, id))
    .sort((a, b) => a.number - b.number)
  const ticks = attempts.map((a): Tick =>
    a.status === "running" ? "run" : a.status === "succeeded" ? "ok" : "fail",
  )
  // The Analyzer derives per-loop policy ids like `corrective@implement:5`; look them up verbatim.
  return { current: attempts.at(-1)?.number ?? 0, max: policies?.[row.policy]?.maxAttempts, ticks }
}

/** Every block inside a loop, mapped to that loop's attempt ceiling. */
export function maxAttemptsByBlock(
  rows: readonly TreeRow[],
  policies?: RetryPolicies,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  for (const row of rows) {
    if (row.kind !== "loop") continue
    const max = policies?.[row.policy]?.maxAttempts
    if (max !== undefined) for (const id of row.bodyBlockIds) out.set(id, max)
  }
  return out
}
