import { afterEach, describe, expect, it, vi } from "vitest"
import { httpSource } from "./api.js"

type Handler = (url: string, init?: RequestInit) => Response

const stubFetch = (handler: Handler) => {
  const calls: string[] = []
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push(url)
    return Promise.resolve(handler(url, init))
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe("artifact", () => {
  const row = { id: "art_1", kind: "diff", path: "a/b.patch", bytes: 12 }

  it("joins the metadata row with the body from /raw", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/raw")
        ? new Response("-old\n+new")
        : new Response(JSON.stringify(row), { headers: { "content-type": "application/json" } }),
    )

    await expect(httpSource.artifact("art_1")).resolves.toEqual({ ...row, text: "-old\n+new" })
    expect(calls).toEqual(["/api/artifacts/art_1", "/api/artifacts/art_1/raw"])
  })

  it("reports an oversized body instead of failing the expander", async () => {
    stubFetch((url) =>
      url.endsWith("/raw")
        ? new Response("", { status: 413 })
        : new Response(JSON.stringify(row), { headers: { "content-type": "application/json" } }),
    )

    const body = await httpSource.artifact("art_1")
    expect(body.kind).toBe("diff")
    expect(body.text).toMatch(/too large/)
  })

  it("propagates a real failure on the body request", async () => {
    stubFetch((url) =>
      url.endsWith("/raw")
        ? new Response("", { status: 500 })
        : new Response(JSON.stringify(row), { headers: { "content-type": "application/json" } }),
    )
    await expect(httpSource.artifact("art_1")).rejects.toThrow(/500/)
  })
})

describe("answer", () => {
  it("retries a 409 raised while the attempt is still parking", async () => {
    let n = 0
    const calls = stubFetch(() => {
      n += 1
      return n < 3 ? new Response("", { status: 409 }) : new Response("", { status: 200 })
    })

    await expect(httpSource.answer("run_1", "implement", "a")).resolves.toBeUndefined()
    expect(calls).toHaveLength(3)
  })

  it("gives up once the 30s budget is spent", async () => {
    const calls = stubFetch(() => new Response("", { status: 409 }))
    // Drive the clock instead of sleeping: 20s per reading exhausts the budget on the second check.
    const real = Date.now
    let t = real()
    vi.stubGlobal("Date", { ...Date, now: () => (t += 20_000) })

    await expect(httpSource.answer("run_1", "implement", "a")).rejects.toThrow(/409/)
    expect(calls.length).toBeLessThan(4)
  })

  it("stops early when the question is answered while it backs off", async () => {
    const calls = stubFetch(() => new Response("", { status: 409 }))
    let open = true
    const done = httpSource.answer("run_1", "implement", "a", () => {
      open = false
      return open
    })
    await expect(done).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it("does not retry a status that is not 409", async () => {
    const calls = stubFetch(() => new Response("", { status: 400 }))
    await expect(httpSource.answer("run_1", "implement", "a")).rejects.toThrow(/400/)
    expect(calls).toHaveLength(1)
  })
})
