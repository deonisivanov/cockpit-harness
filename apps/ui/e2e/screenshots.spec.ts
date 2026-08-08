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
})
