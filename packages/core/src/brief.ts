import type { JournalEvent } from "./events.js"
import type { BlockRow, RunRow } from "./Store.js"
import { clip, oneLine } from "./text.js"

const promptChars = 2_000
const inlineChars = 600
const messageChars = 300

/**
 * The brief seeds a session that has to keep working, so a section is never cut in half: each one
 * declares how many entries must survive, and the budget takes the rest from whichever section is
 * furthest above its floor. Long material is named by artifact path, never pasted in.
 */
interface Section {
  readonly title: string
  readonly entries: ReadonlyArray<string>
  readonly floor: number
}

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

type Payload = JournalEvent["payload"]
type Tag = Payload["_tag"]
type OfTag<T extends Tag> = Extract<Payload, { readonly _tag: T }>

const pick = <T extends Tag>(events: ReadonlyArray<JournalEvent>, tag: T) =>
  events.flatMap((event) =>
    event.payload._tag === tag
      ? [{ event, payload: event.payload as OfTag<T> }]
      : [],
  )

const one = <T extends Tag>(events: ReadonlyArray<JournalEvent>, tag: T) =>
  pick(events, tag).at(-1)?.payload

const where = (event: JournalEvent) =>
  event.blockId === undefined ? "run" : event.blockId

interface AttemptFacts {
  readonly blockId: string
  readonly number: number
  verdict?: string
  readonly reasons: string[]
}

const attemptFacts = (events: ReadonlyArray<JournalEvent>, paths: ReadonlyMap<string, string>) => {
  const attempts = new Map<string, AttemptFacts>()
  for (const event of events) {
    const id = event.attemptId
    if (id === undefined) continue
    const payload = event.payload
    if (payload._tag === "AttemptStarted") {
      attempts.set(id, { blockId: where(event), number: payload.number, reasons: [] })
      continue
    }
    const facts = attempts.get(id)
    if (facts === undefined) continue
    if (payload._tag === "AttemptFinished") facts.verdict = payload.verdict
    else if (payload._tag === "AttemptInterrupted") facts.verdict = "interrupted"
    else if (payload._tag === "ErrorRaised") {
      facts.reasons.push(oneLine(payload.message, messageChars))
    } else if (payload._tag === "FailureFeedbackForwarded") {
      const path = paths.get(payload.packetRef)
      if (path !== undefined) facts.reasons.push(`failure packet: ${path}`)
    }
  }
  return [...attempts.values()]
}

const planSection = (events: ReadonlyArray<JournalEvent>, paths: ReadonlyMap<string, string>) => {
  const analyzed = one(events, "TreeAnalyzed")
  const decisions = pick(events, "ApprovalDecided")
  const requests = new Map(
    pick(events, "ApprovalRequested").map(({ payload }) => [payload.gateId, payload.payloadRef]),
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
  const plugins = new Map<string, string>()
  for (const { event, payload } of pick(events, "PluginResolved")) {
    const named = [
      payload.provider.name,
      ...(payload.plugin === undefined ? [] : [`${payload.plugin.name}@${payload.plugin.version}`]),
      ...(payload.entry === undefined ? [] : [`${payload.entry.kind} ${payload.entry.name}`]),
      ...(payload.alternative === true ? ["via its alternative binding"] : []),
    ].join(" · ")
    plugins.set(where(event), named)
  }
  const skipped = new Map(
    pick(events, "BlockSkipped").map(({ event, payload }) => [where(event), payload.reason]),
  )
  return blocks.map((block) => {
    const plugin = plugins.get(block.id)
    const reason = skipped.get(block.id)
    return `${block.id} (${block.defId}, ${block.kind}) — ${block.status}${
      plugin === undefined ? "" : ` · ${plugin}`
    }${reason === undefined ? "" : ` · skipped: ${reason}`}`
  })
}

const errorSection = (events: ReadonlyArray<JournalEvent>) => {
  const counts = new Map<string, { count: number; message: string }>()
  for (const { payload } of pick(events, "ErrorRaised")) {
    const seen = counts.get(payload.signature)
    if (seen === undefined) {
      counts.set(payload.signature, { count: 1, message: oneLine(payload.message, messageChars) })
    } else {
      seen.count += 1
    }
  }
  const retries = pick(events, "RetryScheduled")
  return [
    ...[...counts].map(
      ([signature, { count, message }]) =>
        `${signature}${count > 1 ? ` (${count}x)` : ""}: ${message}`,
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
  pick(events, "ResultProduced").map(({ event, payload }) => {
    const inline =
      payload.outputInline === undefined
        ? undefined
        : oneLine(JSON.stringify(payload.outputInline), inlineChars)
    const path = payload.outputRef === undefined ? undefined : paths.get(payload.outputRef)
    return `${where(event)}: ${inline ?? path ?? "(no output recorded)"}`
  })

const feedbackSection = (events: ReadonlyArray<JournalEvent>) => [
  ...pick(events, "QuestionAsked").map(
    ({ event, payload }) => `${where(event)} asked: ${oneLine(payload.question, messageChars)}`,
  ),
  ...pick(events, "QuestionAnswered").map(
    ({ event, payload }) => `${where(event)} was answered: ${oneLine(payload.answer, messageChars)}`,
  ),
]

const render = (sections: ReadonlyArray<Section>, header: ReadonlyArray<string>) =>
  [
    ...header,
    ...sections.flatMap((section) =>
      section.entries.length === 0 ? [] : ["", `## ${section.title}`, ...section.entries],
    ),
    "",
  ].join("\n")

/** Trims the section furthest above its floor until the whole brief fits, then clips what is left. */
const fit = (
  sections: ReadonlyArray<Section>,
  header: ReadonlyArray<string>,
  maxChars: number,
) => {
  const kept = sections.map((section) => section.entries.length)
  const draft = () =>
    sections.map((section, at) =>
      kept[at] >= section.entries.length
        ? section
        : {
            ...section,
            entries: [
              ...section.entries.slice(0, kept[at]),
              `… ${section.entries.length - kept[at]} more, see the artifact index`,
            ],
          },
    )

  for (;;) {
    const text = render(draft(), header)
    if (text.length <= maxChars) return text
    let slack = 0
    let index = -1
    sections.forEach((section, at) => {
      const room = kept[at] - section.floor
      if (room > slack) {
        slack = room
        index = at
      }
    })
    if (index === -1) return clip(text, maxChars)
    kept[index] -= Math.ceil(slack / 2)
  }
}

export const renderTaskBrief = (input: BriefInput): string => {
  const { blocks, events, run } = input
  const paths = new Map(
    pick(events, "ArtifactCreated").map(({ payload }) => [payload.artifactId, payload.path]),
  )
  const attempts = attemptFacts(events, paths)
  const finished = one(events, "RunFinished")

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
        .map(
          (attempt) =>
            `${attempt.blockId} attempt ${attempt.number} — ${attempt.verdict ?? "never finished"}${
              attempt.reasons.length === 0 ? "" : `: ${attempt.reasons.join("; ")}`
            }`,
        ),
    },
    {
      title: "Decisions",
      floor: 2,
      entries: pick(events, "TreeTransformed").map(
        ({ payload }) => `Transform ${payload.name} (diff: ${paths.get(payload.diffRef) ?? payload.diffRef})`,
      ),
    },
    { title: "Changed files", floor: 5, entries: [...input.changedFiles] },
    {
      title: "Checkpoints",
      floor: 2,
      entries: pick(events, "CheckpointCreated").map(
        ({ payload }) => `${payload.checkpointId} (${payload.kind})`,
      ),
    },
    {
      title: "Verification",
      floor: 3,
      entries: pick(events, "VerificationReported").flatMap(({ event, payload }) =>
        payload.criteria.map(
          (criterion) =>
            `${where(event)} · ${criterion.passed ? "pass" : "FAIL"} — ${criterion.criterion}`,
        ),
      ),
    },
    { title: "Errors and retries", floor: 3, entries: errorSection(events) },
    { title: "Questions and review feedback", floor: 3, entries: feedbackSection(events) },
    { title: "Results", floor: 2, entries: resultSection(events, paths) },
    {
      title: "Artifacts",
      floor: 5,
      entries: pick(events, "ArtifactCreated").map(
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

  return fit(sections, header, input.maxChars)
}
