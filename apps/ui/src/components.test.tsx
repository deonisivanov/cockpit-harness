import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AttachmentChips, RunAttachments } from "./App.js"
import type { EventPayload, JournalEvent, Run, RunDetail, WorkflowNode } from "./model.js"
import { Rail } from "./Rail.js"
import { ProseBox, RawSection } from "./render.js"
import { applyEvents, emptyRunState } from "./store.js"
import { OutcomeCard } from "./Stream.js"
import { Tree } from "./Tree.js"

let seq = 0
const ev = (payload: EventPayload, blockId?: string, attemptId?: string): JournalEvent => ({
  seq: ++seq,
  ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
  runId: "run_1",
  ...(blockId ? { blockId } : {}),
  ...(attemptId ? { attemptId } : {}),
  payload,
})

const run = (id: string, prompt: string, status: Run["status"]): Run => ({
  id,
  projectId: "p",
  prompt,
  status,
  createdAt: new Date(Date.now() - 300_000).toISOString(),
})

describe("Rail", () => {
  const runs = [
    run("r1", "Fix interview recovery after reconnect", "running"),
    run("r2", "Fix live transcript auto-scrolling", "failed"),
    run("r3", "Refactor interview mode configuration", "succeeded"),
  ]

  const render = (props: Partial<Parameters<typeof Rail>[0]> = {}) =>
    renderToStaticMarkup(
      <Rail
        expanded
        onToggle={() => {}}
        project={{ id: "p", name: "ai-interview-assistant", repoPath: "~/src/x" }}
        projects={[{ id: "p", name: "ai-interview-assistant", repoPath: "~/src/x" }]}
        onSelectProject={() => {}}
        runs={runs}
        selectedRunId="r1"
        onSelect={() => {}}
        onDelete={() => {}}
        onNewTask={() => {}}
        insightsOpen={false}
        onInsights={() => {}}
        badge={null}
        activity={[]}
        addProjectOpen={false}
        onToggleAddProject={() => {}}
        onAddProject={() => {}}
        addProjectBusy={false}
        addProjectError={null}
        {...props}
      />,
    )

  it("lists every run with the project name and counters", () => {
    const html = render()
    expect(html).toContain("ai-interview-assistant")
    expect(html).toContain("Fix interview recovery after reconnect")
    expect(html).toContain("1 running")
    expect(html).toContain("1 failed")
  })

  it("pulses the dot of a running task and marks a failed one", () => {
    const html = render()
    expect(html).toContain("animate-ck-pulse")
    expect(html).toContain("text-red")
  })

  it("raises a badged task to the top of the list and shows its badge", () => {
    const html = render({ badge: "approval", selectedRunId: "r3" })
    expect(html).toContain("approval")
    expect(html.indexOf("Refactor interview mode configuration")).toBeLessThan(
      html.indexOf("Fix interview recovery after reconnect"),
    )
  })

  it("offers a delete control on every task row", () => {
    const html = render()
    expect(html.match(/data-testid="delete-task"/g)).toHaveLength(3)
    expect(html).toContain('aria-label="delete Fix interview recovery after reconnect"')
  })

  it("collapses to status dots only", () => {
    const html = render({ expanded: false })
    expect(html).not.toContain("ai-interview-assistant")
    expect(html).toContain("w-[54px]")
  })

  it("shows the register hint and the form instead of a dead dropdown when there is no project", () => {
    const html = render({ project: null })
    expect(html).toContain("register a git repository to start")
    expect(html).toContain('data-testid="add-project-form"')
    expect(html).not.toContain('data-testid="add-project-toggle"')
  })

  it("disables the register button until both fields are filled", () => {
    const html = render({ project: null })
    expect(html).toMatch(/data-testid="add-project-submit"[^>]*disabled=""/)
  })

  it("labels both register-project inputs for assistive tech", () => {
    const html = render({ project: null })
    expect(html).toContain('aria-label="project name"')
    expect(html).toContain('aria-label="repository path"')
  })

  it("keeps the add-project form collapsed behind a toggle when a project is selected", () => {
    const html = render()
    expect(html).toContain('data-testid="add-project-toggle"')
    expect(html).not.toContain('data-testid="add-project-form"')
  })

  it("switches the project box to a native select listing every project", () => {
    const html = render({
      projects: [
        { id: "p", name: "ai-interview-assistant", repoPath: "~/src/x" },
        { id: "p2", name: "second-repo", repoPath: "~/src/y" },
      ],
    })
    expect(html).toContain('data-testid="project-select"')
    expect(html).toContain('value="p"')
    expect(html).toContain("second-repo")
  })
})

describe("Tree", () => {
  const root: WorkflowNode = {
    _tag: "Sequence",
    children: [
      { _tag: "Block", id: "explore", def: "codex" },
      { _tag: "Gate", id: "plan-approval", payload: { title: "plan-approval", summary: "" } },
      {
        _tag: "Loop",
        policy: "corrective",
        kind: "corrective",
        body: { _tag: "Block", id: "implement", def: "implement" },
      },
    ],
  }

  const detail: RunDetail = {
    run: run("run_1", "x", "running"),
    tree: { runId: "run_1", templateId: "bugfix-with-reproduction", root },
    retryPolicies: { corrective: { maxAttempts: 3 } },
  }

  const state = applyEvents(emptyRunState(), [
    ev({ _tag: "BlockStarted", defId: "codex", kind: "agent" }, "explore"),
    ev({ _tag: "BlockFinished", status: "succeeded" }, "explore"),
    ev({ _tag: "ApprovalRequested", gateId: "plan-approval", payloadRef: "art" }, "plan-approval"),
    ev({ _tag: "BlockStarted", defId: "implement", kind: "agent" }, "implement"),
    ev({ _tag: "AttemptStarted", number: 1 }, "implement", "at1"),
    ev({ _tag: "AttemptFinished", verdict: "semantic-failure" }, "implement", "at1"),
    ev({ _tag: "AttemptStarted", number: 2 }, "implement", "at2"),
  ])

  const html = renderToStaticMarkup(
    <Tree
      detail={detail}
      state={state}
      selected={null}
      onSelect={() => {}}
      onSkip={() => {}}
      floating={false}
    />,
  )

  it("shows every block with its plugin badge", () => {
    expect(html).toContain("explore")
    expect(html).toContain("codex")
    expect(html).toContain("implement")
    expect(html).toContain("bugfix-with-reproduction")
  })

  it("renders the loop attempt indicator as 2/3 with a failed then live tick", () => {
    expect(html).toContain(">2/3<")
    expect(html).toContain("rounded-full bg-red")
    expect(html).toContain("rounded-full bg-vio animate-ck-pulse")
  })

  it("shows a pending message instead of nodes when the tree has not arrived", () => {
    const out = renderToStaticMarkup(
      <Tree
        detail={{ run: detail.run }}
        state={state}
        selected={null}
        onSelect={() => {}}
        onSkip={() => {}}
        floating={false}
      />,
    )
    expect(out).toContain("still assembling this workflow")
    expect(out).not.toContain("data-testid=\"tree-node\"")
  })

  it("marks a pending gate as waiting and a finished block as done", () => {
    expect(html).toContain('data-status="waiting"')
    expect(html).toContain('data-status="done"')
    expect(html).toContain('data-status="running"')
  })

  it("offers skip on a pending block only", () => {
    const idle = renderToStaticMarkup(
      <Tree
        detail={detail}
        state={applyEvents(emptyRunState(), [ev({ _tag: "RunStarted" })])}
        selected={null}
        onSelect={() => {}}
        onSkip={() => {}}
        floating={false}
      />,
    )
    // Every block is still pending, so each carries the affordance; the gate does not.
    expect(idle.match(/data-testid="skip-block"/g)).toHaveLength(2)
    // The started fixture: explore is done and implement is running — neither is skippable.
    expect(html).not.toContain('data-testid="skip-block"')
  })

  it("dims a skipped block", () => {
    const skipped = applyEvents(state, [ev({ _tag: "BlockSkipped", reason: "n/a" }, "implement")])
    const out = renderToStaticMarkup(
      <Tree
        detail={detail}
        state={skipped}
        selected={null}
        onSelect={() => {}}
        onSkip={() => {}}
        floating={false}
      />,
    )
    expect(out).toContain("opacity-45")
    expect(out).toContain('data-status="skipped"')
  })
})

describe("result prose", () => {
  it("renders an outcome card with its title, meta and prose paragraphs", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard
        focused={false}
        row={{
          kind: "outcome",
          key: "1",
          event: { seq: 1, ts: "", runId: "r", payload: { _tag: "BlockFinished", status: "succeeded" } },
          title: "explore — finished",
          meta: "11:04:15 · 12s",
          failed: false,
          paras: [
            { kind: "p", text: "The reconnect path is mapped." },
            { kind: "b", text: "No code was changed." },
          ],
        }}
      />,
    )
    expect(html).toContain("explore — finished")
    expect(html).toContain("11:04:15 · 12s")
    expect(html).toContain("The reconnect path is mapped.")
    expect(html).toContain("—  No code was changed.")
  })

  it("keeps the raw JSON behind a details element that starts closed", () => {
    const html = renderToStaticMarkup(<RawSection value={{ ok: true }} />)
    expect(html).toContain("<details")
    expect(html).not.toContain("open")
    expect(html).toContain("RAW")
    expect(html).toContain("ok")
  })

  it("says so instead of rendering an empty prose box", () => {
    const html = renderToStaticMarkup(<ProseBox paras={[]} />)
    expect(html).toContain("No textual result was reported.")
  })
})

describe("attachments", () => {
  it("previews image drafts and names the rest, each with a remove control", () => {
    const drafts = [
      { file: new File(["png"], "shot.png", { type: "image/png" }), previewUrl: "blob:shot" },
      { file: new File(["# notes"], "notes.md", { type: "text/markdown" }), previewUrl: null },
    ]
    const html = renderToStaticMarkup(<AttachmentChips attachments={drafts} onRemove={() => {}} />)
    expect(html).toContain('src="blob:shot"')
    expect(html).toContain("notes.md")
    expect(html).toContain('data-testid="remove-attachment-0"')
    expect(html).toContain('data-testid="remove-attachment-1"')
  })

  it("renders nothing for an empty draft list", () => {
    expect(renderToStaticMarkup(<AttachmentChips attachments={[]} onRemove={() => {}} />)).toBe("")
  })

  it("shows a run's attachments: images inline, files as raw links", () => {
    const html = renderToStaticMarkup(
      <RunAttachments
        attachments={[
          { id: "art_1", name: "shot.png", bytes: 10 },
          { id: "art_2", name: "notes.md", bytes: 7 },
        ]}
      />,
    )
    expect(html).toContain('src="/api/artifacts/art_1/raw"')
    expect(html).toContain('href="/api/artifacts/art_2/raw"')
    expect(html).toContain("notes.md")
  })

  it("renders nothing for a run without attachments", () => {
    expect(renderToStaticMarkup(<RunAttachments attachments={[]} />)).toBe("")
  })
})
