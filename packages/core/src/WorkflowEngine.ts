import { Context, Deferred, Effect, Either, Exit, HashMap, HashSet, Layer, Ref } from "effect"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import * as NodePath from "node:path"
import { AgentOutput, ArtifactStore, readAgentOutput } from "./ArtifactStore.js"
import { ClaudeCodeProvider } from "./ClaudeCodeProvider.js"
import { CodexProvider } from "./CodexProvider.js"
import { CommandRunner, CommandSpec, matchArtifacts } from "./CommandRunner.js"
import {
  JournalError,
  PreflightError,
  ProcessError,
  ProviderError,
  ValidationError,
  WorkspaceError,
} from "./errors.js"
import { AttemptVerdict, CriterionResult } from "./events.js"
import { AttemptEvidence, buildFailurePacket } from "./failure.js"
import { ArtifactId, AttemptId, BlockId, CheckpointId, RunId, SessionId } from "./ids.js"
import { Journal } from "./Journal.js"
import { PluginCatalog, PreflightResult } from "./PluginCatalog.js"
import {
  Provider,
  ProviderEvent,
  ProviderName,
  ProviderResult,
  runToResult,
} from "./Provider.js"
import { iterationOpen, ResumePlan, resumedIteration } from "./Resume.js"
import { AttemptInput, AttemptOutcome, RetryCoordinator } from "./RetryCoordinator.js"
import { clip, outputBudget, renderSlots } from "./text.js"
import { CheckpointService, Workspace } from "./Workspace.js"
import { blocksIn, bindingOf, validateWorkflow, WorkflowCatalog } from "./WorkflowValidator.js"
import {
  BlockDef,
  BlockInputEnvelope,
  BlockOverrides,
  ContractField,
  contractProblems,
  evaluateCheck,
  GatePayload,
  pickFields,
  PluginBinding,
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
  /**
   * Re-entry into a run the journal already holds (plan §9): what it completed is replayed rather
   * than executed, and its loops carry on where they stopped. Absent for a first execution.
   */
  readonly resume?: ResumePlan
  /** Skip requests recorded before this execution started; live ones arrive via requestSkip. */
  readonly skips?: ReadonlySet<string>
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
  | PreflightError

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
    /** Resumes the suspended session of the attempt that asked; the same attempt carries on. */
    readonly answerQuestion: (
      runId: RunId,
      blockId: BlockId,
      answer: string,
    ) => Effect.Effect<void, JournalError>
    /** Records that the node's next visit is to be skipped; consumed at that visit. */
    readonly requestSkip: (runId: RunId, nodeId: BlockId) => Effect.Effect<void>
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

interface NodeContext {
  readonly readOnly: boolean
  readonly feedback?: AttemptInput["feedback"]
  /** A corrective loop hands its feedback to one block; the rest of the body must not see it. */
  readonly feedbackTo?: BlockId
  /**
   * Set inside a loop a re-entering run is opening a new iteration of: what the last iteration
   * finished belongs to that iteration, not to this one, so the body does the work again.
   */
  readonly newIteration?: boolean
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

const outputInstruction = (fields: ReadonlyArray<ContractField>, path: string) =>
  [
    `Write your result as a single JSON object to the file at $COCKPIT_OUTPUT (${path}).`,
    "It must contain:",
    ...fields.map(
      (field) => `- ${field.name}: ${field.type}${field.required ? " (required)" : " (optional)"}`,
    ),
    "Nothing else counts as this block's result; a missing or malformed file is a failure.",
  ].join("\n")

const qualified = (binding: PluginBinding) =>
  binding.plugin === undefined ? binding.entry.name : `${binding.plugin}:${binding.entry.name}`

/**
 * Claude expands a slash command only when the prompt opens with it, so a bound block leads with
 * the invocation and everything the block would otherwise have said follows as its argument text.
 * Codex has no slash commands, so the same binding becomes an instruction naming the entry.
 */
const bindingLines = (
  binding: PluginBinding,
  provider: ProviderName,
  prompt: string,
): ReadonlyArray<string> => {
  // Collapsed onto one line: a multi-line prompt rendered into the template would otherwise end the
  // slash invocation at its first newline and leave the rest as loose text below it.
  const args = renderSlots(binding.argsTemplate ?? "", { prompt }).replace(/\s+/g, " ").trim()
  const name = qualified(binding)
  const withArgs = args === "" ? "" : ` with: ${args}`
  const invocation =
    provider === "claude-code" && binding.entry.kind === "slash"
      ? `/${name}${args === "" ? "" : ` ${args}`}`
      : binding.entry.kind === "agent"
        ? `Delegate this block to the ${name} agent (Agent tool, subagent_type ${binding.entry.name})${withArgs}.`
        : binding.entry.kind === "skill"
          ? `Invoke the ${name} skill before anything else${withArgs}.`
          : `Follow the workflow of the ${name} command${withArgs}.`
  return [
    invocation,
    ...(binding.extraInstructions === undefined ? [] : ["", binding.extraInstructions]),
  ]
}

const composePrompt = (input: {
  readonly def: BlockDef
  readonly binding?: PluginBinding
  readonly goal?: string
  readonly prompt: string
  readonly envelope: unknown
  readonly outputPath: string
  readonly feedback?: string
}) =>
  [
    ...(input.binding === undefined
      ? []
      : [...bindingLines(input.binding, input.def.provider ?? "claude-code", input.prompt), ""]),
    `# ${input.def.title}`,
    "",
    "## Task",
    input.prompt,
    ...(input.goal === undefined ? [] : ["", "## Goal", input.goal]),
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
    const plugins = yield* PluginCatalog

    const gates = yield* Ref.make(
      HashMap.empty<string, Deferred.Deferred<{ approved: boolean; note?: string }>>(),
    )
    const questions = yield* Ref.make(HashMap.empty<string, Deferred.Deferred<string>>())
    // Keyed and cleared per run like the two above: a stale entry would swallow a same-named
    // node in a later run.
    const skips = yield* Ref.make(HashSet.empty<string>())
    const pendingKey = (runId: RunId, blockId: BlockId) => `${runId}:${blockId}`

    /**
     * Parks the attempt on the answer the way a gate parks on a decision (plan §10). Nothing is
     * journaled here: the QuestionAsked the stream produced is already in the log, and a block
     * waiting on it is exactly "asked, not yet answered" — no run or attempt status says it.
     */
    const awaitAnswer = (runId: RunId, blockId: BlockId) =>
      Effect.acquireUseRelease(
        Effect.tap(Deferred.make<string>(), (deferred) =>
          Ref.update(questions, HashMap.set(pendingKey(runId, blockId), deferred)),
        ),
        Deferred.await,
        () => Ref.update(questions, HashMap.remove(pendingKey(runId, blockId))),
      )

    const resolvePending = <A>(
      op: string,
      pending: HashMap.HashMap<string, Deferred.Deferred<A>>,
      key: string,
      value: A,
      missing: string,
    ) => {
      const deferred = HashMap.get(pending, key)
      return deferred._tag === "None"
        ? Effect.fail(new JournalError({ op, detail: missing }))
        : Effect.asVoid(Deferred.succeed(deferred.value, value))
    }

    const requestApproval = (runId: RunId, gateId: BlockId, payload: GatePayload) =>
      Effect.gen(function* () {
        const ref = yield* artifacts.write({
          runId,
          blockId: gateId,
          kind: "gate-payload",
          name: "approval.json",
          content: JSON.stringify(payload, null, 2),
        })
        const key = pendingKey(runId, gateId)
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

        const plan = request.resume
        // A resumed run was re-opened by whoever reconciled its worktree; it is already running.
        if (plan === undefined) yield* journal.startRun(runId)

        yield* Ref.update(skips, (set) =>
          [...(request.skips ?? []), ...(plan?.skips ?? [])].reduce(
            (acc, nodeId) => HashSet.add(acc, pendingKey(runId, BlockId.make(nodeId))),
            set,
          ),
        )

        // Rollback needs a target from the first attempt onward, and recovery treats the newest
        // success checkpoint as the resume point — so the run opens with one. A re-entering run
        // has that checkpoint already, and its worktree was put back onto it.
        const baseline =
          plan?.lastCheckpoint ??
          (yield* checkpoints.checkpoint(workspace, {
            kind: "success",
            message: `cockpit: run ${runId} baseline`,
          }))
        const state = yield* Ref.make<RunState>({
          outputs: {},
          outputRefs: {},
          // Seeded so the next instance of a node numbers past the ones the journal holds, and a
          // `continue` block resumes the session its interrupted instance was using.
          executions: Object.fromEntries(
            [...(plan?.nodes ?? [])].map(([nodeId, node]) => [nodeId, node.instances]),
          ),
          sessions: Object.fromEntries(
            [...(plan?.nodes ?? [])].flatMap(([nodeId, node]) =>
              node.session === undefined ? [] : [[nodeId, node.session]],
            ),
          ),
          lastCheckpoint: baseline,
        })

        // Each record is spent on the first visit to its node: a loop coming round again finds
        // nothing to replay and executes, which is what makes the extra iterations real work.
        const carried = yield* Ref.make(new Map(plan?.nodes ?? []))
        const settled = yield* Ref.make(new Map(plan?.decisions ?? []))

        const take = <A>(ref: Ref.Ref<Map<string, A>>, key: string) =>
          Ref.modify(ref, (map) => {
            const found = map.get(key)
            if (found === undefined) return [undefined, map] as const
            const rest = new Map(map)
            rest.delete(key)
            return [found, rest] as const
          })

        /** A gate the run already decided keeps its decision instead of asking a second time. */
        const approval = (gateId: BlockId, payload: GatePayload) =>
          Effect.gen(function* () {
            const decided = yield* take(settled, gateId)
            return decided ?? (yield* requestApproval(runId, gateId, payload))
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

        /**
         * A plugin's declared state is captured from the worktree it wrote it in, per attempt: a
         * failed attempt's leftovers are exactly the evidence the next one is judged against.
         */
        const captureStateFiles = (
          binding: PluginBinding | undefined,
          blockId: BlockId,
          attemptId: AttemptId,
        ) =>
          Effect.forEach(binding?.stateFiles ?? [], (pattern) =>
            Effect.flatMap(matchArtifacts(workspace.path, pattern), (matches) =>
              Effect.forEach(matches, (relative) =>
                Effect.gen(function* () {
                  const content = yield* Effect.tryPromise(() =>
                    readFile(NodePath.join(workspace.path, relative), "utf8"),
                  ).pipe(Effect.orElseSucceed(() => undefined))
                  if (content === undefined) return
                  yield* artifacts.write({
                    runId,
                    blockId,
                    attemptId,
                    kind: "plugin-state",
                    name: relative.replace(/[/\\]/g, "-"),
                    content: clip(content, outputBudget),
                  })
                }),
              ),
            ),
          ).pipe(Effect.asVoid)

        /**
         * Preflight decides whether a block may run at all (plan §6). What happens when it may not
         * is the block's declared fallback — including an alternative binding, which is recorded as
         * resolved rather than swapped in quietly.
         */
        const resolveBinding = (
          def: BlockDef,
          overrides: BlockOverrides | undefined,
        ): Effect.Effect<
          | {
              readonly _tag: "Ready"
              readonly binding?: PluginBinding
              readonly resolved: PreflightResult
              readonly alternative: boolean
            }
          | { readonly _tag: "Skip"; readonly reason: string },
          EngineError
        > =>
          Effect.gen(function* () {
            const provider = def.provider ?? "claude-code"
            const declared = bindingOf(def, overrides)
            const attempted = yield* Effect.either(plugins.preflight({ provider, binding: declared }))
            if (attempted._tag === "Right") {
              return {
                _tag: "Ready",
                binding: declared,
                resolved: attempted.right,
                alternative: false,
              }
            }

            const failure = attempted.left
            yield* journal.append({
              runId,
              payload: {
                _tag: "ErrorRaised",
                class: "preflight",
                signature: failure.reason,
                message: `${def.id}: ${failure.detail}`,
              },
            })
            switch (def.fallback._tag) {
              case "Fail":
                return yield* Effect.fail(failure)
              case "SkipWithWarning":
                return {
                  _tag: "Skip",
                  reason: `${failure.reason}: ${failure.detail}; any later block that requires ${def.id}'s output will now fail its input contract`,
                }
              case "AlternativeBinding": {
                const alternative = def.fallback.binding
                const resolved = yield* plugins.preflight({ provider, binding: alternative })
                return { _tag: "Ready", binding: alternative, resolved, alternative: true }
              }
            }
          })

        const missingArtifacts = (def: BlockDef) =>
          Effect.forEach(
            (def.expectedArtifacts ?? []).filter((expected) => expected.required),
            (expected) =>
              Effect.map(matchArtifacts(workspace.path, expected.glob, 1), (found) =>
                found.length > 0 ? [] : [`expected artifact ${expected.glob} was not produced`],
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
          readonly binding?: PluginBinding
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

            // A missing required input is a semantic verdict, not an engine crash: it must fail
            // the attempt with a packet, exactly like a contract violation after the session.
            // Reachable through a Condition branch that never ran, a plugin Skip resolution, a
            // resume over a skipped block, and a user skip.
            const built = yield* Effect.either(
              envelopeFor({ def, node, blockId, attemptId, feedback: input.feedback }),
            )
            if (built._tag === "Left") {
              if (built.left._tag !== "ValidationError") return yield* Effect.fail(built.left)
              return {
                failed: true,
                whatFailed: [built.left.message],
                assistantText: "",
                actionsTaken: [],
                commandsRun: [],
                diagnostics: [],
              } satisfies Judged
            }
            const envelope = built.right
            const prompt = composePrompt({
              def,
              binding: input.binding,
              goal: node.overrides?.promptTemplate ?? def.promptTemplate,
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
              question: undefined as string | undefined,
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
                  question: event._tag === "QuestionAsked" ? event.question : acc.question,
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

            // A technical retry is a fresh invocation, so what a previous try left behind has to
            // go: its result file would be read as this one's, and its question would park an
            // attempt that this session never suspended.
            const fresh = Effect.zipRight(
              Effect.promise(() => rm(outputPath, { force: true })),
              Ref.update(seen, (acc) => ({ ...acc, question: undefined })),
            )

            const invoke = (text: string, resume: SessionId | undefined) =>
              coordinator.withTechnicalRetries(
                { runId, blockId, policy: input.policy },
                Effect.zipRight(
                  fresh,
                  runToResult(
                    providerFor(def).run({
                      prompt: text,
                      cwd: workspace.path,
                      sessionId: input.session.assigned,
                      resumeSessionId: resume,
                      // Downgraded, not silenced: a block in a read-only branch still owes the run
                      // its result, so it keeps the one write it needs.
                      permissionProfile: input.readOnly
                        ? "read-plus-output"
                        : def.permissionProfile,
                      outputDir: dir,
                      timeoutMs: input.timeoutMs,
                      // Where the result belongs and which block is asking for it; the prompt states
                      // the same obligation in words.
                      env: { COCKPIT_OUTPUT: outputPath, COCKPIT_BLOCK: def.id },
                    }),
                    onEvent,
                  ),
                ),
              )

            /**
             * A question is a suspension only when the session left without its result (plan §10):
             * one that asked and still delivered has answered itself. The answer resumes that same
             * session inside the same attempt, so the block keeps its timeout and its history.
             */
            const drive = (
              text: string,
              resume: SessionId | undefined,
            ): Effect.Effect<{ result: ProviderResult; written: AgentOutput }, EngineError> =>
              Effect.gen(function* () {
                const result = yield* invoke(text, resume)
                const written = yield* readAgentOutput(outputPath)
                const { question, reported } = yield* Ref.get(seen)
                if (question === undefined || written.text !== undefined) {
                  return { result, written }
                }
                const session = result.sessionId ?? reported ?? input.session.assigned
                const answer = yield* awaitAnswer(runId, blockId)
                yield* journal.append({
                  runId,
                  blockId,
                  attemptId,
                  payload: { _tag: "QuestionAnswered", answer },
                })
                yield* journal.append({
                  runId,
                  blockId,
                  attemptId,
                  payload: { _tag: "SessionResumed", sessionId: session },
                })
                return yield* drive(answer, session)
              })

            /**
             * A `continue` block resumes the session its last execution recorded, and that session
             * can be gone by the time the run comes back to it — GC'd, or left behind by a CLI
             * that moved on (plan §10). The attempt is not lost with it: the seeded id is dropped
             * and the same prompt runs once more as a new session, which is what the block would
             * have done had it never had one to continue.
             */
            const seeded = input.session.resume
            const attempted = drive(prompt, seeded)
            const { result, written } = yield* (seeded === undefined
              ? attempted
              : Effect.catchAll(attempted, (cause) =>
                  Effect.gen(function* () {
                    yield* journal.append({
                      runId,
                      blockId,
                      attemptId,
                      payload: {
                        _tag: "ErrorRaised",
                        class: "provider",
                        signature: "session-unresumable",
                        message: `resuming session ${seeded} failed (${cause.message}); the attempt continues in a fresh one`,
                      },
                    })
                    yield* Ref.update(state, (value) => ({
                      ...value,
                      sessions: Object.fromEntries(
                        Object.entries(value.sessions).filter(([id]) => id !== node.id),
                      ),
                    }))
                    return yield* drive(prompt, undefined)
                  }),
                ))

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

            yield* captureStateFiles(input.binding, blockId, attemptId)

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

        const runFinalize = (input: {
          readonly def: BlockDef
          readonly blockId: BlockId
          readonly attemptId: AttemptId
        }): Effect.Effect<Judged, EngineError> =>
          Effect.gen(function* () {
            const { attemptId, blockId, def } = input
            const target = workspace.targetBranch
            const mode = def.finalizeMode ?? "squash"
            // A refusal is the answer, not a crash: the user has to read why their branch was left
            // alone, and a failed block says that where an aborted run would not.
            const landed = yield* Effect.either(
              checkpoints.finalize(workspace, { targetBranch: target, mode }),
            )
            if (Either.isLeft(landed)) {
              return {
                failed: true,
                whatFailed: [landed.left.detail],
                assistantText: landed.left.detail,
                actionsTaken: [],
                commandsRun: [],
                diagnostics: [],
              } satisfies Judged
            }
            const output = { commit: landed.right.commit, commits: landed.right.commits }
            const problems = yield* verify(def, blockId, attemptId, output)
            return {
              failed: problems.length > 0,
              output,
              whatFailed: problems,
              assistantText: `${mode} of ${landed.right.commits} checkpoint(s) onto ${target} as ${landed.right.commit}`,
              actionsTaken: [`moved ${target} to ${landed.right.commit}`],
              commandsRun: [],
              diagnostics: [],
            } satisfies Judged
          })

        const runBlock = (
          node: BlockNode,
          context: NodeContext,
        ): Effect.Effect<AttemptOutcome, EngineError> =>
          Effect.gen(function* () {
            const def = defs.get(node.def) as BlockDef
            const policy = policies.get(def.retryPolicy) as RetryPolicy
            const before = yield* take(carried, node.id)

            // The §9 invariant: a block the journal already finished is never run a second time.
            // Its result is handed on exactly as the run that produced it handed it on, so a
            // downstream block cannot tell the interruption happened.
            const finished = context.newIteration ? undefined : before?.done
            if (finished !== undefined) {
              yield* journal.append({
                runId,
                blockId: finished.blockId,
                payload: {
                  _tag: "BlockReplayed",
                  defId: def.id,
                  reason: `${finished.blockId} was already ${finished.status} before the interruption`,
                },
              })
              yield* Ref.update(state, (value) => ({
                ...value,
                outputs:
                  finished.output === undefined
                    ? value.outputs
                    : { ...value.outputs, [node.id]: finished.output },
                outputRefs:
                  finished.outputRef === undefined
                    ? value.outputRefs
                    : { ...value.outputRefs, [node.id]: finished.outputRef },
              }))
              return { verdict: "success", output: finished.output } satisfies AttemptOutcome
            }

            const blockId = yield* instanceId(node.id)

            // Mirrors the preflight Skip below; consumed here, so a loop's next iteration runs.
            const requested = yield* Ref.modify(skips, (set) => {
              const key = pendingKey(runId, node.id)
              return HashSet.has(set, key)
                ? ([true, HashSet.remove(set, key)] as const)
                : ([false, set] as const)
            })
            if (requested) {
              yield* journal.skipBlock({
                runId,
                blockId,
                defId: def.id,
                kind: def.kind,
                reason: "skipped by user request",
              })
              return { verdict: "success" } satisfies AttemptOutcome
            }

            const timeoutMs = node.overrides?.timeoutMs ?? def.timeoutMs

            // Command blocks reach no provider and no plugin, so there is nothing to preflight.
            const resolution =
              def.kind === "agent" ? yield* resolveBinding(def, node.overrides) : undefined
            if (resolution?._tag === "Skip") {
              yield* journal.skipBlock({
                runId,
                blockId,
                defId: def.id,
                kind: def.kind,
                reason: resolution.reason,
              })
              return { verdict: "success" } satisfies AttemptOutcome
            }

            yield* journal.startBlock({ runId, blockId, defId: def.id, kind: def.kind })
            if (resolution !== undefined) {
              yield* journal.append({
                runId,
                blockId,
                payload: {
                  _tag: "PluginResolved",
                  provider: resolution.resolved.provider,
                  plugin: resolution.resolved.plugin,
                  entry: resolution.resolved.entry,
                  capabilities: resolution.resolved.capabilities,
                  ...(resolution.alternative ? { alternative: true } : {}),
                },
              })
            }
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
                // Nothing newer exists on a re-entry: the loop lost its packets with the daemon,
                // and the rendered context the interrupted attempt was given is still on disk.
                const rehydrated =
                  input.feedback === undefined && inherited === undefined
                    ? before?.feedback
                    : undefined
                const feedback = (input.feedback ?? inherited ?? rehydrated)?.rendered

                yield* journal.startAttempt({
                  runId,
                  blockId,
                  attemptId,
                  number: input.attempt,
                  sessionId: def.kind === "agent" ? assigned : undefined,
                })
                if (rehydrated !== undefined) {
                  yield* journal.append({
                    runId,
                    blockId,
                    payload: { _tag: "FailureFeedbackForwarded", packetRef: rehydrated.packetRef },
                  })
                }
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
                    def.kind === "workspace"
                      ? yield* runFinalize({ def, blockId, attemptId })
                      : def.kind === "agent"
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
                          binding: resolution?.binding,
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
                      binding: resolution?.binding?.entry.name,
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
                  gate: approval,
                  rollback: rollbackTo(entry),
                  // A new iteration is new work: only the instance the interruption caught
                  // carries its spent attempts into the execution that continues it.
                  startAttempt: (context.newIteration ? 0 : (before?.attempts ?? 0)) + 1,
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
              const body = blocksIn(node.body)
              const target = node.feedbackRoute?.to ?? body[0]?.id
              // Whose verdict ends an iteration: the block a corrective loop learns from, or the
              // last one the body runs.
              const source = node.feedbackRoute?.from ?? body.at(-1)?.id
              return Effect.gen(function* () {
                // Nothing in the body can report a semantic failure, so there is no loop to run.
                if (target === undefined) return yield* runNode(node.body, context)
                const entry = (yield* Ref.get(state)).lastCheckpoint
                // Read, not spent: the body's own visit to that block is what spends the record.
                const records = yield* Ref.get(carried)
                const opens = records.get(target)
                const closes = source === undefined ? undefined : records.get(source)
                return yield* coordinator.semanticLoop(
                  {
                    runId,
                    blockId: currentInstance(target),
                    policy: policies.get(node.policy) as RetryPolicy,
                    gate: approval,
                    rollback: rollbackTo(entry),
                    startAttempt: resumedIteration(opens, closes),
                  },
                  (input) =>
                    runNode(node.body, {
                      ...context,
                      feedback: input.feedback,
                      feedbackTo: target,
                      newIteration: !iterationOpen(opens, closes),
                    }),
                )
              })
            }

            case "Gate":
              return Effect.map(
                approval(node.id, node.payload),
                (approved): AttemptOutcome => ({ verdict: approved ? "success" : "cancelled" }),
              )
          }
        }

        // The engine never closes an interrupted run — the caller owns that close, because only
        // it knows whether the interruption was a Stop, a Cancel, or the daemon going down.
        const outcome = yield* runNode(request.tree.root, { readOnly: false }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || Exit.isInterrupted(exit)
              ? Effect.void
              : Effect.ignoreLogged(journal.finishRun(runId, "failed")),
          ),
        )

        const status = outcome.verdict === "success" ? "succeeded" : "failed"
        yield* journal.finishRun(runId, status)
        const final = yield* Ref.get(state)
        return { status, outputs: final.outputs } satisfies RunOutcome
      }).pipe(
        Effect.ensuring(
          Ref.update(skips, HashSet.filter((key) => !key.startsWith(`${request.runId}:`))),
        ),
      )

    return {
      run,
      approveGate: (runId, gateId, approved, note) =>
        Effect.flatMap(Ref.get(gates), (pending) =>
          resolvePending(
            "approveGate",
            pending,
            pendingKey(runId, gateId),
            { approved, note },
            `run ${runId} has no gate ${gateId} awaiting a decision`,
          ),
        ),

      answerQuestion: (runId, blockId, answer) =>
        Effect.flatMap(Ref.get(questions), (pending) =>
          resolvePending(
            "answerQuestion",
            pending,
            pendingKey(runId, blockId),
            answer,
            `run ${runId} has no question awaiting an answer on block ${blockId}`,
          ),
        ),

      requestSkip: (runId, nodeId) =>
        Ref.update(skips, HashSet.add(pendingKey(runId, nodeId))),
    }
  }),
)
