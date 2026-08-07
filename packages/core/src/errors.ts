import { Schema } from "effect"
import { SessionId } from "./ids.js"

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  op: Schema.String,
  detail: Schema.String,
}) {}

export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  kind: Schema.Literal("spawn", "io", "timeout"),
  detail: Schema.String,
}) {}

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  kind: Schema.Literal("spawn", "crash", "parse", "timeout"),
  detail: Schema.String,
  sessionId: Schema.optional(SessionId),
}) {}

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  op: Schema.Literal("create", "reconcile", "remove", "checkpoint", "rollback", "finalize"),
  detail: Schema.String,
}) {}

export class DaemonError extends Schema.TaggedError<DaemonError>()("DaemonError", {
  op: Schema.Literal("home", "lock"),
  detail: Schema.String,
}) {}
