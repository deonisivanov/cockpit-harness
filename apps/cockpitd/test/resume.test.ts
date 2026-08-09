import { JournalEvent, ProjectRow, RunRow } from "@cockpit/core"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

/**
 * Verification never passes, so the loop spends its three attempts and the run ends failed. Each
 * refusal is different: two identical ones would trip the no-progress rule and park on a gate
 * instead of failing.
 */
const stubborn = {
  analyzer: { output: { templateId: "quickfix", params: {}, rationale: "fixture" } },
  "agent-task": { output: { summary: "a fix" } },
  "verify-output:1": { output: { passed: false, findings: ["the empty case still throws"] } },
  "verify-output:2": { output: { passed: false, findings: ["a single space still throws"] } },
  "verify-output:3": { output: { passed: false, findings: ["a tab still throws"] } },
  // The cycle a resume re-arms: the fourth call is the first one after the run failed.
  "verify-output:4": { output: { passed: true, findings: [] } },
}

const start = (client: Api, prompt: string) =>
  Effect.gen(function* () {
    const repoPath = makeRepo()
    const project = yield* Effect.map(
      client.post("/api/projects", { name: "sample", repoPath }),
      json<ProjectRow>,
    )
    const { runId } = yield* startRun(client, project.id, prompt)
    return { runId, repoPath }
  })

const runRow = (client: Api, runId: string) =>
  Effect.map(client.get(`/api/runs/${runId}`), (response) => json<{ run: RunRow }>(response).run)

const failedRun = (client: Api, prompt: string) =>
  Effect.gen(function* () {
    const started = yield* start(client, prompt)
    yield* waitFor(started.runId, (found) => tagged(found, "RunFinished").length > 0)
    return started
  })

const finishedTwice = (found: ReadonlyArray<JournalEvent>) =>
  tagged(found, "RunFinished").length === 2

it(
  "resumes a failed run for one more cycle without replanning or re-running what succeeded",
  async () => {
    const calls = writeScript(stubborn)

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const { runId } = yield* failedRun(client, "handle empty input")
        const failed = yield* runRow(client, runId)

        const resumed = yield* client.post(`/api/runs/${runId}/resume`)
        yield* waitFor(runId, finishedTwice)
        return {
          failed,
          resumed,
          run: yield* runRow(client, runId),
          found: yield* events(runId),
        }
      }),
    )

    expect(result.failed.status).toBe("failed")
    expect(result.resumed.status).toBe(202)
    expect(result.run.status).toBe("succeeded")

    // The tree came off the artifact the first run wrote: the Analyzer was not asked again.
    expect(calls("analyzer")).toBe(1)
    // Three iterations before the failure, one after it, and no more.
    expect(calls("agent-task")).toBe(4)
    expect(calls("verify-output")).toBe(4)
    expect(tagged(result.found, "RunResumed")).toHaveLength(1)
    expect(
      tagged(result.found, "BlockStarted").map((event) => event.blockId),
    ).toEqual([
      "implement",
      "verify",
      "implement#2",
      "verify#2",
      "implement#3",
      "verify#3",
      "implement#4",
      "verify#4",
    ])
  },
  3 * minutes,
)

it(
  "keeps a resumed run under this daemon while the failed one is still writing its retrospective",
  async () => {
    // The run fails, its fiber lives on through the retrospective, and the resume lands inside
    // that window — the moment a user actually presses Resume.
    writeScript({ ...stubborn, "agent-task:4": { hang: true } })

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const { runId } = yield* failedRun(client, "handle empty input")
        const resumed = yield* client.post(`/api/runs/${runId}/resume`)
        yield* waitFor(runId, (found) =>
          tagged(found, "BlockStarted").some((event) => event.blockId === "implement#4"),
        )
        const stopped = yield* client.post(`/api/runs/${runId}/stop`)
        return { resumed, stopped, run: yield* runRow(client, runId) }
      }),
    )

    expect(result.resumed.status).toBe(202)
    // 409 here means the closing fiber took the resumed run's place in the map with it.
    expect(result.stopped.status).toBe(200)
    expect(result.run.status).toBe("interrupted")
  },
  3 * minutes,
)

it(
  "rebuilds a worktree that is gone and still lands the run on its target branch",
  async () => {
    // `task`, not `quickfix`: it ends in finalize, which is what a restored worktree used to
    // break — the checkout commit stood in for the base the branch is compared against.
    writeScript({
      ...stubborn,
      analyzer: {
        output: { templateId: "task", params: { focus: "the parser" }, rationale: "fixture" },
      },
      // explore and plan, then the loop's three implement attempts, then the resumed one. The
      // file is what gives finalize something to land: a run that changes nothing lands nothing.
      "agent-task": { output: { summary: "a fix" }, writes: { "fix.txt": "fixed\n" } },
    })

    const result = await withApi((client) =>
      Effect.gen(function* () {
        const { repoPath, runId } = yield* start(client, "handle empty input")
        yield* waitFor(runId, (found) => tagged(found, "ApprovalRequested").length > 0)
        const gateId = yield* Effect.map(
          events(runId),
          (found) => (tagged(found, "ApprovalRequested")[0].payload as { gateId: string }).gateId,
        )
        yield* client.post(`/api/runs/${runId}/gates/${gateId}`, { approved: true })
        yield* waitFor(runId, (found) => tagged(found, "RunFinished").length > 0)

        const worktree = (yield* runRow(client, runId)).worktreePath as string
        // Not `git worktree remove`: a directory deleted by hand leaves the registration behind,
        // which is the state a restore has to cope with.
        yield* Effect.sync(() => rmSync(worktree, { recursive: true, force: true }))

        const resumed = yield* client.post(`/api/runs/${runId}/resume`)
        yield* waitFor(runId, finishedTwice)
        return {
          repoPath,
          resumed,
          runId,
          rebuilt: existsSync(worktree),
          run: yield* runRow(client, runId),
          found: yield* events(runId),
        }
      }),
    )

    expect(result.resumed.status).toBe(202)
    expect(result.rebuilt).toBe(true)
    expect(result.run.status).toBe("succeeded")
    // The work reached the user's branch: a run whose worktree was rebuilt still finalizes.
    expect(tagged(result.found, "RunFinalized")).toHaveLength(1)
    expect(
      execFileSync("git", ["log", "--format=%s", "-1", "main"], {
        cwd: result.repoPath,
        encoding: "utf8",
      }).trim(),
    ).toBe(`cockpit: run ${result.runId}`)
  },
  3 * minutes,
)

it(
  "refuses to re-enter a run whose recorded tree no longer reads",
  async () => {
    writeScript(stubborn)

    const answer = await withApi((client) =>
      Effect.gen(function* () {
        const { runId } = yield* failedRun(client, "handle empty input")
        const artifact = yield* Effect.map(events(runId), (found) =>
          tagged(found, "ArtifactCreated").find(
            (event) => (event.payload as { kind: string }).kind === "workflow-tree",
          ),
        )
        const path = (artifact!.payload as { path: string }).path
        // Half a file is what a disk that filled up mid-write leaves behind.
        yield* Effect.sync(() =>
          writeFileSync(path, readFileSync(path, "utf8").slice(0, 120)),
        )
        return yield* client.post(`/api/runs/${runId}/resume`)
      }),
    )

    expect(answer.status).toBe(409)
    expect(json<{ detail: string }>(answer).detail).toContain("no workflow tree that still reads")
  },
  3 * minutes,
)

it("refuses to resume a run that was not left unfinished", async () => {
  writeScript({
    analyzer: { output: { templateId: "quickfix", params: {}, rationale: "fixture" } },
    "agent-task": { hang: true },
  })

  const answers = await withApi((client) =>
    Effect.gen(function* () {
      const { runId } = yield* start(client, "hang forever")
      yield* waitFor(runId, (found) => tagged(found, "AttemptStarted").length > 0)
      // A run this daemon is executing is not interrupted, whatever the caller believes.
      const live = yield* client.post(`/api/runs/${runId}/resume`)
      yield* client.post(`/api/runs/${runId}/cancel`)
      yield* waitFor(runId, (found) => tagged(found, "RunCancelled").length > 0)
      return {
        live,
        cancelled: yield* client.post(`/api/runs/${runId}/resume`),
        unknown: yield* client.post("/api/runs/nope/resume"),
      }
    }),
  )

  expect(answers.live.status).toBe(409)
  expect(answers.cancelled.status).toBe(409)
  expect(json<{ detail: string }>(answers.cancelled).detail).toContain("cancelled")
  expect(answers.unknown.status).toBe(404)
}, 3 * minutes)
