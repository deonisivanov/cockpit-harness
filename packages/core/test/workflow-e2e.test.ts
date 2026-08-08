import { Effect, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { expect, it } from "vitest"
import {
  agentTask,
  ArtifactId,
  correctivePolicy,
  EventSeq,
  finalize,
  Journal,
  verifyOutput,
} from "../src/index.js"
import { block, catalog, id, of, withEngine } from "./engine-harness.js"
import { readEvents } from "./helpers.js"

const implementVerifyLoop = {
  _tag: "Loop" as const,
  body: {
    _tag: "Sequence" as const,
    children: [
      block("implement", agentTask.id),
      block("verify", verifyOutput.id, { inputs: [id("implement")] }),
    ],
  },
  policy: correctivePolicy.id,
  kind: "corrective" as const,
  feedbackRoute: { from: id("verify"), to: id("implement") },
}

const finding = "callers of the renamed field in src/parser.ts were never updated"

const script = {
  "agent-task:1": { output: { summary: "renamed the field and moved on" }, text: "first pass" },
  "agent-task:2": { output: { summary: "read the callers, then renamed both sides" }, text: "second pass" },
  "verify-output:1": {
    output: { passed: false, findings: [finding] },
    stderr: "2 tests failed\n",
    text: "verification failed",
  },
  "verify-output:2": { output: { passed: true, findings: [] }, text: "verification passed" },
}

it("recovers from a semantic failure and finishes the run", async () => {
  const result = await withEngine(script, ({ runId, start }) =>
    Effect.gen(function* () {
      const outcome = yield* start(implementVerifyLoop, catalog())
      const events = yield* readEvents(runId)

      const paths = new Map(
        of(events, "ArtifactCreated").map((event) => [event.payload.artifactId, event.payload.path]),
      )
      const read = (artifactId: ArtifactId) =>
        Effect.promise(() => readFile(paths.get(artifactId)!, "utf8"))

      const forwarded = of(events, "FailureFeedbackForwarded")[0]
      const secondPrompt = of(events, "PromptComposed").find(
        (event) => event.blockId === "implement#2",
      )!

      // The whole log has to decode again from any cursor a client might hold.
      const journal = yield* Journal
      const fromMiddle = yield* Stream.runCollect(
        journal.eventsFrom(runId, EventSeq.make(events[4].seq), 10_000),
      )

      return {
        outcome,
        events,
        packet: yield* read(forwarded.payload.packetRef),
        prompt: yield* read(secondPrompt.payload.promptRef),
        replayed: Array.from(fromMiddle).map((event) => event.seq),
      }
    }),
  )

  const { events, outcome, packet, prompt, replayed } = result

  expect(outcome.status).toBe("succeeded")
  expect(outcome.outputs).toMatchObject({
    implement: { summary: "read the callers, then renamed both sides" },
    verify: { passed: true },
  })

  // Attempt timeline: the first verification fails, the second round succeeds.
  expect(
    of(events, "AttemptFinished").map((event) => [event.blockId, event.payload.verdict]),
  ).toEqual([
    ["implement", "success"],
    ["verify", "semantic-failure"],
    ["implement#2", "success"],
    ["verify#2", "success"],
  ])

  // The failure packet is journaled, stored, and says what actually broke — in the verifier's
  // own words, attributed to the verifier rather than to the implementer it is handed to.
  expect(of(events, "FailureFeedbackForwarded")).toHaveLength(1)
  expect(packet).toContain("What failed:")
  expect(packet).toContain("verification-passed")
  expect(packet).toContain(finding)
  expect(packet).toContain("judged by verify")
  expect(packet).not.toContain("repeating attempt 1 unchanged")
  expect(packet).toContain("Do not repeat:")

  // The retrying attempt reads that feedback, verbatim, in a session of its own.
  expect(prompt).toContain("## Previous attempts")
  expect(prompt).toContain("verification-passed")
  expect(prompt).toContain(finding)
  expect(prompt).toContain("do not repeat what already failed")
  const sessions = of(events, "SessionStarted").filter((event) =>
    event.blockId?.startsWith("implement"),
  )
  expect(sessions).toHaveLength(2)
  expect(sessions[0].payload.sessionId).not.toBe(sessions[1].payload.sessionId)

  // A verifier never shares the implementer's session.
  expect(new Set(of(events, "SessionStarted").map((event) => event.payload.sessionId)).size).toBe(4)

  expect(of(events, "VerificationReported").map((event) => event.payload.criteria)).toMatchObject([
    [{ criterion: "verification-passed", passed: false }],
    [{ criterion: "verification-passed", passed: true }],
  ])

  // The run baseline, then one checkpoint per successful block that could touch the worktree.
  expect(
    of(events, "CheckpointCreated").map((event) => [event.blockId, event.payload.kind]),
  ).toEqual([
    [undefined, "success"],
    ["implement", "success"],
    ["implement#2", "success"],
  ])

  expect(replayed).toEqual(events.slice(5).map((event) => event.seq))
  expect(events.at(-1)?.payload).toMatchObject({ _tag: "RunFinished", status: "succeeded" })
}, 60_000)

it("lands the run's work on the target branch through a finalize block", async () => {
  const result = await withEngine(
    { "agent-task": { output: { summary: "wrote the feature" }, writes: { "feature.ts": "export const x = 1\n" } } },
    ({ runId, start, workspace }) =>
      Effect.gen(function* () {
        const outcome = yield* start({
          _tag: "Sequence",
          children: [block("implement", agentTask.id), block("finalize", finalize.id)],
        })
        return { outcome, workspace, events: yield* readEvents(runId) }
      }),
  )

  const { repoPath, targetBranch, baseCommit } = result.workspace
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim()

  expect(result.outcome.status).toBe("succeeded")
  expect(targetBranch).toBe("main")
  expect(git("rev-parse", `${targetBranch}^`)).toBe(baseCommit)
  expect(await readFile(NodePath.join(repoPath, "feature.ts"), "utf8")).toBe("export const x = 1\n")

  const [landed] = of(result.events, "RunFinalized")
  expect(landed?.payload).toMatchObject({ targetBranch: "main", mode: "squash", commits: 1 })
  // A workspace block writes nothing of its own, so it earns no checkpoint of its own either:
  // the baseline and the implement block are the only two, and both precede the finalize.
  const commits = of(result.events, "CheckpointCreated")
  expect(commits).toHaveLength(2)
  expect(commits.every((event) => event.seq < landed!.seq)).toBe(true)
})

it("fails the finalize block, with the reason, when the target branch cannot take the result", async () => {
  const result = await withEngine(
    { "agent-task": { output: { summary: "wrote the feature" }, writes: { "feature.ts": "x\n" } } },
    ({ runId, start, workspace }) =>
      Effect.gen(function* () {
        // The owner is mid-edit on the branch the run started from.
        yield* Effect.promise(() =>
          writeFile(NodePath.join(workspace.repoPath, "app.txt"), "mid-edit\n"),
        )
        const outcome = yield* start({
          _tag: "Sequence",
          children: [block("implement", agentTask.id), block("finalize", finalize.id)],
        })
        return { outcome, workspace, events: yield* readEvents(runId) }
      }),
  )

  const { repoPath, baseCommit } = result.workspace
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim()

  expect(result.outcome.status).toBe("failed")
  expect(of(result.events, "RunFinalized")).toHaveLength(0)
  expect(git("rev-parse", "main")).toBe(baseCommit)
  expect(await readFile(NodePath.join(repoPath, "app.txt"), "utf8")).toBe("mid-edit\n")
  const [failed] = of(result.events, "AttemptFinished").filter(
    (event) => event.payload.verdict === "semantic-failure",
  )
  expect(failed).toBeDefined()
})
