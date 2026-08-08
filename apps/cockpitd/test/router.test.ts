import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { api, json, withApi } from "./harness.js"

const get = (path: string) => withApi(() => api.get(path))

it('GET /healthz returns 200 with {status: "ok"}', async () => {
  const { status, body } = await get("/healthz")
  expect(status).toBe(200)
  expect(JSON.parse(body)).toEqual({ status: "ok" })
})

describe("static UI serving", () => {
  it("serves index.html at the root path", async () => {
    const { status, body } = await get("/")
    expect(status).toBe(200)
    expect(body).toContain("spa shell")
  })

  it("serves a real nested file with its content type", async () => {
    const { status, headers, body } = await get("/assets/app.js")
    expect(status).toBe(200)
    expect(body).toBe("export const x = 1")
    expect(headers["content-type"]).toContain("javascript")
  })

  it("falls back to index.html for an unknown SPA route", async () => {
    const { status, body } = await get("/runs/abc123")
    expect(status).toBe(200)
    expect(body).toContain("spa shell")
  })

  it("does not hang or escape uiDist on a path-traversal attempt", async () => {
    const { status, body } = await get("/..%2f..%2f..%2fetc%2fpasswd")
    expect(status).toBe(200)
    expect(body).toContain("spa shell")
  })

  it("serves index.html for a doubled leading slash instead of 500ing", async () => {
    const { status, body } = await get("//")
    expect(status).toBe(200)
    expect(body).toContain("spa shell")
  })

  it("returns a safe 404 instead of 500ing on a malformed %-escape", async () => {
    // find-my-way rejects the malformed escape during route matching, before serveUi runs;
    // this pins the router's own safe-404 behavior rather than a serveUi response.
    const { status } = await get("/%zz")
    expect(status).toBe(404)
  })

  it("returns 404 json for an unmatched GET /api/* path", async () => {
    const { status, body } = await get("/api/nonexistent")
    expect(status).toBe(404)
    expect(JSON.parse(body)).toEqual({ error: "not found" })
  })

  it("returns 404 json for an unmatched POST /api/* path", async () => {
    const { status, body } = await withApi(() => api.post("/api/nonexistent"))
    expect(status).toBe(404)
    expect(JSON.parse(body)).toEqual({ error: "not found" })
  })
})

it("answers unknown ids and malformed bodies in JSON", async () => {
  const answers = await withApi(() =>
    Effect.all({
      run: api.get("/api/runs/nope"),
      attempt: api.get("/api/attempts/nope"),
      artifact: api.get("/api/artifacts/nope"),
      runs: api.get("/api/projects/nope/runs"),
      badBody: api.post("/api/projects", { name: "x" }),
      retry: api.post("/api/runs/nope/retry"),
    }),
  )

  expect(answers.run.status).toBe(404)
  expect(json<{ error: string }>(answers.run).error).toBe("not found")
  expect(answers.attempt.status).toBe(404)
  expect(answers.artifact.status).toBe(404)
  expect(answers.runs.status).toBe(404)
  expect(answers.badBody.status).toBe(400)
  expect(json<{ error: string }>(answers.badBody).error).toBe("invalid request")
  // Re-entering a tree is not built; it says so rather than pretending to have run.
  expect(answers.retry.status).toBe(501)
})
