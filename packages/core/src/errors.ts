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
  op: Schema.Literal(
    "create",
    "reconcile",
    "resolve",
    "remove",
    "checkpoint",
    "rollback",
    "finalize",
  ),
  detail: Schema.String,
}) {}

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  rule: Schema.String,
  path: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

export class DaemonError extends Schema.TaggedError<DaemonError>()("DaemonError", {
  op: Schema.Literal("home", "lock"),
  detail: Schema.String,
}) {}

export class CartridgeError extends Schema.TaggedError<CartridgeError>()("CartridgeError", {
  stage: Schema.Literal("load", "validate", "transform"),
  detail: Schema.String,
}) {}

export class HerdrError extends Schema.TaggedError<HerdrError>()("HerdrError", {
  op: Schema.Literal("connect", "tab", "agent"),
  detail: Schema.String,
}) {}

export class PreflightError extends Schema.TaggedError<PreflightError>()("PreflightError", {
  reason: Schema.Literal(
    "provider-unavailable",
    "plugin-missing",
    "entry-missing",
    "version-incompatible",
    "permission-missing",
    "workspace-unsafe",
  ),
  detail: Schema.String,
}) {}
