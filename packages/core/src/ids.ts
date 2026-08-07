import { Schema } from "effect"

export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

export const BlockId = Schema.String.pipe(Schema.brand("BlockId"))
export type BlockId = typeof BlockId.Type

export const AttemptId = Schema.String.pipe(Schema.brand("AttemptId"))
export type AttemptId = typeof AttemptId.Type

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const CheckpointId = Schema.String.pipe(Schema.brand("CheckpointId"))
export type CheckpointId = typeof CheckpointId.Type

export const ArtifactId = Schema.String.pipe(Schema.brand("ArtifactId"))
export type ArtifactId = typeof ArtifactId.Type

export const EventSeq = Schema.Int.pipe(Schema.brand("EventSeq"))
export type EventSeq = typeof EventSeq.Type
