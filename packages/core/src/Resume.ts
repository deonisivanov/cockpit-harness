import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { JournalError } from "./errors.js"
import { BlockStatus, eventsOf, JournalEvent } from "./events.js"
import { ArtifactId, AttemptId, BlockId, CheckpointId, RunId, SessionId } from "./ids.js"
import { allEvents, Journal } from "./Journal.js"
import { BlockRow, Store } from "./Store.js"
import { clip, outputBudget } from "./text.js"

/** What a resumed run already knows about one node of its tree, folded out of the journal. */
export interface ResumedNode {
  /** Instances recorded for this node; the next live one numbers past them. */
  readonly instances: number
  /** Instances that reached a terminal status — iterations an enclosing loop has already spent. */
  readonly completed: number
  /** Judged attempts of the newest instance; a resumed execution continues past them. */
  readonly attempts: number
  /** Set when the newest instance finished: it is replayed rather than executed again. */
  readonly done?: {
    readonly blockId: BlockId
    readonly status: Extract<BlockStatus, "succeeded" | "skipped">
    readonly output?: unknown
    readonly outputRef?: ArtifactId
  }
  /** The retry context the interrupted attempt was handed, replayed verbatim to its successor. */
  readonly feedback?: { readonly rendered: string; readonly packetRef: ArtifactId }
  /** The newest instance's provider session, which a `continue` block resumes. */
  readonly session?: SessionId
}

export interface ResumePlan {
  /** Keyed by node id, so an instance the engine has yet to number can still be looked up. */
  readonly nodes: ReadonlyMap<string, ResumedNode>
  /** Gates the run already decided; a resumed walk reads the decision instead of asking again. */
  readonly decisions: ReadonlyMap<string, boolean>
  /** Node ids with an outstanding skip request, honoured at their next visit. */
  readonly skips: ReadonlySet<string>
  readonly lastCheckpoint?: CheckpointId
  /** The attempt the interruption left open, which owns whatever the worktree still holds. */
  readonly openAttempt?: { readonly blockId: BlockId; readonly attemptId: AttemptId }
}

const instanced = /^(.*)#(\d+)$/

/** `implement#2` is the second execution of the node `implement`; the engine appends the suffix. */
export const nodeOf = (blockId: string) => instanced.exec(blockId)?.[1] ?? blockId

const terminal = new Set<BlockStatus>(["succeeded", "failed", "skipped"])

/**
 * Node ids with an outstanding skip request. A request is consumed only by the BlockSkipped that
 * honours it — not by a visit that ran or replayed the node — because that is the one event the
 * live path also produces when it consumes its Ref entry. Any broader rule lets a fold taken
 * mid-race disagree with the Ref, and then a skip is honoured on a fresh start but not on a
 * resume, or the reverse, silently.
 */
export const recordedSkips = (events: ReadonlyArray<JournalEvent>): ReadonlySet<string> => {
  const pending = new Set<string>()
  for (const event of events) {
    const payload = event.payload
    // A request names a node of the tree that was current when it was made. Re-planning replaces
    // that tree, so a same-named node in the new one is a decision the user has not taken.
    if (payload._tag === "TreeAnalyzed") pending.clear()
    else if (payload._tag === "BlockSkipRequested") pending.add(payload.nodeId)
    else if (payload._tag === "BlockSkipped" && event.blockId !== undefined) {
      pending.delete(nodeOf(event.blockId))
    }
  }
  return pending
}

/**
 * Whether the interruption caught a loop part-way through an iteration, rather than between two:
 * the block whose verdict closes an iteration has finished fewer of them than the block that opens
 * one has started. An open iteration is continued — what it already did is replayed — while a
 * closed one means the next pass is a new iteration, which re-does the whole body.
 *
 * A body that runs its closing block only under a Condition reads as open for the iterations that
 * skipped it, which costs a replay rather than a re-execution: safe, and never a repeated effect.
 */
export const iterationOpen = (target?: ResumedNode, source?: ResumedNode) =>
  target !== undefined && (source?.completed ?? 0) < target.instances

/** The iteration a re-entering loop carries on at: the unfinished one, or the one after it. */
export const resumedIteration = (target?: ResumedNode, source?: ResumedNode) =>
  target === undefined ? 1 : target.instances + (iterationOpen(target, source) ? 0 : 1)

const readText = (path: string | undefined) =>
  path === undefined
    ? Effect.succeed(undefined)
    : Effect.tryPromise(() => readFile(path, "utf8")).pipe(
        Effect.map((text) => clip(text, outputBudget)),
        Effect.orElseSucceed(() => undefined),
      )

const parse = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * A completed block's output is not optional: the blocks wired to it would otherwise run against
 * an empty envelope, or a condition would silently take the branch it takes when nothing is there.
 * So an artifact that cannot be read back stops the re-entry instead of shaping it.
 */
const rehydrate = (block: BlockRow, ref: ArtifactId, path: string | undefined) =>
  Effect.gen(function* () {
    const output = parse(yield* readText(path))
    return output === undefined
      ? yield* new JournalError({
          op: "buildResumePlan",
          detail: `${block.id} completed with its output in artifact ${ref}${
            path === undefined ? "" : ` (${path})`
          }, which cannot be read back; the run cannot be re-entered`,
        })
      : output
  })

interface NodeFacts {
  instances: number
  completed: number
  newest: BlockRow
}

/**
 * Everything a re-entering run needs from what the last one left behind (plan §9). Read once,
 * before execution: the walk consults this in place of the journal, so nothing it decides depends
 * on the rows the resumed run is itself writing.
 */
export const buildResumePlan = (
  runId: RunId,
): Effect.Effect<ResumePlan, JournalError, Journal | Store> =>
  Effect.gen(function* () {
    const journal = yield* Journal
    const store = yield* Store
    const events = yield* allEvents(journal, runId)

    const facts = new Map<string, NodeFacts>()
    for (const block of yield* store.blocks(runId)) {
      const key = nodeOf(block.id)
      const seen = facts.get(key)
      const completed = terminal.has(block.status) ? 1 : 0
      if (seen === undefined) facts.set(key, { instances: 1, completed, newest: block })
      else {
        seen.instances += 1
        seen.completed += completed
        seen.newest = block
      }
    }

    const paths = new Map(
      eventsOf(events, "ArtifactCreated").map(({ payload }) => [payload.artifactId, payload.path]),
    )
    // Only the newest matters at either end: the last result a block produced, and the last
    // context forwarded to the node — which a loop journals under the instance that failed, not
    // under the one that was about to read it.
    const results = new Map(
      eventsOf(events, "ResultProduced").map(({ event, payload }) => [event.blockId, payload]),
    )
    const forwarded = new Map(
      eventsOf(events, "FailureFeedbackForwarded").map(({ event, payload }) => [
        nodeOf(event.blockId ?? ""),
        payload.packetRef,
      ]),
    )

    const nodes = new Map<string, ResumedNode>()
    yield* Effect.forEach([...facts], ([key, fact]) =>
      Effect.gen(function* () {
        const own = yield* store.attempts(runId, fact.newest.id)
        const status = fact.newest.status
        const done = status === "succeeded" || status === "skipped" ? status : undefined
        const produced = status === "succeeded" ? results.get(fact.newest.id) : undefined
        const inline = produced?.outputInline
        const output =
          inline === undefined && produced?.outputRef !== undefined
            ? yield* rehydrate(fact.newest, produced.outputRef, paths.get(produced.outputRef))
            : inline
        // Stale for a node that finished, and the newest thing an unfinished one was given.
        const packetRef = done === undefined ? forwarded.get(key) : undefined
        const rendered =
          packetRef === undefined ? undefined : yield* readText(paths.get(packetRef))
        const session = own.at(-1)?.sessionId ?? undefined

        nodes.set(key, {
          instances: fact.instances,
          completed: fact.completed,
          // An interrupted attempt was never judged, so it is not charged to the budget: a crash
          // must not spend the attempts a block still has to change strategy.
          attempts: own.filter(
            (attempt) => attempt.verdict !== null && attempt.verdict !== "interrupted",
          ).length,
          ...(done === undefined
            ? {}
            : {
                done: {
                  blockId: fact.newest.id,
                  status: done,
                  output,
                  outputRef: produced?.outputRef,
                },
              }),
          ...(rendered === undefined || packetRef === undefined
            ? {}
            : { feedback: { rendered, packetRef } }),
          ...(session === undefined ? {} : { session }),
        })
      }),
    )

    const confirmed = eventsOf(events, "CheckpointCreated").filter(
      ({ payload }) => payload.kind === "success",
    )
    const open = eventsOf(events, "AttemptInterrupted").at(-1)?.event

    return {
      nodes,
      decisions: new Map(
        eventsOf(events, "ApprovalDecided").map(({ payload }) => [payload.gateId, payload.approved]),
      ),
      skips: recordedSkips(events),
      lastCheckpoint: confirmed.at(-1)?.payload.checkpointId,
      ...(open?.blockId === undefined || open.attemptId === undefined
        ? {}
        : { openAttempt: { blockId: open.blockId, attemptId: open.attemptId } }),
    } satisfies ResumePlan
  })
