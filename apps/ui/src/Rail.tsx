import { useState } from "react"
import type { Project, Run, RunStatus } from "./model.js"
import { relativeTime } from "./presentation.js"

const DOT: Record<RunStatus, { glyph: string; className: string }> = {
  running: { glyph: "●", className: "text-vio animate-ck-pulse" },
  created: { glyph: "○", className: "text-ink-4" },
  succeeded: { glyph: "✓", className: "text-green" },
  failed: { glyph: "✕", className: "text-red" },
  cancelled: { glyph: "✕", className: "text-slate" },
  interrupted: { glyph: "◐", className: "text-amber" },
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
  readonly insightsOpen: boolean
  readonly onInsights: () => void
  readonly addProjectOpen: boolean
  readonly onToggleAddProject: () => void
  readonly onAddProject: (name: string, repoPath: string) => void
  readonly addProjectBusy: boolean
  readonly addProjectError: string | null
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
  insightsOpen,
  onInsights,
  addProjectOpen,
  onToggleAddProject,
  onAddProject,
  addProjectBusy,
  addProjectError,
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
          <button
            type="button"
            data-testid="rail-insights"
            title="insights"
            onClick={onInsights}
            className={`flex h-[30px] items-center justify-center rounded-md text-[10px] ${
              insightsOpen ? "bg-vio/12 text-vio-hi" : "text-ink-4 hover:text-ink-2"
            }`}
          >
            ✳
          </button>
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
            {project ? (
              <>
                <div className="flex flex-1 items-center justify-between rounded-md border border-white/7 bg-[#101014] px-2.5 py-[7px] hover:border-white/14">
                  <span className="truncate font-sans text-[12.5px] font-medium text-[#c4c4ce]">
                    {project.name}
                  </span>
                  <span className="font-mono text-[9px] text-ink-4">▼</span>
                </div>
                <button
                  type="button"
                  data-testid="add-project-toggle"
                  title="add project"
                  aria-label="add project"
                  aria-expanded={addProjectOpen}
                  onClick={onToggleAddProject}
                  className={`flex-none rounded-md border px-2 py-[7px] font-mono text-[11px] ${
                    addProjectOpen
                      ? "border-vio/40 bg-vio/10 text-vio-hi"
                      : "border-white/7 text-ink-4 hover:border-vio/40 hover:text-vio-hi"
                  }`}
                >
                  +
                </button>
              </>
            ) : (
              <div className="font-sans text-[12px] text-[#8a8a96]">
                register a git repository to start
              </div>
            )}
          </div>

          {(addProjectOpen || !project) && (
            <AddProjectForm onSubmit={onAddProject} busy={addProjectBusy} error={addProjectError} />
          )}

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
            <button
              type="button"
              data-testid="rail-insights"
              onClick={onInsights}
              className={`mt-1.5 w-full rounded-md border px-2.5 py-2 text-center font-sans text-[12px] font-medium ${
                insightsOpen
                  ? "border-vio/40 bg-vio/10 text-vio-hi"
                  : "border-transparent text-[#7a7a86] hover:bg-white/3"
              }`}
            >
              ✳ insights
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

function AddProjectForm({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (name: string, repoPath: string) => void
  busy: boolean
  error: string | null
}) {
  const [name, setName] = useState("")
  const [repoPath, setRepoPath] = useState("")

  return (
    <form
      data-testid="add-project-form"
      className="mx-3 mb-2.5 flex flex-col gap-1.5 rounded-md border border-white/8 bg-[#101014] p-2.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim() && repoPath.trim()) onSubmit(name.trim(), repoPath.trim())
      }}
    >
      <input
        data-testid="add-project-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="name"
        className="rounded-sm border border-white/8 bg-[#0a0a0d] px-2 py-1.5 font-sans text-[12px] text-[#c9c9d4] outline-none placeholder:text-[#5c5c67] focus:border-vio/40"
      />
      <input
        data-testid="add-project-path"
        value={repoPath}
        onChange={(e) => setRepoPath(e.target.value)}
        placeholder="/Users/you/path/to/repo"
        className="rounded-sm border border-white/8 bg-[#0a0a0d] px-2 py-1.5 font-mono text-[11.5px] text-[#c9c9d4] outline-none placeholder:text-[#5c5c67] focus:border-vio/40"
      />
      <button
        type="submit"
        data-testid="add-project-submit"
        disabled={busy || !name.trim() || !repoPath.trim()}
        className="rounded-sm border border-vio/35 bg-vio/11 px-2.5 py-1.5 font-sans text-[11.5px] font-medium text-vio-hi hover:bg-vio/20 disabled:opacity-40"
      >
        Register project
      </button>
      {error && (
        <div data-testid="add-project-error" role="alert" className="font-sans text-[11px] text-red">
          {error}
        </div>
      )}
    </form>
  )
}
