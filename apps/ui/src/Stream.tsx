import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { VList, type VListHandle } from "virtua"
import type { Source } from "./api.js"
import type { ArtifactBody, EventPayload, JournalEvent } from "./model.js"
import {
  fmtClock,
  fmtDuration,
  TERMINAL_TITLE,
  toneClass,
  type StreamMode,
  type StreamRow,
} from "./presentation.js"
import { Ansi, ArtifactBodyView, Code, Markdown } from "./render.js"
import type { RunState } from "./store.js"

function useArtifact(source: Source, id: string | undefined) {
  const [body, setBody] = useState<ArtifactBody | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let live = true
    setBody(null)
    setError(null)
    source
      .artifact(id)
      .then((b) => live && setBody(b))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [source, id])

  return { body, error }
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2.5">
        <span className="font-mono text-[9.5px] font-medium tracking-[0.13em] text-[#55555f]">
          {title}
        </span>
        {note && <span className="font-mono text-[10px] text-[#3f3f49]">{note}</span>}
      </div>
      {children}
    </div>
  )
}

function KV({ pairs }: { pairs: readonly (readonly [string, ReactNode])[] }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-[3px] font-mono text-[11.5px] leading-[1.6]">
      {pairs.map(([k, v], i) => (
        <div key={i} className="contents">
          <span className="text-[#55555f]">{k}</span>
          <span className="min-w-0 break-all text-ink">{v}</span>
        </div>
      ))}
    </div>
  )
}

function ArtifactSection({
  source,
  id,
  title,
  note,
}: {
  source: Source
  id: string
  title: string
  note?: string
}) {
  const { body, error } = useArtifact(source, id)
  return (
    <Section title={title} note={note ?? body?.path}>
      {error ? (
        <div className="font-mono text-[11.5px] text-red">{error}</div>
      ) : body ? (
        <ArtifactBodyView kind={body.kind} path={body.path} text={body.text} />
      ) : (
        <div className="font-mono text-[11.5px] text-ink-4">loading…</div>
      )}
    </Section>
  )
}

function EventDetail({ event, source }: { event: JournalEvent; source: Source }) {
  const p: EventPayload = event.payload
  switch (p._tag) {
    case "SessionStarted":
    case "SessionResumed":
      return (
        <Section title="SESSION">
          <KV
            pairs={[
              ["id", <span className="text-vio">{p.sessionId}</span>],
              ["block", event.blockId ?? "—"],
              ["attempt", event.attemptId ?? "—"],
            ]}
          />
        </Section>
      )
    case "PluginResolved":
      return (
        <Section title="PLUGIN">
          <KV
            pairs={[
              ["provider", `${p.provider.name}${p.provider.version ? ` ${p.provider.version}` : ""}`],
              ["plugin", p.plugin ? `${p.plugin.name} ${p.plugin.version}` : "—"],
              ["entry", p.entry ? `${p.entry.kind} · ${p.entry.name}` : "—"],
              ["capabilities", p.capabilities.join(", ") || "—"],
              ...(p.alternative
                ? ([["binding", <span className="text-amber">alternative used</span>]] as const)
                : []),
            ]}
          />
        </Section>
      )
    case "PromptComposed":
      return <ArtifactSection source={source} id={p.promptRef} title="PROMPT" />
    case "CommandExecuted":
      return (
        <Section title="COMMAND">
          <KV
            pairs={[
              ["argv", JSON.stringify(p.argv)],
              [
                "exit",
                <span className={p.success ? "text-green" : "text-red"}>
                  {p.exitCode === null ? "killed" : p.exitCode}
                </span>,
              ],
              ["duration", fmtDuration(p.durationMs)],
              ...(p.timedOut ? ([["timed out", <span className="text-red">yes</span>]] as const) : []),
            ]}
          />
        </Section>
      )
    case "OutputChunk":
      return p.ref ? (
        <ArtifactSection source={source} id={p.ref} title={p.streamKind.toUpperCase()} />
      ) : (
        <Section title={p.streamKind.toUpperCase()}>
          <Ansi text={p.excerpt} />
        </Section>
      )
    case "ResultProduced":
      return p.outputRef ? (
        <ArtifactSection source={source} id={p.outputRef} title="RESULT" />
      ) : (
        <Section title="RESULT">
          <Code text={JSON.stringify(p.outputInline ?? null, null, 2)} lang="json" />
        </Section>
      )
    case "ArtifactCreated":
      return (
        <div className="flex flex-col gap-3">
          <Section title="ARTIFACT">
            <KV
              pairs={[
                ["id", p.artifactId],
                ["kind", p.kind],
                ["path", p.path],
                ["bytes", String(p.bytes)],
              ]}
            />
          </Section>
          <ArtifactSection source={source} id={p.artifactId} title="PREVIEW" note={p.path} />
        </div>
      )
    case "CheckpointCreated":
      return (
        <Section title="CHECKPOINT">
          <KV
            pairs={[
              ["sha", <span className="text-vio">{p.checkpointId}</span>],
              ["kind", p.kind],
            ]}
          />
        </Section>
      )
    case "VerificationReported":
      return (
        <Section title="EVIDENCE">
          <KV
            pairs={p.criteria.map(
              (c) =>
                [
                  c.criterion,
                  <span className={c.passed ? "text-green" : "text-red"}>
                    {c.passed ? "passed" : "failed"}
                  </span>,
                ] as const,
            )}
          />
        </Section>
      )
    case "FailureFeedbackForwarded":
      return <ArtifactSection source={source} id={p.packetRef} title="FEEDBACK PACKET" />
    case "ErrorRaised":
      return (
        <Section title="ERROR">
          <KV
            pairs={[
              ["class", p.class],
              ["signature", p.signature],
              ["message", p.message],
            ]}
          />
        </Section>
      )
    case "TreeAnalyzed":
      return (
        <div className="flex flex-col gap-3">
          <Section title="RATIONALE">
            <Markdown text={p.rationale} />
          </Section>
          <Section title="DECISION">
            <Code text={JSON.stringify(p.decision, null, 2)} lang="json" />
          </Section>
        </div>
      )
    case "TreeValidated":
      return (
        <Section title="VALIDATION">
          {p.errors.length === 0 ? (
            <div className="font-mono text-[11.5px] text-green">no errors</div>
          ) : (
            <KV pairs={p.errors.map((e) => [e.rule, `${e.path.join(".")} — ${e.message}`] as const)} />
          )}
        </Section>
      )
    case "RetryScheduled":
      return (
        <Section title="RETRY">
          <KV
            pairs={[
              ["class", p.class],
              ["next attempt", String(p.nextAttempt)],
              ["delay", fmtDuration(p.delayMs)],
            ]}
          />
        </Section>
      )
    case "AgentActivity":
      return (
        <Section title="ACTIVITY">
          <KV pairs={[["activity", p.activity], ["detail", p.detail ?? "—"]]} />
        </Section>
      )
    case "ApprovalDecided":
      return (
        <Section title="DECISION">
          <KV
            pairs={[
              ["gate", p.gateId],
              [
                "decision",
                <span className={p.approved ? "text-green" : "text-red"}>
                  {p.approved ? "approved" : "rejected"}
                </span>,
              ],
              ["note", p.note ?? "—"],
            ]}
          />
        </Section>
      )
    default:
      return (
        <Section title="PAYLOAD">
          <Code text={JSON.stringify(p, null, 2)} lang="json" />
        </Section>
      )
  }
}

function EventRow({
  row,
  source,
  open,
  focused,
  live,
  wrap,
  onToggle,
}: {
  row: Extract<StreamRow, { kind: "event" }>
  source: Source
  open: boolean
  focused: boolean
  live: boolean
  wrap: boolean
  onToggle: () => void
}) {
  return (
    <div className="animate-ck-in">
      <button
        type="button"
        data-testid="event-row"
        data-tag={row.view.tag}
        onClick={onToggle}
        className={`flex w-full items-baseline gap-2.5 border-l-2 px-3.5 py-1 text-left hover:bg-white/3 ${
          focused ? "border-vio bg-vio/6" : open ? "border-transparent bg-white/2" : "border-transparent"
        }`}
      >
        <span
          className={`h-[5px] w-[5px] flex-none -translate-y-0.5 rounded-full ${
            live ? "animate-ck-pulse" : ""
          }`}
          style={{ background: "currentColor" }}
        />
        <span className={`w-[74px] flex-none font-mono text-[10.5px] ${toneClass[row.view.tone]}`}>
          {row.view.tag}
        </span>
        <span
          className={`min-w-0 flex-1 font-mono text-[12px] leading-[1.7] ${
            focused || open ? "text-[#dcdce6]" : "text-[#a2a2ae]"
          } ${wrap ? "break-all whitespace-pre-wrap" : "truncate"}`}
        >
          {row.view.summary}
        </span>
        {live && <span className="h-3 w-1.5 flex-none animate-ck-blink bg-vio" />}
        <span className="w-[52px] flex-none text-right font-mono text-[10.5px] text-ink-5">
          {fmtClock(row.event.ts)}
        </span>
        <span className="w-[44px] flex-none text-right font-mono text-[10.5px] text-ink-5">
          {row.view.dur}
        </span>
      </button>
      {open && (
        <div className="mt-0.5 mr-3.5 mb-3 ml-[46px] flex flex-col gap-3">
          <EventDetail event={row.event} source={source} />
        </div>
      )}
    </div>
  )
}

function ApprovalCard({
  row,
  source,
  onDecide,
  busy,
  error,
}: {
  row: Extract<StreamRow, { kind: "approval" }>
  source: Source
  onDecide: (approved: boolean, note?: string) => void
  busy: boolean
  error: string | null
}) {
  const [note, setNote] = useState("")
  const decided = row.decision

  return (
    <div
      data-testid="approval-card"
      className={`mx-3.5 mt-2.5 mb-3.5 overflow-hidden rounded-xl border border-amber/30 bg-[#0e0d0b] ${
        decided ? "" : "animate-ck-glow"
      }`}
    >
      <div className="flex items-center gap-2.5 border-b border-amber/16 bg-amber/5 px-4 py-2.5">
        <span className="font-mono text-[11px] text-amber">◆</span>
        <span className="font-mono text-[12px] font-semibold text-amber-hi">{row.gateId}</span>
        <span className="font-mono text-[11px] text-[#7a6a4a]">
          {decided ? "decided" : "human gate · execution paused"}
        </span>
      </div>
      <div className="px-4 py-4">
        <ArtifactSection source={source} id={row.payloadRef} title="" />
      </div>
      <div className="flex items-center gap-2.5 border-t border-white/5 bg-[#0b0b0e] px-4 py-3">
        <button
          type="button"
          data-testid="approve"
          disabled={!!decided || busy}
          onClick={() => onDecide(true, note || undefined)}
          className="rounded-md border border-green/35 bg-green/10 px-4 py-2 font-mono text-[11.5px] font-medium text-green-hi disabled:opacity-40"
        >
          Approve <span className="opacity-55">a</span>
        </button>
        <button
          type="button"
          data-testid="reject"
          disabled={!!decided || busy}
          onClick={() => onDecide(false, note || undefined)}
          className="rounded-md border border-red/28 px-4 py-2 font-mono text-[11.5px] font-medium text-[#b56a6a] hover:border-red/50 hover:text-red disabled:opacity-40"
        >
          Reject with note
        </button>
        {!decided && (
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="note (optional)"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-[#0a0a0d] px-2.5 py-2 font-mono text-[11.5px] text-[#c9c9d4] outline-none placeholder:text-[#42424c] focus:border-vio/40"
          />
        )}
        <span
          className={`ml-auto font-mono text-[10.5px] ${error ? "text-red" : "text-[#42424c]"}`}
          data-testid={error ? "gate-error" : undefined}
        >
          {error ??
            (decided
              ? decided.approved
                ? "approved — execution resumed"
                : "rejected — feedback returned"
              : "execution resumes on decision")}
        </span>
      </div>
    </div>
  )
}

function QuestionCard({
  row,
  onAnswer,
  busy,
  error,
}: {
  row: Extract<StreamRow, { kind: "question" }>
  onAnswer: (answer: string) => void
  busy: boolean
  error: string | null
}) {
  const [answer, setAnswer] = useState("")
  return (
    <div
      data-testid="question-card"
      className="mx-3.5 mt-2 mb-3 rounded-lg border border-blue/28 bg-blue/5 px-4 py-3.5"
    >
      <div className="mb-2.5 flex items-center gap-2.5">
        <span className="font-mono text-[10px] font-medium tracking-[0.12em] text-blue">QUESTION</span>
        <span className="font-mono text-[10.5px] text-ink-4">{row.blockId ?? ""}</span>
      </div>
      <div className="font-mono text-[13px] leading-[1.65] text-[#c9c9d4]">{row.question}</div>
      {row.pending ? (
        <form
          className="mt-3 flex items-center gap-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (answer.trim()) onAnswer(answer.trim())
          }}
        >
          <input
            data-testid="answer-input"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="answer…"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-[#0a0a0d] px-2.5 py-2.5 font-mono text-[12px] text-[#c9c9d4] outline-none placeholder:text-[#42424c] focus:border-blue/40"
          />
          <button
            type="submit"
            data-testid="send-answer"
            disabled={busy || !answer.trim()}
            className="rounded-md border border-blue/40 bg-blue/12 px-3.5 py-2.5 font-mono text-[11.5px] font-medium text-blue-hi disabled:opacity-40"
          >
            Send ⏎
          </button>
        </form>
      ) : (
        <div className="mt-3 border-t border-white/5 pt-2.5">
          <div className="font-mono text-[9.5px] font-medium tracking-[0.13em] text-[#55555f]">
            ANSWERED
          </div>
          <div className="mt-1 font-mono text-[12px] leading-[1.6] text-[#9a9aa6]">
            {row.answer ?? "answered"}
          </div>
        </div>
      )}
      {row.pending && error && (
        <div data-testid="question-error" className="mt-2 font-mono text-[11px] text-red">
          {error}
        </div>
      )}
    </div>
  )
}

function FailureCard({
  row,
  source,
  open,
  onToggle,
}: {
  row: Extract<StreamRow, { kind: "failure" }>
  source: Source
  open: boolean
  onToggle: () => void
}) {
  return (
    <div
      data-testid="failure-card"
      className="mx-3.5 mt-1.5 mb-2.5 rounded-lg border border-red/22 bg-red/4 px-3.5 py-3"
    >
      <div className="mb-2 font-mono text-[11px] font-medium tracking-[0.06em] text-red">
        ATTEMPT FAILED
      </div>
      <div className="font-mono text-[12px] leading-[1.6] text-[#b0b0bc]">{row.title}</div>
      <div className="mt-2.5 flex flex-wrap gap-4">
        <span className="font-mono text-[10.5px] text-[#5c5c67]">{row.meta}</span>
        {row.packetRef && (
          <button
            type="button"
            data-testid="expand-packet"
            onClick={onToggle}
            className="font-mono text-[10.5px] text-vio-hi hover:underline"
          >
            feedback passed to next attempt →
          </button>
        )}
      </div>
      {open && row.packetRef && (
        <div className="mt-3">
          <ArtifactSection source={source} id={row.packetRef} title="FEEDBACK PACKET" />
        </div>
      )}
    </div>
  )
}

function SummaryCard({
  row,
  state,
  onOpenTerminal,
  busy,
}: {
  row: Extract<StreamRow, { kind: "summary" }>
  state: RunState
  onOpenTerminal: () => void
  busy: boolean
}) {
  const blocks = [...state.blocks.values()]
  const done = blocks.filter((b) => b.status === "succeeded").length
  const attempts = [...state.attempts.values()]
  const verification = state.events.findLast((e) => e.payload._tag === "VerificationReported")
  const criteria =
    verification?.payload._tag === "VerificationReported" ? verification.payload.criteria : []
  const checkpoint = state.events.findLast((e) => e.payload._tag === "CheckpointCreated")

  const ok = row.status === "succeeded"
  const accent = ok ? "border-green/24" : row.status === "failed" ? "border-red/24" : "border-white/10"

  return (
    <div
      data-testid="summary-card"
      className={`mx-3.5 mt-2.5 mb-4 overflow-hidden rounded-xl border ${accent} bg-[#0a0d0b]`}
    >
      <div className="flex items-center gap-2.5 border-b border-white/6 px-4 py-3">
        <span className={ok ? "text-green" : "text-red"}>{ok ? "✓" : "✕"}</span>
        <span
          className={`font-mono text-[12.5px] font-semibold ${ok ? "text-green-hi" : "text-red-hi"}`}
        >
          run finished · {row.status}
        </span>
      </div>
      <div className="grid grid-cols-3 border-b border-white/5">
        {[
          ["BLOCKS", `${done} / ${blocks.length}`],
          ["ATTEMPTS", `${attempts.length} used`],
          ["VERIFICATION", `${criteria.filter((c) => c.passed).length} / ${criteria.length} passed`],
        ].map(([k, v]) => (
          <div key={k} className="border-r border-white/5 px-4 py-3.5">
            <div className="font-mono text-[9.5px] font-medium tracking-[0.13em] text-ink-4">{k}</div>
            <div className="mt-1.5 font-mono text-[15px] text-ink">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2.5 border-t border-white/5 bg-[#0b0b0e] px-4 py-3">
        <button
          type="button"
          data-testid="summary-open-terminal"
          disabled={busy}
          onClick={onOpenTerminal}
          title={TERMINAL_TITLE}
          className="rounded-md border border-vio/35 bg-vio/10 px-3.5 py-2 font-mono text-[11.5px] font-medium text-vio-hi hover:bg-vio/20 disabled:opacity-40"
        >
          Open session in terminal ↗
        </button>
        <span className="ml-auto font-mono text-[10.5px] text-[#42424c]">
          {checkpoint?.payload._tag === "CheckpointCreated"
            ? `checkpoint ${checkpoint.payload.checkpointId}`
            : ""}
        </span>
      </div>
    </div>
  )
}

export interface StreamProps {
  readonly rows: readonly StreamRow[]
  readonly state: RunState
  readonly source: Source
  readonly label: string
  readonly sub: string
  readonly filter: string | null
  readonly onClearFilter: () => void
  readonly mode: StreamMode
  readonly onModeChange: (mode: StreamMode) => void
  readonly focus: number
  readonly onFocus: (i: number) => void
  readonly expanded: ReadonlySet<string>
  readonly onToggle: (key: string) => void
  readonly onDecide: (gateId: string, approved: boolean, note?: string) => void
  readonly onAnswer: (blockId: string, answer: string) => void
  readonly onOpenTerminal: () => void
  readonly busy: boolean
  readonly gateError: string | null
  readonly questionError: string | null
  readonly treeToggle: ReactNode
}

export function Stream({
  rows,
  state,
  source,
  label,
  sub,
  filter,
  onClearFilter,
  mode,
  onModeChange,
  focus,
  onFocus,
  expanded,
  onToggle,
  onDecide,
  onAnswer,
  onOpenTerminal,
  busy,
  gateError,
  questionError,
  treeToggle,
}: StreamProps) {
  const list = useRef<VListHandle>(null)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(false)
  const { runStatus } = state
  const live = runStatus === "running" || runStatus === "created"

  useEffect(() => {
    if (follow && rows.length > 0) list.current?.scrollToIndex(rows.length - 1, { align: "end" })
  }, [follow, rows.length])

  useEffect(() => {
    if (focus >= 0) list.current?.scrollToIndex(focus, { align: "nearest" })
  }, [focus])

  const onScroll = useCallback((offset: number) => {
    const h = list.current
    if (!h) return
    const atBottom = offset - h.scrollSize + h.viewportSize >= -1.5
    setFollow(atBottom)
  }, [])

  const dotColor = useMemo(() => {
    if (runStatus === "succeeded") return "border-green"
    if (runStatus === "failed") return "border-red"
    if (runStatus === "cancelled" || runStatus === "interrupted") return "border-slate"
    return state.gates.size || state.questions.size ? "border-amber" : "border-vio"
  }, [runStatus, state.gates, state.questions])

  return (
    <section
      data-testid="stream"
      className="relative flex min-w-[520px] flex-1 flex-col overflow-hidden rounded-xl border border-white/6 bg-panel"
    >
      <div className="flex flex-none items-center gap-2.5 border-b border-white/6 bg-head px-3.5 py-2.5">
        <span
          className={`h-[9px] w-[9px] flex-none rounded-full border-2 ${dotColor} ${live ? "animate-ck-pulse" : ""}`}
        />
        <span className="flex-none font-mono text-[12px] font-medium text-[#c4c4ce]">{label}</span>
        {sub && <span className="truncate font-mono text-[11px] text-ink-4">· {sub}</span>}
        {filter && (
          <button
            type="button"
            data-testid="clear-filter"
            onClick={onClearFilter}
            className="flex items-center gap-1.5 rounded-sm border border-vio/30 bg-vio/9 px-2 py-0.5 font-mono text-[10.5px] text-vio-hi"
          >
            filtered: {filter} ✕
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          data-testid="stream-mode"
          onClick={() => onModeChange(mode === "essential" ? "full" : "essential")}
          title="essential hides narration the tree and attempt header already carry; full shows every journal row"
          className={`flex-none rounded-sm border px-2 py-0.5 font-mono text-[10px] ${
            mode === "full" ? "border-white/18 text-[#c4c4ce]" : "border-white/7 text-[#55555f]"
          }`}
        >
          {mode === "full" ? "full log" : "essential"}
        </button>
        <button
          type="button"
          onClick={() => setWrap((w) => !w)}
          className={`flex-none rounded-sm border px-2 py-0.5 font-mono text-[10px] ${
            wrap ? "border-white/18 text-[#c4c4ce]" : "border-white/7 text-[#55555f]"
          }`}
        >
          wrap
        </button>
        <button
          type="button"
          data-testid="follow"
          onClick={() => setFollow((f) => !f)}
          className={`flex-none rounded-sm border px-2 py-0.5 font-mono text-[10px] ${
            follow ? "border-vio/30 bg-vio/8 text-vio-hi" : "border-white/7 text-[#55555f]"
          }`}
        >
          follow
        </button>
        {treeToggle}
      </div>

      <div className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center font-mono text-[11.5px] text-ink-4">
            waiting for events…
          </div>
        ) : (
          <VList ref={list} data={rows as StreamRow[]} onScroll={onScroll} className="h-full py-1.5">
            {(row, i) => {
              const open = expanded.has(row.key)
              const isLast = i === rows.length - 1
              switch (row.kind) {
                case "event":
                  return (
                    <EventRow
                      row={row}
                      source={source}
                      open={open}
                      focused={focus === i}
                      live={live && isLast}
                      wrap={wrap}
                      onToggle={() => {
                        onFocus(i)
                        onToggle(row.key)
                      }}
                    />
                  )
                case "attempt":
                  return (
                    <div
                      data-testid="attempt-header"
                      className="mx-3.5 mt-3.5 mb-1.5 flex items-center gap-2.5 rounded-md border border-white/8 border-l-2 border-l-vio bg-white/2 px-3 py-2"
                    >
                      <span className="flex-none font-mono text-[11.5px] font-semibold text-[#c4c4ce]">
                        {row.title}
                      </span>
                      <span className="truncate font-mono text-[11px] text-[#5c5c67]">{row.meta}</span>
                      <div className="h-px min-w-3 flex-1 bg-white/6" />
                      <span className="flex-none font-mono text-[10.5px] text-[#42424c]">
                        {row.right}
                      </span>
                    </div>
                  )
                case "approval":
                  return (
                    <ApprovalCard
                      row={row}
                      source={source}
                      busy={busy}
                      error={gateError}
                      onDecide={(approved, note) => onDecide(row.gateId, approved, note)}
                    />
                  )
                case "question":
                  return (
                    <QuestionCard
                      row={row}
                      busy={busy}
                      error={questionError}
                      onAnswer={(a) => onAnswer(row.blockId, a)}
                    />
                  )
                case "banner":
                  return (
                    <div className="mx-3.5 my-2 flex items-center gap-2.5 rounded-lg border border-blue/25 bg-blue/6 px-3 py-2.5">
                      <span className="font-mono text-[12px] text-blue">↻</span>
                      <span className="font-mono text-[11.5px] leading-[1.5] text-blue-hi">
                        {row.title}
                      </span>
                    </div>
                  )
                case "failure":
                  return (
                    <FailureCard
                      row={row}
                      source={source}
                      open={open}
                      onToggle={() => onToggle(row.key)}
                    />
                  )
                case "summary":
                  return (
                    <SummaryCard
                      row={row}
                      state={state}
                      onOpenTerminal={onOpenTerminal}
                      busy={busy}
                    />
                  )
              }
            }}
          </VList>
        )}
      </div>

      {!follow && rows.length > 0 && (
        <button
          type="button"
          data-testid="jump-to-live"
          onClick={() => setFollow(true)}
          className="absolute bottom-3.5 left-1/2 -translate-x-1/2 rounded-[20px] border border-vio/35 bg-[rgba(20,20,28,0.95)] px-3.5 py-1.5 font-mono text-[11px] text-vio-hi shadow-[0_4px_18px_rgba(0,0,0,0.5)] backdrop-blur-[6px]"
        >
          ↓ jump to live
        </button>
      )}
    </section>
  )
}
