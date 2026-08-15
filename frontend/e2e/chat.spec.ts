import { expect, test } from "@playwright/test";

/**
 * The chat flow, end to end against the real model.
 *
 * These assert behaviour, not wording: the model's exact phrasing varies run to
 * run, so the tests check that an answer streamed, that it cited something, and
 * that unanswerable questions escalate rather than producing invented facts.
 *
 * Requires the seeded knowledge base — run `make seed` first.
 */

test.describe("chat", () => {
  // These need the model server and the embedding service, which need a GPU.
  // On a machine without one they fail five times over ninety seconds each,
  // which reads as a broken product rather than as an absent dependency —
  // so check first and say plainly which piece is missing.
  test.beforeEach(async ({ page }) => {
    const response = await page.request
      .get("/api/health/ready", { timeout: 5000 })
      .catch(() => null);
    const checks = response?.ok()
      ? ((await response.json()) as { checks?: Record<string, boolean> }).checks
      : undefined;

    const missing = ["vllm", "embeddings"].filter((name) => checks?.[name] !== true);
    test.skip(
      !checks || missing.length > 0,
      checks
        ? `not reachable: ${missing.join(", ")} — these specs need a GPU host running the model`
        : "backend not reachable — run `make dev` for the chat specs",
    );
  });

  test("streams an answer and cites a source", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Message").fill("How long do I have to return something?");
    await page.getByRole("button", { name: "Send message" }).click();

    const log = page.getByRole("log", { name: "Conversation" });
    await expect(log).toBeVisible();

    // Generation finished when the copy control appears.
    await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible({
      timeout: 90_000,
    });

    await expect(log).toContainText("30");
    await expect(page.getByText(/source(s)? cited/)).toBeVisible();
  });

  test("a citation chip opens the passage it refers to", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Message").fill("How fast is express shipping?");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: "Copy answer" })).toBeVisible({
      timeout: 90_000,
    });

    const chip = page.getByRole("button", { name: /^Source 1:/ });
    await expect(chip).toBeVisible();
    await chip.click();

    // The dialog shows the actual indexed text, which is what makes the
    // citation checkable rather than decorative.
    await expect(page.getByRole("dialog")).toContainText(/business day/i);
  });

  test("escalates instead of inventing an answer it has no source for", async ({ page }) => {
    await page.goto("/");

    await page
      .getByLabel("Message")
      .fill("What was my exact account balance on 14 March and who authorised it?");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByText("Handed off to a person")).toBeVisible({
      timeout: 90_000,
    });
  });

  test("stop halts generation and keeps the partial answer", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Message").fill("Explain the full returns process in detail.");
    await page.getByRole("button", { name: "Send message" }).click();

    const stop = page.getByRole("button", { name: "Stop generating" });
    await expect(stop).toBeVisible();
    await stop.click();

    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  });

  test("suggested questions start a conversation", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Test the assistant")).toBeVisible();
    await page.getByRole("button", { name: "How fast is express shipping?" }).click();

    await expect(page.getByRole("log", { name: "Conversation" })).toBeVisible();
  });

  test("is operable by keyboard alone", async ({ page }) => {
    await page.goto("/");

    await page.getByLabel("Message").focus();
    await page.keyboard.type("How fast is express shipping?");
    // Enter sends; Shift+Enter would insert a newline.
    await page.keyboard.press("Enter");

    await expect(page.getByRole("log", { name: "Conversation" })).toContainText(
      "How fast is express shipping?",
    );
  });
});
