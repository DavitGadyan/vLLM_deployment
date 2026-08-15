import { expect, test, type Page } from "@playwright/test";

/**
 * The focused component's name. Scoped to level 2 because the panel's four
 * rationale sections are headings too — an unscoped `getByRole("heading")`
 * matches five elements and fails on strict mode rather than on the app.
 */
const panelTitle = (page: Page) =>
  page.locator("aside").getByRole("heading", { level: 2 });

/**
 * The demo surface: three tabs, the architecture graph, and the guided tour.
 *
 * These are the paths that get recorded, so they are worth testing directly.
 * A broken tour discovered mid-take is expensive in a way a broken unit is not.
 *
 * The architecture tests deliberately run **without requiring a backend** — that
 * tab is static by design, and this suite is what proves the claim rather than
 * merely asserting it in a README.
 */

test.describe("navigation", () => {
  test("has exactly the three specified tabs", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Product" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Architecture" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Monitoring" })).toBeVisible();
  });

  test("Product stays highlighted across its sub-views", async ({ page }) => {
    // Configuration and Knowledge Base are part of the product, not siblings of
    // it. The top nav should not appear to jump elsewhere when you open them.
    for (const path of ["/", "/config", "/knowledge"]) {
      await page.goto(path);
      await expect(
        page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
          name: "Product",
        }),
      ).toHaveAttribute("aria-current", "page");
    }
  });

  test("sub-navigation appears only inside Product", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("navigation", { name: "Product" })).toBeVisible();

    // Architecture and Monitoring are full-bleed views; a second bar would crowd
    // them and eat vertical space in the recording.
    await page.goto("/architecture");
    await expect(page.getByRole("navigation", { name: "Product" })).toHaveCount(0);
  });
});

test.describe("architecture tab", () => {
  test("renders a WebGL scene", async ({ page }) => {
    await page.goto("/architecture");
    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible({ timeout: 20_000 });

    const hasContext = await canvas.evaluate(
      (el) => !!((el as HTMLCanvasElement).getContext("webgl2") ||
                 (el as HTMLCanvasElement).getContext("webgl")),
    );
    expect(hasContext).toBe(true);
  });

  test("the guided tour walks the cost argument in order", async ({ page }) => {
    await page.goto("/architecture");
    await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /Guided tour/ }).click();
    await expect(page.getByText("1 / 23")).toBeVisible();

    // Step 1 is the customer's question — the tour must open on the problem,
    // not on the technology.
    await expect(panelTitle(page)).toHaveText("User");

    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: /Next/ }).click();
    }

    // Stop 7 is the vLLM card, where the commercial argument lives.
    await expect(page.getByText("7 / 23")).toBeVisible();
    await expect(panelTitle(page)).toHaveText("vLLM Server");
    // The commercial claim has to be on screen, not just in the data file.
    await expect(page.locator("aside")).toContainText("$0.85");
  });

  test("the assistant stop shows a worked example, and names the model", async ({
    page,
  }) => {
    // Two things a client asks that a box-and-arrow diagram cannot answer: what
    // does it look like, and what is actually running. Both have to be on screen
    // rather than only in the data file.
    await page.goto("/architecture");
    await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /Guided tour/ }).click();
    await page.getByRole("button", { name: "Next →" }).click();

    const panel = page.locator("aside");
    await expect(panelTitle(page)).toHaveText("Support Assistant");
    await expect(panel).toContainText("Example exchange");
    await expect(panel).toContainText("Handed off to a person");

    // Stop 8 is the model itself.
    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: "Next →" }).click();
    }
    await expect(page.getByText("8 / 23")).toBeVisible();
    await expect(panelTitle(page)).toHaveText("Qwen2.5-7B-Instruct");
    await expect(panel).toContainText("W4A16");
  });

  test("arrow keys drive the tour", async ({ page }) => {
    // The presenter needs to advance while talking, without hunting for a button.
    await page.goto("/architecture");
    await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /Guided tour/ }).click();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("2 / 23")).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByText("1 / 23")).toBeVisible();
  });

  test("clicking a component shows its cost and quality rationale", async ({ page }) => {
    await page.goto("/architecture");
    await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: /Guided tour/ }).click();
    const panel = page.locator("aside");

    await expect(panel).toContainText("What it does");
    await expect(panel).toContainText("Why it is used");
    await expect(panel).toContainText("Client benefit");
    await expect(panel).toContainText("User benefit");
  });

  test("tier filters cannot empty the scene", async ({ page }) => {
    // An empty canvas reads as a crash rather than as a filter, so the last
    // visible tier must refuse to switch off.
    await page.goto("/architecture");
    await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });

    const stages = [
      "User",
      "Support Assistant",
      "API Gateway",
      "RAG & Skills",
      "vLLM Server",
      "Database",
      "Monitoring & Audit",
      "Platform",
    ];
    for (const tier of stages) {
      await page.getByRole("button", { name: tier, exact: true }).click();
    }

    const pressed = await page
      .getByRole("button", { pressed: true })
      .count();
    expect(pressed).toBeGreaterThan(0);
  });
});

test.describe("monitoring tab", () => {
  // Unlike Architecture, this tab genuinely needs the backend — it is reading
  // real endpoints. Skipping with a clear reason beats four identical 15-second
  // timeouts that look like product bugs.
  test.beforeEach(async ({ page }) => {
    const response = await page
      .request.get("/api/dashboard/quality", { timeout: 5000 })
      .catch(() => null);
    test.skip(
      !response?.ok(),
      "backend not reachable — run `make dev` for the monitoring specs",
    );
  });

  test("labels its data source honestly", async ({ page }) => {
    await page.goto("/monitoring");

    // With no Prometheus configured the API returns `source: "demo"` and the UI
    // must say so. Silently showing plausible synthetic numbers during a sales
    // demo is the failure this badge exists to prevent.
    const badge = page.getByText(/Live data|Demo data/).first();
    await expect(badge).toBeVisible({ timeout: 15_000 });
  });

  test("has all four sections", async ({ page }) => {
    await page.goto("/monitoring");
    for (const section of ["Quality", "Performance", "Security", "Audit"]) {
      await expect(page.getByRole("tab", { name: new RegExp(section) })).toBeVisible({
        timeout: 15_000,
      });
    }
  });

  test("the audit tab reports hash-chain status", async ({ page }) => {
    await page.goto("/monitoring");
    await page.getByRole("tab", { name: /Audit/ }).click();

    // The chain verdict is the claim that turns the log from assurance into
    // evidence, so it must be stated, not implied.
    await expect(page.getByText(/Hash chain intact|Tampering detected/)).toBeVisible({
      timeout: 15_000,
    });
  });
});
