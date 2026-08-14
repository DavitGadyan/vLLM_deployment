import { z } from "zod";

/**
 * Client-side validation, mirroring `backend/app/schemas/config.py`.
 *
 * This exists for immediate feedback in the form, not for enforcement — the
 * backend validates independently and is the authority. Keeping the two in
 * sync is a deliberate maintenance cost, paid so the operator sees an error on
 * the field they are typing in rather than after a round trip.
 */

export const TONES = [
  { value: "professional", label: "Professional", hint: "Clear and courteous. Safe default." },
  { value: "friendly", label: "Friendly", hint: "Warm and conversational, still professional." },
  { value: "concise", label: "Concise", hint: "Shortest answer the question allows." },
  { value: "formal", label: "Formal", hint: "Precise, no contractions." },
  { value: "empathetic", label: "Empathetic", hint: "Acknowledges the situation, then answers." },
] as const;

export const toneSchema = z.enum([
  "professional",
  "friendly",
  "concise",
  "formal",
  "empathetic",
]);

export const policySchema = z.object({
  title: z.string().trim().min(1, "Give the policy a title").max(120),
  body: z
    .string()
    .trim()
    .min(1, "A policy needs content, or it will not affect answers")
    .max(8000, "Policies over 8000 characters crowd out retrieved context"),
});

export const configSchema = z.object({
  company_name: z
    .string()
    .trim()
    .min(1, "The assistant needs a company name to represent")
    .max(200),
  agent_name: z.string().trim().min(1, "Give the assistant a name").max(120),
  support_email: z
    .string()
    .trim()
    .max(320)
    .email("Enter a valid email address")
    .or(z.literal(""))
    .nullish(),
  support_url: z
    .string()
    .trim()
    .max(500)
    .url("Enter a valid URL, including https://")
    .or(z.literal(""))
    .nullish(),

  tone: toneSchema,
  languages: z.array(z.string().trim().min(1)).max(20),
  greeting: z.string().trim().max(500).nullish(),
  signature: z.string().trim().max(500).nullish(),

  policies: z.array(policySchema).max(50),
  escalation_rules: z.string().trim().max(4000).nullish(),
  forbidden_topics: z.array(z.string().trim().min(1)).max(50),
  custom_instructions: z.string().trim().max(4000).nullish(),

  temperature: z.number().min(0).max(2).nullish(),
  max_output_tokens: z.number().int().min(64).max(4096).nullish(),
  retrieval_top_k: z.number().int().min(1).max(20).nullish(),
  retrieval_min_score: z.number().min(0).max(1).nullish(),

  change_note: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .describe("Why this changed — shown in version history"),
});

export type ConfigFormValues = z.infer<typeof configSchema>;
export type PolicyValue = z.infer<typeof policySchema>;

export const chatMessageSchema = z.object({
  message: z.string().trim().min(1).max(8000),
});
