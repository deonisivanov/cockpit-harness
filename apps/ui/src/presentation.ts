import type { EventPayload, JournalEvent, RunStatus, TerminalHandoff } from "./model.js"
import type { AttemptState, RunState } from "./store.js"

/** Plan §9: re-entry is offered for a run that stopped without finishing, and for nothing else. */
export const resumable = (status: RunStatus): boolean =>
  status === "interrupted" || status === "failed"

export const startable = (status: RunStatus): boolean => status === "awaiting-start"

/**
 * How many trees the run has settled on. The artifact is what `GET /api/runs/:id` reads back, and
 * it is written after the transforms — `TreeAnalyzed` only says the analyzer chose one.
 */
export const treeRevisions = (events: readonly JournalEvent[]): number =>
  events.filter((e) => e.payload._tag === "ArtifactCreated" && e.payload.kind === "workflow-tree")
    .length

export const RUN_TITLE = "Executes this workflow; nothing has run so far"

export const REGENERATE_TITLE =
  "Plans the task again and replaces this workflow; the newest one is what Run executes"

export const RESUME_TITLE =
  "Carries this run on from its last confirmed checkpoint; blocks it already finished are not executed again"

export const TERMINAL_TITLE =
  "Opens the run's canonical session in a terminal, seeded with the task brief"

/** Plan §10: the button stays available during execution, and the risk is on screen, not in a tooltip. */
export const TERMINAL_WRITE_WARNING =
  "This run is still executing — a block may hold write access to this worktree, so read at your own risk."

export const TERMINAL_WAITING_WARNING =
  "This run has not started — anything written in this worktree now is left for it to find, and a dirty worktree is refused when you press Run."

/** One line for the handoff: which terminal took it, which session, and what had to be rebuilt. */
export const terminalNote = (handoff: TerminalHandoff): string =>
  [
    `opened a ${handoff.mode === "herdr" ? "herdr tab" : "Ghostty window"} with ${
      handoff.fallback === "fresh-session"
        ? "a new session — the previous one could not be resumed"
        : handoff.briefPath
          ? "a new session seeded with the task brief"
          : "the run's session, resumed"
    }`,
    ...(handoff.fallback === "fresh-worktree"
      ? ["the worktree was gone, so it was checked out again from the last checkpoint"]
      : []),
    ...(handoff.warning === undefined ? [] : [`herdr was unavailable: ${handoff.warning}`]),
  ].join(" · ")

export type Tone = "vio" | "blue" | "green" | "amber" | "red" | "slate" | "mute"

export const toneClass: Record<Tone, string> = {
  vio: "text-vio",
  blue: "text-blue",
  green: "text-green",
  amber: "text-amber",
  red: "text-red",
  slate: "text-slate",
  mute: "text-ink-3",
}

export interface EventView {
  readonly tag: string
  readonly tone: Tone
  readonly summary: string
  readonly dur: string
}

export const fmtDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, "0")}`
}

/** Coarse enough for a list: a task from yesterday is "yd", not a timestamp nobody reads. */
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

export const fmtClock = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 8)
}

export const fmtElapsed = (fromIso: string, toIso?: string): string => {
  const from = new Date(fromIso).getTime()
  const to = toIso ? new Date(toIso).getTime() : Date.now()
  if (Number.isNaN(from) || Number.isNaN(to)) return ""
  const s = Math.max(0, Math.round((to - from) / 1000))
  return `${Math.floor(s / 60)}m ${(s % 60).toString().padStart(2, "0")}s`
}

const firstLine = (s: string): string => {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? s
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

export function describe(payload: EventPayload): EventView {
  const none = { dur: "" }
  switch (payload._tag) {
    case "SessionStarted":
      return { tag: "session", tone: "vio", summary: `session started · ${payload.sessionId}`, ...none }
    case "SessionResumed":
      return { tag: "session", tone: "vio", summary: `session resumed · ${payload.sessionId}`, ...none }
    case "AgentActivity":
      return {
        tag: "agent",
        tone: "blue",
        summary: payload.detail ? `${payload.activity} · ${payload.detail}` : payload.activity,
        ...none,
      }
    case "PluginResolved": {
      const name = payload.plugin ? `${payload.plugin.name}@${payload.plugin.version}` : payload.provider.name
      return {
        tag: "plugin",
        tone: payload.alternative ? "amber" : "vio",
        summary: payload.alternative ? `${name} · alternative binding used` : name,
        ...none,
      }
    }
    case "PromptComposed":
      return { tag: "prompt", tone: "mute", summary: "prompt composed", ...none }
    case "CommandExecuted":
      return {
        tag: "bash",
        tone: payload.success ? "slate" : "red",
        summary: payload.argv.join(" "),
        dur: fmtDuration(payload.durationMs),
      }
    case "OutputChunk":
      return {
        tag: payload.streamKind === "assistant" ? "agent" : payload.streamKind,
        tone: payload.streamKind === "stderr" ? "red" : "slate",
        summary: firstLine(payload.excerpt),
        ...none,
      }
    case "ResultProduced": {
      // Only answerQuestion's `answer` and agentTask's `summary` are meant as a preview; a finalize
      // commit stays the fixed label since RunFinalized's own row already renders it.
      const inline = payload.outputInline
      const record = typeof inline === "object" && inline !== null ? (inline as Record<string, unknown>) : undefined
      const field = record?.answer ?? record?.summary
      const text = typeof field === "string" && field.length > 0 ? field : undefined
      return {
        tag: "result",
        tone: "green",
        summary: text === undefined ? "result produced" : firstLine(text),
        ...none,
      }
    }
    case "ErrorRaised":
      return { tag: "error", tone: "red", summary: `${payload.signature} — ${payload.message}`, ...none }
    case "ArtifactCreated":
      return { tag: "artifact", tone: "green", summary: payload.path, ...none }
    case "CheckpointCreated":
      return {
        tag: "checkpoint",
        tone: "slate",
        summary: `checkpoint ${payload.checkpointId} · ${payload.kind}`,
        ...none,
      }
    case "RetryScheduled":
      return {
        tag: "retry",
        tone: "amber",
        summary: `attempt ${payload.nextAttempt} scheduled · ${payload.class} · +${fmtDuration(payload.delayMs)}`,
        ...none,
      }
    case "VerificationReported": {
      const passed = payload.criteria.filter((c) => c.passed).length
      return {
        tag: "verify",
        tone: passed === payload.criteria.length ? "green" : "red",
        summary: `verification ${passed}/${payload.criteria.length} passed`,
        ...none,
      }
    }
    case "FailureFeedbackForwarded":
      return { tag: "feedback", tone: "amber", summary: "envelope forwarded to next attempt", ...none }
    case "TreeAnalyzed":
      return {
        tag: "analyzer",
        tone: payload.fallback ? "amber" : "vio",
        summary: payload.fallback
          ? `template fallback · ${payload.templateId}`
          : `template selected · ${payload.templateId}`,
        ...none,
      }
    case "TreeValidated":
      return {
        tag: "tree",
        tone: payload.errors.length ? "red" : "mute",
        summary: payload.errors.length
          ? `${payload.errors.length} validation error(s)`
          : "workflow validated",
        ...none,
      }
    case "TreeTransformed":
      return { tag: "tree", tone: "mute", summary: `transform · ${payload.name}`, ...none }
    case "ApprovalDecided":
      return {
        tag: "approval",
        tone: payload.approved ? "green" : "red",
        summary: payload.approved ? `${payload.gateId} approved` : `${payload.gateId} rejected`,
        ...none,
      }
    case "AttemptFinished":
      return { tag: "attempt", tone: payload.verdict === "success" ? "green" : "red", summary: `attempt ${payload.verdict}`, ...none }
    case "BlockSkipped":
      return { tag: "block", tone: "slate", summary: `skipped · ${payload.reason}`, ...none }
    case "BlockSkipRequested":
      return { tag: "block", tone: "amber", summary: `skip requested · ${payload.nodeId}`, ...none }
    case "BlockReplayed":
      return { tag: "resume", tone: "amber", summary: `not re-executed · ${payload.reason}`, ...none }
    case "RunResumed":
      return { tag: "resume", tone: "vio", summary: "run resumed", ...none }
    case "RunFinalized":
      return {
        tag: "event",
        tone: "green",
        summary: `${payload.targetBranch} → ${payload.commit.slice(0, 8)} · ${payload.mode} of ${payload.commits}`,
        ...none,
      }
    default:
      return { tag: "event", tone: "mute", summary: payload._tag, ...none }
  }
}

/** Events the stream never shows as their own row: run/block bookkeeping the other panels already carry. */
const HIDDEN = new Set([
  "RunCreated",
  "RunStarted",
  "BlockStarted",
  "BlockFinished",
  // The answer is shown on the question card it belongs to, not as a row of its own.
  "QuestionAnswered",
])

export type StreamMode = "essential" | "full"

/**
 * Essential mode additionally hides narration: provenance the tree and the attempt header already
 * carry, or raw output that has an artifact behind it and a block boundary pointing at it.
 */
const ESSENTIAL_HIDDEN = new Set([
  "OutputChunk",
  "AgentActivity",
  "PromptComposed",
  "SessionStarted",
  "SessionResumed",
  "ArtifactCreated",
  "PluginResolved",
  "TreeTransformed",
  "CheckpointCreated",
])

export type StreamRow =
  | { readonly kind: "event"; readonly key: string; readonly event: JournalEvent; readonly view: EventView }
  | {
      readonly kind: "attempt"
      readonly key: string
      readonly event: JournalEvent
      readonly title: string
      readonly meta: string
      readonly right: string
    }
  | {
      readonly kind: "approval"
      readonly key: string
      readonly event: JournalEvent
      readonly gateId: string
      readonly payloadRef: string
      readonly decision?: { readonly approved: boolean; readonly note?: string }
    }
  | {
      readonly kind: "question"
      readonly key: string
      readonly event: JournalEvent
      readonly question: string
      readonly blockId: string
      readonly pending: boolean
      readonly answer?: string
    }
  | { readonly kind: "banner"; readonly key: string; readonly event: JournalEvent; readonly title: string }
  | {
      readonly kind: "failure"
      readonly key: string
      readonly event: JournalEvent
      readonly title: string
      readonly meta: string
      readonly packetRef?: string
    }
  | {
      readonly kind: "summary"
      readonly key: string
      readonly event: JournalEvent
      readonly status: "succeeded" | "failed" | "cancelled"
    }

/**
 * Rows are rebuilt on every appended event; handing back the previous object when nothing about a
 * row changed keeps React and virtua from re-rendering settled rows — an expanded xterm viewport
 * is destroyed and recreated if its row remounts.
 */
const rowCache = new WeakMap<JournalEvent, StreamRow>()

const sameRow = (a: StreamRow, b: StreamRow): boolean => {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) {
    if (k === "event") continue
    const va = (a as unknown as Record<string, unknown>)[k]
    const vb = (b as unknown as Record<string, unknown>)[k]
    if (va === vb) continue
    // `decision` and `view` are the only fields rebuilt as fresh objects each pass.
    if (k === "decision" || k === "view") {
      const oa = va as Record<string, unknown> | undefined
      const ob = vb as Record<string, unknown> | undefined
      if (oa && ob && Object.keys(oa).every((f) => oa[f] === ob[f])) continue
    }
    return false
  }
  return true
}

const cached = (event: JournalEvent, row: StreamRow): StreamRow => {
  const prev = rowCache.get(event)
  if (prev && prev.kind === row.kind && sameRow(prev, row)) return prev
  rowCache.set(event, row)
  return row
}

const attemptTitle = (
  a: AttemptState | undefined,
  blockId: string | undefined,
  max?: number,
): string => `Attempt ${a?.number ?? 1}${max ? ` of ${max}` : ""} — ${blockId ?? "block"}`

export function buildRows(
  state: RunState,
  maxAttempts?: ReadonlyMap<string, number>,
  mode: StreamMode = "essential",
): StreamRow[] {
  const decisions = new Map<string, { approved: boolean; note?: string }>()
  const packets = new Map<string, string>()
  const errorOf = new Map<string, string>()
  // Bucketed per block: interleaved questions from parallel branches must not swap answers.
  const answers = new Map<string, string[]>()

  for (const e of state.events) {
    const p = e.payload
    if (p._tag === "ApprovalDecided") decisions.set(p.gateId, { approved: p.approved, note: p.note })
    if (p._tag === "FailureFeedbackForwarded" && e.attemptId) packets.set(e.attemptId, p.packetRef)
    if (p._tag === "ErrorRaised" && e.attemptId) errorOf.set(e.attemptId, p.message)
    if (p._tag === "QuestionAnswered") {
      const key = e.blockId ?? ""
      const bucket = answers.get(key)
      if (bucket) bucket.push(p.answer)
      else answers.set(key, [p.answer])
    }
  }

  const rows: StreamRow[] = []
  for (const e of state.events) {
    const p = e.payload
    const key = String(e.seq)
    switch (p._tag) {
      case "AttemptStarted": {
        const a = e.attemptId ? state.attempts.get(e.attemptId) : undefined
        rows.push(
          cached(e, {
            kind: "attempt",
            key,
            event: e,
            title: attemptTitle(a, e.blockId, e.blockId ? maxAttempts?.get(e.blockId) : undefined),
            meta: p.sessionId ? `session ${p.sessionId}` : "",
            right: `started ${fmtClock(e.ts)}`,
          }),
        )
        break
      }
      case "ApprovalRequested":
        rows.push(
          cached(e, {
            kind: "approval",
            key,
            event: e,
            gateId: p.gateId,
            payloadRef: p.payloadRef,
            decision: decisions.get(p.gateId),
          }),
        )
        break
      case "QuestionAsked": {
        const blockId = e.blockId ?? ""
        const answer = answers.get(blockId)?.shift()
        rows.push(
          cached(e, {
            kind: "question",
            key,
            event: e,
            question: p.question,
            blockId,
            pending: state.questions.get(blockId)?.seq === e.seq,
            ...(answer === undefined ? {} : { answer }),
          }),
        )
        break
      }
      case "RunRecovered":
        rows.push(
          cached(e, {
            kind: "banner",
            key,
            event: e,
            title: p.lastCheckpoint
              ? `run recovered from checkpoint ${p.lastCheckpoint} — stream backfilled`
              : "run recovered — stream backfilled",
          }),
        )
        break
      case "AttemptFinished": {
        if (p.verdict === "success") break
        const a = e.attemptId ? state.attempts.get(e.attemptId) : undefined
        rows.push(
          cached(e, {
            kind: "failure",
            key,
            event: e,
            title:
              (e.attemptId ? errorOf.get(e.attemptId) : undefined) ??
              `Attempt ${a?.number ?? ""} ended with verdict ${p.verdict}.`.trim(),
            meta: `${p.verdict} · ${e.blockId ?? ""}`.trim(),
            packetRef: e.attemptId ? packets.get(e.attemptId) : undefined,
          }),
        )
        break
      }
      case "RunFinished":
        rows.push(cached(e, { kind: "summary", key, event: e, status: p.status }))
        break
      case "RunCancelled":
        rows.push(cached(e, { kind: "summary", key, event: e, status: "cancelled" }))
        break
      case "RunStopped":
        rows.push(cached(e, { kind: "banner", key, event: e, title: "run stopped — resumable" }))
        break
      case "RunAwaitingStart":
        rows.push(
          cached(e, {
            kind: "banner",
            key,
            event: e,
            title: "workflow ready — nothing runs until you press Run",
          }),
        )
        break
      default: {
        if (HIDDEN.has(p._tag)) break
        if (mode === "essential") {
          if (ESSENTIAL_HIDDEN.has(p._tag)) break
          if (p._tag === "TreeValidated" && p.errors.length === 0) break
        }
        rows.push(cached(e, { kind: "event", key, event: e, view: describe(p) }))
      }
    }
  }
  return rows
}

export const filterRows = (rows: readonly StreamRow[], blockId: string | null): StreamRow[] =>
  blockId === null ? [...rows] : rows.filter((r) => r.event.blockId === blockId)

export interface DiffLine {
  readonly kind: "add" | "del" | "hunk" | "file" | "ctx"
  readonly text: string
  /** `[start, end)` offsets into `text` that differ from the paired line. */
  readonly emphasis?: readonly [number, number]
}

const commonPrefix = (a: string, b: string): number => {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return i
}

const commonSuffix = (a: string, b: string, floor: number): number => {
  let i = 0
  while (i < a.length - floor && i < b.length - floor && a[a.length - 1 - i] === b[b.length - 1 - i])
    i += 1
  return i
}

/** Adjacent -/+ pairs get their differing middle highlighted, the way a review tool does. */
export function parseDiff(src: string): DiffLine[] {
  const lines = src.split("\n").map((text): DiffLine => {
    if (text.startsWith("+++") || text.startsWith("---")) return { kind: "file", text }
    if (text.startsWith("@@")) return { kind: "hunk", text }
    if (text.startsWith("+")) return { kind: "add", text }
    if (text.startsWith("-")) return { kind: "del", text }
    return { kind: "ctx", text }
  })

  for (let i = 0; i < lines.length - 1; i += 1) {
    const del = lines[i]!
    const add = lines[i + 1]!
    if (del.kind !== "del" || add.kind !== "add") continue
    const a = del.text.slice(1)
    const b = add.text.slice(1)
    const pre = commonPrefix(a, b)
    const suf = commonSuffix(a, b, pre)
    if (pre === a.length && pre === b.length) continue
    lines[i] = { ...del, emphasis: [pre + 1, a.length - suf + 1] }
    lines[i + 1] = { ...add, emphasis: [pre + 1, b.length - suf + 1] }
  }
  return lines
}
