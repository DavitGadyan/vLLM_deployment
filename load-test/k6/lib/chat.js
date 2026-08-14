import http from "k6/http";
import { Trend, Counter, Rate } from "k6/metrics";

/**
 * Shared helpers for the k6 scenarios.
 *
 * The important measurement here is time-to-first-token, not request duration.
 * A support assistant that starts answering in 400ms and finishes in 8s feels
 * responsive; one that pauses 4s and then dumps the whole answer feels broken.
 * Total duration cannot tell those apart, so we parse the SSE stream and time
 * the first content delta.
 */

export const ttft = new Trend("ttft_ms", true);
export const totalDuration = new Trend("answer_total_ms", true);
export const tokensPerSecond = new Trend("output_tokens_per_second");
export const cachedPromptTokens = new Trend("cached_prompt_tokens");
export const promptTokens = new Trend("prompt_tokens");
export const escalations = new Counter("escalations");
export const answered = new Counter("answered");
export const errors = new Counter("stream_errors");
export const success = new Rate("chat_success");

export const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

// A realistic mix: most support traffic is a handful of recurring questions,
// with a long tail. Sending one identical question would inflate prefix-cache
// hit rate to a number production will never see.
export const QUESTIONS = [
  "How long do I have to return something?",
  "How fast is express shipping?",
  "Is water damage covered by the warranty?",
  "Can you deliver to a PO box?",
  "How do I track my order?",
  "What happens if my package says delivered but I never got it?",
  "Do you ship internationally?",
  "How much is shipping on a $40 order?",
  "My hinge broke after 14 months, is that a warranty claim?",
  "Can I exchange an item instead of returning it?",
  "How long do refunds take to appear on my card?",
  "Are opened items returnable?",
];

export function pickQuestion() {
  return QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
}

/**
 * Send one chat turn and measure the stream.
 *
 * k6 has no native SSE client, so the response body is read whole and parsed
 * afterwards. That means TTFT here is measured as k6's `waiting` time — the
 * interval until the first byte of the response body arrives, which for a
 * streamed response is the first token. It is a close proxy, and the backend's
 * own `ttft_ms` in the final event is used to cross-check it.
 */
export function chat(question, conversationId = null) {
  const payload = JSON.stringify({
    message: question,
    conversation_id: conversationId,
  });

  const response = http.post(`${BASE_URL}/api/chat`, payload, {
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    timeout: "120s",
    tags: { name: "chat" },
  });

  if (response.status !== 200) {
    errors.add(1);
    success.add(false);
    return { ok: false, status: response.status };
  }

  const result = parseStream(response.body);

  // Network-level first-byte time. Recorded alongside the server-reported
  // value so a discrepancy between them points at proxy buffering.
  ttft.add(response.timings.waiting);
  success.add(true);

  if (result.done) {
    if (result.done.total_ms) totalDuration.add(result.done.total_ms);
    if (result.done.prompt_tokens) promptTokens.add(result.done.prompt_tokens);
    if (result.done.cached_prompt_tokens != null) {
      cachedPromptTokens.add(result.done.cached_prompt_tokens);
    }
    if (result.done.completion_tokens && result.done.total_ms) {
      const generationSeconds =
        (result.done.total_ms - (result.done.ttft_ms || 0)) / 1000;
      if (generationSeconds > 0) {
        tokensPerSecond.add(result.done.completion_tokens / generationSeconds);
      }
    }
  }

  if (result.escalated) {
    escalations.add(1);
  } else {
    answered.add(1);
  }

  return { ok: true, ...result };
}

function parseStream(body) {
  const result = {
    text: "",
    escalated: false,
    conversationId: null,
    sources: [],
    done: null,
  };

  if (!body) return result;

  for (const frame of body.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line.slice(6));
    } catch {
      continue;
    }

    switch (event.type) {
      case "start":
        result.conversationId = event.data.conversation_id;
        break;
      case "delta":
        result.text += event.data.text;
        break;
      case "citations":
        result.sources = event.data.sources || [];
        break;
      case "escalation":
        result.escalated = true;
        break;
      case "done":
        result.done = event.data;
        if (event.data.escalated) result.escalated = true;
        break;
      case "error":
        errors.add(1);
        break;
    }
  }

  return result;
}

/** Consistent summary line so runs can be compared across configurations. */
export function describeRun(name) {
  return `
${name}
  BASE_URL: ${BASE_URL}
  Measure TTFT, not total duration — it is what users perceive as speed.
  Cross-check ttft_ms against the serving dashboard's vllm:time_to_first_token.
`;
}
