/**
 * The architecture graph's content.
 *
 * Structured as the request pipeline, in the order a question actually travels:
 *
 *   User → Support Assistant → API Gateway → RAG & Skills → vLLM Server
 *        → Database → Monitoring, Security & Audit
 *
 * with Platform underneath all of it. Each stage is one card that expands into
 * its parts, so a client meets six boxes and drills into whichever matters to
 * them. The vLLM card is the one the commercial argument lives in: it opens into
 * the model itself plus KV caching, PagedAttention, prefix caching,
 * quantization, pruning and continuous batching, each with its own short
 * cost/quality benefit in the side panel.
 *
 * Every node answers four questions — what it does, why it exists, what it saves
 * the buyer, what the user feels — because a diagram of boxes and arrows explains
 * nothing to the person deciding whether to pay for it.
 *
 * Numbers are real where this repository has measured or derived them. Anything
 * not implemented is said plainly rather than implied (see `pruning`): one
 * overstated capability discredits the rest.
 *
 * Deliberately static. The Architecture tab renders with the backend stopped, so
 * a demo can never fail because a GPU is cold.
 */

import type { IconKey } from "@/lib/node-icons";

export type TierId =
  | "client"
  | "ui"
  | "gateway"
  | "context"
  | "serving"
  | "data"
  | "ops"
  | "improve"
  | "platform";

export interface Tier {
  id: TierId;
  label: string;
  blurb: string;
  color: string;
}

export const TIERS: Tier[] = [
  { id: "client", label: "User", blurb: "Where the question starts", color: "#8d99a4" },
  { id: "ui", label: "Support Assistant", blurb: "What the customer talks to", color: "#3f7a75" },
  { id: "gateway", label: "API Gateway", blurb: "Rate limiting and security", color: "#a9661b" },
  { id: "context", label: "RAG & Skills", blurb: "The facts pulled into the model", color: "#7a6ba8" },
  { id: "serving", label: "vLLM Server", blurb: "The GPU and its optimisations", color: "#c8821f" },
  { id: "data", label: "Database", blurb: "Where results are saved", color: "#5b7596" },
  { id: "ops", label: "Monitoring & Audit", blurb: "Proof it works, and evidence", color: "#b04e72" },
  {
    id: "improve",
    label: "Improvement Loop",
    blurb: "How it gets better over time",
    color: "#2f8f5b",
  },
  { id: "platform", label: "Platform", blurb: "How it scales and ships", color: "#6b7280" },
];

export interface ArchNode {
  id: string;
  label: string;
  tier: TierId;
  /** Hierarchy. The graph opens collapsed and expands on click. */
  parent?: string;
  /**
   * Position along the flow axis, for top-level stages only.
   *
   * Pinning just this one axis makes the pipeline read left to right in the
   * order a request travels, while leaving height and depth free — so it is a
   * genuine 3D graph rather than a flowchart drawn in WebGL.
   */
  flowOrder?: number;
  sub?: string;
  logo?: string;
  /**
   * Glyph drawn on the node in the 3D scene. A client scanning the graph should
   * recognise the database, the gateway and the model before reading a word —
   * shape carries further than 11px type does in a compressed recording.
   */
  icon?: IconKey;
  size?: number;

  what: string;
  whyUsed: string;
  clientBenefit: string;
  userBenefit: string;
  metric?: { value: string; caption: string; estimated?: boolean };
  demoNote: string;
}

export const ROOT_ID = "root";

export const NODES: ArchNode[] = [
  // ========================================================== 0. user
  {
    id: "customer",
    label: "User",
    tier: "client",
    parent: ROOT_ID,
    flowOrder: 0,
    sub: "asks a question",
    icon: "user",
    size: 8,
    what: "A customer with a problem — a refund, a delivery, a warranty claim — types it in their own words.",
    whyUsed:
      "The entry point. Everything downstream exists to answer this correctly, or to admit honestly that it cannot.",
    clientBenefit:
      "Every question answered here is a support ticket that never opens. Support cost scales with headcount; this does not.",
    userBenefit:
      "An answer in seconds at 2am instead of a queue position and a callback window.",
    demoNote:
      "Start here. Everything I show next happens between this question and the answer appearing.",
  },

  // ========================================================== 1. the assistant UI
  {
    id: "console",
    label: "Support Assistant",
    tier: "ui",
    parent: ROOT_ID,
    flowOrder: 1,
    sub: "chat UI · Next.js",
    logo: "nextjs",
    icon: "assistant",
    size: 9,
    what: "The assistant the customer actually talks to: streaming chat with citations, plus the operator console for configuration and monitoring.",
    whyUsed:
      "Server-side route handlers proxy every call, so the browser never learns the backend address and never holds a credential. One surface covers both the customer product and the operator tooling.",
    clientBenefit:
      "No API key can leak from a browser, because none is ever sent to one. Non-engineers change the assistant's behaviour without a deploy, and see exactly what the model will receive before saving.",
    userBenefit:
      "Answers stream token by token rather than appearing after a blank pause, each with a citation they can open and check.",
    demoNote:
      "The browser talks only to /api routes. It cannot reach the model directly at all.",
  },

  // ========================================================== 2. gateway
  {
    id: "stage-gateway",
    label: "API Gateway",
    tier: "gateway",
    parent: ROOT_ID,
    flowOrder: 2,
    sub: "rate limiting · security",
    icon: "gateway",
    size: 9,
    what: "The only public surface: TLS, rate limiting, authentication, authorization and prompt-injection detection.",
    whyUsed:
      "One entry point is one place to defend and one place to apply policy. Everything behind it sits on private IPs with no route in from outside.",
    clientBenefit:
      "Abuse is stopped at the cheapest possible point — a rejected request costs a fraction of a cent, a generated answer costs far more. Fixed cost that does not grow with traffic.",
    userBenefit:
      "One heavy or hostile user cannot degrade latency for everyone else.",
    demoNote:
      "Everything expensive sits behind this. Open it to see what gets stopped here.",
  },
  {
    id: "ingress",
    label: "TLS & load balancing",
    tier: "gateway",
    parent: "stage-gateway",
    sub: "ingress",
    icon: "gateway",
    size: 5,
    what: "Terminates TLS and spreads traffic across healthy replicas.",
    whyUsed:
      "The single public surface. Its backend timeout is set to 180s — the 30s default would cut a long answer off mid-sentence.",
    clientBenefit: "Fixed cost, independent of traffic. The cheapest component in the system.",
    userBenefit: "Requests always land on a replica that can serve them.",
    demoNote: "Small detail that matters: the timeout has to outlast the longest answer.",
  },
  {
    id: "ratelimit",
    label: "Rate limiting",
    tier: "gateway",
    parent: "stage-gateway",
    sub: "abuse control",
    icon: "gateway",
    size: 5,
    what: "Caps requests per client and rejects floods before they reach a GPU.",
    whyUsed:
      "GPU time is the most expensive resource here, so anything that can waste it is stopped at the cheapest point available.",
    clientBenefit:
      "A scripted abuser cannot run up a GPU bill. Rejection costs a fraction of a cent; generation costs meaningfully more.",
    userBenefit: "Latency stays flat when someone else misbehaves.",
    demoNote: "Cheap rejection early is what protects the expensive resource later.",
  },
  {
    id: "authn",
    label: "Authentication",
    tier: "gateway",
    parent: "stage-gateway",
    sub: "OIDC",
    icon: "shield",
    size: 5,
    what: "Establishes who is making the request before anything else happens.",
    whyUsed:
      "Every audit obligation downstream starts with an attributable actor. An action with no actor cannot evidence a control.",
    clientBenefit:
      "Required for SOC 2 access control and HIPAA access logging. Without it an audit stops at the first question.",
    userBenefit: "Their conversation and their documents stay theirs.",
    demoNote: "Identity captured here flows all the way through to the audit entry.",
  },
  {
    id: "authz",
    label: "Authorization",
    tier: "gateway",
    parent: "stage-gateway",
    sub: "RBAC",
    icon: "shield",
    size: 5,
    what: "Decides what this caller may do — chat, edit policy, upload documents.",
    whyUsed:
      "Separate from authentication on purpose: knowing who someone is says nothing about what they should be allowed to change.",
    clientBenefit:
      "A support agent cannot rewrite company policy. Keeps the blast radius of a compromised account small.",
    userBenefit: "Answers stay consistent, because not everyone can change the rules behind them.",
    demoNote: "A denied attempt is itself an audit event — attempts matter as much as successes.",
  },
  {
    id: "injection",
    label: "Prompt injection defence",
    tier: "gateway",
    parent: "stage-gateway",
    sub: "detect · count · audit",
    icon: "shield",
    size: 7,
    what: "Scans the customer's message and every retrieved passage for attempts to hijack the model's instructions.",
    whyUsed:
      "Once customers can upload documents, text inside a PDF telling the model to ignore its rules is a working attack arriving through a trusted channel. The system prompt treats retrieved content as data, never instructions; this measures how often that defence is exercised.",
    clientBenefit:
      "Turns a security claim into a number on the dashboard. Auditors ask for evidence, not assurances.",
    userBenefit:
      "The assistant cannot be talked into contradicting policy by another customer's uploaded file.",
    metric: { value: "8 patterns", caption: "scanned on input and on every retrieved chunk" },
    demoNote:
      "A payload found inside an indexed document is far worse than one a customer types — it means the knowledge base itself is poisoned.",
  },

  // ========================================================== 3. RAG & skills
  {
    id: "stage-context",
    label: "RAG & Skills",
    tier: "context",
    parent: ROOT_ID,
    flowOrder: 3,
    sub: "pulled into the model",
    icon: "brain",
    size: 9,
    what: "Finds the relevant passages from your documents, runs deterministic business logic, and compiles your policies into the prompt the model receives.",
    whyUsed:
      "The model does not know your refund policy and must not guess it. This stage supplies the facts; the model only has to phrase them.",
    clientBenefit:
      "Changing an answer means uploading a document or editing a policy — minutes, and no retraining. Runs stateless on cheap CPU, so it scales independently of the GPU.",
    userBenefit:
      "Answers reflect current policy, with a citation they can open and check.",
    demoNote:
      "This is what makes it a support agent rather than a chatbot: it answers from your documents, not from the internet.",
  },
  {
    id: "chatbot",
    label: "Agent orchestration",
    tier: "context",
    parent: "stage-context",
    sub: "one turn",
    icon: "cluster",
    size: 6,
    what: "Owns a single conversational turn: retrieve, assemble, stream, analyse, persist.",
    whyUsed:
      "Prompt compilation, retrieval, guardrails and token accounting belong in one auditable place rather than scattered across a frontend.",
    clientBenefit:
      "One place to change behaviour and one place to audit it. Holds no session state, so it scales sideways with no sticky sessions.",
    userBenefit: "Consistent behaviour regardless of which replica served them.",
    demoNote: "Stateless is a scaling prerequisite here, not a style preference.",
  },
  {
    id: "analysis",
    label: "Question analysis",
    tier: "context",
    parent: "stage-context",
    sub: "intent",
    icon: "brain",
    size: 5,
    what: "Works out what is being asked before deciding what context to fetch.",
    whyUsed:
      "Retrieving the right passage depends on understanding the question. Retrieval quality caps answer quality — no model recovers from being handed the wrong document.",
    clientBenefit:
      "Better retrieval means fewer escalations, and every avoided escalation is a support contact that never costs anything.",
    userBenefit: "Answers about the thing they actually asked about.",
    demoNote: "Everything the model gets right depends on this step choosing well.",
  },
  {
    id: "rag",
    label: "RAG retrieval",
    tier: "context",
    parent: "stage-context",
    sub: "pgvector · HNSW",
    logo: "postgres",
    icon: "brain",
    size: 7,
    what: "Embeds the question and finds the closest passages from the company's own documents.",
    whyUsed:
      "Retrieval quality caps answer quality — no model recovers from being handed the wrong document. Below a relevance floor it refuses to answer at all.",
    clientBenefit:
      "Updating an answer is a document upload, not a training run. Policy changes take minutes and cost nothing.",
    userBenefit: "Answers cite a source they can open and verify.",
    metric: { value: "0.35", caption: "relevance floor — below this it escalates instead" },
    demoNote:
      "Ask something the documents do not cover and it hands off rather than inventing.",
  },
  {
    id: "skills",
    label: "Skills & tools",
    tier: "context",
    parent: "stage-context",
    sub: "deterministic logic",
    icon: "layers",
    size: 5,
    what: "Order lookup, eligibility rules, date arithmetic — computed, not generated.",
    whyUsed:
      "Anything that can be computed should be. Asking a language model to do arithmetic it could look up is how wrong numbers reach customers.",
    clientBenefit: "Exact answers to exact questions, at no token cost and with no drift.",
    userBenefit: "Correct dates and amounts, every time.",
    demoNote: "Rules are code. Only judgement goes to the model.",
  },
  {
    id: "promptc",
    label: "Prompt compiler",
    tier: "context",
    parent: "stage-context",
    sub: "config → prompt",
    icon: "layers",
    size: 7,
    what: "Turns the settings on the Configuration tab into the exact system prompt the model receives.",
    whyUsed:
      "Deterministic, so the same configuration always produces byte-identical text. That is not tidiness — it is what makes the prefix cache possible at all.",
    clientBenefit:
      "Non-engineers change behaviour safely. Every save is a new immutable version that can be diffed and rolled back in one click.",
    userBenefit: "The assistant sounds like the company and follows its actual policies.",
    metric: { value: "~600", caption: "tokens shared by every single request" },
    demoNote:
      "Type a policy on the Configuration tab and watch this text change. That is what the model sees.",
  },
  {
    id: "guardrails",
    label: "Guardrails",
    tier: "context",
    parent: "stage-context",
    sub: "4 layers",
    icon: "shield",
    size: 6,
    what: "Compiled policy, a pre-generation gate, an escalation sentinel, and a post-answer citation check.",
    whyUsed:
      "The pre-generation gate matters most because it is deterministic: if retrieval found nothing above the floor, the model is never called. A model handed weak context will find something plausible to say.",
    clientBenefit:
      "Escalating costs one support contact. An invented refund policy costs the refund plus the trust — and the gate saves the GPU call entirely.",
    userBenefit:
      "Told honestly that a person will help, rather than given a confident answer that turns out to be wrong.",
    demoNote: "The most reliable guardrail is the one that never calls the model.",
  },
  {
    id: "embeddings",
    label: "Embeddings",
    tier: "context",
    parent: "stage-context",
    sub: "CPU, separate",
    icon: "brain",
    size: 5,
    what: "Turns documents and questions into vectors, on CPU, in its own service.",
    whyUsed:
      "Deliberately off the GPU. Ingesting a 200-page policy PDF is hundreds of embedding calls; on the serving GPU that would evict KV cache blocks and spike latency for every customer mid-conversation.",
    clientBenefit: "Cheap CPU that scales independently. Bulk uploads never compete with live traffic.",
    userBenefit: "Someone uploading a manual does not slow down the person asking a question.",
    demoNote: "Isolating these two workloads is why a bulk upload cannot disturb a live conversation.",
  },

  // ========================================================== 4. vLLM server
  {
    id: "vllm",
    label: "vLLM Server",
    tier: "serving",
    parent: ROOT_ID,
    flowOrder: 4,
    sub: "open-source model on your GPU",
    logo: "vllm",
    icon: "chip",
    size: 12,
    what: "Serves the open-source model, scheduling many conversations across one GPU at once.",
    whyUsed:
      "Self-hosting converts a per-token bill that scales with success into a fixed hourly cost that does not. Above modest volume the arithmetic stops being close.",
    clientBenefit:
      "One L4 at roughly $0.85/hour serves ~35 concurrent conversations. The same traffic on a per-token API is billed again every single month.",
    userBenefit: "Answers begin in under a second and stay that fast as usage grows.",
    metric: { value: "~$0.85/hr", caption: "one L4 GPU · ~35 conversations at once" },
    demoNote:
      "Open this card. Inside is the model itself, and the techniques that make one cheap GPU enough to serve it.",
  },
  {
    id: "model",
    label: "Qwen2.5-7B-Instruct",
    tier: "serving",
    parent: "vllm",
    sub: "INT4 W4A16 · GPTQ",
    logo: "qwen",
    icon: "chip",
    size: 9,
    what: "The model doing the answering: Qwen2.5-7B-Instruct, Alibaba's open-weight instruction-tuned 7B, compressed to 4-bit and served from your own GPU.",
    whyUsed:
      "Instruction-tuned rather than a base model, because a support assistant has to follow your policy rather than continue your text. 7B is the size where a single commodity GPU is enough and the answers are still good — 3B starts ignoring policy detail, 70B needs hardware that changes the economics entirely. Apache 2.0, so there is no per-token licence and no vendor able to deprecate it out from under you.",
    clientBenefit:
      "The weights are yours. No per-token bill, no rate limits, no model retired on someone else's schedule, and nothing about your customers leaves your own infrastructure. Swapping to a different open model later is a config change, not a rebuild.",
    userBenefit:
      "Answers grounded in your policies rather than in a general-purpose assistant's guesses, with strong multilingual coverage out of the box.",
    metric: { value: "7.6 B", caption: "parameters · Apache 2.0 · 32K context" },
    demoNote:
      "This is the specific model, and it is open weights. Point at it: nothing here is a wrapper around someone else's API.",
  },
  {
    id: "kvcache",
    label: "KV caching",
    tier: "serving",
    parent: "vllm",
    sub: "56 KiB per token",
    icon: "cache",
    size: 8,
    what: "Keeps the attention state of every live conversation on the GPU, so each new token reuses the work already done rather than reprocessing the whole conversation.",
    whyUsed:
      "Without it, generating token n means re-reading tokens 1..n-1 — quadratic cost, and answers that get slower the longer the conversation runs. With it, each token is a constant amount of new work.",
    clientBenefit:
      "How much KV fits is how many conversations fit. 56 KiB per token against ~16 GB free on a 24 GB L4 is ~292,000 tokens of cache — the number every concurrency figure here is derived from.",
    userBenefit:
      "Replies stay fast deep into a long conversation instead of degrading turn by turn.",
    metric: { value: "56 KiB", caption: "KV per token · ~16 GB free on a 24 GB L4" },
    demoNote:
      "28 layers, 4 KV heads, 128 dimensions, two bytes, times K and V. That arithmetic is in the serving entrypoint, and it is where the concurrency number comes from.",
  },
  {
    id: "pagedattention",
    label: "PagedAttention",
    tier: "serving",
    parent: "vllm",
    sub: "16-token blocks",
    icon: "cache",
    size: 8,
    what: "Stores that KV cache in fixed-size blocks drawn from a shared pool, the way an operating system pages memory, rather than one contiguous reservation per conversation.",
    whyUsed:
      "This is the idea vLLM was built around. Reserving a contiguous buffer per conversation means reserving for the worst case — a conversation that *might* reach 8192 tokens holds memory for 8192 tokens while using 300. Blocks are allocated as they fill, so the waste is at most one partial block each. It is also what makes the other two possible: prefix caching shares blocks by reference, and continuous batching lets sequences join and leave without compacting anything.",
    clientBenefit:
      "Recovers the GPU memory that per-sequence reservation would strand. That reclaimed memory is more concurrent conversations on the same card — the same lever as quantization, applied to the cache instead of the weights.",
    userBenefit:
      "Far fewer requests queued or preempted at peak, because the card is genuinely full before it runs out rather than reserved full.",
    metric: { value: "block=16", caption: "tokens per block · vLLM default, set explicitly" },
    demoNote:
      "This is the paper vLLM is named for. Virtual memory, applied to attention — and the reason one L4 holds thirty-five conversations instead of a handful.",
  },
  {
    id: "prefixcache",
    label: "Prefix caching",
    tier: "serving",
    parent: "vllm",
    sub: "--enable-prefix-caching",
    icon: "cache",
    size: 8,
    what: "Recognises that two requests begin with the same tokens and reuses the already-computed blocks instead of prefilling them again.",
    whyUsed:
      "Every conversation here opens with the same compiled system prompt — your company name, your policies, the escalation rule — around 600 tokens before the customer's question. Prefilling that once per conversation is the same work done over and over. Because the blocks are shared by reference, it is prefilled once and reused by everyone.",
    clientBenefit:
      "Removes most of the repeated prefill across concurrent conversations, and prefill is the expensive half of a short support turn. It is also why the prompt compiler is deterministic: stable content is assembled first so the shared prefix is byte-identical.",
    userBenefit:
      "The pause before the assistant starts typing largely disappears — the cached part of the prompt costs almost nothing to re-read.",
    metric: { value: "~600 tok", caption: "shared system prefix, prefilled once not per conversation" },
    demoNote:
      "This is the payoff for assembling the prompt in a fixed order, stable content first. Reorder it and the shared prefix breaks and this is worth nothing.",
  },
  {
    id: "quantized",
    label: "Quantization",
    tier: "serving",
    parent: "vllm",
    sub: "INT4 · GPTQ W4A16",
    icon: "chip",
    size: 8,
    what: "Qwen2.5-7B-Instruct compressed to 4-bit weights, served as compressed-tensors.",
    whyUsed:
      "Not primarily a memory saving. The 9.7 GB freed becomes KV cache, and KV cache is what decides how many conversations fit on the card.",
    clientBenefit:
      "5.5 GB instead of 15.2 GB — the difference between one $0.85/hour L4 and a card several times the price. The single largest cost decision in the system.",
    userBenefit:
      "Same answer quality, verified by a gate that fails the build if accuracy drops, on a fraction of the hardware.",
    metric: { value: "5.5 GB", caption: "down from 15.2 GB at full precision" },
    demoNote:
      "Compression is gated: a quality check runs against the uncompressed baseline and blocks the release if the model got worse.",
  },
  {
    id: "pruning",
    label: "Pruning",
    tier: "serving",
    parent: "vllm",
    sub: "2:4 sparsity · opt-in",
    icon: "scissors",
    size: 7,
    what: "SparseGPT 2:4 semi-structured sparsity, zeroing two of every four weights so Ampere+ sparse tensor cores can skip them.",
    whyUsed:
      "Stacks on top of INT4 for a further reduction in weights and memory traffic. The recipe ships ready to run in `model/recipes/w4a16_sparse24.yaml`.",
    clientBenefit:
      "Potentially more KV cache again on the same card — but **not enabled by default, and this is deliberate.** One-shot 2:4 on a 7B reliably costs real quality, and it costs it exactly where a support assistant cannot afford to: instruction following and faithfulness to retrieved policy. The quality gate is expected to fail it.",
    userBenefit:
      "None today. Turning it on without a recovery finetune would make answers less faithful to your policies, which is the wrong trade for support.",
    metric: { value: "opt-in", caption: "recipe ready; needs a recovery finetune to ship" },
    demoNote:
      "I am showing you the honest version: the pruning path exists and is wired, but it does not ship enabled because it would degrade answer quality without further training.",
  },
  {
    id: "batching",
    label: "Continuous batching",
    tier: "serving",
    parent: "vllm",
    sub: "scheduler",
    icon: "layers",
    size: 8,
    what: "Adds and removes conversations from the running batch every step, instead of waiting for a batch to fill.",
    whyUsed:
      "Static batching forces a choice between wasting GPU cycles and making people wait. Continuous batching refuses the trade — a new request joins on the very next step.",
    clientBenefit:
      "Keeps the GPU saturated, so the fixed hourly cost spreads across far more conversations. This is what makes the cost-per-conversation number small.",
    userBenefit: "No queue behind a batch that has not filled. Arrival time stops mattering.",
    demoNote:
      "Ten people asking at once are served in the same step, not one after another.",
  },

  // ========================================================== 5. database
  {
    id: "stage-db",
    label: "Database",
    tier: "data",
    parent: ROOT_ID,
    flowOrder: 5,
    sub: "results saved",
    logo: "postgres",
    icon: "database",
    size: 8,
    what: "PostgreSQL with pgvector: conversations and answers, document chunks and embeddings, configuration versions, and the audit trail.",
    whyUsed:
      "One database rather than a separate vector store. pgvector with an HNSW index handles a support knowledge base comfortably, and one system is one thing to secure, back up and keep consistent.",
    clientBenefit:
      "One managed database instead of two, with a single backup and restore path.",
    userBenefit: "Citations resolve instantly because the text and its vector live together.",
    demoNote: "Every answer is saved here, PII-redacted on the way in.",
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    tier: "data",
    parent: "stage-db",
    sub: "pgvector · HNSW",
    logo: "postgres",
    icon: "database",
    size: 6,
    what: "Stores conversations, messages, documents, chunk embeddings and configuration versions.",
    whyUsed:
      "HNSW over cosine distance needs no retraining as documents are added — a support corpus grows one upload at a time, and an index that silently decays until someone reindexes is an operational trap.",
    clientBenefit: "Managed Postgres is a commodity. No specialist vector database to operate.",
    userBenefit: "Retrieval stays fast as the knowledge base grows.",
    demoNote: "Conversations are stored with PII redacted on the write path, not filtered on read.",
  },
  {
    id: "artifacts",
    label: "Model registry",
    tier: "data",
    parent: "stage-db",
    sub: "versioned weights",
    icon: "archive",
    size: 5,
    what: "Compressed model weights as signed, versioned artifacts, separate from application images.",
    whyUsed:
      "Weights are 5.5 GB and change on a different schedule from code. Coupling them would make every prompt fix a multi-gigabyte push.",
    clientBenefit: "Model and application roll independently; a bad model rolls back on its own.",
    userBenefit: "A new replica starts serving in minutes rather than waiting on a download.",
    demoNote: "Model and code version separately, because they change for different reasons.",
  },

  // ========================================================== 6. observability
  {
    id: "stage-ops",
    label: "Monitoring & Audit",
    tier: "ops",
    parent: ROOT_ID,
    flowOrder: 6,
    sub: "security · proof · evidence",
    logo: "grafana",
    icon: "chart",
    size: 9,
    what: "Latency, throughput and error metrics; security detections; and an append-only, hash-chained audit log with compliance mapping.",
    whyUsed:
      "Two dashboards, because they answer different questions and can disagree — an empty knowledge base produces a perfectly healthy idle GPU and an assistant that escalates everything.",
    clientBenefit:
      "Deflection rate and cost per resolved conversation sit beside the technical metrics, so the business case stays measurable after the pilot. Audit evidence is a filter, not a project.",
    userBenefit: "Problems are caught on a dashboard rather than through complaints.",
    demoNote:
      "Open this for the audit log. Edit a row in the database and it tells you which entry was tampered with.",
  },
  {
    id: "prometheus",
    label: "Prometheus",
    tier: "ops",
    parent: "stage-ops",
    sub: "metrics",
    logo: "prometheus",
    icon: "chart",
    size: 6,
    what: "Scrapes latency, throughput, 4xx/5xx rates, KV-cache utilisation and queue depth.",
    whyUsed:
      "Queue depth in particular, because that is what autoscaling keys on. A saturated GPU pod sits at ~30% CPU while requests pile up.",
    clientBenefit:
      "Capacity is added when it is needed and removed when it is not, instead of over-provisioning permanently against a peak.",
    userBenefit: "Latency stays flat through traffic spikes.",
    demoNote: "Scaling on queue depth rather than CPU is the most important operational decision here.",
  },
  {
    id: "grafana",
    label: "Grafana",
    tier: "ops",
    parent: "stage-ops",
    sub: "dashboards",
    logo: "grafana",
    icon: "chart",
    size: 6,
    what: "Two dashboards: serving health, and product outcomes.",
    whyUsed:
      "A system can be green on every infrastructure metric and useless. Only the product dashboard shows that.",
    clientBenefit: "The business case stays measurable rather than becoming an assumption.",
    userBenefit: "Degradation is noticed and fixed before most people encounter it.",
    demoNote: "Green infrastructure with a useless product is a real state. Hence two dashboards.",
  },
  {
    id: "audit",
    label: "Audit log",
    tier: "ops",
    parent: "stage-ops",
    sub: "hash-chained",
    icon: "ledger",
    size: 8,
    what: "Append-only record of every configuration change, upload, answer, escalation and security detection — each entry hash-chained to the one before it.",
    whyUsed:
      "Any log records what happened. A hash-chained log proves it has not been edited since: altering or deleting a historical row breaks every hash after it, and the console names the entry. The database rejects UPDATE and DELETE outright.",
    clientBenefit:
      "Evidence rather than assurance. Each event names the control it serves — SOC 2 CC7.2, GDPR Art. 17, HIPAA 164.312(b).",
    userBenefit: "Their data handling is accountable, and erasure is provable rather than promised.",
    metric: { value: "SHA-256", caption: "chained · append-only enforced by the database" },
    demoNote:
      "This is the one to show a compliance buyer. Tampering is detectable, not just discouraged.",
  },
  {
    id: "logging",
    label: "Structured logging",
    tier: "ops",
    parent: "stage-ops",
    sub: "stateless",
    icon: "ledger",
    size: 5,
    what: "JSON logs with a request ID echoed back to the caller.",
    whyUsed:
      "Nothing is held in process memory, which is what lets any replica serve any request and the tier scale horizontally.",
    clientBenefit: "Horizontal scaling with no sticky sessions.",
    userBenefit: "A reported problem maps to an exact log entry rather than a day of traffic.",
    demoNote: "Stateless is a scaling prerequisite, not a style preference.",
  },
  {
    id: "alerting",
    label: "Alerting",
    tier: "ops",
    parent: "stage-ops",
    sub: "13 rules",
    icon: "chart",
    size: 5,
    what: "Rules on latency, cache saturation, queue backlog, escalation rate and ingestion failures.",
    whyUsed:
      "Every rule carries a runbook line saying what to check. An alert that leaves the on-call with nothing to do trains people to ignore the channel.",
    clientBenefit: "Degradation is caught before customers report it.",
    userBenefit: "Problems fixed before most people encounter them.",
    demoNote: "Thirteen rules, each actionable or it does not ship.",
  },

  // ========================================================== 7. improvement loop
  {
    id: "stage-improve",
    label: "Improvement Loop",
    tier: "improve",
    parent: ROOT_ID,
    flowOrder: 7,
    sub: "RLHF · feedback → training",
    icon: "loop",
    size: 9,
    what: "Turns what people say about answers into the training data for the next version of the model, and scores whether that version is actually better.",
    whyUsed:
      "A support assistant is never finished. Your policies change, your products change, and the questions customers ask drift. Without a loop that captures where the assistant was wrong, the only way to improve it is for someone to notice, guess the cause, and edit a prompt.",
    clientBenefit:
      "The assistant gets better from being used, so the deflection rate you buy in month one is a floor rather than a ceiling. Every judgement your team makes is a durable asset that stays yours — it does not improve a vendor's shared model.",
    userBenefit:
      "Answers that were unhelpful once are less likely to be unhelpful again, because someone said so and that judgement went somewhere.",
    metric: { value: "RLHF", caption: "preference collection shipped · fine-tuning operator-run" },
    demoNote:
      "This is the part that compounds. Open it — and note the honest boundary: collection is automatic, training is not.",
  },
  {
    id: "feedbackcapture",
    label: "Feedback capture",
    tier: "improve",
    parent: "stage-improve",
    sub: "thumbs · comments",
    icon: "thumb",
    size: 6,
    what: "Controls under every answer: helpful or not, plus an optional note saying why.",
    whyUsed:
      "The cheapest possible signal, gathered at the one moment the judgement is free — when someone has just read the answer and already has an opinion. Ask later and you get recall, not judgement.",
    clientBenefit:
      "Costs nothing to collect and immediately shows *which* answers are failing, so effort goes to the questions that are actually going wrong rather than the ones someone happened to notice.",
    userBenefit:
      "Saying an answer was wrong actually does something, instead of disappearing into a form.",
    metric: { value: "±1", caption: "thumbs, not a 1-5 scale — the middle carries no signal" },
    demoNote:
      "Notice the comment is PII-redacted before it is stored. This table becomes training data, and training data leaves the building.",
  },
  {
    id: "abcompare",
    label: "Side-by-side A/B",
    tier: "improve",
    parent: "stage-improve",
    sub: "same question, two answers",
    icon: "compare",
    size: 7,
    what: "Answers one question twice under different settings and asks a person which is better.",
    whyUsed:
      "Comparisons are far more reliable than ratings. Asked to score one answer out of five people disagree wildly; asked which of two is better they mostly agree. It also removes the confound — both sides get identical retrieved context, so the judgement is about the model, not about which side got luckier documents.",
    clientBenefit:
      "This is how a proposed change is proven before it ships. A win rate near 50% says the change is noise and saves you from adopting it; well above says it is real.",
    userBenefit:
      "Changes reach customers only after being judged better by a person, rather than because a metric moved.",
    metric: { value: "2×", caption: "generations per question — an operator tool, not the customer path" },
    demoNote:
      "Two answers, one shared context, and the cost is stated plainly: this spends twice the GPU time, which is why it is not on the customer path.",
  },
  {
    id: "preferences",
    label: "Preference dataset",
    tier: "improve",
    parent: "stage-improve",
    sub: "prompt · chosen · rejected",
    icon: "archive",
    size: 7,
    what: "The accumulated judgements, stored as the exact triple a preference-training run consumes.",
    whyUsed:
      "Stored denormalised and versioned on purpose. The exported example must be precisely what the annotator saw, and it has to survive the conversation being deleted under retention — reconstructing it later would silently pick up whatever the prompt had become in the meantime.",
    clientBenefit:
      "This is the asset. Ten thousand judgements about *your* policies are worth more than any general-purpose model, they compound, and unlike a vendor's fine-tune they remain yours if you change model entirely.",
    userBenefit:
      "Indirect, and real: the model is corrected on the questions your customers actually ask rather than on a public benchmark.",
    metric: { value: "JSONL", caption: "DPO format — no conversion step to drift out of sync" },
    demoNote:
      "Export is resumable: rows are marked consumed, so the same preference is never trained on twice and quietly over-weighted.",
  },
  {
    id: "scoring",
    label: "Answer scoring",
    tier: "improve",
    parent: "stage-improve",
    sub: "approval · win rate",
    icon: "chart",
    size: 7,
    what: "Continuous measurement of how the current model is judged: approval rate, head-to-head win rate, and where the negatives cluster.",
    whyUsed:
      "Serving metrics say the GPU is healthy. They say nothing about whether the answers are good, and those two can move in opposite directions — a faster model that is worse looks like an improvement on every latency chart.",
    clientBenefit:
      "Quality becomes a number you can put next to the cost number, so a change that saves money by degrading answers is visible at the time rather than in a churn report.",
    userBenefit:
      "A drop in answer quality is caught by a chart rather than by customers giving up.",
    metric: { value: "never seeded", caption: "this panel shows real judgements or nothing at all" },
    demoNote:
      "The one dashboard panel with no demo mode. Every other section falls back to synthetic data; inventing feedback would be inventing what your customers said.",
  },
  {
    id: "finetune",
    label: "DPO fine-tuning",
    tier: "improve",
    parent: "stage-improve",
    sub: "LoRA · operator-run",
    icon: "chip",
    size: 7,
    what: "The training step that folds collected preferences into the model — Direct Preference Optimization over a LoRA adapter.",
    whyUsed:
      "DPO rather than classic RLHF because it trains directly on preference pairs with no separate reward model and no PPO loop — far less machinery to get wrong for the same signal. LoRA rather than full fine-tuning because an adapter is a few hundred MB, trains on the same class of GPU that serves, and can be detached instantly if it turns out worse.",
    clientBenefit:
      "Adapting the model costs hours on one GPU rather than a training cluster, and rollback is unloading a file rather than a redeploy.",
    userBenefit:
      "The assistant stops repeating the specific mistakes people took the trouble to flag.",
    metric: { value: "operator-run", caption: "recipe shipped; training is a deliberate step, not automatic" },
    demoNote:
      "Be straight about this one: the collection loop runs continuously, the training does not. A fine-tune that fires automatically on unread data is how you ship a regression nobody chose.",
  },
  {
    id: "evalgate",
    label: "Promotion gate",
    tier: "improve",
    parent: "stage-improve",
    sub: "beat the incumbent or stay",
    icon: "shield",
    size: 7,
    what: "The check a newly trained adapter must pass before it can serve traffic. It is benchmarked on quality and on speed, compared against the model currently in production, and promoted only if it has not regressed on either.",
    whyUsed:
      "Preference training reliably improves the thing it was trained on and can quietly damage everything else. Same gate already used for quantization — a compressed or fine-tuned model ships only if it is measurably not worse.",
    clientBenefit:
      "Continuous improvement without continuous risk. The worst realistic outcome of a bad training run is a rejected adapter and some wasted GPU hours, not a degraded assistant in front of customers.",
    userBenefit:
      "No update reaches a customer without having beaten what it replaces, on both answer quality and response speed.",
    metric: { value: "2 axes", caption: "quality and performance — either one failing blocks it" },
    demoNote:
      "The loop closes here, and it closes safely: collect, train, prove it is better on both axes, then promote. Skipping that third step is how models quietly get worse.",
  },
  {
    id: "lmeval",
    label: "Quality benchmark",
    tier: "improve",
    parent: "evalgate",
    sub: "lm_eval · ifeval · arc · gsm8k",
    icon: "brain",
    size: 6,
    what: "Runs lm_eval over the candidate — instruction following, reasoning, arithmetic — plus a held-out support suite that checks it still answers from your policy and still escalates rather than inventing facts.",
    whyUsed:
      "Answers the question 'is it still smart'. Benchmarks are compared as a delta against the model being replaced, because the absolute score matters far less than the direction of travel. The support suite is different: those are absolute floors, since a model that ignores your supplied policy is unshippable whatever it scored on a public benchmark.",
    clientBenefit:
      "The accuracy corner of the cost/performance/accuracy triangle, made into a number that can block a release. Instruction-following is held to the tightest bound of all, because it is the one that actually predicts support quality.",
    userBenefit:
      "A model that started ignoring instructions or inventing policy details never reaches a customer.",
    metric: { value: "1.5 pts", caption: "max drop on instruction following before the gate fails" },
    demoNote:
      "Note the support suite is assertion-based, not LLM-judged. A gate that blocks releases has to be deterministic — an LLM judge would add its own variance to the signal being measured.",
  },
  {
    id: "guidellm",
    label: "Performance benchmark",
    tier: "improve",
    parent: "evalgate",
    sub: "GuideLLM · TTFT · throughput",
    icon: "chart",
    size: 6,
    what: "Drives GuideLLM at a realistic request rate against a server hosting the candidate, and measures time-to-first-token, inter-token latency and tokens per second.",
    whyUsed:
      "Answers the question 'is it still fast', which lm_eval cannot. The two genuinely come apart: an adapter that improves answers can add per-token latency, and a change that speeds up generation can cost accuracy. A gate that asks only one question ships the other regression.",
    clientBenefit:
      "Throughput is cost. Fewer tokens per second on the same GPU is directly a higher cost per conversation, so a 15% throughput drop is caught as a budget regression rather than discovered on an invoice.",
    userBenefit:
      "Nothing ships that makes the assistant feel slower. Inter-token latency has a hard ceiling — past roughly 80ms, streaming stops reading as typing and starts reading as stuttering.",
    metric: { value: "≤20%", caption: "allowed p95 TTFT increase · measured through the real serving path" },
    demoNote:
      "Benchmarked against a running server, not an in-process engine — including the scheduler, batching and HTTP. An in-process benchmark measures a configuration nobody actually runs.",
  },

  // ========================================================== 8. platform
  {
    id: "stage-platform",
    label: "Platform",
    tier: "platform",
    parent: ROOT_ID,
    flowOrder: 8,
    sub: "Kubernetes · scaling",
    logo: "kubernetes",
    icon: "cluster",
    size: 8,
    what: "Kubernetes running every service, autoscaling on GPU queue depth, and a gated path from staging to production.",
    whyUsed:
      "CPU and GPU pools scale completely differently — a web pod starts in seconds, a vLLM replica takes minutes to load weights and capture CUDA graphs — so they are separated.",
    clientBenefit:
      "The expensive resource is sized against real demand rather than permanently over-provisioned against a peak.",
    userBenefit: "Latency holds through spikes; rollouts cause no downtime.",
    demoNote: "If you take one operational point away: never autoscale GPU inference on CPU.",
  },
  {
    id: "k8s",
    label: "Kubernetes",
    tier: "platform",
    parent: "stage-platform",
    sub: "GKE",
    logo: "kubernetes",
    icon: "cluster",
    size: 6,
    what: "Runs every service, handles rollouts, restarts and scheduling across CPU and GPU node pools.",
    whyUsed:
      "Separate node pools so a cheap frontend pod cannot pin an expensive GPU node alive.",
    clientBenefit: "GPU nodes scale independently of web traffic.",
    userBenefit: "Rolling updates with no downtime; failed pods replaced automatically.",
    demoNote: "Two pools, because the two workloads become ready on completely different timescales.",
  },
  {
    id: "hpa",
    label: "Autoscaling",
    tier: "platform",
    parent: "stage-platform",
    sub: "on queue depth",
    icon: "layers",
    size: 6,
    what: "Adds vLLM replicas based on how many requests are waiting, not on CPU utilisation.",
    whyUsed:
      "The mistake almost everyone makes. Inference pods block on the accelerator, not on compute, so CPU stays low while latency climbs and a CPU-target autoscaler sits idle through the whole incident.",
    clientBenefit:
      "Instant scale up, ten-minute scale down — asymmetric on purpose, because a replica takes minutes to start.",
    userBenefit: "Latency holds during a spike instead of degrading until someone notices.",
    metric: { value: "queue depth", caption: "not CPU — CPU would never trigger" },
    demoNote: "Do not autoscale GPU inference on CPU. This is the single most reusable point here.",
  },
  {
    id: "envs",
    label: "Staging → production",
    tier: "platform",
    parent: "stage-platform",
    sub: "gated promotion",
    icon: "archive",
    size: 5,
    what: "Separate environments from the same infrastructure code, promoted through a reviewed pipeline.",
    whyUsed:
      "Model compression, prompt changes and infrastructure changes all need somewhere to be wrong first.",
    clientBenefit: "Change-management evidence for SOC 2, and a rollback that works.",
    userBenefit: "Changes arrive tested rather than discovered in production.",
    demoNote:
      "Migrations run as a pre-upgrade hook that blocks the release rather than letting pods start against a missing schema.",
  },
];

export interface ArchLink {
  source: string;
  target: string;
  /**
   * `tree` is containment. `request` is the live path a question takes.
   * `context` is retrieval being pulled *into* the model. The rest support.
   */
  kind: "tree" | "request" | "context" | "data" | "observe" | "improve" | "platform";
  label?: string;
}

/**
 * The pipeline.
 *
 * Written at leaf level and rolled up to whichever ancestor is visible, so the
 * same edges describe the flow whether the graph is collapsed to six cards or
 * fully expanded.
 */
export const LINKS: ArchLink[] = [
  // Client → Gateway
  { source: "customer", target: "console", kind: "request" },
  { source: "console", target: "ingress", kind: "request" },

  // Inside the gateway
  { source: "ingress", target: "ratelimit", kind: "request" },
  { source: "ratelimit", target: "authn", kind: "request" },
  { source: "authn", target: "authz", kind: "request" },
  { source: "authz", target: "injection", kind: "request" },

  // Gateway → RAG & Skills
  { source: "injection", target: "chatbot", kind: "request" },

  // Inside RAG & Skills
  { source: "chatbot", target: "analysis", kind: "request" },
  { source: "analysis", target: "rag", kind: "request" },
  { source: "rag", target: "skills", kind: "request" },
  { source: "skills", target: "promptc", kind: "request" },
  { source: "promptc", target: "guardrails", kind: "request" },
  { source: "rag", target: "embeddings", kind: "context" },

  // RAG & Skills → vLLM: the retrieved facts and compiled policy are pulled in
  { source: "guardrails", target: "vllm", kind: "context" },
  { source: "promptc", target: "kvcache", kind: "context" },

  // Inside the vLLM card
  { source: "vllm", target: "kvcache", kind: "request" },
  { source: "vllm", target: "quantized", kind: "request" },
  { source: "vllm", target: "pruning", kind: "request" },
  { source: "vllm", target: "batching", kind: "request" },

  // vLLM → Database
  { source: "vllm", target: "postgres", kind: "request" },
  { source: "quantized", target: "artifacts", kind: "data" },
  { source: "rag", target: "postgres", kind: "data" },
  { source: "promptc", target: "postgres", kind: "data" },
  { source: "embeddings", target: "postgres", kind: "data" },

  // Database → Monitoring, Security, Audit
  { source: "postgres", target: "audit", kind: "observe" },
  { source: "chatbot", target: "logging", kind: "observe" },
  { source: "injection", target: "audit", kind: "observe" },
  { source: "authz", target: "audit", kind: "observe" },
  { source: "vllm", target: "prometheus", kind: "observe" },
  { source: "chatbot", target: "prometheus", kind: "observe" },
  { source: "logging", target: "prometheus", kind: "observe" },
  { source: "prometheus", target: "grafana", kind: "observe" },
  { source: "prometheus", target: "alerting", kind: "observe" },

  // Platform underneath
  { source: "prometheus", target: "hpa", kind: "platform" },
  { source: "hpa", target: "k8s", kind: "platform" },
  { source: "k8s", target: "vllm", kind: "platform" },
  { source: "k8s", target: "chatbot", kind: "platform" },
  { source: "artifacts", target: "envs", kind: "platform" },
  { source: "envs", target: "k8s", kind: "platform" },

  // The improvement loop. Reads what happened, and writes back to the model —
  // the only edge in the diagram that returns upstream, which is the point: it
  // is what makes this a loop rather than a pipeline.
  { source: "audit", target: "feedbackcapture", kind: "improve" },
  { source: "postgres", target: "feedbackcapture", kind: "improve" },
  { source: "console", target: "feedbackcapture", kind: "improve" },
  { source: "feedbackcapture", target: "preferences", kind: "improve" },
  { source: "abcompare", target: "preferences", kind: "improve" },
  { source: "vllm", target: "abcompare", kind: "improve" },
  { source: "preferences", target: "finetune", kind: "improve" },
  { source: "feedbackcapture", target: "scoring", kind: "improve" },
  { source: "scoring", target: "grafana", kind: "observe" },
  { source: "finetune", target: "evalgate", kind: "improve" },
  { source: "evalgate", target: "artifacts", kind: "improve" },
  { source: "evalgate", target: "vllm", kind: "improve", label: "promoted model" },
];

/**
 * The recorded walkthrough — the pipeline in the order a request travels,
 * pausing inside the vLLM card for the four optimisations that pay for it.
 */
export interface TourStop {
  nodeId: string;
  chapter: string;
  say: string;
}

export const TOUR: TourStop[] = [
  {
    nodeId: "customer",
    chapter: "1 · The question",
    say: "A customer asks something at 2am. Everything from here is what happens before they see an answer.",
  },
  {
    nodeId: "console",
    chapter: "2 · The assistant",
    say: "This is what they talk to. It streams the answer back with citations — and it cannot reach the model directly, only our own API.",
  },
  {
    nodeId: "stage-gateway",
    chapter: "3 · The front door",
    say: "One public surface. Rate limiting and authentication, and every request scanned for prompt injection before it costs a penny of GPU.",
  },
  {
    nodeId: "injection",
    chapter: "4 · Treating input as hostile",
    say: "Text inside an uploaded PDF telling the model to ignore its rules is a real attack. We detect it, count it, and audit it.",
  },
  {
    nodeId: "stage-context",
    chapter: "5 · Finding the facts",
    say: "The model does not know your refund policy. This stage finds it in your documents and compiles your rules into the prompt — no retraining.",
  },
  {
    nodeId: "guardrails",
    chapter: "6 · Knowing when to stop",
    say: "If retrieval found nothing good enough, the model is never called. Escalating costs one contact; an invented policy costs the refund and the trust.",
  },
  {
    nodeId: "vllm",
    chapter: "7 · Serving it yourself",
    say: "One GPU at roughly $0.85 an hour. A per-token API bills you again every month; this does not. Open the card — the model is inside, and the techniques that make it fit.",
  },
  {
    nodeId: "model",
    chapter: "8 · The model",
    say: "Qwen2.5-7B-Instruct. Open weights, Apache 2.0, running on your hardware — so there is no per-token bill, no rate limit, and no customer data leaving your infrastructure. Seven billion parameters is the size where one commodity GPU is enough and the answers are still good.",
  },
  {
    nodeId: "quantized",
    chapter: "9 · Quantization",
    say: "Four-bit weights: 5.5 GB instead of 15.2. That 9.7 GB freed is what pays for everything in the next two stops.",
  },
  {
    nodeId: "kvcache",
    chapter: "10 · KV caching",
    say: "The freed memory becomes KV cache: 56 KiB per token, about 292,000 tokens of it. That is where the figure of 35 concurrent conversations comes from.",
  },
  {
    nodeId: "pagedattention",
    chapter: "11 · PagedAttention",
    say: "This is the idea vLLM is named for. KV lives in 16-token blocks from a shared pool instead of one reservation per conversation — so a conversation that might reach 8,000 tokens no longer holds memory for 8,000 while using 300.",
  },
  {
    nodeId: "prefixcache",
    chapter: "12 · Prefix caching",
    say: "Every conversation opens with the same 600-token system prompt. Because the blocks are shared by reference, it is prefilled once for everyone rather than once each — which is why the prompt is assembled in a fixed order.",
  },
  {
    nodeId: "batching",
    chapter: "13 · Continuous batching",
    say: "Requests join the running batch on the very next step. Nobody waits for a batch to fill, so the GPU is never idle.",
  },
  {
    nodeId: "pruning",
    chapter: "14 · Pruning, honestly",
    say: "The pruning path is built and ready. It is off by default, because one-shot 2:4 sparsity costs answer quality — I would rather show you the honest version.",
  },
  {
    nodeId: "stage-db",
    chapter: "15 · Saving the result",
    say: "Every answer is stored with PII redacted on the way in — not filtered on the way out, which is a step someone can forget.",
  },
  {
    nodeId: "audit",
    chapter: "16 · Proving all of it",
    say: "Every action, hash-chained. Edit a row in the database and the console tells you exactly which entry was tampered with.",
  },
  {
    nodeId: "stage-improve",
    chapter: "17 · Getting better",
    say: "Everything so far describes an assistant that stays the same. This is the part that compounds: every judgement your team makes about an answer becomes training data for the next version.",
  },
  {
    nodeId: "abcompare",
    chapter: "18 · Judging by comparison",
    say: "The same question, answered two ways, with identical retrieved context — so the choice is about the model, not about which side got better documents. People are far more reliable comparing two answers than scoring one.",
  },
  {
    nodeId: "finetune",
    chapter: "19 · Training on it, deliberately",
    say: "Preferences export straight into a DPO run over a LoRA adapter — hours on one GPU, and rollback is unloading a file. Note that this step is operator-run, not automatic: a fine-tune that fires on unread data is how you ship a regression nobody chose.",
  },
  {
    nodeId: "evalgate",
    chapter: "20 · Only if it is better",
    say: "The new adapter has to beat the model it replaces before it serves a single customer — measured on two axes, because quality and speed come apart. Same gate that blocks a bad quantization. That is what makes continuous improvement safe rather than merely continuous.",
  },
  {
    nodeId: "lmeval",
    chapter: "21 · Is it still smart",
    say: "lm_eval on instruction following, reasoning and arithmetic, compared against the model in production — plus a held-out support suite checking it still answers from your policy and still escalates instead of inventing. Instruction following gets the tightest bound: a point and a half.",
  },
  {
    nodeId: "guidellm",
    chapter: "22 · Is it still fast",
    say: "GuideLLM against a real server at a realistic request rate. A fine-tune that improves answers can still add latency, and fewer tokens per second on the same GPU is directly a higher cost per conversation. Twenty percent slower on first token and it does not ship.",
  },
  {
    nodeId: "stage-platform",
    chapter: "23 · Scaling it",
    say: "Scale on queue depth, never CPU. A saturated GPU pod sits at 30% CPU while latency climbs — CPU autoscaling would never fire.",
  },
];

export const NODE_BY_ID = new Map(NODES.map((n) => [n.id, n]));
export const TIER_BY_ID = new Map(TIERS.map((t) => [t.id, t]));

/** Children of each node, in declaration order. */
export const CHILDREN_BY_PARENT = new Map<string, ArchNode[]>();
for (const node of NODES) {
  if (!node.parent) continue;
  const siblings = CHILDREN_BY_PARENT.get(node.parent) ?? [];
  siblings.push(node);
  CHILDREN_BY_PARENT.set(node.parent, siblings);
}

export function hasChildren(id: string): boolean {
  return (CHILDREN_BY_PARENT.get(id)?.length ?? 0) > 0;
}

/** Every ancestor of `id`, nearest first — used to expand a tour target. */
export function ancestorsOf(id: string): string[] {
  const chain: string[] = [];
  let current = NODE_BY_ID.get(id)?.parent;
  while (current) {
    chain.push(current);
    current = NODE_BY_ID.get(current)?.parent;
  }
  return chain;
}

/** Parent→child edges, drawn so expanded children stay attached to their card. */
export const TREE_LINKS: ArchLink[] = NODES.filter((n) => n.parent).map((n) => ({
  source: n.parent as string,
  target: n.id,
  kind: "tree" as const,
}));

/** Stages in pipeline order — the spine of the diagram. */
export const STAGES = NODES.filter((n) => n.flowOrder !== undefined).sort(
  (a, b) => (a.flowOrder ?? 0) - (b.flowOrder ?? 0),
);
