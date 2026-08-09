import type {
  ArtifactBody,
  Insight,
  InsightTarget,
  JournalEvent,
  Project,
  Run,
  RunDetail,
  TerminalHandoff,
} from "./model.js"
import type { EventSource } from "./store.js"

/** A file going up with `createRun`; the daemon stores it beside the run for the agent to read. */
export interface NewAttachment {
  readonly name: string
  readonly contentBase64: string
}

export interface Source extends EventSource {
  projects(): Promise<readonly Project[]>
  createProject(name: string, repoPath: string): Promise<Project>
  runs(projectId: string): Promise<readonly Run[]>
  run(runId: string): Promise<RunDetail>
  /** Plans the run and stops; it executes only once `start` is called. */
  createRun(
    projectId: string,
    prompt: string,
    attachments?: readonly NewAttachment[],
  ): Promise<{ runId: string }>
  start(runId: string): Promise<void>
  /** Replans a waiting run; the tree it writes replaces the one on screen. */
  regenerate(runId: string): Promise<void>
  /** Deletes the run and everything it owns — events, artifacts, worktree. Irreversible. */
  deleteRun(runId: string): Promise<void>
  artifact(id: string): Promise<ArtifactBody>
  decideGate(runId: string, gateId: string, approved: boolean, note?: string): Promise<void>
  /** `stillPending` lets the retry loop give up as soon as the question is answered elsewhere. */
  answer(
    runId: string,
    blockId: string,
    answer: string,
    stillPending?: () => boolean,
  ): Promise<void>
  cancel(runId: string): Promise<void>
  stop(runId: string): Promise<void>
  skipBlock(runId: string, blockId: string): Promise<void>
  /** Re-enters an interrupted or failed run; what it already finished is not executed again. */
  resume(runId: string): Promise<void>
  openTerminal(runId: string): Promise<TerminalHandoff>
  insights(target?: InsightTarget): Promise<readonly Insight[]>
}

/** The daemon answers failures in JSON too, and its `detail` is the only useful half of them. */
const failure = async (head: string, res: Response) => {
  try {
    const body = (await res.json()) as { error?: string; detail?: string }
    const said = [body.error, body.detail].filter(Boolean).join(": ")
    return said === "" ? head : `${head} ${said}`
  } catch {
    return head
  }
}

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  })
  if (!res.ok) {
    throw new Error(await failure(`${init?.method ?? "GET"} /api${path} → ${res.status}`, res))
  }
  return (await res.json()) as T
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  json<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })

const EVENT_PAGE = 500
const ANSWER_BUDGET_MS = 30_000
const ANSWER_BACKOFF_MS = 200
const ANSWER_BACKOFF_CAP_MS = 2_000
const OVERSIZE = "artifact too large to preview (over 1 MiB) — open it from the workspace"

export const httpSource: Source = {
  projects: () => json<readonly Project[]>("/projects"),
  createProject: (name, repoPath) => post<Project>("/projects", { name, repoPath }),
  runs: (projectId) => json<readonly Run[]>(`/projects/${projectId}/runs`),
  run: (runId) => json<RunDetail>(`/runs/${runId}`),
  createRun: (projectId, prompt, attachments) =>
    post<{ runId: string }>(
      "/runs",
      attachments === undefined || attachments.length === 0
        ? { projectId, prompt }
        : { projectId, prompt, attachments },
    ),
  start: (runId) => post<void>(`/runs/${runId}/start`),
  regenerate: (runId) => post<void>(`/runs/${runId}/regenerate`),
  deleteRun: (runId) => json<void>(`/runs/${runId}`, { method: "DELETE" }),
  decideGate: (runId, gateId, approved, note) =>
    post<void>(`/runs/${runId}/gates/${gateId}`, { approved, note }),
  cancel: (runId) => post<void>(`/runs/${runId}/cancel`),
  stop: (runId) => post<void>(`/runs/${runId}/stop`),
  skipBlock: (runId, blockId) => post<void>(`/runs/${runId}/blocks/${blockId}/skip`),
  resume: (runId) => post<void>(`/runs/${runId}/resume`),
  openTerminal: (runId) => post<TerminalHandoff>(`/runs/${runId}/terminal`),
  insights: (target) =>
    json<readonly Insight[]>(`/insights${target === undefined ? "" : `?target=${target}`}`),

  // The row carries kind/path; the body lives behind /raw, capped at 1 MiB by the daemon.
  async artifact(id) {
    const row = await json<Omit<ArtifactBody, "text">>(`/artifacts/${id}`)
    const res = await fetch(`/api/artifacts/${id}/raw`)
    if (res.status === 413) return { ...row, text: OVERSIZE }
    if (!res.ok) throw new Error(`GET /api/artifacts/${id}/raw → ${res.status}`)
    return { ...row, text: await res.text() }
  },

  // A question 409s in the window before its attempt parks; it is still open, so back off and retry.
  async answer(runId, blockId, answer, stillPending) {
    const deadline = Date.now() + ANSWER_BUDGET_MS
    let delay = ANSWER_BACKOFF_MS
    for (;;) {
      const res = await fetch(`/api/runs/${runId}/questions/${blockId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer }),
      })
      if (res.ok) return
      const retryable = res.status === 409 && Date.now() + delay < deadline
      if (!retryable) throw new Error(`POST /api/runs/${runId}/questions/${blockId} → ${res.status}`)
      await new Promise((r) => setTimeout(r, delay))
      // Someone else answered it while we were backing off; the POST would only 409 forever.
      if (stillPending?.() === false) return
      delay = Math.min(delay * 2, ANSWER_BACKOFF_CAP_MS)
    }
  },

  async fetchEvents(runId, from, signal) {
    const all: JournalEvent[] = []
    for (;;) {
      const cursor = all.at(-1)?.seq ?? from
      const page = await json<readonly JournalEvent[]>(
        `/runs/${runId}/events?from=${cursor}&limit=${EVENT_PAGE}`,
        { signal },
      )
      all.push(...page)
      if (page.length < EVENT_PAGE) return all
    }
  },

  subscribe(runId, from, onEvents) {
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let cursor = from
    let closed = false
    let attempt = 0

    const connect = () => {
      if (closed) return
      const url = new URL(`/api/ws`, window.location.href)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      url.searchParams.set("runId", runId)
      url.searchParams.set("from", String(cursor))
      socket = new WebSocket(url)

      socket.onopen = () => {
        attempt = 0
      }
      socket.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(String(msg.data)) as JournalEvent | readonly JournalEvent[]
          // Heartbeats arrive as `{type:"ping"}`; anything without a seq must not move the cursor.
          const batch = (Array.isArray(parsed) ? parsed : [parsed]).filter(
            (e: JournalEvent) => typeof e?.seq === "number",
          )
          if (batch.length === 0) return
          cursor = Math.max(cursor, ...batch.map((e) => e.seq))
          onEvents(batch)
        } catch {
          // A frame the UI cannot parse must not tear down a healthy stream.
        }
      }
      socket.onclose = () => {
        if (closed) return
        attempt += 1
        timer = setTimeout(connect, Math.min(1000 * 2 ** (attempt - 1), 10_000))
      }
    }

    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  },
}
