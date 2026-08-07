import { Context, Effect, Layer, PubSub, Scope, Stream } from "effect"
import type { JournalEvent } from "./events.js"

export class EventBus extends Context.Tag("cockpit/EventBus")<
  EventBus,
  {
    readonly publish: (event: JournalEvent) => Effect.Effect<void>
    /** Scoped so the subscription is registered on acquire — a subscriber built lazily would miss events. */
    readonly subscribe: Effect.Effect<Stream.Stream<JournalEvent>, never, Scope.Scope>
  }
>() {}

export const EventBusLive = Layer.effect(
  EventBus,
  Effect.map(PubSub.unbounded<JournalEvent>(), (pubsub) => ({
    publish: (event: JournalEvent) => Effect.asVoid(PubSub.publish(pubsub, event)),
    subscribe: Stream.fromPubSub(pubsub, { scoped: true }),
  })),
)
