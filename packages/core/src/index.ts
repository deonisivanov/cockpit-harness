import { Layer } from "effect"
import { AnalyzerLive } from "./Analyzer.js"
import { ArtifactStoreLive } from "./ArtifactStore.js"
import { CartridgeLoaderLive } from "./CartridgeLoader.js"
import { ClaudeCodeProviderLive } from "./ClaudeCodeProvider.js"
import { CodexProviderLive } from "./CodexProvider.js"
import { CommandRunnerLive } from "./CommandRunner.js"
import { ContinuationServiceLive } from "./Continuation.js"
import { DbLive } from "./Db.js"
import { EventBusLive } from "./EventBus.js"
import { HerdrClientLive } from "./Herdr.js"
import { JournalLive } from "./Journal.js"
import { PluginCatalogLive } from "./PluginCatalog.js"
import { ProcessSupervisorLive } from "./ProcessSupervisor.js"
import { RetrospectiveServiceLive } from "./Retrospective.js"
import { RetryCoordinatorLive } from "./RetryCoordinator.js"
import { TransformPipelineLive } from "./TransformPipeline.js"
import { StoreLive } from "./Store.js"
import { CheckpointServiceLive, WorkspaceManagerLive } from "./Workspace.js"
import { WorkflowEngineLive } from "./WorkflowEngine.js"

export * from "./Analyzer.js"
export * from "./ArtifactStore.js"
export * from "./blocks.js"
export * from "./brief.js"
export * from "./cartridge.js"
export * from "./CartridgeLoader.js"
export * from "./ClaudeCodeProvider.js"
export * from "./CodexProvider.js"
export * from "./CommandRunner.js"
export * from "./Continuation.js"
export * from "./DaemonLock.js"
export * from "./Db.js"
export * from "./errors.js"
export * from "./EventBus.js"
export * from "./events.js"
export * from "./failure.js"
export * from "./Herdr.js"
export * from "./ids.js"
export * from "./Journal.js"
export * from "./PluginCatalog.js"
export * from "./ProcessSupervisor.js"
export * from "./Provider.js"
export * from "./Recovery.js"
export * from "./Resume.js"
export * from "./Store.js"
export * from "./RetryCoordinator.js"
export * from "./Retrospective.js"
export * from "./templates.js"
export * from "./TemplateRegistry.js"
export * from "./text.js"
export * from "./TransformPipeline.js"
export * from "./Workspace.js"
export * from "./workflow.js"
export * from "./WorkflowEngine.js"
export * from "./WorkflowValidator.js"

export const coreVersion = "0.0.0"

/** Recovery is composed on top by the daemon, which decides when a boot scan is due. */
export const KernelLive = Layer.mergeAll(
  WorkspaceManagerLive,
  CheckpointServiceLive,
  CommandRunnerLive,
  ClaudeCodeProviderLive,
  CodexProviderLive,
  StoreLive,
).pipe(
  Layer.provideMerge(Layer.mergeAll(JournalLive, ProcessSupervisorLive)),
  Layer.provideMerge(Layer.mergeAll(DbLive, EventBusLive)),
)

export const EngineLive = WorkflowEngineLive.pipe(
  Layer.provideMerge(RetryCoordinatorLive),
  Layer.provideMerge(Layer.mergeAll(ArtifactStoreLive, PluginCatalogLive)),
  Layer.provideMerge(KernelLive),
)

/** What turns a prompt into a validated tree: cartridge, Analyzer, transforms (plan §16.5). */
export const PlanningLive = Layer.mergeAll(
  AnalyzerLive,
  TransformPipelineLive,
  CartridgeLoaderLive,
).pipe(Layer.provideMerge(EngineLive))

/** The terminal handoff (plan §16.7); it reads the cartridge for the project's checks. */
export const ContinuityLive = ContinuationServiceLive.pipe(
  Layer.provideMerge(HerdrClientLive),
  Layer.provideMerge(PlanningLive),
)

/** Cross-run learning (plan §16.8); it reads the journal a finished run left behind. */
export const RetrospectiveLive = RetrospectiveServiceLive.pipe(
  Layer.provideMerge(ContinuityLive),
)
