import { Effect, Fiber, Schedule } from "effect"
import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"
import { agentTask, BlockId, WorkflowEngine } from "../src/index.js"
import { block, of, waitFor, withEngine } from "./engine-harness.js"
import { readEvents } from "./helpers.js"

const question = "Which database should the migration target?"
const answer = "postgres, the one in docker-compose.yml"

/** First call asks and leaves without a result; the resumed call answers with what it was told. */
const script = {
  "agent-task:1": { question },
  "agent-task:2": { output: { summary: "migrated" }, echoPrompt: true },
}

const implement = block("implement", agentTask.id)

it("suspends on a question, resumes the same session with the answer, and succeeds", async () => {
  const result = await withEngine(script, ({ runId, start }) =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine
      const running = yield* Effect.fork(start(implement))

      yield* waitFor(runId, (events) => of(events, "QuestionAsked").length > 0)
      // The question is journaled as the stream produces it, a moment before the session exits and
      // the attempt parks; an answer offered inside that window is refused, so it is offered again.
      yield* Effect.retry(
        engine.answerQuestion(runId, BlockId.make("implement"), answer),
        Schedule.spaced("20 millis").pipe(Schedule.intersect(Schedule.recurs(500))),
      )

      const outcome = yield* Fiber.join(running)
      const events = yield* readEvents(runId)
      const transcript = of(events, "ArtifactCreated").find(
        (event) => event.payload.kind === "transcript",
      )!
      return {
        outcome,
        events,
        transcript: yield* Effect.promise(() => readFile(transcript.payload.path, "utf8")),
      }
    }),
  )

  const { events, outcome, transcript } = result

  expect(outcome.status).toBe("succeeded")
  expect(of(events, "QuestionAsked")[0].payload.question).toBe(question)
  expect(of(events, "QuestionAnswered")[0].payload.answer).toBe(answer)

  // One attempt across both calls, and the resume carried the session the first call reported.
  const attempts = of(events, "AttemptStarted")
  expect(attempts).toHaveLength(1)
  const started = of(events, "SessionStarted")[0].payload.sessionId
  const resumed = of(events, "SessionResumed")
  expect(resumed.map((event) => event.payload.sessionId)).toEqual([started])
  expect(resumed[0].attemptId).toBe(attempts[0].attemptId)
  expect(transcript.split("\n").filter((line) => line.includes(`"session_id":"${started}"`)))
    .toHaveLength(2)

  // The answer reached the resumed session as its prompt, verbatim.
  expect(transcript).toContain(answer)
  expect(of(events, "AttemptFinished")[0].payload.verdict).toBe("success")
}, 60_000)

it("does not park on a question the retried session never asked", async () => {
  // The first try asks, then crashes before any result — a technical failure, so the same attempt
  // is invoked again. The retry asks nothing and writes nothing: it owes a failure, not a wait.
  const result = await withEngine(
    { "agent-task:1": { question, exitCode: 3 }, "agent-task:2": {} },
    ({ runId, start }) =>
      Effect.gen(function* () {
        const outcome = yield* start(implement)
        return { outcome, events: yield* readEvents(runId) }
      }),
  )

  expect(result.outcome.status).toBe("failed")
  expect(of(result.events, "QuestionAsked")).toHaveLength(1)
  expect(of(result.events, "QuestionAnswered")).toHaveLength(0)
  expect(of(result.events, "AttemptFinished")[0].payload.verdict).toBe("semantic-failure")
}, 60_000)

it("leaves a run waiting on an answer open when its fiber is interrupted", async () => {
  const events = await withEngine({ "agent-task:1": { question } }, ({ runId, start }) =>
    Effect.gen(function* () {
      const running = yield* Effect.fork(start(implement))
      yield* waitFor(runId, (events) => of(events, "QuestionAsked").length > 0)
      yield* Fiber.interrupt(running)
      return yield* readEvents(runId)
    }),
  )

  expect(of(events, "AttemptInterrupted")).toHaveLength(1)
  expect(of(events, "BlockFinished")[0].payload.status).toBe("interrupted")
  // The engine never closes an interrupted run; that is the supervisor's call.
  expect(of(events, "RunCancelled")).toHaveLength(0)
}, 60_000)
