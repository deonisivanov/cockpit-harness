import { expect, test } from "@playwright/test"

/** Owner-review captures; the artefacts land in apps/ui/screenshots/. */
const shot = (name: string, mock: string, ready: (page: import("@playwright/test").Page) => Promise<void>) =>
  test(`screenshot · ${name}`, async ({ page }) => {
    await page.goto(`/?mock=${mock}`)
    await ready(page)
    // Let the font swap and the entry animation settle so the capture is stable.
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `screenshots/${name}.png`, fullPage: false })
  })

shot("running", "running", async (page) => {
  await expect(page.getByTestId("stream")).toBeVisible()
  await expect(page.getByTestId("event-row").first()).toBeVisible()
  await expect(page.getByTestId("tree")).toBeVisible()
})

shot("awaiting-start", "awaiting-start", async (page) => {
  await expect(page.getByTestId("tree-node").first()).toBeVisible()
  await expect(page.getByTestId("run-workflow")).toBeVisible()
})

// S9: the workflow panel sizes to its content — short trees stay short, long trees scroll.
const paneHeights = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('[data-testid="tree"]') as HTMLElement
    const row = pane.parentElement as HTMLElement
    const scroll = document.querySelector('[data-testid="tree-scroll"]') as HTMLElement
    return {
      pane: pane.getBoundingClientRect().height,
      row: row.getBoundingClientRect().height,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
    }
  })

shot("tree-short", "tree-short", async (page) => {
  await expect(page.getByTestId("tree-node")).toHaveCount(2)
  await expect(page.getByTestId("run-workflow")).toBeVisible()
  const { pane, row } = await paneHeights(page)
  // The pane sizes to its 2-row content instead of stretching to the row's full height.
  expect(pane).toBeLessThan(row * 0.5)
})

shot("tree-long", "tree-long", async (page) => {
  await expect(page.getByTestId("tree-node")).toHaveCount(40)
  await expect(page.getByTestId("run-workflow")).toBeVisible()
  const { pane, row, scrollHeight, clientHeight } = await paneHeights(page)
  // The pane is capped at the row's height and the inner region scrolls instead of the pane growing past it.
  expect(pane).toBeLessThanOrEqual(row + 1)
  expect(scrollHeight).toBeGreaterThan(clientHeight)
})

shot("failed-retry", "retry", async (page) => {
  await expect(page.getByTestId("failure-card")).toBeVisible()
  await page.getByTestId("expand-packet").click()
  await expect(page.getByText("FEEDBACK PACKET")).toBeVisible()
})

shot("approval", "approval", async (page) => {
  await expect(page.getByTestId("approval-card")).toBeVisible()
})

shot("finished", "finished", async (page) => {
  await expect(page.getByTestId("summary-card")).toBeVisible()
  await expect(page.getByTestId("stream-mode")).toHaveText("full log")
})

shot("stream-full", "finished", async (page) => {
  await expect(page.getByTestId("summary-card")).toBeVisible()
  await page.getByTestId("stream-mode").click()
  await expect(page.getByTestId("stream-mode")).toHaveClass(/border-white\/18/)
})
