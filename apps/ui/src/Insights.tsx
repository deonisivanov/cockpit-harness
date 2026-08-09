import { useEffect, useMemo, useState } from "react"
import type { Source } from "./api.js"
import { insightView } from "./insightModel.js"
import type { Insight, InsightTarget } from "./model.js"
import { Markdown } from "./render.js"

const FILTERS: readonly (InsightTarget | "all")[] = ["all", "core", "cartridge"]

export function Insights({ source }: { source: Source }) {
  const [filter, setFilter] = useState<InsightTarget | "all">("all")
  const [rows, setRows] = useState<readonly Insight[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setError(null)
    source
      .insights(filter === "all" ? undefined : filter)
      .then((found) => live && setRows(found))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [source, filter])

  const open = useMemo(() => rows.find((row) => row.id === selected), [rows, selected])

  return (
    <>
      <section
        data-testid="insights"
        className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/12 bg-panel"
      >
        <div className="flex flex-none items-baseline gap-2.5 border-b border-white/9 bg-head px-3.5 py-2.5">
          <span className="font-mono text-[12px] font-semibold text-[#c4c4ce]">insights</span>
          <span className="flex-1 font-mono text-[10.5px] text-[#6b6b77]">
            what past runs say should change
          </span>
          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`insight-filter-${option}`}
              onClick={() => setFilter(option)}
              className={`rounded-sm border px-2 py-0.5 font-mono text-[10px] ${
                filter === option
                  ? "border-vio/40 bg-vio/10 text-vio-hi"
                  : "border-white/12 text-ink-4 hover:text-ink-2"
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {error && (
            <div data-testid="insights-error" className="px-2 py-3 font-mono text-[11px] text-red">
              {error}
            </div>
          )}
          {!error && rows.length === 0 && (
            <div data-testid="insights-empty" className="px-2 py-3 font-mono text-[11px] text-ink-4">
              no insights yet — they arrive when a run finishes
            </div>
          )}
          {rows.map((row) => {
            const view = insightView(row)
            return (
              <button
                key={view.id}
                type="button"
                data-testid="insight-row"
                data-target={view.target}
                onClick={() => setSelected(view.id === selected ? null : view.id)}
                className={`flex w-full items-baseline gap-2.5 rounded-md border px-2.5 py-2 text-left ${
                  view.id === selected
                    ? "border-vio/30 bg-vio/10"
                    : "border-transparent hover:bg-white/3"
                }`}
              >
                <span
                  className={`flex-none rounded-xs border px-1.5 py-0.5 font-mono text-[9.5px] ${view.toneClass}`}
                >
                  {view.target}
                </span>
                <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] text-[#c9c9d4]">
                  {view.title}
                </span>
                {view.occurrences && (
                  <span
                    data-testid="insight-occurrences"
                    className="flex-none rounded-xs border border-white/13 bg-white/4 px-1.5 py-px font-mono text-[10px] text-[#c4c4ce]"
                  >
                    {view.occurrences}
                  </span>
                )}
                <span className="flex-none font-mono text-[10px] text-[#6b6b77]">
                  {view.lastSeen}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      {open && <InsightDetail insight={open} onClose={() => setSelected(null)} />}
    </>
  )
}

function InsightDetail({ insight, onClose }: { insight: Insight; onClose: () => void }) {
  const view = insightView(insight)

  return (
    <aside
      data-testid="insight-detail"
      className="relative flex w-[440px] flex-none flex-col overflow-hidden rounded-xl border border-white/12 bg-panel"
    >
      <div className="flex flex-none items-baseline gap-2.5 border-b border-white/9 bg-head px-3.5 py-2.5">
        <span
          className={`flex-none rounded-xs border px-1.5 py-0.5 font-mono text-[9.5px] ${view.toneClass}`}
        >
          {view.target}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-[#c4c4ce]">
          {view.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close insight"
          className="font-mono text-[11px] font-medium text-ink-4 hover:text-ink-2"
        >
          ]
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3.5 py-3">
        <div className="font-sans text-[12.5px] leading-[1.6] text-[#c9c9d4]">
          <Markdown text={insight.body} />
        </div>

        <Block title="OCCURRENCES">
          <div className="font-mono text-[11px] text-[#8f8f9c]">
            {`raised ${insight.occurrences} time${insight.occurrences === 1 ? "" : "s"}`}
          </div>
          {view.runs.map((line) => (
            <div key={line} className="font-mono text-[11px] text-[#87878f]">
              {line}
            </div>
          ))}
        </Block>

        {view.evidence.length > 0 && (
          <Block title="EVIDENCE">
            {view.evidence.map((line) => (
              <div
                key={line}
                data-testid="insight-evidence"
                className="truncate font-mono text-[11px] text-[#8f8f9c]"
                title={line}
              >
                {line}
              </div>
            ))}
          </Block>
        )}
      </div>
    </aside>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[9.5px] font-medium tracking-[0.13em] text-[#7e7e8a]">
        {title}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}
