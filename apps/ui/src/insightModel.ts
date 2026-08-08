import type { Insight, InsightTarget } from "./model.js"
import { relativeTime } from "./presentation.js"

const TARGET_TONE: Record<InsightTarget, string> = {
  core: "border-vio/30 bg-vio/8 text-vio",
  cartridge: "border-blue/30 bg-blue/8 text-blue",
}

export interface InsightView {
  readonly id: string
  readonly target: InsightTarget
  readonly title: string
  readonly toneClass: string
  /** Empty until it has happened twice: a counter of one is noise on every row. */
  readonly occurrences: string
  readonly lastSeen: string
  readonly evidence: readonly string[]
  readonly runs: readonly string[]
}

export const insightView = (insight: Insight): InsightView => ({
  id: insight.id,
  target: insight.target,
  title: insight.title,
  toneClass: TARGET_TONE[insight.target],
  occurrences: insight.occurrences > 1 ? `×${insight.occurrences}` : "",
  lastSeen: insight.lastSeenAt ? relativeTime(insight.lastSeenAt) : "",
  evidence: insight.evidence.map((entry) => `${entry.kind} · ${entry.ref}`),
  runs: [
    ...(insight.firstSeenRun ? [`first seen in run ${insight.firstSeenRun}`] : []),
    ...(insight.lastSeenRun && insight.lastSeenRun !== insight.firstSeenRun
      ? [`last seen in run ${insight.lastSeenRun}`]
      : []),
  ],
})
