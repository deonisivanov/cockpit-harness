import { useCallback, useEffect, useMemo, useState } from "react"
import type {
  AttemptVerdict,
  BlockKind,
  BlockStatus,
  JournalEvent,
  RunStatus,
} from "./model.js"

export interface BlockState {
  readonly id: string
  readonly defId?: string
  readonly kind?: BlockKind
  readonly status: BlockStatus
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly skipReason?: string
  readonly attemptIds: readonly string[]
}

export interface AttemptState {
  readonly id: string
  readonly blockId: string
  readonly number: number
  readonly sessionId?: string
  readonly verdict?: AttemptVerdict
  readonly status: "running" | "succeeded" | "failed" | "interrupted"
  readonly startedAt: string
  readonly finishedAt?: string
}

export interface PendingGate {
  readonly gateId: string
  readonly payloadRef: string
  readonly blockId?: string
  readonly seq: number
}

export interface PendingQuestion {
  readonly blockId: string
  readonly question: string
  readonly seq: number
}

export interface RunState {
  readonly events: readonly JournalEvent[]
  readonly lastSeq: number
  readonly runStatus: RunStatus
  /** From the `RunStarted` event: the runs table has no start column. */
  readonly startedAt?: string
  readonly blocks: ReadonlyMap<string, BlockState>
  readonly attempts: ReadonlyMap<string, AttemptState>
  /** Parallel branches can park several at once, so these are maps, not single slots. */
  readonly gates: ReadonlyMap<string, PendingGate>
  readonly questions: ReadonlyMap<string, PendingQuestion>
  readonly seen: ReadonlySet<number>
}

export const emptyRunState = (): RunState => ({
  events: [],
  lastSeq: 0,
  runStatus: "created",
  blocks: new Map(),
  attempts: new Map(),
  gates: new Map(),
  questions: new Map(),
  seen: new Set(),
})

const verdictStatus = (v: AttemptVerdict): AttemptState["status"] =>
  v === "success" ? "succeeded" : v === "interrupted" || v === "cancelled" ? "interrupted" : "failed"

const upsertBlock = (
  blocks: Map<string, BlockState>,
  id: string,
  patch: Partial<BlockState>,
): void => {
  const prev = blocks.get(id) ?? { id, status: "running" as BlockStatus, attemptIds: [] }
  blocks.set(id, { ...prev, ...patch })
}

export function applyEvents(prev: RunState, incoming: readonly JournalEvent[]): RunState {
  // The socket also carries heartbeats, which have no seq and no payload to fold.
  const fresh = incoming
    .filter((e) => typeof e?.seq === "number" && e.payload != null && !prev.seen.has(e.seq))
    .sort((a, b) => a.seq - b.seq)
  if (fresh.length === 0) return prev

  const seen = new Set(prev.seen)
  const blocks = new Map(prev.blocks)
  const attempts = new Map(prev.attempts)
  const gates = new Map(prev.gates)
  const questions = new Map(prev.questions)
  let runStatus = prev.runStatus
  let startedAt = prev.startedAt

  for (const e of fresh) {
    seen.add(e.seq)
    const p = e.payload
    switch (p._tag) {
      case "RunCreated":
        runStatus = "created"
        break
      case "RunAwaitingStart":
        runStatus = "awaiting-start"
        break
      case "RunStarted":
        runStatus = "running"
        startedAt ??= e.ts
        break
      // The scan that writes this one only marks what a dead daemon left behind; nothing is
      // executing again until a resume says so.
      case "RunRecovered":
        runStatus = "interrupted"
        break
      case "RunResumed":
        runStatus = "running"
        break
      case "RunFinished":
        runStatus = p.status
        break
      case "RunCancelled":
        runStatus = "cancelled"
        break
      case "RunStopped":
        runStatus = "interrupted"
        break
      case "BlockStarted":
        if (e.blockId)
          upsertBlock(blocks, e.blockId, {
            defId: p.defId,
            kind: p.kind,
            status: "running",
            startedAt: e.ts,
            finishedAt: undefined,
          })
        break
      case "BlockFinished":
        if (e.blockId) upsertBlock(blocks, e.blockId, { status: p.status, finishedAt: e.ts })
        break
      case "BlockSkipped":
        if (e.blockId)
          upsertBlock(blocks, e.blockId, {
            status: "skipped",
            skipReason: p.reason,
            finishedAt: e.ts,
          })
        break
      case "AttemptStarted":
        if (e.attemptId && e.blockId) {
          attempts.set(e.attemptId, {
            id: e.attemptId,
            blockId: e.blockId,
            number: p.number,
            sessionId: p.sessionId,
            status: "running",
            startedAt: e.ts,
          })
          const block = blocks.get(e.blockId)
          const ids = block?.attemptIds ?? []
          if (!ids.includes(e.attemptId))
            upsertBlock(blocks, e.blockId, { attemptIds: [...ids, e.attemptId] })
        }
        break
      case "AttemptFinished": {
        const a = e.attemptId ? attempts.get(e.attemptId) : undefined
        if (a)
          attempts.set(a.id, {
            ...a,
            verdict: p.verdict,
            status: verdictStatus(p.verdict),
            finishedAt: e.ts,
          })
        break
      }
      case "AttemptInterrupted": {
        const a = e.attemptId ? attempts.get(e.attemptId) : undefined
        if (a) attempts.set(a.id, { ...a, status: "interrupted", finishedAt: e.ts })
        break
      }
      case "ApprovalRequested":
        gates.set(p.gateId, {
          gateId: p.gateId,
          payloadRef: p.payloadRef,
          blockId: e.blockId,
          seq: e.seq,
        })
        break
      case "ApprovalDecided":
        gates.delete(p.gateId)
        break
      case "QuestionAsked":
        questions.set(e.blockId ?? "", {
          blockId: e.blockId ?? "",
          question: p.question,
          seq: e.seq,
        })
        break
      case "QuestionAnswered":
        questions.delete(e.blockId ?? "")
        break
    }
  }

  const last = prev.events.at(-1)
  const appended = !last || fresh[0]!.seq > last.seq
  const events = appended
    ? [...prev.events, ...fresh]
    : [...prev.events, ...fresh].sort((a, b) => a.seq - b.seq)

  return {
    events,
    lastSeq: Math.max(prev.lastSeq, fresh.at(-1)!.seq),
    runStatus,
    startedAt,
    blocks,
    attempts,
    gates,
    questions,
    seen,
  }
}

export const attemptsOf = (state: RunState, blockId: string): readonly AttemptState[] => {
  const ids = state.blocks.get(blockId)?.attemptIds ?? []
  return ids.map((id) => state.attempts.get(id)).filter((a): a is AttemptState => a !== undefined)
}

export const currentBlockId = (state: RunState): string | undefined => {
  for (const [id, b] of state.blocks) if (b.status === "running") return id
  return undefined
}

export interface EventSource {
  fetchEvents(runId: string, from: number, signal?: AbortSignal): Promise<readonly JournalEvent[]>
  subscribe(runId: string, from: number, onEvents: (e: readonly JournalEvent[]) => void): () => void
}

/** Backfills the whole journal, then streams from where the backfill ended. */
export function useEventStore(source: EventSource, runId: string | null) {
  const [state, setState] = useState<RunState>(emptyRunState)

  const push = useCallback((incoming: readonly JournalEvent[]) => {
    setState((prev) => applyEvents(prev, incoming))
  }, [])

  useEffect(() => {
    if (!runId) {
      setState(emptyRunState())
      return
    }
    let live = true
    setState(emptyRunState())

    const abort = new AbortController()
    let unsubscribe: (() => void) | undefined
    void source
      .fetchEvents(runId, 0, abort.signal)
      .then((backfill) => {
        if (!live) return
        push(backfill)
        // From the batch, not from state: a setState updater has not run yet at this point.
        const from = backfill.reduce((max, e) => Math.max(max, e.seq), 0)
        unsubscribe = source.subscribe(runId, from, push)
      })
      .catch(() => {
        // An aborted backfill is the expected outcome of switching runs mid-flight.
      })

    return () => {
      live = false
      abort.abort()
      unsubscribe?.()
    }
  }, [source, runId, push])

  const answered = useCallback((blockId: string) => {
    setState((prev) => {
      if (!prev.questions.has(blockId)) return prev
      const questions = new Map(prev.questions)
      questions.delete(blockId)
      return { ...prev, questions }
    })
  }, [])

  const decided = useCallback((gateId: string) => {
    setState((prev) => {
      if (!prev.gates.has(gateId)) return prev
      const gates = new Map(prev.gates)
      gates.delete(gateId)
      return { ...prev, gates }
    })
  }, [])

  return useMemo(() => ({ state, answered, decided }), [state, answered, decided])
}
