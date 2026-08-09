import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { httpSource, type NewAttachment, type Source } from "./api.js"
import { Insights } from "./Insights.js"
import { isMockState, mockSource } from "./mock.js"
import type {
  Project,
  Run,
  RunAttachment,
  RunDetail,
  RunStatus,
  TerminalHandoff,
} from "./model.js"
import {
  buildRows,
  filterRows,
  fmtElapsed,
  REGENERATE_TITLE,
  RESUME_TITLE,
  resumable,
  RUN_TITLE,
  startable,
  type StreamMode,
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
  const [width, setWidth] = useState(() => window.innerWidth)
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null)
  const [streamMode, setStreamMode] = useState<StreamMode>("essential")
  const [focus, setFocus] = useState(-1)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ scope: ActionScope; message: string } | null>(null)
  const [prompt, setPrompt] = useState("")
  const [attachments, setAttachments] = useState<readonly DraftAttachment[]>([])
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
  const allRows = useMemo(
    () => buildRows(state, maxAttempts, streamMode),
    [state, maxAttempts, streamMode],
  )
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

  const deleteRun = useCallback(
    (id: string) => {
      if (busy) return
      const target = runs.find((r) => r.id === id)
      // Native confirm, not a layout element: delete drops the branch and every checkpoint on it.
      if (!window.confirm(`Delete "${target?.prompt ?? id}" and everything it produced? This cannot be undone.`)) {
        return
      }
      void act("run", async () => {
        await source.deleteRun(id)
        if (project) setRuns(await source.runs(project.id))
        if (id === runId) {
          setRunId(null)
          setSelectedBlock(null)
          setFocus(-1)
          setExpanded(new Set())
          setHandoff(null)
        }
      })
    },
    [act, source, project, runId, busy, runs],
  )

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
      const encoded = await Promise.all(attachments.map((draft) => encodeAttachment(draft.file)))
      const { runId: created } = await source.createRun(project.id, prompt.trim(), encoded)
      setRunId(created)
      setRuns(await source.runs(project.id))
      setPrompt("")
      attachments.forEach((draft) => draft.previewUrl && URL.revokeObjectURL(draft.previewUrl))
      setAttachments([])
    })
  }, [act, source, project, prompt, attachments])

  const attach = useCallback((files: readonly File[]) => {
    setAttachments((prev) => [
      ...prev,
      ...files.map((file) => ({
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      })),
    ])
  }, [])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const gone = prev[index]
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((_, at) => at !== index)
    })
  }, [])

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
        // Only rows with an expandable body; cards ignore the key rather than leak into `expanded`.
        if (row && (row.kind === "event" || row.kind === "failure")) toggleRow(row.key)
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
          onDelete={deleteRun}
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
            <div className="mx-3 mt-3 flex-none rounded-xl border border-white/9 bg-head px-4 pt-3.5 pb-3">
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
              <RunAttachments attachments={detail?.attachments ?? []} />
              <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
                <span className="font-sans text-[11.5px] text-[#87878f]" data-testid="elapsed">
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
                  mode={streamMode}
                  onModeChange={(m) => {
                    setStreamMode(m)
                    setFocus(-1)
                  }}
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
                  insetForTree={narrow}
                />
                <Tree
                  detail={detail}
                  state={state}
                  selected={selectedBlock}
                  onSelect={(id) => {
                    setSelectedBlock(id)
                    setFocus(-1)
                  }}
                  onSkip={skipBlock}
                  floating={narrow}
                />
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
                attachments={attachments}
                onAttach={attach}
                onRemoveAttachment={removeAttachment}
              />
            )}
          </div>
        </main>
      </div>

      <div className="flex flex-none items-center gap-1.5 border-t border-white/9 bg-rail px-3 py-1.5">
        <span className="font-mono text-[10px] text-[#5a5a68]">
          j/k move · o expand · G end · esc clear filter · a approve
        </span>
        {error?.scope === "run" && !(runId && run) && (
          <span data-testid="run-error" className="ml-auto font-mono text-[10px] text-red">
            {error.message}
          </span>
        )}
      </div>
    </div>
  )
}

/** A file picked or pasted into the new-task form, kept as-is until Analyze uploads it. */
export interface DraftAttachment {
  readonly file: File
  /** Object URL for an image thumbnail; null for everything else. */
  readonly previewUrl: string | null
}

const encodeAttachment = (file: File) =>
  new Promise<NewAttachment>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ name: file.name, contentBase64: url.slice(url.indexOf(",") + 1) })
    }
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`))
    reader.readAsDataURL(file)
  })

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|svg|avif)$/i

/** What the run was created with; images preview inline, everything else opens from its name. */
export function RunAttachments({ attachments }: { attachments: readonly RunAttachment[] }) {
  if (attachments.length === 0) return null
  return (
    <div data-testid="run-attachments" className="mt-2.5 flex flex-wrap items-end gap-2">
      {attachments.map((attachment) => {
        const raw = `/api/artifacts/${attachment.id}/raw`
        return IMAGE_NAME.test(attachment.name) ? (
          <a key={attachment.id} href={raw} target="_blank" rel="noreferrer" title={attachment.name}>
            <img
              src={raw}
              alt={attachment.name}
              className="max-h-24 rounded-md border border-white/14"
            />
          </a>
        ) : (
          <a
            key={attachment.id}
            href={raw}
            target="_blank"
            rel="noreferrer"
            className="rounded-sm border border-white/12 px-2 py-1 font-mono text-[10.5px] text-[#8f8f9c] hover:text-ink"
          >
            {attachment.name}
          </a>
        )
      })}
    </div>
  )
}

export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly DraftAttachment[]
  onRemove: (index: number) => void
}) {
  if (attachments.length === 0) return null
  return (
    <div data-testid="attachment-chips" className="mt-2 flex flex-wrap items-end gap-2">
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.file.name}-${index}`}
          className="flex items-center gap-1.5 rounded-sm border border-white/12 px-2 py-1 font-mono text-[10.5px] text-[#8f8f9c]"
        >
          {attachment.previewUrl && (
            <img src={attachment.previewUrl} alt="" className="max-h-12 rounded-sm" />
          )}
          <span className="max-w-48 truncate">{attachment.file.name}</span>
          <button
            type="button"
            data-testid={`remove-attachment-${index}`}
            onClick={() => onRemove(index)}
            aria-label={`Remove ${attachment.file.name}`}
            className="text-[#87878f] hover:text-red"
          >
            ×
          </button>
        </span>
      ))}
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
  attachments,
  onAttach,
  onRemoveAttachment,
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
  attachments: readonly DraftAttachment[]
  onAttach: (files: readonly File[]) => void
  onRemoveAttachment: (index: number) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <section
      data-testid="idle"
      className="flex flex-1 flex-col justify-center overflow-y-auto rounded-xl border border-white/9 bg-panel px-[12%]"
    >
      <div className="mb-3.5 font-mono text-[11px] font-medium tracking-[0.12em] text-ink-4">
        NEW TASK · {projectName.toUpperCase()}
      </div>
      <div className="rounded-xl border border-white/13 bg-surface px-4 py-3.5">
        <textarea
          data-testid="prompt-input"
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          placeholder="Describe the task, or paste an issue URL…"
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.length > 0) {
              e.preventDefault()
              onAttach(files)
            }
          }}
          className="min-h-[76px] w-full resize-none bg-transparent font-mono text-[13px] leading-[1.6] text-[#c9c9d4] outline-none placeholder:text-[#6a6a76]"
        />
        <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />
        <div className="mt-3 flex items-center gap-2 border-t border-white/8 pt-3">
          <span className="rounded-sm border border-white/12 px-2 py-1.5 font-mono text-[10.5px] text-[#8f8f9c]">
            claude-code
          </span>
          <span className="rounded-sm border border-white/12 px-2 py-1.5 font-mono text-[10.5px] text-[#8f8f9c]">
            analyzer: auto
          </span>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="attach-input"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) onAttach(files)
              e.target.value = ""
            }}
          />
          <button
            type="button"
            data-testid="attach-files"
            onClick={() => fileInput.current?.click()}
            title="Attach images or files; pasting a screenshot into the prompt works too"
            className="rounded-sm border border-white/12 px-2 py-1.5 font-mono text-[10.5px] text-[#8f8f9c] hover:border-vio/40 hover:text-ink"
          >
            + attach
          </button>
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
      <div className="mt-6 mb-2 font-mono text-[9.5px] font-medium tracking-[0.14em] text-[#666672]">
        RECENT
      </div>
      {runs.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onSelect(r.id)}
          className="flex items-center gap-2.5 border-b border-white/6 px-0.5 py-2 text-left font-mono text-[12px] text-[#8f8f9c] hover:text-ink"
        >
          <span className="min-w-0 flex-1 truncate">{r.prompt}</span>
          <span className="text-[10.5px] text-[#6b6b77]">{r.status}</span>
        </button>
      ))}
    </section>
  )
}
