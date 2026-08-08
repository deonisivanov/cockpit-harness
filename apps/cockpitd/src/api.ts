import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import {
  ArtifactId,
  AttemptId,
  BlockId,
  ContinuationService,
  EventBus,
  EventSeq,
  InsightTarget,
  Journal,
  JournalEvent,
  outputBudget,
  RetrospectiveService,
  RetryPolicy,
  RunId,
  Store,
  WorkflowEngine,
  WorkflowTree,
  WorkspaceManager,
} from "@cockpit/core"
import { Chunk, Effect, Fiber, Schema, Stream } from "effect"
import { readFile } from "node:fs/promises"
import * as NodePath from "node:path"
import { RunSupervisor, treeArtifactKind } from "./runs.js"

const loopbackNames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

/** Parsing beats splitting on ":" — an IPv6 authority is full of them. */
export const isLoopbackUrl = (url: string) => {
  try {
    return loopbackNames.has(new URL(url).hostname)
  } catch {
    return false
  }
}

const defaultPageSize = 1_000
const maxPageSize = 5_000
const wsPageSize = 500
const heartbeatMs = 30_000

/**
 * The one websocket message that is not a journal event; a client tells them apart by `seq`.
 * It is not a protocol ping: @effect/platform 0.97's Socket exposes only run/runRaw/writer, and
 * the writer takes data or a close — there is no ping frame and no pong to wait for. So a peer
 * that vanishes without a FIN is noticed when the OS gives up on the write, not on a missed pong.
 */
const heartbeat = JSON.stringify({ type: "ping" })

const NonEmpty = Schema.String.pipe(Schema.minLength(1))
const CreateProject = Schema.Struct({ name: NonEmpty, repoPath: NonEmpty })
const CreateRun = Schema.Struct({ projectId: NonEmpty, prompt: NonEmpty })
const GateDecision = Schema.Struct({
  approved: Schema.Boolean,
  note: Schema.optional(Schema.String),
})
const QuestionAnswer = Schema.Struct({ answer: NonEmpty })

const ok = (body: unknown, status = 200) => HttpServerResponse.json(body, { status })

const problem = (status: number, error: string, detail?: string) =>
  HttpServerResponse.json(detail === undefined ? { error } : { error, detail }, { status }).pipe(
    Effect.orDie,
  )

const detailOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Every route answers in JSON, including the ones that fail. */
const respond = <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.catchAll(handler, (cause) => {
    const tag = (cause as { readonly _tag?: string })._tag
    const rejected = tag === "ParseError" || tag === "RequestError"
    return problem(
      rejected ? 400 : 500,
      rejected ? "invalid request" : "internal error",
      detailOf(cause),
    )
  })

const pathParam = (name: string) =>
  Effect.map(HttpRouter.params, (params) => params[name] ?? "")

const single = (value: string | ReadonlyArray<string> | undefined) =>
  typeof value === "string" ? value : value?.[0]

const intParam = (
  value: string | ReadonlyArray<string> | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) => {
  const parsed = Number(single(value))
  return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback
}

interface PlannedTree {
  readonly tree: WorkflowTree
  readonly policies: ReadonlyArray<RetryPolicy>
}

const readJson = (path: string) =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as unknown)),
    Effect.orElseSucceed(() => undefined),
  )

const page = (runId: RunId, after: EventSeq, limit: number) =>
  Effect.flatMap(Journal, (journal) =>
    Stream.runCollect(journal.eventsFrom(runId, after, limit)),
  ).pipe(Effect.map(Chunk.toReadonlyArray))

/** `mime` has nothing for a transcript or a log, and a browser should still show them as text. */
const asText = new Set([".jsonl", ".log", ".diff", ".txt", ""])

const listProjects = Effect.flatMap(Store, (store) => Effect.flatMap(store.projects, ok))

const addProject = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(CreateProject)
  const workspaces = yield* WorkspaceManager
  const store = yield* Store
  const resolved = yield* Effect.either(workspaces.resolveRepo(body.repoPath))
  if (resolved._tag === "Left") {
    return yield* problem(400, "not a git repository", resolved.left.detail)
  }
  // The repository root, not the path that was typed: a run's worktree branches off the root.
  return yield* ok(yield* store.addProject({ name: body.name, repoPath: resolved.right }), 201)
})

const listRuns = Effect.gen(function* () {
  const store = yield* Store
  const projectId = yield* pathParam("id")
  const project = yield* store.project(projectId)
  return project === undefined
    ? yield* problem(404, "not found", `project ${projectId}`)
    : yield* ok(yield* store.runs(projectId))
})

const getRun = Effect.gen(function* () {
  const store = yield* Store
  const runId = RunId.make(yield* pathParam("id"))
  const run = yield* store.run(runId)
  if (run === undefined) return yield* problem(404, "not found", `run ${runId}`)
  const artifact = yield* store.latestArtifact(runId, treeArtifactKind)
  // Absent until planning has settled on a tree; the run is `created` until then.
  const planned =
    artifact === undefined
      ? undefined
      : ((yield* readJson(artifact.path)) as PlannedTree | undefined)
  return yield* ok({
    run,
    tree: planned?.tree,
    retryPolicies:
      planned === undefined
        ? undefined
        : Object.fromEntries(
            planned.policies.map((policy) => [policy.id, { maxAttempts: policy.maxAttempts }]),
          ),
    blocks: yield* store.blocks(runId),
  })
})

const startRun = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(CreateRun)
  const store = yield* Store
  const supervisor = yield* RunSupervisor
  const project = yield* store.project(body.projectId)
  if (project === undefined) {
    return yield* problem(404, "not found", `project ${body.projectId}`)
  }
  const runId = yield* supervisor.start({ project, prompt: body.prompt })
  return yield* ok({ runId }, 202)
})

const runEvents = Effect.gen(function* () {
  const search = yield* HttpServerRequest.ParsedSearchParams
  const runId = RunId.make(yield* pathParam("id"))
  const events = yield* page(
    runId,
    EventSeq.make(intParam(search.from, 0)),
    intParam(search.limit, defaultPageSize, maxPageSize),
  )
  return yield* ok(events)
})

const decideGate = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(GateDecision)
  const engine = yield* WorkflowEngine
  const runId = RunId.make(yield* pathParam("id"))
  const gateId = BlockId.make(yield* pathParam("gateId"))
  const decided = yield* Effect.either(
    engine.approveGate(runId, gateId, body.approved, body.note),
  )
  return decided._tag === "Left"
    ? yield* problem(409, "no gate awaiting a decision", decided.left.detail)
    : yield* ok({ ok: true })
})

const answerQuestion = Effect.gen(function* () {
  const body = yield* HttpServerRequest.schemaBodyJson(QuestionAnswer)
  const engine = yield* WorkflowEngine
  const runId = RunId.make(yield* pathParam("id"))
  const blockId = BlockId.make(yield* pathParam("blockId"))
  const answered = yield* Effect.either(engine.answerQuestion(runId, blockId, body.answer))
  return answered._tag === "Left"
    ? yield* problem(409, "no question awaiting an answer", answered.left.detail)
    : yield* ok({ ok: true })
})

const cancelRun = Effect.gen(function* () {
  const store = yield* Store
  const supervisor = yield* RunSupervisor
  const runId = RunId.make(yield* pathParam("id"))
  const run = yield* store.run(runId)
  if (run === undefined) return yield* problem(404, "not found", `run ${runId}`)
  const cancelled = yield* supervisor.cancel(runId)
  return cancelled
    ? yield* ok({ ok: true })
    : yield* problem(
        409,
        "run is not executing here",
        `run ${runId} is ${run.status} and is not owned by this daemon process`,
      )
})

/** ADR-008: one canonical session per run, seeded from the task brief and resumed after that. */
const openTerminal = Effect.gen(function* () {
  const store = yield* Store
  const continuation = yield* ContinuationService
  const runId = RunId.make(yield* pathParam("id"))
  const run = yield* store.run(runId)
  if (run === undefined) return yield* problem(404, "not found", `run ${runId}`)
  const opened = yield* Effect.either(continuation.open(runId))
  if (opened._tag === "Right") return yield* ok({ opened: true, ...opened.right })
  // Only a terminal that would not open is the terminal's fault; a journal or git failure is ours.
  return opened.left._tag === "HerdrError"
    ? yield* problem(502, "could not open a terminal", opened.left.detail)
    : yield* problem(500, "internal error", opened.left.detail)
})

/** Plan §12: a retrospective judges a run that is over, so a live one is refused rather than read. */
const runRetrospective = Effect.gen(function* () {
  const store = yield* Store
  const retrospectives = yield* RetrospectiveService
  const runId = RunId.make(yield* pathParam("id"))
  const run = yield* store.run(runId)
  if (run === undefined) return yield* problem(404, "not found", `run ${runId}`)
  if (run.status === "created" || run.status === "running") {
    return yield* problem(409, "run has not finished", `run ${runId} is ${run.status}`)
  }
  const analyzed = yield* Effect.either(retrospectives.analyze(runId))
  return analyzed._tag === "Left"
    ? yield* problem(502, "the retrospective produced no insights", detailOf(analyzed.left))
    : yield* ok({ insights: analyzed.right })
})

const listInsights = Effect.gen(function* () {
  const search = yield* HttpServerRequest.ParsedSearchParams
  const retrospectives = yield* RetrospectiveService
  const target = single(search.target)
  if (target !== undefined && !InsightTarget.literals.includes(target as InsightTarget)) {
    return yield* problem(400, "invalid request", `target must be one of ${InsightTarget.literals.join(", ")}`)
  }
  return yield* ok(
    yield* retrospectives.insights({
      target: target as InsightTarget | undefined,
      limit: intParam(search.limit, defaultPageSize, maxPageSize),
      offset: intParam(search.offset, 0),
    }),
  )
})

const getInsight = Effect.gen(function* () {
  const retrospectives = yield* RetrospectiveService
  const id = yield* pathParam("id")
  const found = yield* retrospectives.insight(id)
  return found === undefined ? yield* problem(404, "not found", `insight ${id}`) : yield* ok(found)
})

const retryRun = problem(
  501,
  "not implemented",
  "re-entering a tree requires the engine to skip blocks the journal already completed; deferred with boot-time resume (plan §9)",
)

/** Under the run: a block id names an instance inside one run, not a row in the whole journal. */
const listAttempts = Effect.gen(function* () {
  const store = yield* Store
  const runId = RunId.make(yield* pathParam("id"))
  const blockId = BlockId.make(yield* pathParam("blockId"))
  return yield* ok(yield* store.attempts(runId, blockId))
})

const getAttempt = Effect.gen(function* () {
  const store = yield* Store
  const attemptId = AttemptId.make(yield* pathParam("id"))
  const attempt = yield* store.attempt(attemptId)
  return attempt === undefined
    ? yield* problem(404, "not found", `attempt ${attemptId}`)
    : yield* ok(attempt)
})

const getArtifact = Effect.gen(function* () {
  const store = yield* Store
  const artifactId = ArtifactId.make(yield* pathParam("id"))
  const artifact = yield* store.artifact(artifactId)
  return artifact === undefined
    ? yield* problem(404, "not found", `artifact ${artifactId}`)
    : yield* ok(artifact)
})

const getArtifactRaw = Effect.gen(function* () {
  const store = yield* Store
  const artifactId = ArtifactId.make(yield* pathParam("id"))
  const artifact = yield* store.artifact(artifactId)
  if (artifact === undefined) {
    return yield* problem(404, "not found", `artifact ${artifactId}`)
  }
  if (artifact.bytes > outputBudget) {
    return yield* problem(
      413,
      "artifact too large",
      `${artifact.bytes} bytes is over the ${outputBudget} byte limit`,
    )
  }
  // The platform infers the type from the extension and falls back to a download; a transcript or
  // a log is text, and only an explicit header says so.
  return yield* HttpServerResponse.file(
    artifact.path,
    asText.has(NodePath.extname(artifact.path))
      ? { headers: { "content-type": "text/plain; charset=utf-8" } }
      : undefined,
  )
})

/** Backfill from the client's cursor, then live: contracts §9, and reconnect is a new cursor. */
const streamRun = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const search = yield* HttpServerRequest.ParsedSearchParams
  const runId = single(search.runId)
  if (runId === undefined) {
    return yield* problem(400, "invalid request", "a runId query parameter is required")
  }
  // A websocket is exempt from CORS, so the browser's Origin is checked here or nowhere. Absent
  // means a non-browser client (curl, the tests), which no page can forge on a browser's behalf.
  const origin = request.headers.origin
  if (origin !== undefined && !isLoopbackUrl(origin)) {
    return yield* problem(403, "forbidden", `origin ${origin} may not open a run stream`)
  }
  const from = EventSeq.make(intParam(search.from, 0))
  const bus = yield* EventBus
  const socket = yield* request.upgrade

  yield* Effect.scoped(
    Effect.gen(function* () {
      // Subscribed before the backfill reads, so an event landing between the two is not lost.
      // ponytail: that subscription buffers every run's events, unfiltered, for as long as the
      // backfill takes. Upgrade path if a long backfill on a busy daemon ever costs memory:
      // backfill first, subscribe after, then re-page from the cursor to close the gap.
      const live = yield* bus.subscribe
      const write = yield* socket.writer
      const send = (event: JournalEvent) => write(JSON.stringify(event))
      // The handshake happens inside `run`, and every write waits on it, so it starts first.
      // It ends when the client goes away, which is what closes this handler.
      const connection = yield* Effect.fork(socket.run(() => {}))

      const backfill = (after: EventSeq): Effect.Effect<EventSeq, unknown, Journal> =>
        Effect.gen(function* () {
          const events = yield* page(RunId.make(runId), after, wsPageSize)
          const last = events[events.length - 1]
          if (last === undefined) return after
          yield* Effect.forEach(events, send, { discard: true })
          return events.length < wsPageSize ? last.seq : yield* backfill(last.seq)
        })

      const cursor = yield* backfill(from)
      const forward = Stream.runForEach(
        Stream.filter(live, (event) => event.runId === runId && event.seq > cursor),
        send,
      )
      const ping = Effect.forever(Effect.zipRight(Effect.sleep(heartbeatMs), write(heartbeat)))
      yield* Effect.raceFirst(forward, Effect.raceFirst(ping, Fiber.join(connection)))
    }),
  ).pipe(Effect.ignoreLogged)

  return HttpServerResponse.empty()
})

type ApiServices =
  | ContinuationService
  | EventBus
  | Journal
  | RetrospectiveService
  | RunSupervisor
  | Store
  | WorkflowEngine
  | WorkspaceManager

type ApiHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  ApiServices | HttpRouter.HttpRouter.Provided | HttpRouter.HttpRouter.DefaultServices
>

export const apiRoutes = (
  router: HttpRouter.HttpRouter.Service<unknown, HttpRouter.HttpRouter.DefaultServices>,
) =>
  Effect.gen(function* () {
    // The router types a handler's context as the request's own, so the daemon's services are
    // closed over here instead — which is also what puts them in the layer's requirements.
    const context = yield* Effect.context<ApiServices>()
    const route = (handler: ApiHandler) => Effect.provide(handler, context)

    yield* router.get("/api/projects", route(respond(listProjects)))
    yield* router.post("/api/projects", route(respond(addProject)))
    yield* router.get("/api/projects/:id/runs", route(respond(listRuns)))
    yield* router.post("/api/runs", route(respond(startRun)))
    yield* router.get("/api/runs/:id", route(respond(getRun)))
    yield* router.get("/api/runs/:id/events", route(respond(runEvents)))
    yield* router.post("/api/runs/:id/gates/:gateId", route(respond(decideGate)))
    yield* router.post("/api/runs/:id/questions/:blockId", route(respond(answerQuestion)))
    yield* router.post("/api/runs/:id/cancel", route(respond(cancelRun)))
    yield* router.post("/api/runs/:id/terminal", route(respond(openTerminal)))
    yield* router.post("/api/runs/:id/retrospective", route(respond(runRetrospective)))
    yield* router.post("/api/runs/:id/retry", retryRun)
    yield* router.get("/api/insights", route(respond(listInsights)))
    yield* router.get("/api/insights/:id", route(respond(getInsight)))
    yield* router.get("/api/runs/:id/blocks/:blockId/attempts", route(respond(listAttempts)))
    yield* router.get("/api/attempts/:id", route(respond(getAttempt)))
    yield* router.get("/api/artifacts/:id", route(respond(getArtifact)))
    yield* router.get("/api/artifacts/:id/raw", route(respond(getArtifactRaw)))
    yield* router.get("/api/ws", route(respond(streamRun)))
  })
