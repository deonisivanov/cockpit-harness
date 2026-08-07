import { Layer } from "effect"
import { ClaudeCodeProviderLive } from "./ClaudeCodeProvider.js"
import { CodexProviderLive } from "./CodexProvider.js"
import { CommandRunnerLive } from "./CommandRunner.js"
import { DbLive } from "./Db.js"
import { EventBusLive } from "./EventBus.js"
import { JournalLive } from "./Journal.js"
import { ProcessSupervisorLive } from "./ProcessSupervisor.js"
import { CheckpointServiceLive, WorkspaceManagerLive } from "./Workspace.js"

export * from "./ClaudeCodeProvider.js"
export * from "./CodexProvider.js"
export * from "./CommandRunner.js"
export * from "./DaemonLock.js"
export * from "./Db.js"
export * from "./errors.js"
export * from "./EventBus.js"
export * from "./events.js"
export * from "./ids.js"
export * from "./Journal.js"
export * from "./ProcessSupervisor.js"
export * from "./Provider.js"
export * from "./Recovery.js"
export * from "./Workspace.js"

export const coreVersion = "0.0.0"

/** Recovery is composed on top by the daemon, which decides when a boot scan is due. */
export const KernelLive = Layer.mergeAll(
  WorkspaceManagerLive,
  CheckpointServiceLive,
  CommandRunnerLive,
  ClaudeCodeProviderLive,
  CodexProviderLive,
).pipe(
  Layer.provideMerge(Layer.mergeAll(JournalLive, ProcessSupervisorLive)),
  Layer.provideMerge(Layer.mergeAll(DbLive, EventBusLive)),
)
