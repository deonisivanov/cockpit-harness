import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { ArtifactStore } from "./ArtifactStore.js"
import { JournalError } from "./errors.js"
import { AttemptVerdict } from "./events.js"
import { buildRetryContext, failureSignature, renderRetryContext } from "./failure.js"
import { ArtifactId, BlockId, RunId } from "./ids.js"
import { Journal } from "./Journal.js"
import { FailurePacket, GatePayload, RetryPolicy } from "./workflow.js"

/**
 * Technical failures are the same attempt tried again, so they are bounded on their own instead of
 * eating the semantic attempts a block gets to change strategy.
 */
const technicalRetryLimit = 3

export interface AttemptOutcome {
  readonly verdict: AttemptVerdict
  readonly output?: unknown
  readonly packet?: FailurePacket
}

export interface LoopEnv {
  readonly runId: RunId
  /**
   * Where loop-level events hang: the block being retried, or a corrective loop's feedback target.
   * Resolved per use — a loop's target is a fresh block instance on every iteration, and an event
   * may only name an instance that has actually run.
   */
  readonly blockId: Effect.Effect<BlockId>
  readonly policy: RetryPolicy
  readonly gate: (
    gateId: BlockId,
    payload: GatePayload,
  ) => Effect.Effect<boolean, JournalError>
  readonly rollback: Effect.Effect<void, never>
  /**
   * Where a re-entering run picks the loop up (plan §9): the attempts the journal already spent
   * stay spent. The body runs before the ceiling is checked, so a loop that had exhausted its
   * budget gets exactly one more cycle — which is what the user asked for by resuming it.
   */
  readonly startAttempt?: number
}

export interface AttemptInput {
  readonly attempt: number
  readonly feedback?: { readonly rendered: string; readonly packetRef: ArtifactId }
}

const isTechnical = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  ((error as { _tag?: string })._tag === "ProviderError" ||
    (error as { _tag?: string })._tag === "ProcessError")

export class RetryCoordinator extends Context.Tag("cockpit/RetryCoordinator")<
  RetryCoordinator,
  {
    readonly withTechnicalRetries: <A, E, R>(
      env: { readonly runId: RunId; readonly blockId: BlockId; readonly policy: RetryPolicy },
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | JournalError, R>

    readonly semanticLoop: <E, R>(
      env: LoopEnv,
      body: (input: AttemptInput) => Effect.Effect<AttemptOutcome, E, R>,
    ) => Effect.Effect<AttemptOutcome, E | JournalError, R>
  }
>() {}

export const RetryCoordinatorLive = Layer.effect(
  RetryCoordinator,
  Effect.gen(function* () {
    const journal = yield* Journal
    const artifacts = yield* ArtifactStore

    const scheduled = (
      runId: RunId,
      blockId: BlockId,
      failureClass: "technical" | "semantic",
      nextAttempt: number,
      delayMs: number,
    ) =>
      journal.append({
        runId,
        blockId,
        payload: { _tag: "RetryScheduled", class: failureClass, nextAttempt, delayMs },
      })

    const withTechnicalRetries = <A, E, R>(
      env: { readonly runId: RunId; readonly blockId: BlockId; readonly policy: RetryPolicy },
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | JournalError, R> => {
      const { backoff } = env.policy
      const allowed =
        env.policy.retryable.includes("technical") && !env.policy.nonRetryable.includes("technical")
      if (!allowed) return effect

      const schedule = Schedule.exponential(Duration.millis(backoff.initialMs), backoff.factor).pipe(
        Schedule.modifyDelay((_, delay) => Duration.min(delay, Duration.millis(backoff.maxMs))),
        Schedule.intersect(Schedule.recurs(technicalRetryLimit)),
        Schedule.tapOutput(([delay, count]: readonly [Duration.Duration, number]) =>
          Effect.ignoreLogged(
            scheduled(
              env.runId,
              env.blockId,
              "technical",
              count + 2,
              Duration.toMillis(Duration.min(delay, Duration.millis(backoff.maxMs))),
            ),
          ),
        ),
      )

      return Effect.retry(effect, { schedule, while: isTechnical })
    }

    const semanticLoop = <E, R>(
      env: LoopEnv,
      body: (input: AttemptInput) => Effect.Effect<AttemptOutcome, E, R>,
    ): Effect.Effect<AttemptOutcome, E | JournalError, R> => {
      const { policy } = env

      const step = (
        attempt: number,
        packets: ReadonlyArray<FailurePacket>,
      ): Effect.Effect<AttemptOutcome, E | JournalError, R> =>
        Effect.gen(function* () {
          const [oldest, ...rest] = packets
          const feedback =
            oldest === undefined
              ? undefined
              : yield* Effect.gen(function* () {
                  // The artifact holds the rendered form because that is exactly what the next
                  // attempt reads — contracts §9 calls for the packet the attempt actually sees.
                  const rendered = renderRetryContext(
                    buildRetryContext([oldest, ...rest], policy.contextBudgetChars),
                  )
                  const blockId = yield* env.blockId
                  const ref = yield* artifacts.write({
                    runId: env.runId,
                    blockId,
                    kind: "failure-packet",
                    name: `attempt-${attempt}-feedback.md`,
                    content: rendered,
                  })
                  yield* journal.append({
                    runId: env.runId,
                    blockId,
                    payload: { _tag: "FailureFeedbackForwarded", packetRef: ref.id },
                  })
                  return { rendered, packetRef: ref.id }
                })

          const outcome = yield* body({ attempt, feedback })
          if (outcome.verdict !== "semantic-failure" || outcome.packet === undefined) {
            return outcome
          }
          // Retrying a semantic failure is what the policy forbids, so the first one is the verdict.
          if (policy.nonRetryable.includes("semantic")) return outcome

          const history = [...packets, outcome.packet]
          const signature = failureSignature(outcome.packet)
          const repeats = history.filter((packet) => failureSignature(packet) === signature).length
          const stalled = repeats >= policy.noProgress.sameFailureSignatureLimit
          const blockId = yield* env.blockId

          // Above the attempt-count exit: a human who asked to see failure N wants to see it even
          // when N is the last one the policy allows.
          if (
            !stalled &&
            policy.humanGateAfterFailures !== undefined &&
            history.length >= policy.humanGateAfterFailures
          ) {
            const approved = yield* env.gate(blockId, {
              title: `Continue retrying ${blockId}?`,
              summary: `${history.length} attempts have failed. Last failure: ${outcome.packet.whatFailed}`,
            })
            if (!approved) return outcome
          }

          if (attempt >= policy.maxAttempts) return outcome

          if (stalled) {
            const approved = yield* env.gate(blockId, {
              title: `No progress on ${blockId}`,
              summary: `Attempt ${attempt} failed the same way ${repeats} times: ${signature}. Approve to try once more, deny to stop the run.`,
            })
            if (!approved) return outcome
          }

          yield* scheduled(env.runId, blockId, "semantic", attempt + 1, 0)
          if (policy.onRetry === "rollback") yield* env.rollback

          return yield* step(attempt + 1, history)
        })

      return step(env.startAttempt ?? 1, []).pipe(
        Effect.timeoutTo({
          duration: Duration.millis(policy.loopTimeoutMs),
          onSuccess: (outcome: AttemptOutcome) => outcome,
          onTimeout: (): AttemptOutcome => ({ verdict: "technical-failure" }),
        }),
      )
    }

    return { withTechnicalRetries, semanticLoop }
  }),
)
