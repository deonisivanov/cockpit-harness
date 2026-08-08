import type { Project, Run, RunStatus } from "./model.js"

const DOT: Record<RunStatus, { glyph: string; className: string }> = {
  running: { glyph: "●", className: "text-vio animate-ck-pulse" },
  created: { glyph: "○", className: "text-ink-4" },
  succeeded: { glyph: "✓", className: "text-green" },
  failed: { glyph: "✕", className: "text-red" },
  cancelled: { glyph: "✕", className: "text-slate" },
  interrupted: { glyph: "◐", className: "text-amber" },
}

export const relativeTime = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ""
  const m = Math.round(ms / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return h < 48 ? "yd" : `${Math.round(h / 24)}d`
}

export interface RailProps {
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly project: Project | null
  readonly runs: readonly Run[]
  readonly selectedRunId: string | null
  readonly onSelect: (runId: string) => void
  readonly onNewTask: () => void
  readonly badge: string | null
  readonly activity: readonly { text: string; tone: string }[]
}

export function Rail({
  expanded,
  onToggle,
  project,
  runs,
  selectedRunId,
  onSelect,
  onNewTask,
  badge,
  activity,
}: RailProps) {
  const badged = (r: Run) => (r.id === selectedRunId && badge ? badge : null)
  const ordered = [...runs].sort((a, b) => (badged(b) ? 1 : 0) - (badged(a) ? 1 : 0))
  const counts = {
    running: runs.filter((r) => r.status === "running").length,
    failed: runs.filter((r) => r.status === "failed").length,
  }

  return (
    <aside
      data-testid="rail"
      className={`${expanded ? "w-[272px]" : "w-[54px]"} flex flex-none flex-col overflow-hidden border-r border-white/6 bg-[#0a0a0d] transition-[width] duration-150`}
    >
      <div className="flex items-center justify-between px-3.5 pt-3.5 pb-2.5">
        {expanded && (
          <div className="font-sans text-[14.5px] font-semibold tracking-[-0.01em] text-[#e4e4ec]">
            Cockpit
          </div>
        )}
        <button
          type="button"
          onClick={onToggle}
          title="toggle rail"
          aria-label="toggle rail"
          className="mr-auto rounded-sm px-1.5 py-1 font-mono text-[11px] font-medium text-ink-4 hover:bg-white/4 hover:text-ink-2"
        >
          {expanded ? "[" : "]"}
        </button>
      </div>

      {!expanded && (
        <div className="flex flex-col gap-[3px] px-2 py-1">
          {ordered.slice(0, 8).map((r) => (
            <button
              key={r.id}
              type="button"
              title={r.prompt}
              onClick={() => onSelect(r.id)}
              className={`flex h-[30px] items-center justify-center rounded-md text-[10px] ${DOT[r.status].className} ${r.id === selectedRunId ? "bg-white/5" : ""}`}
            >
              {DOT[r.status].glyph}
            </button>
          ))}
        </div>
      )}

      {expanded && (
        <>
          <div className="flex items-center gap-1.5 px-3 pb-2.5">
            <div className="flex flex-1 items-center justify-between rounded-md border border-white/7 bg-[#101014] px-2.5 py-[7px] hover:border-white/14">
              <span className="truncate font-sans text-[12.5px] font-medium text-[#c4c4ce]">
                {project?.name ?? "no project"}
              </span>
              <span className="font-mono text-[9px] text-ink-4">▼</span>
            </div>
          </div>

          <div className="flex gap-3 px-3.5 pt-0.5 pb-2.5 font-sans text-[10.5px] font-medium">
            <span className="text-[#7b93f2]">● {counts.running} running</span>
            <span className="text-red">✕ {counts.failed} failed</span>
          </div>

          <div className="flex-1 overflow-y-auto px-2">
            {ordered.map((r) => {
              const selected = r.id === selectedRunId
              const b = badged(r)
              return (
                <button
                  key={r.id}
                  type="button"
                  data-testid="rail-task"
                  onClick={() => onSelect(r.id)}
                  className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left font-sans text-[12.5px] ${
                    selected
                      ? "border-white/8 bg-white/4 text-[#dcdce6]"
                      : "border-transparent text-[#8a8a96] hover:bg-white/3"
                  }`}
                >
                  <span className={`w-3 flex-none text-[9px] ${DOT[r.status].className}`}>
                    {DOT[r.status].glyph}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.prompt}</span>
                  {b && (
                    <span className="flex-none rounded-xs border border-amber/40 bg-amber/8 px-1.5 py-0.5 font-mono text-[9px] text-amber">
                      {b}
                    </span>
                  )}
                  <span className="flex-none font-mono text-[10px] text-[#42424c]">
                    {relativeTime(r.createdAt)}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="border-t border-white/5 px-3 py-2.5">
            <button
              type="button"
              onClick={onNewTask}
              className="w-full rounded-md border border-dashed border-white/11 px-2.5 py-2 text-center font-sans text-[12px] font-medium text-[#7a7a86] hover:border-vio/40 hover:text-vio-hi"
            >
              + new task
            </button>
          </div>

          <div className="px-3.5 pb-3">
            <div className="py-2 font-mono text-[9px] font-medium tracking-[0.14em] text-[#3f3f49]">
              ACTIVITY
            </div>
            {activity.map((a, i) => (
              <div
                key={i}
                className="flex items-baseline gap-[7px] py-[3px] font-sans text-[11px] leading-[1.45] text-[#5c5c67]"
              >
                <span className={`flex-none text-[7px] ${a.tone}`}>●</span>
                <span className="min-w-0 flex-1 truncate">{a.text}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
