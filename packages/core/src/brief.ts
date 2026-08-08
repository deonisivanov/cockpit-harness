import {
  attemptFacts,
  blockOf,
  errorCounts,
  eventsOf,
  lastOf,
  pluginLabels,
  skipReasons,
  type JournalEvent,
} from "./events.js"
import type { BlockRow, RunRow } from "./Store.js"
import { clip, fitSections, oneLine, type Section } from "./text.js"

const promptChars = 2_000
const inlineChars = 600
const messageChars = 300

export interface BriefInput {
  readonly run: RunRow
  readonly projectName: string
  readonly repoPath: string
  readonly worktreePath: string
  readonly events: ReadonlyArray<JournalEvent>
  readonly blocks: ReadonlyArray<BlockRow>
  readonly changedFiles: ReadonlyArray<string>
  readonly healthChecks: ReadonlyArray<{ readonly argv: ReadonlyArray<string> }>
  readonly maxChars: number
}

/** Errors read verbatim, packets by the path the next attempt was handed. */
const reasonsOf = (
  facts: ReturnType<typeof attemptFacts>[number],
  paths: ReadonlyMap<string, string>,
) =>
  facts.reasons.flatMap((reason) => {
    if (reason._tag === "Error") return [oneLine(reason.message, messageChars)]
    const path = paths.get(reason.packetRef)
    return path === undefined ? [] : [`failure packet: ${path}`]
  })

const planSection = (events: ReadonlyArray<JournalEvent>, paths: ReadonlyMap<string, string>) => {
  const analyzed = lastOf(events, "TreeAnalyzed")
  const decisions = eventsOf(events, "ApprovalDecided")
  const requests = new Map(
    eventsOf(events, "ApprovalRequested").map(({ payload }) => [
      payload.gateId,
      payload.payloadRef,
    ]),
  )
  return [
    ...(analyzed === undefined
      ? []
      : [
          `Template: ${analyzed.templateId}${analyzed.fallback ? " (analyzer fell back to the template defaults)" : ""}`,
          `Rationale: ${oneLine(analyzed.rationale, messageChars)}`,
          ...(analyzed.warning === undefined ? [] : [`Analyzer warning: ${analyzed.warning}`]),
        ]),
    ...decisions.map(({ payload }) => {
      const ref = requests.get(payload.gateId)
      const path = ref === undefined ? undefined : paths.get(ref)
      return `Gate ${payload.gateId}: ${payload.approved ? "approved" : "rejected"}${
        payload.note === undefined ? "" : ` — "${oneLine(payload.note, messageChars)}"`
      }${path === undefined ? "" : ` (payload: ${path})`}`
    }),
  ]
}

const blockSection = (
  blocks: ReadonlyArray<BlockRow>,
  events: ReadonlyArray<JournalEvent>,
) => {
  const plugins = pluginLabels(events)
  const skipped = skipReasons(events)
  return blocks.map((block) => {
    const plugin = plugins.get(block.id)
    const reason = skipped.get(block.id)
    return `${block.id} (${block.defId}, ${block.kind}) — ${block.status}${
      plugin === undefined ? "" : ` · ${plugin}`
    }${reason === undefined ? "" : ` · skipped: ${reason}`}`
  })
}

const errorSection = (events: ReadonlyArray<JournalEvent>) => {
  const retries = eventsOf(events, "RetryScheduled")
  return [
    ...errorCounts(events).map(
      ({ signature, count, message }) =>
        `${signature} — raised ${count}x: ${oneLine(message, messageChars)}`,
    ),
    ...(retries.length === 0
      ? []
      : [
          `Retries scheduled: ${retries
            .map(({ payload }) => `${payload.class} → attempt ${payload.nextAttempt}`)
            .join(", ")}`,
        ]),
  ]
}

const resultSection = (
  events: ReadonlyArray<JournalEvent>,
  paths: ReadonlyMap<string, string>,
) =>
  eventsOf(events, "ResultProduced").map(({ event, payload }) => {
    const inline =
      payload.outputInline === undefined
        ? undefined
        : oneLine(JSON.stringify(payload.outputInline), inlineChars)
    const path = payload.outputRef === undefined ? undefined : paths.get(payload.outputRef)
    return `${blockOf(event)}: ${inline ?? path ?? "(no output recorded)"}`
  })

const feedbackSection = (events: ReadonlyArray<JournalEvent>) => [
  ...eventsOf(events, "QuestionAsked").map(
    ({ event, payload }) => `${blockOf(event)} asked: ${oneLine(payload.question, messageChars)}`,
  ),
  ...eventsOf(events, "QuestionAnswered").map(
    ({ event, payload }) => `${blockOf(event)} was answered: ${oneLine(payload.answer, messageChars)}`,
  ),
]

export const renderTaskBrief = (input: BriefInput): string => {
  const { blocks, events, run } = input
  const paths = new Map(
    eventsOf(events, "ArtifactCreated").map(({ payload }) => [payload.artifactId, payload.path]),
  )
  const attempts = attemptFacts(events)
  const finished = lastOf(events, "RunFinished")

  const header = [
    `# Cockpit task brief — run ${run.id}`,
    "",
    "You are continuing a task Cockpit already executed. Everything below comes from that run's",
    "journal. Long material is referenced by path; read a file when you need its detail.",
    "",
    "## Task",
    clip(run.prompt, promptChars),
  ]

  const sections: ReadonlyArray<Section> = [
    {
      title: "Run",
      floor: 6,
      entries: [
        `Project: ${input.projectName} (${input.repoPath})`,
        `Status: ${run.status}${finished === undefined ? "" : ` (${finished.status})`}`,
        `Worktree: ${input.worktreePath}`,
        `Branch: ${run.branch ?? "(none recorded)"}`,
        `Base commit: ${run.baseCommit ?? "(none recorded)"}`,
        `Started: ${run.createdAt}${run.finishedAt === null ? "" : ` · finished ${run.finishedAt}`}`,
      ],
    },
    { title: "Approved plan", floor: 3, entries: planSection(events, paths) },
    { title: "Blocks", floor: 3, entries: blockSection(blocks, events) },
    {
      title: "Attempts worth knowing about",
      floor: 2,
      entries: attempts
        .filter((attempt) => attempt.verdict !== "success")
        .map((attempt) => {
          const reasons = reasonsOf(attempt, paths)
          return `${attempt.blockId} attempt ${attempt.number} — ${attempt.verdict ?? "never finished"}${
            reasons.length === 0 ? "" : `: ${reasons.join("; ")}`
          }`
        }),
    },
    {
      title: "Decisions",
      floor: 2,
      entries: eventsOf(events, "TreeTransformed").map(
        ({ payload }) => `Transform ${payload.name} (diff: ${paths.get(payload.diffRef) ?? payload.diffRef})`,
      ),
    },
    { title: "Changed files", floor: 5, entries: [...input.changedFiles] },
    {
      title: "Checkpoints",
      floor: 2,
      entries: eventsOf(events, "CheckpointCreated").map(
        ({ payload }) => `${payload.checkpointId} (${payload.kind})`,
      ),
    },
    {
      title: "Verification",
      floor: 3,
      entries: eventsOf(events, "VerificationReported").flatMap(({ event, payload }) =>
        payload.criteria.map(
          (criterion) =>
            `${blockOf(event)} · ${criterion.passed ? "pass" : "FAIL"} — ${criterion.criterion}`,
        ),
      ),
    },
    { title: "Errors and retries", floor: 3, entries: errorSection(events) },
    { title: "Questions and review feedback", floor: 3, entries: feedbackSection(events) },
    { title: "Results", floor: 2, entries: resultSection(events, paths) },
    {
      title: "Artifacts",
      floor: 5,
      entries: eventsOf(events, "ArtifactCreated").map(
        ({ payload }) => `${payload.kind}: ${payload.path} (${payload.bytes} bytes)`,
      ),
    },
    {
      title: "Working here",
      floor: 2,
      entries: [
        `You are in ${input.worktreePath}, on ${run.branch ?? "the run's branch"}.`,
        ...(input.healthChecks.length === 0
          ? ["The project's cartridge declares no health checks."]
          : [
              "Checks this project declares:",
              ...input.healthChecks.map((check) => `- ${check.argv.join(" ")}`),
            ]),
      ],
    },
  ]

  return fitSections(sections, header, input.maxChars)
}
