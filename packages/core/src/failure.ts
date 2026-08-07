import { ArtifactId } from "./ids.js"
import { clip } from "./text.js"
import { FailurePacket, RetryContext } from "./workflow.js"

/** Below this the fixed scaffolding of a rendered context would not fit, so budgets clamp up to it. */
export const minimumContextChars = 512

const summaryChars = 240

const condense = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`

const asStrings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []

const field = (output: unknown, name: string): unknown =>
  typeof output === "object" && output !== null
    ? (output as Record<string, unknown>)[name]
    : undefined

/** What one attempt produced; the engine adds who tried it and how it was judged. */
export interface AttemptEvidence {
  readonly actionsTaken: ReadonlyArray<string>
  readonly commandsRun: ReadonlyArray<string>
  readonly whatFailed: ReadonlyArray<string>
  readonly diagnostics: ReadonlyArray<{ readonly excerpt: string; readonly ref?: ArtifactId }>
  /** Present when the agent produced parseable JSON that nonetheless failed its contract. */
  readonly output?: unknown
  readonly assistantText: string
}

export interface AttemptRecord extends AttemptEvidence {
  readonly attemptNumber: number
  readonly approach: string
  readonly binding?: string
  readonly failureReason: string
  /** Names the reporter when a loop routes this failure to a block other than the one that failed. */
  readonly reportedBy?: string
}

/**
 * The agent's own account of what it believed is the most useful line in the packet, so it is
 * taken from the block output when the contract carries it and reconstructed from the transcript
 * otherwise.
 */
const hypothesisOf = (record: AttemptRecord) => {
  const declared = field(record.output, "hypothesis")
  if (typeof declared === "string" && declared.trim() !== "") return declared.trim()
  const tail = record.assistantText.trim().split(/\n{2,}/).at(-1)
  return tail === undefined || tail === "" ? "not stated by the attempt" : condense(tail, 600)
}

export const buildFailurePacket = (record: AttemptRecord): FailurePacket => {
  // A verifier states what is wrong in `findings`; that is the sharpest account of the failure
  // there is, so it survives both as the failure itself and as the work left to do.
  const findings = asStrings(field(record.output, "findings"))
  const hypothesis = hypothesisOf(record)
  const reporter = record.reportedBy
  return {
    attemptNumber: record.attemptNumber,
    hypothesis,
    // The recipient of a routed packet never chose this strategy, so it is labelled as a report.
    strategy:
      reporter === undefined
        ? { binding: record.binding, approach: record.approach }
        : { approach: `the previous attempt, judged by ${reporter}` },
    actionsTaken: record.actionsTaken,
    commandsRun: record.commandsRun,
    whatFailed: [
      ...(record.whatFailed.length === 0 ? [record.failureReason] : record.whatFailed),
      ...findings,
    ].join("; "),
    diagnostics: record.diagnostics,
    failureReason: record.failureReason,
    doNotRepeat: [
      reporter === undefined
        ? `repeating attempt ${record.attemptNumber} unchanged: ${condense(hypothesis, 200)}`
        : `whatever ${reporter} rejected in attempt ${record.attemptNumber}: ${condense(hypothesis, 200)}`,
      ...asStrings(field(record.output, "doNotRepeat")),
    ],
    remainingDirections: [...asStrings(field(record.output, "remainingDirections")), ...findings],
  }
}

/**
 * Collapses the volatile parts of a failure — counts, paths, ids, hex — so two attempts that broke
 * the same way compare equal and no-progress detection can see it.
 */
export const failureSignature = (packet: FailurePacket) =>
  packet.whatFailed
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/(^|\s)[^\s]*[/\\][^\s]*/g, "$1<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)

const summarize = (packet: FailurePacket) =>
  condense(
    `Attempt ${packet.attemptNumber} tried ${packet.strategy.approach} on the hypothesis that ${packet.hypothesis} It failed: ${packet.whatFailed} (${packet.failureReason})`,
    summaryChars,
  )

const bullets = (label: string, entries: ReadonlyArray<string>) =>
  entries.length === 0 ? [] : [`${label}:`, ...entries.map((entry) => `- ${entry}`)]

const render = (context: RetryContext) => {
  const last = context.lastAttempt
  const lines = [
    `## Previous attempts (context budget ${context.budget.maxChars} chars)`,
    "",
    `### Attempt ${last.attemptNumber} — most recent`,
    `Hypothesis: ${last.hypothesis}`,
    `Strategy: ${last.strategy.approach}${last.strategy.binding === undefined ? "" : ` via ${last.strategy.binding}`}`,
    ...(last.actionsTaken.length === 0 ? [] : [`Actions taken: ${last.actionsTaken.join(", ")}`]),
    ...(last.commandsRun.length === 0 ? [] : [`Commands run: ${last.commandsRun.join(" ; ")}`]),
    `What failed: ${last.whatFailed}`,
    `Why it was judged a failure: ${last.failureReason}`,
    ...bullets("Do not repeat", last.doNotRepeat),
    ...bullets("Remaining directions", last.remainingDirections),
    ...bullets(
      "Diagnostics",
      last.diagnostics.map(
        (entry) =>
          `${entry.excerpt}${entry.ref === undefined ? "" : ` [artifact ${entry.ref}]`}`,
      ),
    ),
    ...bullets(
      "Earlier attempts",
      context.olderAttempts.map((older) => `Attempt ${older.attemptNumber}: ${older.summary}`),
    ),
    ...bullets(
      "Repeated errors",
      context.repeatedErrors.map((error) => `${error.signature} (seen ${error.count}x)`),
    ),
  ]
  return lines.join("\n")
}

/**
 * The reductions summarize whole parts away, but the fixed scaffolding alone can outgrow a very
 * small budget — so the text a caller actually sends is clipped as the last step.
 */
export const renderRetryContext = (context: RetryContext) =>
  clip(render(context), context.budget.maxChars)

const withLast = (context: RetryContext, patch: Partial<FailurePacket>): RetryContext => ({
  ...context,
  lastAttempt: { ...context.lastAttempt, ...patch },
})

/**
 * Reductions, applied in order until the render fits. Each one removes or summarizes a whole part
 * of the structure; none ever cuts the rendered text in half.
 */
const reductions: ReadonlyArray<(context: RetryContext) => RetryContext> = [
  (context) =>
    withLast(context, {
      diagnostics: context.lastAttempt.diagnostics.flatMap((entry) =>
        entry.ref === undefined ? [] : [{ excerpt: "(see artifact)", ref: entry.ref }],
      ),
    }),
  (context) => ({ ...context, repeatedErrors: context.repeatedErrors.slice(0, 5) }),
  (context) =>
    withLast(context, {
      actionsTaken: [],
      commandsRun: [],
      remainingDirections: context.lastAttempt.remainingDirections.slice(0, 3),
    }),
  (context) => ({ ...context, olderAttempts: context.olderAttempts.slice(-2) }),
  (context) => ({ ...context, olderAttempts: [] }),
  (context) =>
    withLast(context, {
      diagnostics: [],
      remainingDirections: [],
      doNotRepeat: context.lastAttempt.doNotRepeat.slice(0, 1),
      hypothesis: condense(context.lastAttempt.hypothesis, 200),
    }),
  // Bare: what failed, tried by whom, judged how. Everything else is already a reference.
  (context) => ({
    ...context,
    olderAttempts: [],
    repeatedErrors: [],
    lastAttempt: {
      ...context.lastAttempt,
      hypothesis: "(summarized away for budget)",
      strategy: {
        ...context.lastAttempt.strategy,
        approach: condense(context.lastAttempt.strategy.approach, 60),
      },
      actionsTaken: [],
      commandsRun: [],
      doNotRepeat: [],
      remainingDirections: [],
      diagnostics: [],
      failureReason: condense(context.lastAttempt.failureReason, 120),
    },
  }),
]

/** Last resort: the one field that must survive is trimmed to exactly the room left for it. */
const fitWhatFailed = (context: RetryContext) => {
  const room = context.budget.maxChars - render(withLast(context, { whatFailed: "" })).length
  return withLast(context, { whatFailed: condense(context.lastAttempt.whatFailed, Math.max(0, room)) })
}

export const buildRetryContext = (
  packets: readonly [FailurePacket, ...ReadonlyArray<FailurePacket>],
  maxChars: number,
): RetryContext => {
  const lastAttempt = packets[packets.length - 1]
  const counts = new Map<string, number>()
  for (const packet of packets) {
    const signature = failureSignature(packet)
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }

  const initial: RetryContext = {
    lastAttempt,
    olderAttempts: packets.slice(0, -1).map((packet) => ({
      attemptNumber: packet.attemptNumber,
      summary: summarize(packet),
    })),
    repeatedErrors: [...counts]
      .filter(([, count]) => count > 1)
      .sort(([, left], [, right]) => right - left)
      .map(([signature, count]) => ({ signature, count })),
    budget: { maxChars: Math.max(maxChars, minimumContextChars) },
  }

  let context = initial
  for (const reduce of reductions) {
    if (render(context).length <= context.budget.maxChars) return context
    context = reduce(context)
  }
  return render(context).length <= context.budget.maxChars ? context : fitWhatFailed(context)
}
