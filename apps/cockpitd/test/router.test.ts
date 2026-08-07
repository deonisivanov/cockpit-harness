import { HttpClient, HttpRouter } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeRoutesLayer } from "../src/router.js"

const uiDist = mkdtempSync(NodePath.join(tmpdir(), "cockpitd-ui-"))
writeFileSync(NodePath.join(uiDist, "index.html"), "<html>spa shell</html>")
mkdirSync(NodePath.join(uiDist, "assets"))
writeFileSync(NodePath.join(uiDist, "assets", "app.js"), "export const x = 1")

afterAll(() => rmSync(uiDist, { recursive: true, force: true }))

const ServeLive = HttpRouter.Default.serve().pipe(Layer.provide(makeRoutesLayer(uiDist)))

const request = (method: "GET" | "POST", path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* (method === "GET" ? client.get(path) : client.post(path))
    const body = yield* response.text
    return { status: response.status, headers: response.headers, body }
  }).pipe(Effect.provide(ServeLive), Effect.provide(NodeHttpServer.layerTest), Effect.runPromise)

const get = (path: string) => request("GET", path)

it("GET /healthz returns 200 with {status: \"ok\"}", async () => {
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
    const { status, body } = await request("POST", "/api/nonexistent")
    expect(status).toBe(404)
    expect(JSON.parse(body)).toEqual({ error: "not found" })
  })
})
