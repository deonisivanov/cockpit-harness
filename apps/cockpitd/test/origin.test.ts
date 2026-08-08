import { Effect } from "effect"
import * as Http from "node:http"
import { expect, it } from "vitest"
import { address, served } from "./harness.js"

interface Attempt {
  readonly status: number | undefined
  readonly upgraded: boolean
  readonly body: string
}

/**
 * node:http rather than fetch or the platform client: both refuse to set Host, and neither lets a
 * websocket handshake carry an Origin. This sends the handshake by hand and reads what comes back.
 */
const request = (
  port: number,
  path: string,
  headers: Readonly<Record<string, string>>,
  upgrade = false,
) =>
  Effect.promise(
    () =>
      new Promise<Attempt>((resolve) => {
        const call = Http.request({
          host: "127.0.0.1",
          port,
          path,
          headers: {
            ...(upgrade
              ? {
                  connection: "Upgrade",
                  upgrade: "websocket",
                  "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                  "sec-websocket-version": "13",
                }
              : {}),
            ...headers,
          },
        })
        call.on("upgrade", (response, socket) => {
          socket.destroy()
          resolve({ status: response.statusCode, upgraded: true, body: "" })
        })
        call.on("response", (response) => {
          let body = ""
          response.on("data", (chunk) => (body += String(chunk)))
          response.on("end", () => resolve({ status: response.statusCode, upgraded: false, body }))
        })
        call.end()
      }),
  )

it("serves loopback hosts and refuses every other name", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* address
      return {
        loopback: yield* request(port, "/api/projects", { host: `127.0.0.1:${port}` }),
        named: yield* request(port, "/api/projects", { host: `localhost:${port}` }),
        // The daemon is bound to 127.0.0.1, so a name that resolves there is the whole attack.
        rebound: yield* request(port, "/api/projects", { host: "cockpit.evil.example" }),
        shell: yield* request(port, "/", { host: "cockpit.evil.example" }),
      }
    }).pipe(Effect.provide(served), Effect.scoped),
  )

  expect(result.loopback.status).toBe(200)
  expect(result.named.status).toBe(200)
  expect(result.rebound.status).toBe(403)
  expect(JSON.parse(result.rebound.body).error).toBe("forbidden")
  // The SPA shell is refused too, or the rebound page just reads it and asks the user to log in.
  expect(result.shell.status).toBe(403)
})

it("upgrades a run stream only for a loopback origin", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* address
      const stream = "/api/ws?runId=run-x&from=0"
      return {
        // curl and the tests send no Origin at all; only a browser is made to.
        anonymous: yield* request(port, stream, { host: `127.0.0.1:${port}` }, true),
        own: yield* request(
          port,
          stream,
          { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
          true,
        ),
        // A dev server on another loopback port is still the user's own machine.
        dev: yield* request(
          port,
          stream,
          { host: `127.0.0.1:${port}`, origin: "http://localhost:5173" },
          true,
        ),
        foreign: yield* request(
          port,
          stream,
          { host: `127.0.0.1:${port}`, origin: "https://evil.example" },
          true,
        ),
      }
    }).pipe(Effect.provide(served), Effect.scoped),
  )

  expect(result.anonymous.upgraded).toBe(true)
  expect(result.own.upgraded).toBe(true)
  expect(result.dev.upgraded).toBe(true)
  expect(result.foreign.upgraded).toBe(false)
  expect(result.foreign.status).toBe(403)
})
