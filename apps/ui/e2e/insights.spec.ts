import { expect, test } from "@playwright/test"

test("the insights view lists what past runs learned and opens one in detail", async ({ page }) => {
  await page.goto("/?mock=insights")

  const rows = page.getByTestId("insight-row")
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText("Retry context is too large to be read")
  // A recurring insight is one row with a counter, never three rows.
  await expect(rows.first().getByTestId("insight-occurrences")).toHaveText("×3")
  await expect(rows.nth(1)).toHaveAttribute("data-target", "cartridge")

  await expect(page.getByTestId("insight-detail")).toHaveCount(0)
  await rows.first().click()

  const detail = page.getByTestId("insight-detail")
  await expect(detail).toBeVisible()
  await expect(detail.getByText(/failure packet and repeated/)).toBeVisible()
  await expect(detail.getByText("raised 3 times")).toBeVisible()
  await expect(
    detail.getByTestId("insight-evidence").filter({ hasText: "art_packet-attempt-2-feedback.md" }),
  ).toBeVisible()

  await page.getByTestId("insight-filter-cartridge").click()
  await expect(page.getByTestId("insight-row")).toHaveCount(1)
  await expect(page.getByTestId("insight-row")).toHaveAttribute("data-target", "cartridge")
})

test("the rail toggles between the run view and insights", async ({ page }) => {
  await page.goto("/?mock=finished")

  await expect(page.getByTestId("stream")).toBeVisible()
  await page.getByTestId("rail-insights").click()

  await expect(page.getByTestId("insights")).toBeVisible()
  await expect(page.getByTestId("stream")).toHaveCount(0)

  await page.getByTestId("rail-insights").click()
  await expect(page.getByTestId("stream")).toBeVisible()
})
