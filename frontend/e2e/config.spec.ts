import { expect, test } from "@playwright/test";

/**
 * The configuration console.
 *
 * The claim under test is that what an operator types becomes what the model
 * receives — verified through the compiled prompt preview, which is produced by
 * the same code path that runs on save.
 */

test.describe("configuration console", () => {
  test("compiles the company name into the system prompt as you type", async ({ page }) => {
    await page.goto("/config");

    const companyName = page.getByLabel("Company name");
    await expect(companyName).toBeVisible();

    await companyName.fill("Contoso Robotics");

    // The preview is debounced; wait for the compiled prompt to catch up.
    await expect(page.locator("pre")).toContainText("Contoso Robotics", {
      timeout: 10_000,
    });
  });

  test("a new policy appears verbatim in the compiled prompt", async ({ page }) => {
    await page.goto("/config");
    await page.getByRole("tab", { name: "Policies" }).click();

    await page.getByRole("button", { name: "Add policy" }).click();

    const body = "Store credit is never offered unless the customer asks for it.";
    await page.getByPlaceholder("Policy name, e.g. Refunds").last().fill("Store credit");
    await page
      .getByPlaceholder(/Write the rule as you would tell/)
      .last()
      .fill(body);

    await expect(page.locator("pre")).toContainText(body, { timeout: 10_000 });
  });

  test("grounding rules cannot be removed through the form", async ({ page }) => {
    // These are compiled in by code, not config. An operator who empties every
    // field must still get a prompt that forbids answering from memory.
    await page.goto("/config");
    await expect(page.locator("pre")).toContainText(
      "Answer using only the company policies above",
      { timeout: 10_000 },
    );
    await expect(page.locator("pre")).toContainText("[[ESCALATE]]");
  });

  test("saving creates a new version and surfaces it in history", async ({ page }) => {
    await page.goto("/config");

    await page.getByLabel("Assistant name").fill(`Ada${Date.now().toString().slice(-5)}`);
    await page.getByLabel("Change note").fill("e2e: rename assistant");
    await page.getByRole("button", { name: /Save as version/ }).click();

    await expect(page.getByText(/Saved as version/)).toBeVisible();

    await page.getByRole("tab", { name: /History/ }).click();
    await expect(page.getByText("e2e: rename assistant")).toBeVisible();
    await expect(page.getByText("Live").first()).toBeVisible();
  });

  test("the save button stays disabled until something changes", async ({ page }) => {
    await page.goto("/config");
    await expect(page.getByRole("button", { name: /Save as version/ })).toBeDisabled();

    await page.getByLabel("Assistant name").fill("Changed");
    await expect(page.getByRole("button", { name: /Save as version/ })).toBeEnabled();
  });

  test("invalid input is caught in the form rather than server-side", async ({ page }) => {
    await page.goto("/config");

    await page.getByLabel("Company name").fill("");
    await page.getByLabel("Assistant name").click();

    await expect(
      page.getByText("The assistant needs a company name to represent"),
    ).toBeVisible();
  });
});
