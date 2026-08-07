import { Schema } from "effect"

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  op: Schema.String,
  detail: Schema.String,
}) {}

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  op: Schema.Literal("create", "reconcile", "remove", "checkpoint", "rollback", "finalize"),
  detail: Schema.String,
}) {}

export class DaemonError extends Schema.TaggedError<DaemonError>()("DaemonError", {
  op: Schema.Literal("home", "lock"),
  detail: Schema.String,
}) {}
