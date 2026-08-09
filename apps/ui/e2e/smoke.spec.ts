import { expect, test } from "@playwright/test"

const json = (body: unknown, status = 200) =>
  ({ status, contentType: "application/json", body: JSON.stringify(body) }) as const

test("boots with three panels and a populated stream", async ({ page }) => {
  await page.goto("/?mock=running")

  await expect(page.getByTestId("rail")).toBeVisible()
  await expect(page.getByTestId("stream")).toBeVisible()
  await expect(page.getByTestId("tree")).toBeVisible()

  // Project names live in a native <select>'s <option>s, which Playwright reports as hidden.
  await expect(page.getByTestId("project-select")).toHaveValue("prj_interview")
  await expect(page.getByText("Fix interview recovery after reconnect").first()).toBeVisible()

  // The elapsed clock is derived from the RunStarted event, not a column on the run row.
  await expect(page.getByTestId("elapsed")).toHaveText(/^\d+m \d{2}s$/)

  const rows = page.getByTestId("event-row")
  await expect(rows.first()).toBeVisible()
  // The stream follows its tail and the list is virtual; step to the top so early rows render.
  await page.keyboard.press("k")
  await expect(rows.filter({ hasText: "rg -n reconnect" }).first()).toBeVisible()
  await expect(page.getByTestId("attempt-header").first()).toBeVisible()

  await expect(rows.filter({ hasText: "session started" })).toHaveCount(0)
  await page.getByTestId("stream-mode").click()
  await expect(rows.filter({ hasText: "session started" }).first()).toBeVisible()
})

test("interactive buttons render with a pointer cursor", async ({ page }) => {
  await page.goto("/?mock=running")
  await expect(page.getByTestId("cancel-run")).toHaveCSS("cursor", "pointer")
})

test("a live run offers Stop", async ({ page }) => {
  await page.goto("/?mock=running")
  await expect(page.getByTestId("stop-run")).toBeVisible()
  await expect(page.getByTestId("run-workflow")).toHaveCount(0)
})

test("a planned run shows its workflow and waits for Run", async ({ page }) => {
  await page.goto("/?mock=awaiting-start")

  // The tree is on screen before anything has executed.
  await expect(page.getByTestId("tree-node").first()).toBeVisible()
  await expect(page.getByTestId("run-workflow")).toBeVisible()
  await expect(page.getByTestId("regenerate-workflow")).toBeVisible()
  await expect(page.getByTestId("cancel-run")).toBeVisible()
  await expect(page.getByTestId("stop-run")).toHaveCount(0)
  // The terminal stays open on a run that has not started, so the risk of writing is on screen.
  await expect(page.getByTestId("terminal-write-warning")).toContainText("has not started")

  await page.getByTestId("run-workflow").click()
  await expect(page.getByTestId("stop-run")).toBeVisible()
  await expect(page.getByTestId("run-workflow")).toHaveCount(0)
})

test("tree shows block statuses, the gate and the loop indicator", async ({ page }) => {
  await page.goto("/?mock=retry")

  const tree = page.getByTestId("tree")
  await expect(tree.getByTestId("tree-node").filter({ hasText: "explore" })).toHaveAttribute(
    "data-status",
    "done",
  )
  await expect(tree.getByTestId("tree-node").filter({ hasText: "implement" })).toHaveAttribute(
    "data-status",
    "running",
  )
  await expect(tree.getByText("plan-approval")).toBeVisible()
  await expect(tree.getByTestId("loop-indicator").filter({ hasText: "2/3" })).toBeVisible()
})

test("the workflow panel waits for the analyzer, then draws the tree once running", async ({
  page,
}) => {
  await page.goto("/?mock=analyzing")

  await expect(page.getByTestId("tree-pending")).toBeVisible()
  await expect(page.getByTestId("tree-node")).toHaveCount(0)

  // The stream still works off events alone while the tree is missing.
  await expect(
    page.getByTestId("event-row").filter({ hasText: "template selected" }),
  ).toBeVisible()

  // RunStarted streams in, the run flips to running, and the refetch brings the tree.
  await expect(page.getByTestId("tree-pending")).toBeHidden()
  await expect(page.getByTestId("tree-node").filter({ hasText: "explore" })).toBeVisible()
})

test("a recovered run shows the recovery banner", async ({ page }) => {
  await page.goto("/?mock=recovery")
  await expect(page.getByText(/run recovered from checkpoint 4f2a91c/)).toBeVisible()
})

test("a failed run start surfaces the error and keeps the prompt", async ({ page }) => {
  await page.route("**/api/projects", (route) =>
    route.fulfill(json([{ id: "p1", name: "demo", repoPath: "~/src/demo" }])),
  )
  await page.route("**/api/projects/*/runs", (route) => route.fulfill(json([])))
  await page.route("**/api/runs", (route) => route.fulfill({ status: 400, body: "bad prompt" }))
  await page.goto("/")

  const prompt = "Add a retry budget to the transcript writer"
  await page.getByTestId("prompt-input").fill(prompt)
  await page.getByTestId("start-run").click()

  await expect(page.getByTestId("start-error")).toContainText("400")
  await expect(page.getByTestId("prompt-input")).toHaveValue(prompt)
})

test("the empty rail state registers a project and selects it", async ({ page }) => {
  let projects: { id: string; name: string; repoPath: string }[] = []
  await page.route("**/api/projects", (route) => {
    if (route.request().method() !== "POST") return route.fulfill(json(projects))
    const created = { id: "p_new", name: "demo", repoPath: "/Users/you/demo" }
    projects = [...projects, created]
    return route.fulfill(json(created, 201))
  })
  await page.route("**/api/projects/*/runs", (route) => route.fulfill(json([])))
  await page.goto("/")

  await expect(page.getByTestId("rail").getByText("register a git repository to start")).toBeVisible()
  const form = page.getByTestId("add-project-form")
  await expect(form).toBeVisible()

  await form.getByTestId("add-project-name").fill("demo")
  await form.getByTestId("add-project-path").fill("/Users/you/demo")
  await form.getByTestId("add-project-submit").click()

  await expect(page.getByTestId("project-select")).toHaveValue("p_new")
  await expect(page.getByTestId("add-project-form")).toBeHidden()
})

test("a 400 from project registration shows inline and keeps the typed values", async ({ page }) => {
  await page.route("**/api/projects", (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill(json([{ id: "p1", name: "demo", repoPath: "~/src/demo" }]))
    return route.fulfill(json({ error: "not a git repository", detail: "/tmp is not a repo" }, 400))
  })
  await page.route("**/api/projects/*/runs", (route) => route.fulfill(json([])))
  await page.goto("/")

  await page.getByTestId("add-project-toggle").click()
  const form = page.getByTestId("add-project-form")
  await form.getByTestId("add-project-name").fill("bad")
  await form.getByTestId("add-project-path").fill("/tmp")
  await form.getByTestId("add-project-submit").click()

  await expect(form.getByTestId("add-project-error")).toContainText("not a git repository")
  await expect(form.getByTestId("add-project-name")).toHaveValue("bad")
  await expect(form.getByTestId("add-project-path")).toHaveValue("/tmp")
})

test("the register form rejects a relative repo path before submitting", async ({ page }) => {
  let posted = false
  await page.route("**/api/projects", (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill(json([{ id: "p1", name: "demo", repoPath: "~/src/demo" }]))
    posted = true
    return route.fulfill(json({ id: "p2", name: "x", repoPath: "x" }, 201))
  })
  await page.route("**/api/projects/*/runs", (route) => route.fulfill(json([])))
  await page.goto("/")

  await page.getByTestId("add-project-toggle").click()
  const form = page.getByTestId("add-project-form")
  await form.getByTestId("add-project-name").fill("demo")
  await form.getByTestId("add-project-path").fill("relative/path")
  await form.getByTestId("add-project-submit").click()

  await expect(form.getByTestId("add-project-error")).toContainText("enter an absolute path")
  expect(posted).toBe(false)
})

test("switching the project select clears the old run list and loads the new project's runs", async ({
  page,
}) => {
  await page.route("**/api/projects", (route) =>
    route.fulfill(
      json([
        { id: "p1", name: "first-repo", repoPath: "/repo/one" },
        { id: "p2", name: "second-repo", repoPath: "/repo/two" },
      ]),
    ),
  )
  await page.route("**/api/projects/p1/runs", (route) =>
    route.fulfill(
      json([
        {
          id: "r1",
          projectId: "p1",
          prompt: "first project run",
          status: "succeeded",
          createdAt: new Date().toISOString(),
        },
      ]),
    ),
  )
  await page.route("**/api/projects/p2/runs", (route) => route.fulfill(json([])))
  await page.goto("/")

  await expect(page.getByTestId("rail-task").filter({ hasText: "first project run" })).toBeVisible()

  await page.getByTestId("project-select").selectOption("p2")

  await expect(page.getByTestId("project-select")).toHaveValue("p2")
  await expect(page.getByTestId("rail-task")).toHaveCount(0)
})

test("selecting a tree node filters the stream to that block and clears again", async ({ page }) => {
  await page.goto("/?mock=retry")
  await expect(page.getByTestId("event-row").first()).toBeVisible()

  await page.getByTestId("tree-node").filter({ hasText: "explore" }).click()
  await expect(page.getByTestId("clear-filter")).toBeVisible()

  // explore owns the ripgrep call; the rspec run belongs to verify and must drop out.
  await expect(page.getByTestId("event-row").filter({ hasText: "rg -n reconnect" })).toHaveCount(1)
  await expect(page.getByTestId("event-row").filter({ hasText: "rspec" })).toHaveCount(0)
  await expect(page.getByTestId("failure-card")).toHaveCount(0)

  await page.getByTestId("clear-filter").click()
  await expect(page.getByTestId("clear-filter")).toBeHidden()
  await expect(page.getByTestId("failure-card")).toBeVisible()
})

test("approval gate renders its plan and clicks through to a decision", async ({ page }) => {
  await page.goto("/?mock=approval")

  const card = page.getByTestId("approval-card")
  await expect(card).toBeVisible()
  await expect(card.getByText("plan-approval").first()).toBeVisible()
  await expect(card.getByText("persist the transcript cursor on every event")).toBeVisible()

  await expect(card.getByTestId("approve")).toBeEnabled()
  await card.getByTestId("approve").click()

  await expect(card.getByText("approved — execution resumed")).toBeVisible()
  await expect(card.getByTestId("approve")).toBeDisabled()
})

test("failure packet expands to the envelope forwarded to the next attempt", async ({ page }) => {
  await page.goto("/?mock=retry")

  const failure = page.getByTestId("failure-card")
  await expect(failure).toBeVisible()
  await expect(failure.getByText("ATTEMPT FAILED")).toBeVisible()
  await expect(failure.getByText(/stale cursor/)).toBeVisible()

  await failure.getByTestId("expand-packet").click()
  await expect(failure.getByText("FEEDBACK PACKET")).toBeVisible()
  await expect(failure.getByText(/interview_recovery_spec:34/)).toBeVisible()
})

test("a question row takes an answer", async ({ page }) => {
  await page.goto("/?mock=question")

  const card = page.getByTestId("question-card")
  await expect(card).toBeVisible()
  await expect(card.getByText(/disagree on cursor ownership/)).toBeVisible()

  await card.getByTestId("answer-input").fill("InterviewRecovery owns the write")
  await card.getByTestId("send-answer").click()

  // The question stays visible next to the answer it received.
  await expect(card.getByText("ANSWERED", { exact: true })).toBeVisible()
  await expect(card.getByText("InterviewRecovery owns the write")).toBeVisible()
  await expect(card.getByText(/disagree on cursor ownership/)).toBeVisible()
})

test("expanders render ANSI output and a unified diff", async ({ page }) => {
  await page.goto("/?mock=retry")
  // Artifact rows are essential-mode narration; switch to full log to reach the diff.
  await page.getByTestId("stream-mode").click()

  await page.locator('[data-testid=event-row][data-tag=stdout]').first().click()
  await expect(page.getByTestId("ansi-terminal").first()).toBeVisible()

  await page.getByTestId("event-row").filter({ hasText: ".patch" }).first().click()
  const diff = page.getByTestId("diff-view").first()
  await expect(diff).toBeVisible()
  await expect(diff.getByText(/reload\.cursor/)).toBeVisible()
})

test("a finished run closes with a summary card", async ({ page }) => {
  await page.goto("/?mock=finished")

  const summary = page.getByTestId("summary-card")
  await expect(summary).toBeVisible()
  await expect(summary.getByText("run finished · succeeded")).toBeVisible()
  await expect(summary.getByText("VERIFICATION")).toBeVisible()
})

test("a cancelled run reports cancelled", async ({ page }) => {
  await page.goto("/?mock=cancelled")
  await expect(page.getByTestId("summary-card").getByText(/cancelled/).first()).toBeVisible()
})

test("the idle state offers a prompt box and recent runs", async ({ page }) => {
  await page.goto("/?mock=idle")

  await expect(page.getByTestId("idle")).toBeVisible()
  await expect(page.getByTestId("start-run")).toBeDisabled()
  await page.getByTestId("prompt-input").fill("Add a retry budget to the transcript writer")
  await expect(page.getByTestId("start-run")).toBeEnabled()
})

test("j moves the stream focus with the keyboard", async ({ page }) => {
  await page.goto("/?mock=finished")

  await expect(page.getByTestId("event-row").first()).toBeVisible()
  await page.keyboard.press("j")
  await expect(page.locator("[data-testid=event-row].border-vio")).toHaveCount(1)

  // The first row is the analyzer's template choice; `o` opens its rationale in place.
  await page.keyboard.press("o")
  await expect(page.getByTestId("stream").getByText("RATIONALE", { exact: true })).toBeVisible()
})
