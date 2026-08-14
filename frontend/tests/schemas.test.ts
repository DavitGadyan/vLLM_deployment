import { describe, expect, it } from "vitest";

import { configSchema, policySchema } from "@/lib/schemas";

const valid = {
  company_name: "Northwind Supply",
  agent_name: "Ada",
  support_email: "help@northwind.example",
  support_url: "https://help.northwind.example",
  tone: "professional" as const,
  languages: ["English"],
  greeting: "",
  signature: "",
  policies: [{ title: "Refunds", body: "Full refund within 30 days." }],
  escalation_rules: "",
  forbidden_topics: [],
  custom_instructions: "",
  temperature: 0.2,
  max_output_tokens: 1024,
  retrieval_top_k: 5,
  retrieval_min_score: 0.35,
  change_note: "",
};

describe("configSchema", () => {
  it("accepts a complete configuration", () => {
    expect(configSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a company name — the assistant has to represent someone", () => {
    const result = configSchema.safeParse({ ...valid, company_name: "  " });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed support email", () => {
    expect(configSchema.safeParse({ ...valid, support_email: "not-an-email" }).success).toBe(
      false,
    );
  });

  it("allows optional contact fields to be blank", () => {
    const result = configSchema.safeParse({
      ...valid,
      support_email: "",
      support_url: "",
    });
    expect(result.success).toBe(true);
  });

  it("treats null generation overrides as 'use the default'", () => {
    const result = configSchema.safeParse({
      ...valid,
      temperature: null,
      max_output_tokens: null,
      retrieval_top_k: null,
      retrieval_min_score: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a temperature outside the model's range", () => {
    expect(configSchema.safeParse({ ...valid, temperature: 3 }).success).toBe(false);
  });

  it("rejects a relevance floor above 1", () => {
    expect(configSchema.safeParse({ ...valid, retrieval_min_score: 1.5 }).success).toBe(false);
  });
});

describe("policySchema", () => {
  it("rejects an empty body — a titled policy with no rule changes nothing", () => {
    expect(policySchema.safeParse({ title: "Refunds", body: "   " }).success).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const result = policySchema.parse({ title: "  Refunds  ", body: "  30 days.  " });
    expect(result).toEqual({ title: "Refunds", body: "30 days." });
  });
});
