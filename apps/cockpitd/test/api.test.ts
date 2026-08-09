import { correctivePolicy, JournalEvent, ProjectRow, RunRow, WorkflowTree } from "@cockpit/core"
import { Effect, Schedule } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  Api,
  events,
  json,
  makeRepo,
  spawnedArgv,
  startRun,
  tagged,
  tempDir,
  waitFor,
  withApi,
  writeCartridge,
  writeScript,
} from "./harness.js"

const minutes = 60_000

const register = (client: Api, repoPath: string) =>
  Effect.map(client.post("/api/projects", { name: "sample", repoPath }), json<ProjectRow>)

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
        // Past the 202: re-entry actually reaches the interrupted block and re-executes it.
        yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length >= 2)
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

const waiting = (found: ReadonlyArray<JournalEvent>) =>
  tagged(found, "RunAwaitingStart").length > 0

const trees = (found: ReadonlyArray<JournalEvent>) =>
  tagged(found, "ArtifactCreated").filter(
    (event) => (event.payload as { kind: string }).kind === "workflow-tree",
  ).length

const plan = (client: Api, projectId: string, prompt: string) =>
  Effect.map(client.post("/api/runs", { projectId, prompt }), json<{ readonly runId: string }>)

const detailOf = (client: Api, runId: string) =>
  Effect.map(
    client.get(`/api/runs/${runId}`),
    json<{
      run: RunRow
      attachments?: ReadonlyArray<{ id: string; name: string; bytes: number }>
      tree?: WorkflowTree
      blocks: ReadonlyArray<{ id: string }>
    }>,
  )

it(
  "plans the workflow, waits for a decision, and executes only when asked",
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
        const created = yield* client.post("/api/runs", {
          projectId: project.id,
          prompt: "small fix",
        })
        const runId = json<{ readonly runId: string }>(created).runId
        yield* waitFor(runId, waiting)

        const parked = yield* detailOf(client, runId)
        const stopped = yield* client.post(`/api/runs/${runId}/stop`)
        const started = yield* client.post(`/api/runs/${runId}/start`)
        yield* waitFor(runId, finished)
        const again = yield* client.post(`/api/runs/${runId}/start`)
        return {
          again,
          created,
          parked,
          run: yield* detailOf(client, runId),
          started,
          stopped,
          found: yield* events(runId),
        }
      }),
    )

    expect(result.created.status).toBe(202)
    // The tree is durable and queryable before a single block exists.
    expect(result.parked.run.status).toBe("awaiting-start")
    expect(result.parked.tree?.templateId).toBe("quickfix")
    expect(result.parked.blocks).toEqual([])
    // Stopping is not the verb for a run that never started; cancel is.
    expect(result.stopped.status).toBe(409)
    expect(json<{ detail: string }>(result.stopped).detail).toContain("cancel it instead")

    expect(result.started.status).toBe(202)
    expect(result.run.run.status).toBe("succeeded")
    expect(result.again.status).toBe(409)
    expect(tagged(result.found, "RunStarted")).toHaveLength(1)
    const tags = result.found.map((event) => event.payload._tag)
    expect(tags.indexOf("RunAwaitingStart")).toBeLessThan(tags.indexOf("RunStarted"))
  },
  2 * minutes,
)

it(
  "regenerates the workflow, and the newest tree is the one that runs",
  async () => {
    writeScript({
      "analyzer:1": chooses("task", { focus: "the parser" }),
      "analyzer:2": chooses("quickfix"),
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* plan(client, project.id, "rename the parser field")
        yield* waitFor(runId, waiting)
        const first = yield* detailOf(client, runId)

        const regenerated = yield* client.post(`/api/runs/${runId}/regenerate`)
        yield* waitFor(runId, (found) => trees(found) > 1)
        const second = yield* detailOf(client, runId)

        yield* client.post(`/api/runs/${runId}/start`)
        yield* waitFor(runId, finished)
        return {
          first,
          regenerated,
          second,
          run: yield* detailOf(client, runId),
          found: yield* events(runId),
        }
      }),
    )

    expect(result.regenerated.status).toBe(202)
    expect(result.first.tree?.templateId).toBe("task")
    // Newest artifact wins: the run is still waiting, holding a different workflow.
    expect(result.second.run.status).toBe("awaiting-start")
    expect(result.second.tree?.templateId).toBe("quickfix")
    expect(result.run.run.status).toBe("succeeded")
    // `task` would have parked on its plan gate; the regenerated `quickfix` has none.
    expect(tagged(result.found, "ApprovalRequested")).toHaveLength(0)
    expect(tagged(result.found, "BlockStarted").map((event) => event.blockId)).toEqual([
      "implement",
      "verify",
    ])
  },
  2 * minutes,
)

it(
  "lets one verb at a time claim a waiting run, and refuses the others while it assembles",
  async () => {
    writeScript({
      "analyzer:1": chooses("quickfix"),
      "analyzer:2": { ...chooses("quickfix"), delayMs: 2500 },
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* plan(client, project.id, "small fix")
        yield* waitFor(runId, waiting)

        // All three land while the second analysis is still thinking.
        const regenerated = yield* client.post(`/api/runs/${runId}/regenerate`)
        const again = yield* client.post(`/api/runs/${runId}/regenerate`)
        const early = yield* client.post(`/api/runs/${runId}/start`)

        yield* waitFor(runId, (found) => trees(found) > 1)
        const started = yield* client.post(`/api/runs/${runId}/start`)
        yield* waitFor(runId, finished)
        return {
          again,
          early,
          regenerated,
          started,
          run: yield* detailOf(client, runId),
          found: yield* events(runId),
        }
      }),
    )

    expect(result.regenerated.status).toBe(202)
    expect(result.again.status).toBe(409)
    expect(json<{ detail: string }>(result.again).detail).toContain("already assembling")
    expect(result.early.status).toBe(409)
    expect(json<{ detail: string }>(result.early).detail).toContain("still assembling")
    // Exactly one planning fiber ran, and the tree it wrote is the one the run then executed
    // under a fiber of its own — a lost or overwritten fiber shows up as a run that never ends.
    expect(trees(result.found)).toBe(2)
    expect(result.started.status).toBe(202)
    expect(tagged(result.found, "RunStarted")).toHaveLength(1)
    expect(result.run.run.status).toBe("succeeded")
  },
  2 * minutes,
)

it(
  "leaves a run waiting on its old workflow when re-planning fails",
  async () => {
    writeScript({
      "analyzer:1": chooses("quickfix"),
      analyzer: chooses("no-such-template"),
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* plan(client, project.id, "small fix")
        yield* waitFor(runId, waiting)

        const regenerated = yield* client.post(`/api/runs/${runId}/regenerate`)
        yield* waitFor(runId, (found) =>
          tagged(found, "ErrorRaised").some(
            (event) => (event.payload as { signature: string }).signature === "regenerate",
          ),
        )
        const parked = yield* detailOf(client, runId)
        const failed = yield* events(runId)

        // Still the run it was: the workflow it kept is one Run can still execute.
        yield* client.post(`/api/runs/${runId}/start`)
        yield* waitFor(runId, finished)
        return { failed, parked, regenerated, run: yield* detailOf(client, runId) }
      }),
    )

    expect(result.regenerated.status).toBe(202)
    expect(result.parked.run.status).toBe("awaiting-start")
    expect(result.parked.tree?.templateId).toBe("quickfix")
    expect(trees(result.failed)).toBe(1)
    // Nothing executed, so nothing may narrate an execution that started and then failed.
    expect(tagged(result.failed, "RunStarted")).toHaveLength(0)
    expect(tagged(result.failed, "RunFinished")).toHaveLength(0)
    expect(result.run.run.status).toBe("succeeded")
  },
  2 * minutes,
)

it(
  "re-plans a waiting run whose worktree was deleted, rebuilding it first",
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
        const { runId } = yield* plan(client, project.id, "small fix")
        yield* waitFor(runId, waiting)

        const worktree = (yield* detailOf(client, runId)).run.worktreePath as string
        yield* Effect.sync(() => rmSync(worktree, { recursive: true, force: true }))

        const regenerated = yield* client.post(`/api/runs/${runId}/regenerate`)
        yield* waitFor(runId, (found) => trees(found) > 1)
        yield* client.post(`/api/runs/${runId}/start`)
        yield* waitFor(runId, finished)
        return { regenerated, rebuilt: existsSync(worktree), run: yield* detailOf(client, runId) }
      }),
    )

    expect(result.regenerated.status).toBe(202)
    // Re-planning takes the same route Run does, so the analyzer never runs in a missing directory.
    expect(result.rebuilt).toBe(true)
    expect(result.run.run.status).toBe("succeeded")
  },
  2 * minutes,
)

it(
  "drops a skip requested against a workflow a regenerate has replaced",
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
        const { runId } = yield* plan(client, project.id, "small fix")
        yield* waitFor(runId, waiting)

        const accepted = yield* client.post(`/api/runs/${runId}/blocks/verify/skip`)
        yield* client.post(`/api/runs/${runId}/regenerate`)
        yield* waitFor(runId, (found) => trees(found) > 1)
        yield* client.post(`/api/runs/${runId}/start`)
        yield* waitFor(runId, finished)
        return { accepted, found: yield* events(runId) }
      }),
    )

    expect(result.accepted.status).toBe(202)
    // The request named a node of the tree the regenerate replaced; the new `verify` runs.
    expect(tagged(result.found, "BlockSkipped")).toHaveLength(0)
    expect(tagged(result.found, "BlockStarted").map((event) => event.blockId)).toEqual([
      "implement",
      "verify",
    ])
  },
  2 * minutes,
)

it(
  "cancels a run that is waiting to start, and one no fiber is holding any more",
  async () => {
    writeScript({ analyzer: chooses("quickfix"), "agent-task": { hang: true } })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        // A waiting run never had a fiber, so cancel has to reach the journal directly.
        const parked = yield* plan(client, project.id, "small fix")
        yield* waitFor(parked.runId, waiting)
        const cancelledWaiting = yield* client.post(`/api/runs/${parked.runId}/cancel`)

        // Same fiber-less path, on the run a stop left open and resumable.
        const { runId } = yield* startRun(client, project.id, "hang forever")
        yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length > 0)
        yield* client.post(`/api/runs/${runId}/stop`)
        const cancelledStopped = yield* client.post(`/api/runs/${runId}/cancel`)

        return {
          cancelledStopped,
          cancelledWaiting,
          stopped: yield* detailOf(client, runId),
          waiting: yield* detailOf(client, parked.runId),
        }
      }),
    )

    expect(result.cancelledWaiting.status).toBe(200)
    expect(result.waiting.run.status).toBe("cancelled")
    expect(result.cancelledStopped.status).toBe(200)
    expect(result.stopped.run.status).toBe("cancelled")
  },
  2 * minutes,
)

it(
  "keeps a waiting run startable after the daemon that planned it is gone",
  async () => {
    writeScript({
      analyzer: chooses("quickfix"),
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()
    const home = tempDir("cockpitd-waiting-home-")

    const runId = await withApi(
      (client) =>
        Effect.gen(function* () {
          const project = yield* register(client, repoPath)
          const { runId } = yield* plan(client, project.id, "small fix")
          yield* waitFor(runId, waiting)
          return runId
        }),
      { COCKPIT_HOME: home },
    )

    // Second daemon, same journal: the wait is a row, so nothing had to be kept alive for it.
    const after = await withApi(
      (client) =>
        Effect.gen(function* () {
          const booted = yield* detailOf(client, runId)
          const started = yield* client.post(`/api/runs/${runId}/start`)
          yield* waitFor(runId, finished)
          return { booted, started, run: yield* detailOf(client, runId) }
        }),
      { COCKPIT_HOME: home },
    )

    expect(after.booted.run.status).toBe("awaiting-start")
    expect(after.booted.tree?.templateId).toBe("quickfix")
    expect(after.started.status).toBe(202)
    expect(after.run.run.status).toBe("succeeded")
  },
  2 * minutes,
)

it(
  "accepts a skip while the run waits, and honours it once the run starts",
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
        const { runId } = yield* plan(client, project.id, "small fix")
        yield* waitFor(runId, waiting)

        const accepted = yield* client.post(`/api/runs/${runId}/blocks/verify/skip`)
        yield* client.post(`/api/runs/${runId}/start`)
        yield* waitFor(runId, finished)
        return { accepted, found: yield* events(runId) }
      }),
    )

    expect(result.accepted.status).toBe(202)
    const skipped = tagged(result.found, "BlockSkipped")
    expect(skipped).toHaveLength(1)
    expect(skipped[0].blockId).toBe("verify")
    expect(tagged(result.found, "RunFinished")[0].payload).toMatchObject({ status: "succeeded" })
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
  "refuses to stop a run that is still planning",
  async () => {
    writeScript({
      analyzer: { ...chooses("quickfix"), delayMs: 2500 },
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* plan(client, project.id, "small fix")
        const stopped = yield* client.post(`/api/runs/${runId}/stop`)
        const started = yield* client.post(`/api/runs/${runId}/start`)
        const cancelled = yield* client.post(`/api/runs/${runId}/cancel`)
        return { stopped, started, cancelled }
      }),
    )

    expect(result.stopped.status).toBe(409)
    expect(json<{ detail: string }>(result.stopped).detail).toContain("cancel it instead")
    // Run is offered on a planned workflow, and a run mid-planning has none to show yet.
    expect(result.started.status).toBe(409)
    expect(json<{ detail: string }>(result.started).detail).toContain("is created")
    expect(result.cancelled.status).toBe(200)
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
    // the boot scan needs to find to mark it interrupted. This pins the marker cleanup and the
    // absent-marker no-op: a stale "stop" or a close-on-absent both turn this row interrupted.
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

it(
  "runs the Analyzer under the model a project's cartridge configures for it",
  async () => {
    writeScript({ analyzer: chooses("quickfix") })
    const repoPath = makeRepo()
    writeCartridge(
      repoPath,
      `export default { name: "sample", analyzer: { model: "opus" } }\n`,
    )

    await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* plan(client, project.id, "small fix")
        yield* waitFor(runId, (found) => tagged(found, "RunAwaitingStart").length > 0)
      }),
    )

    expect(spawnedArgv("analyzer").join(" ")).toContain("--model opus")
  },
  2 * minutes,
)

it(
  "stores attachments at creation, lists them, serves them raw, and shows the agent their paths",
  async () => {
    writeScript({ analyzer: chooses("quickfix") })
    const repoPath = makeRepo()
    // Big enough to prove attachments escape the text-artifact byte budget.
    const image = new Uint8Array(1_500_000).fill(0x42)
    image.set([0x89, 0x50, 0x4e, 0x47])

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const created = yield* client.post("/api/runs", {
          projectId: project.id,
          prompt: "use the attached screenshot",
          attachments: [
            { name: "shot.png", contentBase64: Buffer.from(image).toString("base64") },
            { name: "notes.md", contentBase64: Buffer.from("# notes").toString("base64") },
          ],
        })
        if (created.status !== 202) {
          throw new Error(`create failed: ${created.status} ${created.body}`)
        }
        const { runId } = json<{ runId: string }>(created)
        yield* waitFor(runId, (found) => tagged(found, "RunAwaitingStart").length > 0)
        const detail = yield* detailOf(client, runId)
        const attachments = detail.attachments!
        const shot = attachments.find((entry) => entry.name === "shot.png")!
        const raw = yield* client.get(`/api/artifacts/${shot.id}/raw`)
        const row = yield* Effect.map(
          client.get(`/api/artifacts/${shot.id}`),
          json<{ path: string }>,
        )
        return { attachments, created, prompt: detail.run.prompt, raw, row }
      }),
    )

    expect(result.created.status).toBe(202)
    // The stored prompt is exactly what was typed; paths ride only on the agent's copy.
    expect(result.prompt).toBe("use the attached screenshot")
    expect(result.attachments.map((entry) => entry.name).sort()).toEqual([
      "notes.md",
      "shot.png",
    ])
    expect(result.raw.status).toBe(200)
    expect(result.raw.headers["content-type"]).toContain("image/png")
    // User bytes must never execute on this origin: navigation downloads, <img> still renders.
    expect(result.raw.headers["content-disposition"]).toBe("attachment")
    expect(new Uint8Array(readFileSync(result.row.path))).toEqual(image)
    // The analyzer's prompt operand names the stored path, so the agent can read the file.
    const operand = spawnedArgv("analyzer").at(-1)!
    expect(operand).toContain("use the attached screenshot")
    expect(operand).toContain(result.row.path)
  },
  2 * minutes,
)

it("reports nothing to delete for a run that does not exist", async () => {
  const answer = await withApi((client) => client.del("/api/runs/no-such-run"))

  expect(answer.status).toBe(404)
  expect(json<{ error: string }>(answer).error).toBe("not found")
})

it(
  "deletes a finished run: its rows, its events, its files, its worktree and its branch",
  async () => {
    writeScript({
      analyzer: chooses("quickfix"),
      "agent-task": succeeds,
      "verify-output": verifies,
    })
    const repoPath = makeRepo()
    const home = tempDir("cockpitd-delete-home-")
    const hasRunBranch = () =>
      execFileSync("git", ["branch", "--list", "cockpit/run-*"], {
        cwd: repoPath,
        encoding: "utf8",
      }).trim() !== ""

    const result = await withApi(
      (client) =>
        Effect.gen(function* () {
          const project = yield* register(client, repoPath)
          const { runId } = yield* startRun(client, project.id, "small fix")
          yield* waitFor(runId, finished)

          const worktree = (yield* detailOf(client, runId)).run.worktreePath as string
          const files = NodePath.join(home, "runs", runId)
          const before = {
            branch: hasRunBranch(),
            files: existsSync(files),
            worktree: existsSync(worktree),
          }
          const deleted = yield* client.del(`/api/runs/${runId}`)

          return {
            before,
            deleted,
            detail: yield* client.get(`/api/runs/${runId}`),
            events: yield* events(runId),
            runs: yield* Effect.map(
              client.get(`/api/projects/${project.id}/runs`),
              json<ReadonlyArray<RunRow>>,
            ),
            after: {
              branch: hasRunBranch(),
              files: existsSync(files),
              worktree: existsSync(worktree),
            },
          }
        }),
      { COCKPIT_HOME: home },
    )

    // Everything the assertions below claim is gone was there a moment earlier.
    expect(result.before).toEqual({ branch: true, files: true, worktree: true })
    expect(result.deleted.status).toBe(200)
    expect(result.detail.status).toBe(404)
    expect(result.events).toEqual([])
    expect(result.runs).toHaveLength(0)
    expect(result.after).toEqual({ branch: false, files: false, worktree: false })
  },
  2 * minutes,
)

it(
  "deletes a run this daemon is still executing, interrupting it first",
  async () => {
    writeScript({ analyzer: chooses("quickfix"), "agent-task": { hang: true } })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "hang forever")
        yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length > 0)

        const worktree = (yield* detailOf(client, runId)).run.worktreePath as string
        const deleted = yield* client.del(`/api/runs/${runId}`)
        return {
          deleted,
          detail: yield* client.get(`/api/runs/${runId}`),
          // The interrupt is awaited, so the cancel it triggers cannot land after the rows go.
          events: yield* events(runId),
          worktree: existsSync(worktree),
        }
      }),
    )

    expect(result.deleted.status).toBe(200)
    expect(result.detail.status).toBe(404)
    expect(result.events).toEqual([])
    expect(result.worktree).toBe(false)
  },
  2 * minutes,
)

it(
  "rejects attachments that break the caps and leaves no run behind",
  async () => {
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const post = (attachments: unknown) =>
          client.post("/api/runs", { projectId: project.id, prompt: "capped", attachments })
        const oversize = yield* post([
          {
            name: "big.bin",
            contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
          },
        ])
        const garbage = yield* post([{ name: "bad.png", contentBase64: "not base64!!!" }])
        const dotted = yield* post([{ name: "..", contentBase64: "aGk=" }])
        const crowd = yield* post(
          Array.from({ length: 11 }, (_, index) => ({
            name: `file-${index}.txt`,
            contentBase64: "aGk=",
          })),
        )
        const nine = Buffer.alloc(9 * 1024 * 1024).toString("base64")
        const bulky = yield* post(
          Array.from({ length: 3 }, (_, index) => ({
            name: `chunk-${index}.bin`,
            contentBase64: nine,
          })),
        )
        const longName = yield* post([{ name: `${"a".repeat(201)}.txt`, contentBase64: "aGk=" }])
        const runs = yield* Effect.map(
          client.get(`/api/projects/${project.id}/runs`),
          json<ReadonlyArray<RunRow>>,
        )
        return { bulky, crowd, dotted, garbage, longName, oversize, runs }
      }),
    )

    expect(result.oversize.status).toBe(400)
    expect(result.garbage.status).toBe(400)
    expect(result.dotted.status).toBe(400)
    expect(result.crowd.status).toBe(400)
    expect(result.bulky.status).toBe(400)
    expect(result.longName.status).toBe(400)
    expect(result.runs).toHaveLength(0)
  },
  2 * minutes,
)
