import { describe, expect, it } from "vitest"
import { insightView } from "./insightModel.js"
import type { Insight } from "./model.js"

const insight = (over: Partial<Insight> = {}): Insight => ({
  id: "ins_1",
  target: "core",
  title: "Retry context is too large",
  body: "The second attempt was handed 12 KB of packet.",
  evidence: [{ kind: "artifact", ref: "~/.cockpit/runs/run_1/packet.md" }],
  occurrences: 1,
  firstSeenRun: "run_1",
  lastSeenRun: "run_1",
  lastSeenAt: new Date(Date.now() - 7_200_000).toISOString(),
  ...over,
})

describe("insightView", () => {
  it("counts an insight only once it has happened twice", () => {
    expect(insightView(insight()).occurrences).toBe("")
    expect(insightView(insight({ occurrences: 4 })).occurrences).toBe("×4")
  })

  it("tones the badge by which side of the system should change", () => {
    expect(insightView(insight()).toneClass).toContain("vio")
    expect(insightView(insight({ target: "cartridge" })).toneClass).toContain("blue")
  })

  it("renders evidence as readable references, not raw json", () => {
    const view = insightView(
      insight({
        evidence: [
          { kind: "artifact", ref: "~/.cockpit/runs/run_1/packet.md" },
          { kind: "block", ref: "implement" },
        ],
      }),
    )

    expect(view.evidence).toEqual([
      "artifact · ~/.cockpit/runs/run_1/packet.md",
      "block · implement",
    ])
  })

  it("names the second run only when it is not the first", () => {
    expect(insightView(insight()).runs).toEqual(["first seen in run run_1"])
    expect(insightView(insight({ lastSeenRun: "run_9" })).runs).toEqual([
      "first seen in run run_1",
      "last seen in run run_9",
    ])
  })

  it("shows how long ago it was last seen, and nothing when that run is gone", () => {
    expect(insightView(insight()).lastSeen).toBe("2h")
    expect(insightView(insight({ lastSeenAt: null })).lastSeen).toBe("")
  })
})
