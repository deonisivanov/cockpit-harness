import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { httpSource, type Source } from "./api.js"
import { Insights } from "./Insights.js"
import { isMockState, mockSource } from "./mock.js"
import type { Project, Run, RunDetail, RunStatus, TerminalHandoff } from "./model.js"
import {
  buildRows,
  filterRows,
  fmtElapsed,
  REGENERATE_TITLE,
  RESUME_TITLE,
  resumable,
  RUN_TITLE,
  startable,
  TERMINAL_TITLE,
  TERMINAL_WAITING_WARNING,
  TERMINAL_WRITE_WARNING,
  terminalNote,
  treeRevisions,
} from "./presentation.js"
import { Rail } from "./Rail.js"
import { Stream } from "./Stream.js"
import { attemptsOf, currentBlockId, useEventStore } from "./store.js"
import { Tree } from "./Tree.js"
import { flattenTree, maxAttemptsByBlock } from "./treeModel.js"

type ActionScope = "gate" | "question" | "run" | "start" | "terminal" | "project"

const STATUS_TONE: Record<RunStatus, string> = {
  created: "border-blue/25 bg-blue/8 text-blue",
  "awaiting-start": "border-amber/30 bg-amber/8 text-amber",
  running: "border-vio/30 bg-vio/8 text-vio",
  succeeded: "border-green/30 bg-green/8 text-green",
  failed: "border-red/30 bg-red/8 text-red",
  cancelled: "border-slate/30 bg-slate/8 text-slate",
  interrupted: "border-amber/30 bg-amber/8 text-amber",
}

function pickSource(): { source: Source; mock: string | null } {
  const mock = new URLSearchParams(window.location.search).get("mock")
  if (isMockState(mock)) return { source: mockSource(mock), mock }
  return { source: httpSource, mock: null }
}

export default function App() {
  const { source, mock } = useMemo(pickSource, [])
  const [insightsOpen, setInsightsOpen] = useState(mock === "insights")
  const [projects, setProjects] = useState<readonly Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [runs, setRuns] = useState<readonly Run[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [railOpen, setRailOpen] = useState(true)
  const [treeOpen, setTreeOpen] = useState(true)
  const [width, setWidth] = useState(() => window.innerWidth)
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null)
  const [focus, setFocus] = useState(-1)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ scope: ActionScope; message: string } | null>(null)
  const [prompt, setPrompt] = useState("")
  const [handoff, setHandoff] = useState<TerminalHandoff | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const { state, answered, decided } = useEventStore(source, runId)
  const pending = useRef(state.questions)
  pending.current = state.questions
  const project = projects.find((p) => p.id === selectedProjectId) ?? projects[0] ?? null
  const narrow = width < 1280
  const tiny = width < 1024

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    setTreeOpen(!narrow)
  }, [narrow])

  useEffect(() => {
    setRailOpen(!tiny)
  }, [tiny])

  useEffect(() => {
    void source.projects().then(setProjects)
  }, [source])

  useEffect(() => {
    if (!project) return
    void source
      .runs(project.id)
      .then((list) => {
        setRuns(list)
        setRunId((current) => current ?? (mock && mock !== "idle" ? (list[0]?.id ?? null) : null))
      })
      // The switch already reset runs/runId to empty; a failed refetch just leaves that in place.
      .catch(() => {})
  }, [source, project, mock])

  useEffect(() => {
    if (!runId) {
      setDetail(null)
      return
    }
    let live = true
    void source.run(runId).then((d) => live && setDetail(d))
    return () => {
      live = false
    }
  }, [source, runId])

  const trees = useMemo(() => treeRevisions(state.events), [state.events])
  useEffect(() => {
    if (!runId || trees === 0) return
    let live = true
    void source.run(runId).then((d) => live && setDetail(d))
    return () => {
      live = false
    }
  }, [source, runId, trees])

  const isLive = state.runStatus === "running" || state.runStatus === "created"
  const waitingToStart = startable(state.runStatus)
  useEffect(() => {
    if (!isLive) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isLive])

  const maxAttempts = useMemo(
    () =>
      maxAttemptsByBlock(
        detail?.tree ? flattenTree(detail.tree.root) : [],
        detail?.retryPolicies,
      ),
    [detail],
  )
  const allRows = useMemo(() => buildRows(state, maxAttempts), [state, maxAttempts])
  const rows = useMemo(() => filterRows(allRows, selectedBlock), [allRows, selectedBlock])

  const toggleRow = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const act = useCallback(async (scope: ActionScope, run: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await run()
    } catch (e: unknown) {
      setError({ scope, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }, [])

  const decide = useCallback(
    (gateId: string, approved: boolean, note?: string) => {
      if (!runId) return
      void act("gate", async () => {
        await source.decideGate(runId, gateId, approved, note)
        decided(gateId)
      })
    },
    [act, source, runId, decided],
  )

  const answer = useCallback(
    (blockId: string, text: string) => {
      if (!runId) return
      void act("question", async () => {
        await source.answer(runId, blockId, text, () => pending.current.has(blockId))
        answered(blockId)
      })
    },
    [act, source, runId, answered],
  )

  const cancel = useCallback(() => {
    if (!runId) return
    void act("run", () => source.cancel(runId))
  }, [act, source, runId])

  const stop = useCallback(() => {
    if (!runId) return
    void act("run", () => source.stop(runId))
  }, [act, source, runId])

  // Both put the run back under the engine, and the rail's status for it changes with that.
  const enterRun = useCallback(
    (go: (id: string) => Promise<unknown>) => {
      if (!runId) return
      void act("run", async () => {
        await go(runId)
        if (project) setRuns(await source.runs(project.id))
      })
    },
    [act, source, runId, project],
  )

  const runNow = useCallback(() => enterRun((id) => source.start(id)), [enterRun, source])

  const resume = useCallback(() => enterRun((id) => source.resume(id)), [enterRun, source])

  const regenerate = useCallback(() => {
    if (!runId) return
    void act("run", () => source.regenerate(runId))
  }, [act, source, runId])

  const skipBlock = useCallback(
    (blockId: string) => {
      if (!runId) return
      void act("run", () => source.skipBlock(runId, blockId))
    },
    [act, source, runId],
  )

  const openTerminal = useCallback(() => {
    if (!runId) return
    void act("terminal", async () => setHandoff(await source.openTerminal(runId)))
  }, [act, source, runId])

  const startRun = useCallback(() => {
    if (!project || !prompt.trim()) return
    void act("start", async () => {
      const { runId: created } = await source.createRun(project.id, prompt.trim())
      setRunId(created)
      setRuns(await source.runs(project.id))
      setPrompt("")
    })
  }, [act, source, project, prompt])

  const selectProject = useCallback((id: string) => {
    setSelectedProjectId(id)
    setRunId(null)
    setRuns([])
  }, [])

  const addProject = useCallback(
    (name: string, repoPath: string) => {
      void act("project", async () => {
        const created = await source.createProject(name, repoPath)
        setProjects((prev) => [...prev, created])
        selectProject(created.id)
        setAddProjectOpen(false)
      })
    },
    [act, source, selectProject],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return
      if (e.metaKey || e.ctrlKey || e.altKey || insightsOpen) return

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setFocus((f) => Math.min(rows.length - 1, f + 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setFocus((f) => Math.max(0, f - 1))
      } else if (e.key === "o") {
        const row = rows[focus]
        if (row) toggleRow(row.key)
      } else if (e.key === "t") {
        setTreeOpen((v) => !v)
      } else if (e.key === "G") {
        setFocus(rows.length - 1)
      } else if (e.key === "a" && state.gates.size > 0) {
        decide([...state.gates.keys()][0]!, true)
      } else if (e.key === "Escape") {
        setSelectedBlock(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [rows, focus, toggleRow, state.gates, decide, insightsOpen])

  const run = detail?.run
  const waiting = state.gates.size ? "approval" : state.questions.size ? "question" : null
  const startedAt = state.startedAt ?? run?.createdAt
  const elapsed = startedAt
    ? fmtElapsed(startedAt, run?.finishedAt ?? new Date(now).toISOString())
    : ""

  const liveBlock = currentBlockId(state)
  const liveAttempt = liveBlock ? attemptsOf(state, liveBlock).at(-1) : undefined
  const note = state.gates.size
    ? "plan gate open"
    : state.questions.size
      ? "session asked a question"
      : liveAttempt
        ? `attempt ${liveAttempt.number}${
            liveBlock && maxAttempts.get(liveBlock) ? ` of ${maxAttempts.get(liveBlock)}` : ""
          }`
        : ""

  const activity = useMemo(
    () =>
      state.events
        .slice(-4)
        .reverse()
        .map((e) => ({
          text: `${e.blockId ? `${e.blockId} · ` : ""}${e.payload._tag}`,
          tone:
            e.payload._tag.startsWith("Run") || e.payload._tag.includes("Error")
              ? "text-blue"
              : "text-vio",
        })),
    [state.events],
  )

  const treeToggle =
    narrow && runId ? (
      <button
        type="button"
        data-testid="tree-toggle"
        onClick={() => setTreeOpen((v) => !v)}
        className="flex-none rounded-sm border border-white/12 px-2 py-0.5 font-mono text-[10px] text-ink-2 hover:border-vio/40 hover:text-ink"
      >
        {treeOpen ? "workflow ✕" : "workflow"}
      </button>
    ) : null

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex min-h-0 flex-1">
        <Rail
          expanded={railOpen}
          onToggle={() => setRailOpen((v) => !v)}
          project={project}
          projects={projects}
          onSelectProject={selectProject}
          runs={runs}
          selectedRunId={runId}
          onSelect={(id) => {
            setRunId(id)
            setSelectedBlock(null)
            setFocus(-1)
            setExpanded(new Set())
            setHandoff(null)
            setInsightsOpen(false)
          }}
          onNewTask={() => {
            setRunId(null)
            setHandoff(null)
            setInsightsOpen(false)
          }}
          badge={waiting}
          activity={activity}
          insightsOpen={insightsOpen}
          onInsights={() => setInsightsOpen((v) => !v)}
          addProjectOpen={addProjectOpen}
          onToggleAddProject={() => {
            setAddProjectOpen((v) => !v)
            setError((e) => (e?.scope === "project" ? null : e))
          }}
          onAddProject={addProject}
          addProjectBusy={busy}
          addProjectError={error?.scope === "project" ? error.message : null}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          {!insightsOpen && runId && run && (
            <div className="mx-3 mt-3 flex-none rounded-xl border border-white/6 bg-head px-4 pt-3.5 pb-3">
              <div className="flex items-start gap-3.5">
                <div
                  className={`mt-px flex-none rounded-md border px-3 py-1.5 font-sans text-[12px] font-semibold ${STATUS_TONE[state.runStatus]}`}
                >
                  {waiting ?? state.runStatus}
                </div>
                <div className="min-w-0 flex-1 font-sans text-[16px] leading-[1.4] font-bold tracking-[-0.005em] text-[#e4e4ec]">
                  {run.prompt}
                </div>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
                <span className="font-sans text-[11.5px] text-[#5c5c67]" data-testid="elapsed">
                  {elapsed}
                </span>
                {note && <span className="font-sans text-[11.5px] text-ink-4">· {note}</span>}
                <div className="flex-1" />
                {waitingToStart && (
                  <>
                    <button
                      type="button"
                      data-testid="run-workflow"
                      disabled={busy}
                      onClick={runNow}
                      title={RUN_TITLE}
                      className="rounded-md border border-green/35 bg-green/10 px-3.5 py-1.5 font-sans text-[12px] font-semibold text-green hover:bg-green/18 disabled:opacity-40"
                    >
                      Run
                    </button>
                    <button
                      type="button"
                      data-testid="regenerate-workflow"
                      disabled={busy}
                      onClick={regenerate}
                      title={REGENERATE_TITLE}
                      className="rounded-md border border-white/12 px-3 py-1.5 font-sans text-[12px] font-medium text-ink-2 hover:border-vio/40 hover:text-ink disabled:opacity-40"
                    >
                      Regenerate
                    </button>
                  </>
                )}
                {isLive && (
                  <button
                    type="button"
                    data-testid="stop-run"
                    disabled={busy}
                    onClick={stop}
                    title="Stops the run; it stays resumable from its last confirmed checkpoint"
                    className="rounded-md border border-amber/30 px-3 py-1.5 font-sans text-[12px] font-medium text-amber hover:border-amber/60 disabled:opacity-40"
                  >
                    Stop
                  </button>
                )}
                {(isLive || waitingToStart) && (
                  <button
                    type="button"
                    data-testid="cancel-run"
                    disabled={busy}
                    onClick={cancel}
                    title="Ends the run for good; a cancelled run cannot be resumed"
                    className="rounded-md border border-red/22 px-3 py-1.5 font-sans text-[12px] font-medium text-[#b56a6a] hover:border-red/45 hover:text-red disabled:opacity-40"
                  >
                    Cancel
                  </button>
                )}
                {resumable(state.runStatus) && (
                  <button
                    type="button"
                    data-testid="resume-run"
                    disabled={busy}
                    onClick={resume}
                    title={RESUME_TITLE}
                    className="rounded-md border border-amber/30 px-3 py-1.5 font-sans text-[12px] font-medium text-amber hover:border-amber/60 disabled:opacity-40"
                  >
                    Resume
                  </button>
                )}
                {error?.scope === "run" && (
                  <span data-testid="run-error" className="font-sans text-[11.5px] text-red">
                    {error.message}
                  </span>
                )}
                <button
                  type="button"
                  data-testid="open-terminal"
                  disabled={busy}
                  onClick={openTerminal}
                  title={TERMINAL_TITLE}
                  className="rounded-md border border-vio/40 bg-vio/12 px-3.5 py-1.5 font-sans text-[12px] font-semibold text-vio-hi hover:bg-vio/20 disabled:opacity-40"
                >
                  Open session in terminal ↗
                </button>
              </div>
              {(isLive || waitingToStart) && (
                <div
                  data-testid="terminal-write-warning"
                  className="mt-2 font-sans text-[11.5px] text-amber"
                >
                  {waitingToStart ? TERMINAL_WAITING_WARNING : TERMINAL_WRITE_WARNING}
                </div>
              )}
              {error?.scope === "terminal" ? (
                <div data-testid="terminal-note" className="mt-2 font-sans text-[11.5px] text-red">
                  {error.message}
                </div>
              ) : handoff ? (
                <div data-testid="terminal-note" className="mt-2 font-sans text-[11.5px] text-ink-4">
                  {terminalNote(handoff)}
                </div>
              ) : null}
            </div>
          )}

          <div className="relative flex min-h-0 flex-1 gap-3 overflow-hidden p-3">
            {insightsOpen ? (
              <Insights source={source} />
            ) : runId ? (
              <>
                <Stream
                  rows={rows}
                  state={state}
                  source={source}
                  label={
                    selectedBlock ??
                    (liveBlock && liveAttempt
                      ? `${liveBlock}__attempt-${liveAttempt.number}`
                      : (detail?.tree?.templateId ?? "run"))
                  }
                  sub={isLive ? "live" : state.runStatus === "succeeded" ? "closed" : state.runStatus}
                  filter={selectedBlock}
                  onClearFilter={() => setSelectedBlock(null)}
                  focus={focus}
                  onFocus={setFocus}
                  expanded={expanded}
                  onToggle={toggleRow}
                  onDecide={decide}
                  onAnswer={answer}
                  onOpenTerminal={openTerminal}
                  busy={busy}
                  gateError={error?.scope === "gate" ? error.message : null}
                  questionError={error?.scope === "question" ? error.message : null}
                  treeToggle={treeToggle}
                />
                {treeOpen && (
                  <Tree
                    detail={detail}
                    state={state}
                    selected={selectedBlock}
                    onSelect={(id) => {
                      setSelectedBlock(id)
                      setFocus(-1)
                    }}
                    onSkip={skipBlock}
                    onClose={() => setTreeOpen(false)}
                    floating={narrow}
                  />
                )}
              </>
            ) : (
              <IdleScreen
                projectName={project?.name ?? "no project"}
                hasProject={!!project}
                prompt={prompt}
                onPrompt={setPrompt}
                onStart={startRun}
                busy={busy}
                error={error?.scope === "start" ? error.message : null}
                runs={runs}
                onSelect={setRunId}
              />
            )}
          </div>
        </main>
      </div>

      <div className="flex flex-none items-center gap-1.5 border-t border-white/6 bg-[#0a0a0d] px-3 py-1.5">
        <span className="font-mono text-[10px] text-[#33333c]">
          j/k move · o expand · t tree · G end · esc clear filter · a approve
        </span>
      </div>
    </div>
  )
}

function IdleScreen({
  projectName,
  hasProject,
  prompt,
  onPrompt,
  onStart,
  busy,
  error,
  runs,
  onSelect,
}: {
  projectName: string
  hasProject: boolean
  prompt: string
  onPrompt: (v: string) => void
  onStart: () => void
  busy: boolean
  error: string | null
  runs: readonly Run[]
  onSelect: (id: string) => void
}) {
  return (
    <section
      data-testid="idle"
      className="flex flex-1 flex-col justify-center overflow-y-auto rounded-xl border border-white/6 bg-panel px-[12%]"
    >
      <div className="mb-3.5 font-mono text-[11px] font-medium tracking-[0.12em] text-ink-4">
        NEW TASK · {projectName.toUpperCase()}
      </div>
      <div className="rounded-xl border border-white/9 bg-surface px-4 py-3.5">
        <textarea
          data-testid="prompt-input"
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          placeholder="Describe the task, or paste an issue URL…"
          className="min-h-[76px] w-full resize-none bg-transparent font-mono text-[13px] leading-[1.6] text-[#c9c9d4] outline-none placeholder:text-[#6a6a76]"
        />
        <div className="mt-3 flex items-center gap-2 border-t border-white/5 pt-3">
          <span className="rounded-sm border border-white/8 px-2 py-1.5 font-mono text-[10.5px] text-[#8f8f9c]">
            claude-code
          </span>
          <span className="rounded-sm border border-white/8 px-2 py-1.5 font-mono text-[10.5px] text-[#8f8f9c]">
            analyzer: auto
          </span>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="start-run"
            disabled={busy || !prompt.trim() || !hasProject}
            onClick={onStart}
            className="rounded-md border border-vio/35 bg-vio/11 px-3.5 py-1.5 font-mono text-[11.5px] font-medium text-vio-hi hover:bg-vio/20 disabled:opacity-40"
          >
            Analyze ⏎
          </button>
        </div>
        {error && (
          <div data-testid="start-error" className="mt-2.5 font-mono text-[11px] text-red">
            {error}
          </div>
        )}
      </div>
      <div className="mt-6 mb-2 font-mono text-[9.5px] font-medium tracking-[0.14em] text-[#3f3f49]">
        RECENT
      </div>
      {runs.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onSelect(r.id)}
          className="flex items-center gap-2.5 border-b border-white/4 px-0.5 py-2 text-left font-mono text-[12px] text-[#8f8f9c] hover:text-ink"
        >
          <span className="min-w-0 flex-1 truncate">{r.prompt}</span>
          <span className="text-[10.5px] text-[#42424c]">{r.status}</span>
        </button>
      ))}
    </section>
  )
}
