import { expect, test } from "@playwright/test"

/** Owner-review captures; the artefacts land in apps/ui/screenshots/. */
const settle = (page: import("@playwright/test").Page) => page.waitForTimeout(1200)

const shot = (
  name: string,
  mock: string,
  ready: (page: import("@playwright/test").Page) => Promise<void>,
  after?: (page: import("@playwright/test").Page) => Promise<void>,
) =>
  test(`screenshot · ${name}`, async ({ page }) => {
    await page.goto(`/?mock=${mock}`)
    await ready(page)
    // Let the font swap and the entry animation settle so the capture is stable.
    await settle(page)
    if (after) await after(page)
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

shot(
  "tree-short",
  "tree-short",
  async (page) => {
    await expect(page.getByTestId("tree-node")).toHaveCount(2)
    await expect(page.getByTestId("run-workflow")).toBeVisible()
  },
  async (page) => {
    const { pane, row } = await paneHeights(page)
    expect(pane).toBeLessThan(row * 0.5)
  },
)

shot(
  "tree-long",
  "tree-long",
  async (page) => {
    await expect(page.getByTestId("tree-node")).toHaveCount(40)
    await expect(page.getByTestId("run-workflow")).toBeVisible()
  },
  async (page) => {
    const { pane, row, scrollHeight, clientHeight } = await paneHeights(page)
    // The pane is capped at the row's height and the inner region scrolls instead of the pane growing past it.
    expect(pane).toBeLessThanOrEqual(row - 23)
    expect(scrollHeight).toBeGreaterThan(clientHeight)
  },
)

test("floating tree pane stays clear of the row's bottom edge", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 980 })
  await page.goto("/?mock=tree-long")
  await expect(page.getByTestId("tree-node")).toHaveCount(40)
  await settle(page)
  const { paneBottom, rowBottom } = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="tree"]') as HTMLElement
    const row = pane.parentElement as HTMLElement
    return { paneBottom: pane.getBoundingClientRect().bottom, rowBottom: row.getBoundingClientRect().bottom }
  })
  expect(rowBottom - paneBottom).toBeGreaterThanOrEqual(12)
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
