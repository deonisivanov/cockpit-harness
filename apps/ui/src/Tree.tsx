import { useMemo } from "react"
import type { RunDetail } from "./model.js"
import { fmtDuration } from "./presentation.js"
import { attemptsOf, type RunState } from "./store.js"
import {
  flattenTree,
  loopIndicator,
  type RetryPolicies,
  type TreeRow,
} from "./treeModel.js"

type NodeStatus = "running" | "done" | "failed" | "skipped" | "waiting" | "interrupted" | "pending"

const STATUS: Record<NodeStatus, { dot: string; name: string; label: string }> = {
  running: { dot: "text-vio", name: "text-[#d2d2dc]", label: "● running" },
  done: { dot: "text-green", name: "text-[#d2d2dc]", label: "" },
  failed: { dot: "text-red", name: "text-[#d2d2dc]", label: "● failed" },
  skipped: { dot: "text-slate", name: "text-[#4e4e58]", label: "● skipped" },
  waiting: { dot: "text-amber", name: "text-[#d2d2dc]", label: "● waiting" },
  interrupted: { dot: "text-amber", name: "text-[#d2d2dc]", label: "● interrupted" },
  pending: { dot: "text-[#3d3d46]", name: "text-[#6a6a76]", label: "" },
}

const durationOf = (startedAt?: string, finishedAt?: string): string => {
  if (!startedAt || !finishedAt) return ""
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  return Number.isFinite(ms) && ms > 0 ? fmtDuration(ms) : ""
}

function blockStatus(state: RunState, id: string, isGate: boolean): NodeStatus {
  if (isGate && state.gates.has(id)) return "waiting"
  const b = state.blocks.get(id)
  if (!b) {
    if (isGate) {
      const decided = state.events.some(
        (e) => e.payload._tag === "ApprovalDecided" && e.payload.gateId === id,
      )
      return decided ? "done" : "pending"
    }
    return "pending"
  }
  if (b.status === "succeeded") return "done"
  if (b.status === "running") return state.questions.has(id) ? "waiting" : "running"
  return b.status
}

export interface TreeProps {
  readonly detail: RunDetail | null
  readonly state: RunState
  readonly selected: string | null
  readonly onSelect: (blockId: string | null) => void
  readonly onSkip: (blockId: string) => void
  readonly onClose: () => void
  readonly floating: boolean
}

export function Tree({ detail, state, selected, onSelect, onSkip, onClose, floating }: TreeProps) {
  const rows = useMemo(() => (detail?.tree ? flattenTree(detail.tree.root) : []), [detail])

  return (
    <aside
      data-testid="tree"
      className={`flex flex-none flex-col self-start overflow-hidden rounded-xl border border-white/8 bg-panel ${
        floating
          ? "absolute top-3 right-3 z-20 max-h-[calc(100%-1.5rem)] w-[340px] shadow-[0_12px_44px_rgba(0,0,0,0.62)]"
          : "relative max-h-full w-[352px]"
      }`}
    >
      <div className="flex flex-none items-baseline gap-2.5 border-b border-white/6 bg-head px-3.5 py-2.5">
        <span className="font-mono text-[12px] font-semibold text-[#c4c4ce]">workflow</span>
        <span className="flex-1 font-mono text-[10.5px] text-[#42424c]">
          {detail?.tree?.templateId ?? "assembled per-task by the analyzer"}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close workflow"
          className="font-mono text-[11px] font-medium text-ink-4 hover:text-ink-2"
        >
          ]
        </button>
      </div>

      <div data-testid="tree-scroll" className="flex-1 overflow-y-auto px-1.5 pt-2 pb-6">
        {rows.length === 0 ? (
          <div
            data-testid="tree-pending"
            className="animate-ck-sweep px-2 py-3 font-mono text-[11px] text-ink-4"
          >
            the analyzer is still assembling this workflow…
          </div>
        ) : (
          rows.map((row) => (
            <TreeNode
              key={row.key}
              row={row}
              state={state}
              policies={detail?.retryPolicies}
              selected={selected}
              onSelect={onSelect}
              onSkip={onSkip}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function TreeNode({
  row,
  state,
  policies,
  selected,
  onSelect,
  onSkip,
}: {
  row: TreeRow
  state: RunState
  policies?: RetryPolicies
  selected: string | null
  onSelect: (id: string | null) => void
  onSkip: (id: string) => void
}) {
  if (row.kind === "loop") {
    const loop = loopIndicator(row, state, policies)
    return (
      <div className="flex items-center gap-[7px] rounded-sm px-2 py-1">
        <span className="flex-none" style={{ width: row.depth * 16 }} />
        <span className="font-mono text-[11.5px] text-ink-4">loop</span>
        <span
          data-testid="loop-indicator"
          className={`rounded-xs border border-white/9 bg-white/4 px-1.5 py-px font-mono text-[10px] font-medium ${
            loop.current ? "text-[#c4c4ce]" : "text-[#55555f]"
          }`}
        >
          {loop.max === undefined ? `attempt ${loop.current}` : `${loop.current}/${loop.max}`}
        </span>
        {loop.ticks.map((t, i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 flex-none rounded-full ${
              t === "fail" ? "bg-red" : t === "run" ? "bg-vio animate-ck-pulse" : "bg-green"
            }`}
          />
        ))}
        {row.feedback && loop.ticks.length > 1 && (
          <span className="font-mono text-[9px] text-[#5c5c67]">→ feedback</span>
        )}
      </div>
    )
  }

  if (row.kind === "condition") {
    return (
      <div className="flex items-center gap-[7px] rounded-sm px-2 py-1" title={row.label}>
        <span className="flex-none" style={{ width: row.depth * 16 }} />
        <span className="font-mono text-[11.5px] text-ink-4">if</span>
        <span className="truncate font-mono text-[10px] text-[#55555f]">{row.label}</span>
      </div>
    )
  }

  if (row.kind === "parallel") {
    return (
      <div className="flex items-center gap-[7px] rounded-sm px-2 py-1">
        <span className="flex-none" style={{ width: row.depth * 16 }} />
        <span className="font-mono text-[11.5px] text-ink-4">parallel · {row.branches}</span>
      </div>
    )
  }

  const isGate = row.kind === "gate"
  const status = blockStatus(state, row.id, isGate)
  const style = STATUS[status]
  const block = state.blocks.get(row.id)
  const attempts = attemptsOf(state, row.id)
  const isSelected = selected === row.id
  const label = isGate ? row.title : row.id
  const badge = isGate ? "human-gate" : row.def
  const skippable =
    !isGate &&
    status === "pending" &&
    state.runStatus !== "succeeded" &&
    state.runStatus !== "cancelled"

  return (
    <div className="group relative">
      <button
        type="button"
        data-testid="tree-node"
        data-status={status}
        onClick={() => onSelect(isSelected ? null : row.id)}
        className={`flex w-full items-baseline gap-1.5 rounded-sm border px-2 py-[3px] text-left ${
          isSelected
            ? "border-vio/30 bg-vio/10"
            : status === "running"
              ? "border-transparent bg-vio/5"
              : "border-transparent hover:bg-white/3"
        } ${status === "skipped" ? "opacity-45" : ""} ${
          status === "waiting" && isGate ? "animate-ck-glow" : ""
        }`}
      >
        <span className="flex-none" style={{ width: row.depth * 14 }} />
        {row.depth > 0 && <span className="flex-none font-mono text-[11px] text-[#33333c]">└</span>}
        {isGate && <span className={`flex-none text-[8px] ${style.dot}`}>◆</span>}
        <span className={`flex-none font-mono text-[11.5px] font-semibold ${style.name}`}>
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#3d3d46]">
          · {badge}
        </span>
        {style.label && (
          <span
            className={`flex-none font-mono text-[10px] ${style.dot} ${
              status === "running" ? "animate-ck-sweep" : ""
            }`}
          >
            {style.label}
          </span>
        )}
        {block && (
          <span className="flex-none font-mono text-[10px] text-ink-5">
            {durationOf(block.startedAt, block.finishedAt)}
          </span>
        )}
      </button>

      {skippable && (
        <button
          type="button"
          data-testid="skip-block"
          title="Skip this block's next visit; refused if a later block requires its output"
          onClick={() => onSkip(row.id)}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm border border-white/10 bg-panel px-1.5 font-mono text-[9.5px] text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:border-amber/40 hover:text-amber"
        >
          skip
        </button>
      )}

      {attempts.length > 1 &&
        attempts.map((a) => (
          <div
            key={a.id}
            className="my-px ml-[42px] flex items-baseline gap-2.5 border-l border-white/7 px-2 py-1 font-mono text-[10.5px]"
          >
            <span
              className={
                a.status === "succeeded"
                  ? "text-green"
                  : a.status === "running"
                    ? "text-vio"
                    : "text-red"
              }
            >
              {a.status === "succeeded" ? "✓" : a.status === "running" ? "●" : "✕"}
            </span>
            <span className="flex-1 text-[#5c5c67]">
              attempt {a.number}
              {a.sessionId ? ` · ${a.sessionId}` : ""}
            </span>
            <span className="text-ink-5">{durationOf(a.startedAt, a.finishedAt)}</span>
          </div>
        ))}
    </div>
  )
}
