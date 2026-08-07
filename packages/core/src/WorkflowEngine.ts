import { Context, Deferred, Effect, Exit, HashMap, Layer, Ref } from "effect"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rm } from "node:fs/promises"
import * as NodePath from "node:path"
import { ArtifactStore } from "./ArtifactStore.js"
import { ClaudeCodeProvider } from "./ClaudeCodeProvider.js"
import { CodexProvider } from "./CodexProvider.js"
import { artifactExists, CommandRunner, CommandSpec } from "./CommandRunner.js"
import {
  JournalError,
  ProcessError,
  ProviderError,
  ValidationError,
  WorkspaceError,
} from "./errors.js"
import { AttemptVerdict, CriterionResult } from "./events.js"
import { AttemptEvidence, buildFailurePacket } from "./failure.js"
import { ArtifactId, AttemptId, BlockId, CheckpointId, RunId, SessionId } from "./ids.js"
import { Journal } from "./Journal.js"
import { Provider, ProviderEvent, runToResult } from "./Provider.js"
import { AttemptInput, AttemptOutcome, RetryCoordinator } from "./RetryCoordinator.js"
import { clip, outputBudget } from "./text.js"
import { CheckpointService, Workspace } from "./Workspace.js"
import { blocksIn, validateWorkflow, WorkflowCatalog } from "./WorkflowValidator.js"
import {
  BlockDef,
  BlockInputEnvelope,
  ContractField,
  contractProblems,
  evaluateCheck,
  GatePayload,
  pickFields,
  RetryPolicy,
  WorkflowNode,
  WorkflowTree,
} from "./workflow.js"

export interface RunRequest {
  readonly runId: RunId
  readonly task: { readonly prompt: string; readonly projectId: string }
  readonly tree: WorkflowTree
  readonly workspace: Workspace
  readonly catalog: WorkflowCatalog
}

export interface RunOutcome {
  readonly status: "succeeded" | "failed"
  readonly outputs: Readonly<Record<string, unknown>>
}

export type EngineError =
  | ValidationError
  | JournalError
  | WorkspaceError
  | ProviderError
  | ProcessError

export class WorkflowEngine extends Context.Tag("cockpit/WorkflowEngine")<
  WorkflowEngine,
  {
    readonly run: (request: RunRequest) => Effect.Effect<RunOutcome, EngineError>
    readonly approveGate: (
      runId: RunId,
      gateId: BlockId,
      approved: boolean,
      note?: string,
    ) => Effect.Effect<void, JournalError>
  }
>() {}

type BlockNode = Extract<WorkflowNode, { _tag: "Block" }>

interface RunState {
  readonly outputs: Record<string, unknown>
  readonly outputRefs: Record<string, ArtifactId>
  readonly executions: Record<string, number>
  readonly sessions: Record<string, SessionId>
  readonly lastCheckpoint: CheckpointId
}

/** An attempt's evidence plus the verdict the engine reached on it. */
interface Judged extends AttemptEvidence {
  readonly failed: boolean
  readonly outputRef?: ArtifactId
}

interface OutputFile {
  readonly text?: string
  readonly problem?: string
}

interface NodeContext {
  readonly readOnly: boolean
  readonly feedback?: AttemptInput["feedback"]
  /** A corrective loop hands its feedback to one block; the rest of the body must not see it. */
  readonly feedbackTo?: BlockId
}

const excerpt = (text: string, max = 800) => (text.length <= max ? text : `${clip(text, max)}…`)

/** Small enough that a reader of the journal alone can still see what a block produced. */
const inlineResultChars = 16 * 1024

/** A prior output the next block only glances at should not crowd out its own instructions. */
const inlineFieldChars = 4_000

const sizeOf = (value: unknown) => (JSON.stringify(value) ?? "").length

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Keeps the declared fields, but hands on an excerpt and a pointer when one is oversized. */
const boundedOutput = (
  fields: ReadonlyArray<ContractField>,
  value: unknown,
  ref: ArtifactId | undefined,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(pickFields(fields, value)).map(([name, field]) => {
      const json = JSON.stringify(field) ?? ""
      if (json.length <= inlineFieldChars) return [name, field]
      const where = ref === undefined ? "" : `, full value in artifact ${ref}`
      return [name, `${clip(json, inlineFieldChars)}… [truncated${where}]`]
    }),
  )

/**
 * The result file is the agent's to write, so its size and its kind are checked before it is read:
 * an oversized result breaks the contract rather than being silently truncated, and a symlink is
 * refused outright rather than followed out of the run directory.
 */
const readOutput = (path: string): Effect.Effect<OutputFile> =>
  Effect.gen(function* () {
    const stats = yield* Effect.tryPromise(() => lstat(path)).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    if (stats === undefined) {
      return { problem: `no JSON result was written to $COCKPIT_OUTPUT (${path})` }
    }
    if (!stats.isFile()) {
      return { problem: `$COCKPIT_OUTPUT (${path}) is not a regular file` }
    }
    if (stats.size > outputBudget) {
      return {
        problem: `the result at $COCKPIT_OUTPUT is ${stats.size} bytes, over the ${outputBudget} byte limit`,
      }
    }
    const text = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    return text === undefined
      ? { problem: `the result at $COCKPIT_OUTPUT (${path}) could not be read` }
      : { text }
  })

const outputInstruction = (fields: ReadonlyArray<ContractField>, path: string) =>
  [
    `Write your result as a single JSON object to the file at $COCKPIT_OUTPUT (${path}).`,
    "It must contain:",
    ...fields.map(
      (field) => `- ${field.name}: ${field.type}${field.required ? " (required)" : " (optional)"}`,
    ),
    "Nothing else counts as this block's result; a missing or malformed file is a failure.",
  ].join("\n")

const composePrompt = (input: {
  readonly def: BlockDef
  readonly prompt: string
  readonly envelope: unknown
  readonly outputPath: string
  readonly feedback?: string
}) =>
  [
    `# ${input.def.title}`,
    "",
    "## Task",
    input.prompt,
    ...(input.def.promptTemplate === undefined ? [] : ["", "## Goal", input.def.promptTemplate]),
    "",
    "## Input",
    "```json",
    JSON.stringify(input.envelope, null, 2),
    "```",
    "",
    "## Output contract",
    outputInstruction(input.def.output, input.outputPath),
    ...(input.def.successCriteria.length === 0
      ? []
      : [
          "",
          "## Success criteria",
          ...input.def.successCriteria.map(
            (criterion) => `- ${criterion.id}: ${criterion.description}`,
          ),
        ]),
    ...(input.feedback === undefined
      ? []
      : [
          "",
          input.feedback,
          "",
          "Change strategy based on the evidence above; do not repeat what already failed.",
        ]),
  ].join("\n")

export const WorkflowEngineLive = Layer.effect(
  WorkflowEngine,
  Effect.gen(function* () {
    const journal = yield* Journal
    const artifacts = yield* ArtifactStore
    const checkpoints = yield* CheckpointService
    const commands = yield* CommandRunner
    const coordinator = yield* RetryCoordinator
    const claude = yield* ClaudeCodeProvider
    const codex = yield* CodexProvider

    const gates = yield* Ref.make(
      HashMap.empty<string, Deferred.Deferred<{ approved: boolean; note?: string }>>(),
    )
    const gateKey = (runId: RunId, gateId: BlockId) => `${runId}:${gateId}`

    const requestApproval = (runId: RunId, gateId: BlockId, payload: GatePayload) =>
      Effect.gen(function* () {
        const ref = yield* artifacts.write({
          runId,
          blockId: gateId,
          kind: "gate-payload",
          name: "approval.json",
          content: JSON.stringify(payload, null, 2),
        })
        const key = gateKey(runId, gateId)
        // Registration and removal are one bracket: a failed ApprovalRequested must not leave a
        // deferred behind for `approveGate` to resolve into nothing.
        const decision = yield* Effect.acquireUseRelease(
          Effect.tap(Deferred.make<{ approved: boolean; note?: string }>(), (deferred) =>
            Ref.update(gates, HashMap.set(key, deferred)),
          ),
          (deferred) =>
            Effect.zipRight(
              journal.append({
                runId,
                blockId: gateId,
                payload: { _tag: "ApprovalRequested", gateId, payloadRef: ref.id },
              }),
              Deferred.await(deferred),
            ),
          () => Ref.update(gates, HashMap.remove(key)),
        )
        yield* journal.append({
          runId,
          blockId: gateId,
          payload: {
            _tag: "ApprovalDecided",
            gateId,
            approved: decision.approved,
            note: decision.note,
          },
        })
        return decision.approved
      })

    const providerFor = (def: BlockDef): Provider => (def.provider === "codex" ? codex : claude)

    const run = (request: RunRequest) =>
      Effect.gen(function* () {
        const { runId, workspace } = request
        const defs = new Map(request.catalog.blocks.map((def) => [def.id, def]))
        const policies = new Map(request.catalog.policies.map((policy) => [policy.id, policy]))

        const errors = validateWorkflow(request.tree, request.catalog)
        yield* journal.append({
          runId,
          payload: {
            _tag: "TreeValidated",
            errors: errors.map(({ rule, path, message }) => ({ rule, path, message })),
          },
        })
        const invalid = errors[0]
        if (invalid !== undefined) return yield* Effect.fail(invalid)

        yield* journal.startRun(runId)

        // Rollback needs a target from the first attempt onward, and recovery treats the newest
        // success checkpoint as the resume point — so the run opens with one.
        const baseline = yield* checkpoints.checkpoint(workspace, {
          kind: "success",
          message: `cockpit: run ${runId} baseline`,
        })
        const state = yield* Ref.make<RunState>({
          outputs: {},
          outputRefs: {},
          executions: {},
          sessions: {},
          lastCheckpoint: baseline,
        })

        // The target is captured where the loop starts: an iteration that checkpoints partway
        // through must not become the place a later rollback undoes the loop to. The resume point
        // moves back with the worktree, which no longer holds what the abandoned checkpoint had.
        const rollbackTo = (checkpoint: CheckpointId) =>
          Effect.ignoreLogged(
            Effect.zipRight(
              checkpoints.rollbackTo(workspace, checkpoint),
              Ref.update(state, (value) => ({ ...value, lastCheckpoint: checkpoint })),
            ),
          )

        const instanceId = (nodeId: BlockId) =>
          Ref.modify(state, (current) => {
            const count = (current.executions[nodeId] ?? 0) + 1
            return [
              BlockId.make(count === 1 ? nodeId : `${nodeId}#${count}`),
              { ...current, executions: { ...current.executions, [nodeId]: count } },
            ] as const
          })

        /** The id the newest execution of a node is journaled under, for events that name it later. */
        const currentInstance = (nodeId: BlockId) =>
          Effect.map(Ref.get(state), (current) => {
            const count = current.executions[nodeId] ?? 0
            return BlockId.make(count <= 1 ? nodeId : `${nodeId}#${count}`)
          })

        const envelopeFor = (input: {
          readonly def: BlockDef
          readonly node: BlockNode
          readonly blockId: BlockId
          readonly attemptId: AttemptId
          readonly feedback?: string
        }): Effect.Effect<BlockInputEnvelope, EngineError> =>
          Effect.gen(function* () {
            const { attemptId, blockId, def, node } = input
            const current = yield* Ref.get(state)
            const sources = (node.inputs ?? []).filter((source) => source in current.outputs)
            const supplied = new Set(
              sources.flatMap((source) => Object.keys(pickFields(def.input, current.outputs[source]))),
            )
            // A branch that never ran leaves a wired input unfilled. Handing the block an empty
            // envelope would make it invent the missing half, so the attempt stops instead.
            const missing = def.input.filter(
              (field) => field.required && !supplied.has(field.name),
            )
            if (missing.length > 0) {
              const detail = `${def.id} is missing required input ${missing
                .map((field) => `"${field.name}"`)
                .join(", ")}: no source that ran produced it`
              yield* journal.append({
                runId,
                blockId,
                attemptId,
                payload: {
                  _tag: "ErrorRaised",
                  class: "semantic",
                  signature: "missing-input",
                  message: detail,
                },
              })
              return yield* Effect.fail(
                new ValidationError({ rule: "input-contract", path: [blockId], message: detail }),
              )
            }

            const changedFiles = yield* checkpoints.changedFiles(workspace)
            return {
              task: request.task,
              workspace: {
                worktreePath: workspace.path,
                headCheckpoint: current.lastCheckpoint,
                changedFiles,
              },
              priorOutputs: Object.fromEntries(
                sources.map((source) => [
                  source,
                  boundedOutput(def.input, current.outputs[source], current.outputRefs[source]),
                ]),
              ),
              ...(input.feedback === undefined ? {} : { attemptContext: input.feedback }),
            }
          })

        const missingArtifacts = (def: BlockDef) =>
          Effect.forEach(
            (def.expectedArtifacts ?? []).filter((expected) => expected.required),
            (expected) =>
              Effect.map(artifactExists(workspace.path, expected.glob), (found) =>
                found ? [] : [`expected artifact ${expected.glob} was not produced`],
              ),
            { concurrency: 4 },
          ).pipe(Effect.map((all) => all.flat()))

        const verify = (def: BlockDef, blockId: BlockId, attemptId: AttemptId, output: unknown) =>
          Effect.gen(function* () {
            const criteria = def.successCriteria.map(
              (criterion): CriterionResult => ({
                criterion: criterion.id,
                passed: evaluateCheck(criterion, output),
              }),
            )
            if (criteria.length > 0) {
              yield* journal.append({
                runId,
                blockId,
                attemptId,
                payload: { _tag: "VerificationReported", criteria },
              })
            }
            return criteria.flatMap((result) =>
              result.passed ? [] : [`success criterion "${result.criterion}" was not met`],
            )
          })

        const runAgent = (input: {
          readonly node: BlockNode
          readonly def: BlockDef
          readonly policy: RetryPolicy
          readonly blockId: BlockId
          readonly attemptId: AttemptId
          readonly session: { readonly assigned: SessionId; readonly resume?: SessionId }
          readonly feedback?: string
          readonly readOnly: boolean
          readonly timeoutMs: number
        }): Effect.Effect<Judged, EngineError> =>
          Effect.gen(function* () {
            const { attemptId, blockId, def, node } = input
            const dir = yield* artifacts.runDir(runId)
            const outputPath = NodePath.join(dir, `${attemptId}.output.json`)
            yield* Effect.tryPromise({
              try: () => mkdir(dir, { recursive: true }),
              catch: (cause) =>
                new JournalError({ op: "writeArtifact", detail: `run dir: ${String(cause)}` }),
            })

            const envelope = yield* envelopeFor({
              def,
              node,
              blockId,
              attemptId,
              feedback: input.feedback,
            })
            const prompt = composePrompt({
              def,
              prompt: request.task.prompt,
              envelope,
              outputPath,
              feedback: input.feedback,
            })
            const promptRef = yield* artifacts.write({
              runId,
              blockId,
              attemptId,
              kind: "prompt",
              name: "prompt.md",
              content: prompt,
            })
            yield* journal.append({
              runId,
              blockId,
              attemptId,
              payload: { _tag: "PromptComposed", promptRef: promptRef.id },
            })

            const seen = yield* Ref.make({
              activities: [] as ReadonlyArray<string>,
              transcript: [] as ReadonlyArray<string>,
              stderr: [] as ReadonlyArray<string>,
              reported: undefined as SessionId | undefined,
            })

            const onEvent = (event: ProviderEvent) =>
              Effect.gen(function* () {
                yield* Ref.update(seen, (acc) => ({
                  activities:
                    event._tag === "AgentActivity"
                      ? [...acc.activities, event.activity]
                      : acc.activities,
                  transcript: [...acc.transcript, event.raw],
                  stderr:
                    event._tag === "OutputChunk" && event.streamKind === "stderr"
                      ? [...acc.stderr, event.text]
                      : acc.stderr,
                  reported: event._tag === "SessionStarted" ? event.sessionId : acc.reported,
                }))
                if (event._tag === "AgentActivity") {
                  yield* journal.append({
                    runId,
                    blockId,
                    attemptId,
                    payload: {
                      _tag: "AgentActivity",
                      activity: event.activity,
                      detail: event.detail,
                    },
                  })
                } else if (event._tag === "QuestionAsked") {
                  yield* journal.append({
                    runId,
                    blockId,
                    attemptId,
                    payload: { _tag: "QuestionAsked", question: event.question },
                  })
                } else if (event._tag === "ErrorRaised") {
                  yield* journal.append({
                    runId,
                    blockId,
                    attemptId,
                    payload: {
                      _tag: "ErrorRaised",
                      class: "provider",
                      signature: "stream",
                      message: event.message,
                    },
                  })
                }
              }).pipe(Effect.ignoreLogged)

            const result = yield* coordinator.withTechnicalRetries(
              { runId, blockId, policy: input.policy },
              Effect.zipRight(
                // A technical retry is a fresh invocation, so the file a previous try left behind
                // has to go — otherwise it would be read as this one's result.
                Effect.promise(() => rm(outputPath, { force: true })),
                runToResult(
                  providerFor(def).run({
                    prompt,
                    cwd: workspace.path,
                    sessionId: input.session.assigned,
                    resumeSessionId: input.session.resume,
                    permissionProfile: input.readOnly ? "read-only" : def.permissionProfile,
                    timeoutMs: input.timeoutMs,
                    // Where the result belongs and which block is asking for it; the prompt states
                    // the same obligation in words.
                    env: { COCKPIT_OUTPUT: outputPath, COCKPIT_BLOCK: def.id },
                  }),
                  onEvent,
                ),
              ),
            )

            const observed = yield* Ref.get(seen)
            yield* Ref.update(state, (value) => ({
              ...value,
              sessions: {
                ...value.sessions,
                [node.id]: result.sessionId ?? observed.reported ?? input.session.assigned,
              },
            }))

            const transcriptRef = yield* artifacts.write({
              runId,
              blockId,
              attemptId,
              kind: "transcript",
              name: "transcript.jsonl",
              content: `${observed.transcript.join("\n")}\n`,
            })
            yield* journal.append({
              runId,
              blockId,
              attemptId,
              payload: {
                _tag: "OutputChunk",
                streamKind: "assistant",
                excerpt: excerpt(result.text),
                ref: transcriptRef.id,
              },
            })

            const written = yield* readOutput(outputPath)
            const parsed = written.text === undefined ? undefined : safeJson(written.text)
            const outputRef =
              written.text === undefined
                ? undefined
                : (yield* artifacts.write({
                    runId,
                    blockId,
                    attemptId,
                    kind: "block-output",
                    name: "output.json",
                    content: written.text,
                  })).id

            const problems =
              written.problem !== undefined
                ? [written.problem]
                : parsed === undefined
                  ? ["the result written to $COCKPIT_OUTPUT is not valid JSON"]
                  : [
                      ...contractProblems(def.output, parsed),
                      ...(yield* verify(def, blockId, attemptId, parsed)),
                      ...(yield* missingArtifacts(def)),
                    ]

            return {
              failed: result.isError || problems.length > 0,
              output: parsed,
              outputRef,
              whatFailed: result.isError
                ? [`the provider reported an error: ${excerpt(result.text, 400)}`, ...problems]
                : problems,
              assistantText: result.text,
              actionsTaken: observed.activities,
              commandsRun: [],
              diagnostics: [
                ...(observed.stderr.length === 0
                  ? []
                  : [{ excerpt: excerpt(observed.stderr.join("\n"), 600) }]),
                { excerpt: excerpt(result.text, 600), ref: transcriptRef.id },
              ],
            } satisfies Judged
          })

        const runCommand = (input: {
          readonly def: BlockDef
          readonly command: CommandSpec
          readonly blockId: BlockId
          readonly attemptId: AttemptId
          readonly timeoutMs: number
        }): Effect.Effect<Judged, EngineError> =>
          Effect.gen(function* () {
            const { attemptId, blockId, def } = input
            const result = yield* commands.execute({
              runId,
              blockId,
              attemptId,
              cwd: workspace.path,
              command: input.command,
              timeoutMs: input.timeoutMs,
            })

            const streams = yield* Effect.forEach(
              (
                [
                  ["stdout", result.stdout],
                  ["stderr", result.stderr],
                ] as const
              ).filter(([, text]) => text !== ""),
              ([kind, text]) =>
                Effect.gen(function* () {
                  const ref = yield* artifacts.write({
                    runId,
                    blockId,
                    attemptId,
                    kind: `command-${kind}`,
                    name: `${kind}.log`,
                    content: text,
                  })
                  yield* journal.append({
                    runId,
                    blockId,
                    attemptId,
                    payload: {
                      _tag: "OutputChunk",
                      streamKind: kind,
                      excerpt: excerpt(text),
                      ref: ref.id,
                    },
                  })
                  return { excerpt: excerpt(text, 600), ref: ref.id }
                }),
            )

            const output = {
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              durationMs: result.durationMs,
              success: result.success,
            }
            const problems = result.success
              ? [
                  ...(yield* verify(def, blockId, attemptId, output)),
                  ...(yield* missingArtifacts(def)),
                ]
              : [
                  result.timedOut
                    ? `the command timed out after ${result.durationMs}ms`
                    : `the command exited with code ${result.exitCode}`,
                  ...result.ruleResults.flatMap(({ rule, passed }) =>
                    passed || !rule.required ? [] : [`success rule ${rule._tag} did not match`],
                  ),
                ]

            return {
              failed: problems.length > 0,
              output,
              whatFailed: problems,
              assistantText: excerpt(result.stdout, 600),
              actionsTaken: [],
              commandsRun: [input.command.argv.join(" ")],
              diagnostics: streams,
            } satisfies Judged
          })

        const runBlock = (
          node: BlockNode,
          context: NodeContext,
        ): Effect.Effect<AttemptOutcome, EngineError> =>
          Effect.gen(function* () {
            const def = defs.get(node.def) as BlockDef
            const policy = policies.get(def.retryPolicy) as RetryPolicy
            const blockId = yield* instanceId(node.id)
            const timeoutMs = node.overrides?.timeoutMs ?? def.timeoutMs

            yield* journal.startBlock({ runId, blockId, defId: def.id, kind: def.kind })
            const blockOpen = yield* Ref.make(true)
            const closeBlock = (status: "succeeded" | "failed" | "interrupted") =>
              Effect.flatMap(Ref.getAndSet(blockOpen, false), (open) =>
                open ? journal.finishBlock(runId, blockId, status) : Effect.void,
              )

            const attempt = (input: AttemptInput) =>
              Effect.gen(function* () {
                const attemptId = AttemptId.make(randomUUID())
                const current = yield* Ref.get(state)
                const resume =
                  def.kind === "agent" && def.sessionPolicy === "continue"
                    ? current.sessions[node.id]
                    : undefined
                const assigned = resume ?? SessionId.make(randomUUID())
                // The loop this block sits in may route its feedback elsewhere; only the target reads it.
                const inherited =
                  context.feedbackTo === undefined || context.feedbackTo === node.id
                    ? context.feedback
                    : undefined
                const feedback = (input.feedback ?? inherited)?.rendered

                yield* journal.startAttempt({
                  runId,
                  blockId,
                  attemptId,
                  number: input.attempt,
                  sessionId: def.kind === "agent" ? assigned : undefined,
                })
                const attemptOpen = yield* Ref.make(true)
                const closeAttempt = (verdict: AttemptVerdict) =>
                  Effect.flatMap(Ref.getAndSet(attemptOpen, false), (open) =>
                    !open
                      ? Effect.void
                      : verdict === "interrupted"
                        ? journal.interruptAttempt(runId, blockId, attemptId)
                        : journal.finishAttempt({ runId, blockId, attemptId, verdict }),
                  )

                const body = Effect.gen(function* () {
                  if (def.kind === "agent") {
                    yield* journal.append({
                      runId,
                      blockId,
                      attemptId,
                      payload:
                        resume === undefined
                          ? { _tag: "SessionStarted", sessionId: assigned }
                          : { _tag: "SessionResumed", sessionId: assigned },
                    })
                  }

                  const record =
                    def.kind === "agent"
                      ? yield* runAgent({
                          node,
                          def,
                          policy,
                          blockId,
                          attemptId,
                          session: { assigned, resume },
                          feedback,
                          readOnly: context.readOnly,
                          timeoutMs,
                        })
                      : yield* runCommand({
                          def,
                          command: (node.overrides?.command ?? def.command) as CommandSpec,
                          blockId,
                          attemptId,
                          timeoutMs,
                        })

                  const verdict: AttemptVerdict = record.failed ? "semantic-failure" : "success"
                  yield* closeAttempt(verdict)

                  if (!record.failed) {
                    yield* journal.append({
                      runId,
                      blockId,
                      attemptId,
                      payload: {
                        _tag: "ResultProduced",
                        outputRef: record.outputRef,
                        ...(sizeOf(record.output) <= inlineResultChars
                          ? { outputInline: record.output }
                          : {}),
                      },
                    })
                    yield* Ref.update(state, (value) => ({
                      ...value,
                      outputs: { ...value.outputs, [node.id]: record.output },
                      outputRefs:
                        record.outputRef === undefined
                          ? value.outputRefs
                          : { ...value.outputRefs, [node.id]: record.outputRef },
                    }))
                    // A read-only block cannot have moved the worktree, so it gets no commit of
                    // its own and the resume point stays at the last block that did work.
                    if (def.workspaceAccess === "write") {
                      const checkpoint = yield* checkpoints.checkpoint(workspace, {
                        kind: "success",
                        message: `cockpit: ${def.id} (${blockId})`,
                        blockId,
                        attemptId,
                      })
                      yield* Ref.update(state, (value) => ({
                        ...value,
                        lastCheckpoint: checkpoint,
                      }))
                    }
                    return { verdict, output: record.output } satisfies AttemptOutcome
                  }

                  // A block that could not write has nothing of its own to keep, and what it did
                  // find in the worktree belongs to whoever put it there.
                  if (policy.checkpointEachAttempt && def.workspaceAccess === "write" && !context.readOnly) {
                    yield* checkpoints.salvage(workspace, {
                      message: `cockpit: salvage ${def.id} attempt ${input.attempt}`,
                      blockId,
                      attemptId,
                    })
                  }

                  return {
                    verdict,
                    packet: buildFailurePacket({
                      ...record,
                      attemptNumber: input.attempt,
                      approach: def.title,
                      binding: def.binding?.entry.name,
                      failureReason: `${def.id} did not satisfy its output contract and success criteria`,
                      // The loop sends this elsewhere, so the recipient is told who reported it
                      // rather than being handed the failure as its own last attempt.
                      reportedBy:
                        context.feedbackTo === undefined || context.feedbackTo === node.id
                          ? undefined
                          : node.id,
                    }),
                  } satisfies AttemptOutcome
                })

                return yield* body.pipe(
                  Effect.onExit((exit) =>
                    Exit.isSuccess(exit)
                      ? Effect.void
                      : Effect.ignoreLogged(
                          closeAttempt(
                            Exit.isInterrupted(exit) ? "interrupted" : "technical-failure",
                          ),
                        ),
                  ),
                )
              })

            const entry = (yield* Ref.get(state)).lastCheckpoint
            const outcome = yield* coordinator
              .semanticLoop(
                {
                  runId,
                  blockId: Effect.succeed(blockId),
                  policy,
                  gate: (gateId, payload) => requestApproval(runId, gateId, payload),
                  rollback: rollbackTo(entry),
                },
                attempt,
              )
              .pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.void
                    : Effect.ignoreLogged(
                        closeBlock(Exit.isInterrupted(exit) ? "interrupted" : "failed"),
                      ),
                ),
              )

            yield* closeBlock(outcome.verdict === "success" ? "succeeded" : "failed")
            return outcome
          })

        const runNode = (
          node: WorkflowNode,
          context: NodeContext,
        ): Effect.Effect<AttemptOutcome, EngineError> => {
          switch (node._tag) {
            case "Block":
              return runBlock(node, context)

            case "Sequence":
              return Effect.reduce(
                node.children,
                { verdict: "success" } as AttemptOutcome,
                (outcome, child) =>
                  outcome.verdict === "success" ? runNode(child, context) : Effect.succeed(outcome),
              )

            case "Parallel":
              return Effect.map(
                Effect.all(
                  node.branches.map((branch) =>
                    runNode(branch.node, {
                      ...context,
                      readOnly: context.readOnly || branch.workspaceAccess === "read",
                    }),
                  ),
                  { concurrency: "unbounded" },
                ),
                (outcomes) =>
                  outcomes.find((outcome) => outcome.verdict !== "success") ?? { verdict: "success" },
              )

            case "Condition":
              return Effect.gen(function* () {
                const current = yield* Ref.get(state)
                const source = node.predicate.blockId
                // A branch that never ran left no verdict to read. Comparing against nothing would
                // let `neq` answer true, so the condition is recorded as unanswered and takes the
                // false branch rather than being decided by the shape of its comparator.
                if (!(source in current.outputs)) {
                  yield* journal.append({
                    runId,
                    payload: {
                      _tag: "ErrorRaised",
                      class: "semantic",
                      signature: "predicate-source-missing",
                      message: `condition reads ${source}, which produced no output; taking the false branch`,
                    },
                  })
                }
                const branch =
                  source in current.outputs &&
                  evaluateCheck(node.predicate, current.outputs[source])
                    ? node.onTrue
                    : node.onFalse
                return branch === undefined
                  ? ({ verdict: "success" } satisfies AttemptOutcome)
                  : yield* runNode(branch, context)
              })

            case "Loop": {
              const target = node.feedbackRoute?.to ?? blocksIn(node.body)[0]?.id
              return Effect.gen(function* () {
                // Nothing in the body can report a semantic failure, so there is no loop to run.
                if (target === undefined) return yield* runNode(node.body, context)
                const entry = (yield* Ref.get(state)).lastCheckpoint
                return yield* coordinator.semanticLoop(
                  {
                    runId,
                    blockId: currentInstance(target),
                    policy: policies.get(node.policy) as RetryPolicy,
                    gate: (gateId, payload) => requestApproval(runId, gateId, payload),
                    rollback: rollbackTo(entry),
                  },
                  (input) =>
                    runNode(node.body, {
                      ...context,
                      feedback: input.feedback,
                      feedbackTo: target,
                    }),
                )
              })
            }

            case "Gate":
              return Effect.map(
                requestApproval(runId, node.id, node.payload),
                (approved): AttemptOutcome => ({ verdict: approved ? "success" : "cancelled" }),
              )
          }
        }

        const outcome = yield* runNode(request.tree.root, { readOnly: false }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.ignoreLogged(
                  Exit.isInterrupted(exit)
                    ? journal.cancelRun(runId)
                    : journal.finishRun(runId, "failed"),
                ),
          ),
        )

        const status = outcome.verdict === "success" ? "succeeded" : "failed"
        yield* journal.finishRun(runId, status)
        const final = yield* Ref.get(state)
        return { status, outputs: final.outputs } satisfies RunOutcome
      })

    return {
      run,
      approveGate: (runId, gateId, approved, note) =>
        Effect.flatMap(Ref.get(gates), (pending) => {
          const deferred = HashMap.get(pending, gateKey(runId, gateId))
          return deferred._tag === "None"
            ? Effect.fail(
                new JournalError({
                  op: "approveGate",
                  detail: `run ${runId} has no gate ${gateId} awaiting a decision`,
                }),
              )
            : Effect.asVoid(Deferred.succeed(deferred.value, { approved, note }))
        }),
    }
  }),
)
