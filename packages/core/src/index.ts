import { Layer } from "effect"
import { DbLive } from "./Db.js"
import { EventBusLive } from "./EventBus.js"
import { JournalLive } from "./Journal.js"
import { CheckpointServiceLive, WorkspaceManagerLive } from "./Workspace.js"

export * from "./DaemonLock.js"
export * from "./Db.js"
export * from "./errors.js"
export * from "./EventBus.js"
export * from "./events.js"
export * from "./ids.js"
export * from "./Journal.js"
export * from "./Recovery.js"
export * from "./Workspace.js"

export const coreVersion = "0.0.0"

/** Recovery is composed on top by the daemon, which decides when a boot scan is due. */
export const KernelLive = Layer.mergeAll(WorkspaceManagerLive, CheckpointServiceLive).pipe(
  Layer.provideMerge(JournalLive),
  Layer.provideMerge(Layer.mergeAll(DbLive, EventBusLive)),
)
