import { correctivePolicy, JournalEvent, ProjectRow, RunRow, WorkflowTree } from "@cockpit/core"
import { Effect, Schedule } from "effect"
import { expect, it } from "vitest"
import {
  Api,
  events,
  json,
  makeRepo,
  tagged,
  tempDir,
  waitFor,
  withApi,
  writeScript,
} from "./harness.js"

const minutes = 60_000

const register = (client: Api, repoPath: string) =>
  Effect.map(client.post("/api/projects", { name: "sample", repoPath }), json<ProjectRow>)

const startRun = (client: Api, projectId: string, prompt: string) =>
  Effect.map(
    client.post("/api/runs", { projectId, prompt }),
    json<{ readonly runId: string }>,
  )

const finished = (found: ReadonlyArray<JournalEvent>) =>
  tagged(found, "RunFinished").length + tagged(found, "RunCancelled").length > 0

const succeeds = { output: { summary: "done" } }
const verifies = { output: { passed: true, findings: [] } }

/** The Analyzer answers with a template, exactly as a real one would through $COCKPIT_OUTPUT. */
const chooses = (templateId: string, params: Record<string, unknown> = {}) => ({
  output: { templateId, params, rationale: "fixture" },
})

it("rejects a project whose path is not a git repository", async () => {
  const answer = await withApi((client) =>
    client.post("/api/projects", { name: "nope", repoPath: "/definitely/not/a/repo" }),
  )

  expect(answer.status).toBe(400)
  expect(json<{ error: string }>(answer).error).toBe("not a git repository")
})

it(
  "runs a whole workflow through the API: start, approve the gate, finish",
  async () => {
    writeScript({
      analyzer: chooses("task", { focus: "the parser" }),
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "rename the parser field")

        // The plan block runs, then the tree stops at its approval gate.
        yield* waitFor(runId, (found) => tagged(found, "ApprovalRequested").length > 0)
        const detail = yield* Effect.map(
          client.get(`/api/runs/${runId}`),
          json<{
            run: RunRow
            tree: WorkflowTree
            retryPolicies: Record<string, { maxAttempts: number }>
            blocks: ReadonlyArray<{ id: string }>
          }>,
        )
        const gate = yield* Effect.map(
          client.get(`/api/runs/${runId}/events`),
          (response) =>
            tagged(json<ReadonlyArray<JournalEvent>>(response), "ApprovalRequested")[0],
        )
        const gateId = (gate.payload as { gateId: string }).gateId
        const approved = yield* client.post(`/api/runs/${runId}/gates/${gateId}`, {
          approved: true,
        })

        yield* waitFor(runId, finished)
        const run = yield* Effect.map(
          client.get(`/api/runs/${runId}`),
          json<{ run: RunRow; tree: WorkflowTree }>,
        )
        const found = yield* events(runId)
        const blocks = yield* Effect.map(
          client.get(`/api/runs/${runId}/blocks/implement/attempts`),
          json<ReadonlyArray<{ id: string; verdict: string }>>,
        )
        const attempt = yield* Effect.map(
          client.get(`/api/attempts/${blocks[0].id}`),
          json<{ id: string; blockId: string }>,
        )
        const prompt = tagged(found, "PromptComposed")[0]
        const artifactId = (prompt.payload as { promptRef: string }).promptRef
        const raw = yield* client.get(`/api/artifacts/${artifactId}/raw`)
        const transcript = tagged(found, "ArtifactCreated").find(
          (event) => (event.payload as { kind: string }).kind === "transcript",
        )!
        const jsonl = yield* client.get(
          `/api/artifacts/${(transcript.payload as { artifactId: string }).artifactId}/raw`,
        )

        return { approved, attempt, blocks, detail, found, jsonl, raw, run, runId }
      }),
    )

    expect(result.approved.status).toBe(200)
    expect(result.run.run.status).toBe("succeeded")
    expect(result.run.run.worktreePath).toContain(result.runId)

    // The tree the run executed is queryable, not only replayable from the log.
    expect(result.detail.tree.templateId).toBe("task")
    expect(result.detail.blocks.map((block) => block.id)).toContain("plan")
    // A Loop node names its policy by id; the ceiling behind it is what a "2/3" indicator needs.
    expect(result.detail.retryPolicies[correctivePolicy.id]).toEqual({ maxAttempts: 3 })

    expect(result.blocks[0].verdict).toBe("success")
    expect(result.attempt.blockId).toBe("implement")
    expect(result.raw.status).toBe(200)
    expect(result.raw.body).toContain("## Output contract")
    expect(result.raw.headers["content-type"]).toContain("markdown")
    // A transcript has no mime type of its own, and a browser must still be able to read it.
    expect(result.jsonl.headers["content-type"]).toContain("text/plain")
    expect(tagged(result.found, "ApprovalDecided")).toHaveLength(1)
  },
  2 * minutes,
)

it(
  "suspends on a question and resumes the same session once answered",
  async () => {
    writeScript({
      analyzer: chooses("quickfix"),
      "agent-task:1": { question: "Which database should this target?" },
      "agent-task:2": { ...succeeds, echoPrompt: true },
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "point the migration somewhere")

        yield* waitFor(runId, (found) => tagged(found, "QuestionAsked").length > 0)
        const asked = yield* Effect.map(events(runId), (found) =>
          tagged(found, "QuestionAsked")[0],
        )
        const stray = yield* client.post(`/api/runs/${runId}/questions/verify`, {
          answer: "nobody asked this block",
        })
        // The question is journaled a moment before the session exits and the attempt parks; an
        // answer offered inside that window is refused, so it is offered again.
        const answered = yield* Effect.retry(
          Effect.filterOrFail(
            client.post(`/api/runs/${runId}/questions/${asked.blockId}`, { answer: "postgres" }),
            (response) => response.status === 200,
            () => "not parked yet" as const,
          ),
          Schedule.spaced("50 millis").pipe(Schedule.intersect(Schedule.recurs(200))),
        )

        yield* waitFor(runId, finished)
        const run = yield* Effect.map(client.get(`/api/runs/${runId}`), json<{ run: RunRow }>)
        return { answered, asked, found: yield* events(runId), run, stray }
      }),
    )

    expect(result.asked.blockId).toBe("implement")
    // A question nobody is waiting on is refused, not swallowed.
    expect(result.stray.status).toBe(409)
    expect(result.answered.status).toBe(200)
    expect(result.run.run.status).toBe("succeeded")

    const answers = tagged(result.found, "QuestionAnswered")
    expect(answers).toHaveLength(1)
    expect((answers[0].payload as { answer: string }).answer).toBe("postgres")
    // Same attempt, same session: one AttemptStarted, and the resume names the id it started with.
    const attempts = tagged(result.found, "AttemptStarted").filter(
      (event) => event.blockId === "implement",
    )
    expect(attempts).toHaveLength(1)
    const started = tagged(result.found, "SessionStarted").find(
      (event) => event.blockId === "implement",
    )!
    const resumed = tagged(result.found, "SessionResumed")
    expect(resumed).toHaveLength(1)
    expect((resumed[0].payload as { sessionId: string }).sessionId).toBe(
      (started.payload as { sessionId: string }).sessionId,
    )
  },
  2 * minutes,
)

it(
  "cancels a run this daemon is executing and refuses one it is not",
  async () => {
    writeScript({ analyzer: chooses("quickfix"), "agent-task": { hang: true } })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "hang forever")

        yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length > 0)
        const cancelled = yield* client.post(`/api/runs/${runId}/cancel`)
        const run = yield* Effect.map(client.get(`/api/runs/${runId}`), json<{ run: RunRow }>)
        const again = yield* client.post(`/api/runs/${runId}/cancel`)
        return { again, cancelled, found: yield* events(runId), run }
      }),
    )

    expect(result.cancelled.status).toBe(200)
    expect(result.run.run.status).toBe("cancelled")
    expect(tagged(result.found, "AttemptInterrupted")).toHaveLength(1)
    // The fiber is gone, so the second attempt to cancel says so instead of reporting success.
    expect(result.again.status).toBe(409)
  },
  2 * minutes,
)

it(
  "stops a run into a resumable interrupted state",
  async () => {
    writeScript({ analyzer: chooses("quickfix"), "agent-task": { hang: true } })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "hang forever")

        yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length > 0)
        const stopped = yield* client.post(`/api/runs/${runId}/stop`)
        const run = yield* Effect.map(client.get(`/api/runs/${runId}`), json<{ run: RunRow }>)
        const again = yield* client.post(`/api/runs/${runId}/stop`)
        const resumed = yield* client.post(`/api/runs/${runId}/resume`)
        yield* waitFor(runId, (found) => tagged(found, "RunResumed").length > 0)
        return { stopped, run, again, resumed, found: yield* events(runId) }
      }),
    )

    expect(result.stopped.status).toBe(200)
    expect(result.run.run.status).toBe("interrupted")
    expect(tagged(result.found, "RunStopped")).toHaveLength(1)
    expect(tagged(result.found, "RunCancelled")).toHaveLength(0)
    expect(result.again.status).toBe(409)
    // A stopped run is exactly what /resume re-enters.
    expect(result.resumed.status).toBe(202)
  },
  2 * minutes,
)

it(
  "accepts a safe skip, performs it, and refuses skipping the block that is running",
  async () => {
    writeScript({
      analyzer: chooses("quickfix"),
      "agent-task": { output: { summary: "done" }, delayMs: 2500 },
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "small fix")
        yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length > 0)

        const running = yield* client.post(`/api/runs/${runId}/blocks/implement/skip`)
        const accepted = yield* client.post(`/api/runs/${runId}/blocks/verify/skip`)
        yield* waitFor(runId, finished)
        return { running, accepted, found: yield* events(runId) }
      }),
    )

    expect(result.running.status).toBe(409)
    expect(json<{ detail: string }>(result.running).detail).toContain("Stop the run")
    expect(result.accepted.status).toBe(202)
    expect(tagged(result.found, "BlockSkipRequested")).toHaveLength(1)
    const skipped = tagged(result.found, "BlockSkipped")
    expect(skipped).toHaveLength(1)
    expect(skipped[0].blockId).toBe("verify")
    expect(tagged(result.found, "RunFinished")[0].payload).toMatchObject({ status: "succeeded" })
  },
  2 * minutes,
)

it(
  "refuses a skip that would starve a later block, naming it",
  async () => {
    writeScript({
      analyzer: chooses("task", { focus: "the parser" }),
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "rename the parser field")
        // Parked at the plan gate: nothing is running, the tree exists, nothing after it ran.
        yield* waitFor(runId, (found) => tagged(found, "ApprovalRequested").length > 0)

        const unsafe = yield* client.post(`/api/runs/${runId}/blocks/implement/skip`)
        const unknown = yield* client.post(`/api/runs/${runId}/blocks/no-such-node/skip`)
        return { unsafe, unknown }
      }),
    )

    expect(result.unsafe.status).toBe(409)
    const detail = json<{ detail: string }>(result.unsafe).detail
    expect(detail).toContain("verify")
    expect(result.unknown.status).toBe(409)
    expect(json<{ detail: string }>(result.unknown).detail).toContain("names no block")
  },
  2 * minutes,
)

it(
  "closes nothing on a shutdown interrupt, even after an earlier stop of the same run",
  async () => {
    writeScript({ analyzer: chooses("quickfix"), "agent-task": { hang: true } })
    const repoPath = makeRepo()
    const home = tempDir("cockpitd-shutdown-home-")

    // Phase 1 ends with the run still in flight: closing the daemon scope is graceful shutdown.
    // The earlier stop + resume proves the intent marker was cleaned up — a stale "stop" would
    // close this run as interrupted on the way down instead of leaving it for recovery.
    const runId = await withApi(
      (client) =>
        Effect.gen(function* () {
          const project = yield* register(client, repoPath)
          const { runId } = yield* startRun(client, project.id, "hang forever")
          yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length > 0)
          yield* client.post(`/api/runs/${runId}/stop`)
          yield* client.post(`/api/runs/${runId}/resume`)
          yield* waitFor(runId, (found) => tagged(found, "RunResumed").length > 0)
          return runId
        }),
      { COCKPIT_HOME: home },
    )

    // Phase 2, same journal: nobody closed the run — the row is still `running`, which is what
    // the boot scan needs to find to mark it interrupted. This is the test that fails if the
    // three-case marker is ever collapsed into a set of stop-requested ids.
    const after = await withApi(
      (client) =>
        Effect.gen(function* () {
          const run = yield* Effect.map(client.get(`/api/runs/${runId}`), json<{ run: RunRow }>)
          return { status: run.run.status, found: yield* events(runId) }
        }),
      { COCKPIT_HOME: home },
    )

    expect(after.status).toBe("running")
    expect(tagged(after.found, "RunStopped")).toHaveLength(1)
    expect(tagged(after.found, "RunCancelled")).toHaveLength(0)
    expect(tagged(after.found, "RunFinished")).toHaveLength(0)
  },
  2 * minutes,
)

it(
  "runs the same template twice in one journal, since a block id belongs to its run",
  async () => {
    writeScript({
      analyzer: chooses("quickfix"),
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)

        const first = yield* startRun(client, project.id, "rename the parser field")
        yield* waitFor(first.runId, finished)
        const second = yield* startRun(client, project.id, "rename it back")
        yield* waitFor(second.runId, finished)

        const status = (runId: string) =>
          Effect.map(client.get(`/api/runs/${runId}`), (response) => json<{ run: RunRow }>(response).run.status)
        const attempts = (runId: string) =>
          Effect.map(
            client.get(`/api/runs/${runId}/blocks/implement/attempts`),
            json<ReadonlyArray<{ id: string; blockId: string }>>,
          )

        return {
          first: yield* status(first.runId),
          second: yield* status(second.runId),
          firstAttempts: yield* attempts(first.runId),
          secondAttempts: yield* attempts(second.runId),
        }
      }),
    )

    expect([result.first, result.second]).toEqual(["succeeded", "succeeded"])
    // Each run's `implement` has its own attempts; the route scopes them or they would be shared.
    expect(result.firstAttempts).toHaveLength(1)
    expect(result.secondAttempts).toHaveLength(1)
    expect(result.firstAttempts[0].id).not.toBe(result.secondAttempts[0].id)
  },
  4 * minutes,
)
