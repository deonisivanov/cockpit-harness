import { Journal, JournalEvent, RunId } from "@cockpit/core"
import { Effect, Schedule } from "effect"
import { expect, it } from "vitest"
import { address, served } from "./harness.js"

interface Client {
  readonly received: Array<unknown>
  readonly close: () => void
  readonly take: (count: number) => Effect.Effect<ReadonlyArray<JournalEvent>>
}

const connect = (port: number, query: string) =>
  Effect.async<Client>((resume) => {
    const received: Array<unknown> = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?${query}`)
    socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))))
    socket.addEventListener("open", () =>
      resume(
        Effect.succeed({
          received,
          close: () => socket.close(),
          take: (count) =>
            Effect.filterOrFail(
              Effect.sync(() => received),
              (all) => all.length >= count,
              () => "not yet" as const,
            ).pipe(
              Effect.retry(
                Schedule.spaced("20 millis").pipe(Schedule.intersect(Schedule.recurs(500))),
              ),
              Effect.orDie,
              Effect.map((all) => all.slice(0, count) as ReadonlyArray<JournalEvent>),
            ),
        }),
      ),
    )
  })

it("backfills from the cursor, then streams live events", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const port = yield* address
      const journal = yield* Journal
      const runId = RunId.make(`run-${Date.now()}`)
      yield* journal.createRun({ runId, projectId: "proj", prompt: "stream me" })

      const client = yield* connect(port, `runId=${runId}&from=0`)
      const backfilled = yield* client.take(1)

      // Appended after the socket is up: it can only arrive over the live subscription.
      yield* journal.startRun(runId)
      const live = yield* client.take(2)

      // A reconnect is just a later cursor; the run's first event must not repeat.
      const resumed = yield* connect(port, `runId=${runId}&from=${backfilled[0].seq}`)
      const afterCursor = yield* resumed.take(1)

      const other = RunId.make(`other-${Date.now()}`)
      yield* journal.createRun({ runId: other, projectId: "proj", prompt: "not this one" })
      yield* Effect.sleep("100 millis")

      client.close()
      resumed.close()
      return { afterCursor, backfilled, live, seen: client.received.length }
    }).pipe(Effect.provide(served), Effect.scoped),
  )

  expect(result.backfilled[0].payload._tag).toBe("RunCreated")
  expect(result.live[1].payload._tag).toBe("RunStarted")
  expect(result.live[1].seq).toBeGreaterThan(result.backfilled[0].seq)

  expect(result.afterCursor[0].payload._tag).toBe("RunStarted")
  expect(result.afterCursor[0].seq).toBe(result.live[1].seq)

  // Another run's events are not this socket's business.
  expect(result.seen).toBe(2)
}, 30_000)
