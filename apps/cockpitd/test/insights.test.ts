import { InsightRow, JournalEvent, ProjectRow, RunRow } from "@cockpit/core"
import { Effect } from "effect"
import { expect, it } from "vitest"
import {
  Api,
  events,
  json,
  makeRepo,
  startRun,
  tagged,
  waitFor,
  withApi,
  writeScript,
} from "./harness.js"

const minutes = 60_000

const register = (client: Api, repoPath: string) =>
  Effect.map(client.post("/api/projects", { name: "sample", repoPath }), json<ProjectRow>)

const succeeds = { output: { summary: "done" } }
const verifies = { output: { passed: true, findings: [] } }
const chooses = (templateId: string) => ({ output: { templateId, params: {}, rationale: "fixture" } })

const reports = (title: string, target = "core") => ({
  output: {
    insights: [
      {
        target,
        title,
        body: "The verifier and the implementer disagree about what done means.",
        evidence: [{ kind: "block", ref: "implement" }],
      },
    ],
  },
})

/** The retrospective is the last thing a run does, so its own event is what says the run is over. */
const retrospected = (found: ReadonlyArray<JournalEvent>) =>
  tagged(found, "AgentActivity").some(
    (event) => (event.payload as { activity: string }).activity === "retrospective",
  )

const failed = (found: ReadonlyArray<JournalEvent>) =>
  tagged(found, "ErrorRaised").some(
    (event) => (event.payload as { signature: string }).signature === "retrospective",
  )

it(
  "runs a retrospective when a run finishes and counts an insight the next run raises again",
  async () => {
    writeScript({
      analyzer: chooses("quickfix"),
      "agent-task": succeeds,
      "verify-output": verifies,
      retrospective: reports("Verify and implement disagree on the contract"),
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const first = yield* startRun(client, project.id, "rename the parser field")
        yield* waitFor(first.runId, retrospected)
        const afterFirst = yield* Effect.map(
          client.get("/api/insights"),
          json<ReadonlyArray<InsightRow>>,
        )

        const second = yield* startRun(client, project.id, "rename it again")
        yield* waitFor(second.runId, retrospected)
        const afterSecond = yield* Effect.map(
          client.get("/api/insights"),
          json<ReadonlyArray<InsightRow>>,
        )

        const detail = yield* client.get(`/api/insights/${afterFirst[0].id}`)
        const filtered = yield* Effect.map(
          client.get("/api/insights?target=cartridge"),
          json<ReadonlyArray<InsightRow>>,
        )
        const rejected = yield* client.get("/api/insights?target=elsewhere")
        const missing = yield* client.get("/api/insights/nope")
        const status = (runId: string) =>
          Effect.map(
            client.get(`/api/runs/${runId}`),
            (response) => json<{ run: RunRow }>(response).run.status,
          )

        return {
          afterFirst,
          afterSecond,
          detail,
          filtered,
          first,
          missing,
          rejected,
          second,
          statuses: [yield* status(first.runId), yield* status(second.runId)],
        }
      }),
    )

    expect(result.afterFirst).toHaveLength(1)
    expect(result.afterFirst[0]).toMatchObject({
      target: "core",
      occurrences: 1,
      firstSeenRun: result.first.runId,
      evidence: [{ kind: "block", ref: "implement" }],
    })

    // Same insight from a second run: one row, counted twice, pointing at the newer run.
    expect(result.afterSecond).toHaveLength(1)
    expect(result.afterSecond[0]).toMatchObject({
      id: result.afterFirst[0].id,
      occurrences: 2,
      firstSeenRun: result.first.runId,
      lastSeenRun: result.second.runId,
    })
    expect(result.afterSecond[0].lastSeenAt).not.toBeNull()

    expect(json<InsightRow>(result.detail).body).toContain("disagree about what done means")
    expect(result.filtered).toEqual([])
    expect(result.rejected.status).toBe(400)
    expect(result.missing.status).toBe(404)
    expect(result.statuses).toEqual(["succeeded", "succeeded"])
  },
  4 * minutes,
)

it(
  "leaves the run alone when the retrospective itself fails",
  async () => {
    writeScript({
      analyzer: chooses("quickfix"),
      "agent-task": succeeds,
      "verify-output": verifies,
      retrospective: { output: { insights: [{ target: "nowhere" }] } },
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "rename the parser field")
        yield* waitFor(runId, failed)
        const run = yield* Effect.map(client.get(`/api/runs/${runId}`), json<{ run: RunRow }>)
        const rows = yield* Effect.map(client.get("/api/insights"), json<ReadonlyArray<InsightRow>>)
        return { found: yield* events(runId), rows, run }
      }),
    )

    // The run succeeded and stays succeeded; the retrospective's failure is journaled beside it.
    expect(result.run.run.status).toBe("succeeded")
    expect(result.rows).toEqual([])
    expect(tagged(result.found, "RunFinished")).toHaveLength(1)
  },
  4 * minutes,
)

it(
  "refuses a manual retrospective while the run is still executing, and answers once it is not",
  async () => {
    writeScript({
      analyzer: chooses("quickfix"),
      "agent-task": { hang: true },
      retrospective: reports("Cancelled runs teach nothing", "cartridge"),
    })
    const repoPath = makeRepo()

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const project = yield* register(client, repoPath)
        const { runId } = yield* startRun(client, project.id, "hang forever")
        yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length > 0)
        const live = yield* client.post(`/api/runs/${runId}/retrospective`)

        yield* client.post(`/api/runs/${runId}/cancel`)
        yield* waitFor(runId, (found) => tagged(found, "RunCancelled").length > 0)
        // Cancelling never fires one by itself; asking for it explicitly still works.
        const found = yield* events(runId)
        const asked = yield* client.post(`/api/runs/${runId}/retrospective`)
        const missing = yield* client.post("/api/runs/nope/retrospective")

        return { asked, found, live, missing }
      }),
    )

    expect(result.live.status).toBe(409)
    expect(retrospected(result.found)).toBe(false)
    expect(result.asked.status).toBe(200)
    expect(json<{ insights: ReadonlyArray<InsightRow> }>(result.asked).insights).toMatchObject([
      { target: "cartridge", occurrences: 1 },
    ])
    expect(result.missing.status).toBe(404)
  },
  4 * minutes,
)
