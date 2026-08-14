# Customer Support Assistant on vLLM

A retrieval-grounded customer support assistant: Qwen2.5-7B-Instruct compressed
to INT4, served by vLLM with paged KV cache and continuous batching, behind a
Next.js console where an operator sets the company name, brand voice and
policies — and the answers actually change to match.

Deployed to GKE with Terraform, autoscaled on GPU queue depth, and instrumented
so you can tell the difference between "the GPU is healthy" and "the assistant
is useful".

---

## The idea that shapes everything else

For support chat, the expensive part is prefill, and **nearly every request
shares the same prefix**: the compiled company system prompt.

vLLM caches KV blocks by token prefix. Two requests share cached computation for
exactly as long as their token sequences are identical, and diverge permanently
at the first differing token. So the prompt is assembled in one specific order:

```
1. compiled system prompt   identical for every request  -> always cache hit
2. retrieved context        varies per question           -> diverges here
3. conversation history     varies per conversation
4. current user turn        most volatile, always last
```

That is ~600 tokens of prefill that every concurrent conversation gets for free.
Putting retrieval first, or injecting a timestamp or customer name into the
system prompt, would move divergence to token ~1 and cost the entire cache.

This is why the prompt compiler is deterministic, why config versions are
immutable and materialised, and why history is trimmed by dropping whole turns
rather than summarising them. `backend/tests/test_assembler.py` asserts the
ordering so a refactor cannot quietly reverse it.

---

## Architecture

```
Browser
  │  never sees the model endpoint or any credential
  ▼
Next.js 16 console ── route handlers proxy server-side, SSE passthrough
  │
  ▼
FastAPI gateway ──── asyncpg ────► Postgres 16 + pgvector
  │                                 config versions, documents,
  │                                 chunks + embeddings, conversations
  ├── OpenAI-compatible HTTP ─────► vLLM · Qwen2.5-7B-Instruct W4A16 · L4
  └── OpenAI-compatible HTTP ─────► embeddings · bge-small-en-v1.5 · CPU
```

**Why a gateway instead of calling vLLM from Next.js.** Prompt compilation,
retrieval, guardrails, token accounting and PII redaction all belong in one
auditable place, and the model endpoint must never be reachable from the
internet. A NetworkPolicy restricts vLLM to backend pods only — bypassing the
gateway would bypass every guardrail with it.

**Why embeddings run on CPU.** Ingesting a 200-page policy PDF is a burst of
hundreds of embedding calls. On the serving GPU that would evict KV cache blocks
and spike latency for every customer mid-conversation.

---

## Repository layout

| Path | What it is |
|---|---|
| `model/` | INT4 compression pipeline and the quality gate that blocks bad artifacts |
| `serving/` | vLLM image and the tuned entrypoint (all serving knobs in one file) |
| `backend/` | FastAPI gateway — prompt compiler, retrieval, guardrails, metrics |
| `frontend/` | Next.js console — chat, configuration, knowledge base |
| `deploy/helm/` | Charts for vllm, backend, frontend, embeddings |
| `infra/terraform/` | GCP modules plus `envs/dev` and `envs/prod` |
| `observability/` | Grafana dashboards, alert rules, prometheus-adapter config |
| `load-test/` | k6 scenarios that produce the tuning numbers |

---

## Quick start

You need a Linux machine with an NVIDIA GPU (24 GB is enough) and Docker with
the NVIDIA container runtime.

```bash
cp .env.example .env          # review it — VLLM_BASE_URL can point at a remote GPU box

# 1. Compress the model (~30-60 min on one L4/A10)
make calibration
make quantize
make evaluate                 # quality gate — the artifact does not ship if this fails

# 2. Bring up the stack
make dev                      # postgres + embeddings + vllm + backend + frontend
make seed                     # demo company config and sample knowledge base

# 3. Open http://localhost:3000
```

Developing from a machine without a GPU: point `VLLM_BASE_URL` at your GPU box
and run `make dev-no-gpu`.

---

## The compression pipeline

`Qwen/Qwen2.5-7B-Instruct` → INT4 `compressed-tensors` via GPTQ.

| | bf16 | **W4A16 (shipped)** | FP8 W8A8 |
|---|---|---|---|
| Weights | ~15.2 GB | **~5.5 GB** | ~8.0 GB |
| KV cache left on a 24 GB L4 | does not fit | **~16 GB** | ~13 GB |
| Minimum GPU | A100 40 GB | **L4 24 GB** | L40S / H100 |

The memory freed by 4-bit weights is not the goal in itself — it becomes KV
cache, and KV cache determines how many conversations vLLM can hold in flight at
once. Qwen2.5-7B costs 56 KiB per token of KV at fp16 (28 layers × 4 GQA KV
heads × 128 dim × 2 for K+V × 2 bytes), so ~16 GB is roughly 290,000 tokens —
about 35 concurrent 8K-context conversations, versus not fitting at all.

Calibration uses support-domain text rather than generic web text, because GPTQ
picks quantization scales by minimising error on the tokens it sees. Pointing
`--local-dir` at your own policy documents is the highest-leverage option here:
those tokens appear in every production prompt.

**The quality gate** (`model/evaluate.py`) measures two different things.
Academic benchmarks (`ifeval`, `arc_challenge`, `gsm8k`) catch capability damage
and are gated as a delta against FP16. A support behaviour suite is gated on
absolute floors, because some failures are unshippable regardless of the
baseline: does it answer from the supplied policy, does it escalate instead of
inventing a refund window, does it treat instructions embedded inside an
uploaded document as data rather than commands. Scoring is assertion-based and
generation is greedy — a gate that blocks releases has to give the same answer
twice.

**Pruning is opt-in.** `model/recipes/w4a16_sparse24.yaml` adds SparseGPT 2:4
sparsity. One-shot 2:4 on a 7B reliably costs quality exactly where a support
assistant can least afford it — instruction following and faithfulness to
retrieved text. Expect the gate to fail and plan a recovery finetune. The recipe
is ready when you want to spend that budget; it is not the default.

---

## How configuration becomes behaviour

The config console is the product surface. Four things make it trustworthy
rather than a black box:

**Versions are immutable.** Saving inserts a new row and moves a pointer.
Nothing is edited in place. Rollback is the same operation aimed at an older
row, and every conversation records which version answered it — so "did that
prompt change help?" is answerable.

**The compiled prompt is materialised.** Stored on the version row with a hash.
That gives cheap diffs, lets the console preview exactly what the model will
receive, and means a change to the compiler cannot silently alter the behaviour
of already-shipped versions.

**The preview is the real thing.** The pane on the right of the config page is
produced by the same compiler that runs on save. There is one implementation, so
preview cannot drift from reality.

**Some rules are code, not config.** Grounding, the escalation sentinel and the
prompt-injection defence are appended by `prompt_compiler.py` and cannot be
edited from the console. An operator misconfiguring the tone is a bad day; an
operator deleting "only answer from the provided context" is a model that
invents refund policies.

### Grounding, concretely

"The system will respond properly" is not something you can prompt your way to.
It is four layers:

1. **Compiled policy** — the operator's rules enter the system prompt.
2. **Pre-generation gate** — if retrieval found nothing above the relevance
   floor, the request escalates *without calling the model at all*. A model
   handed weakly-related text will find something plausible to say; not asking
   is more reliable than asking and hoping. This is the layer that matters most,
   because it is deterministic.
3. **Model sentinel** — the model emits `[[ESCALATE]]` when it cannot answer.
   The backend detects it mid-stream, suppresses it, and returns a structured
   handoff state. The customer never sees the marker.
4. **Post-generation check** — an answer stating a specific figure while citing
   nothing is flagged, surfaced in the UI, and counted on the dashboard.

Citations are checkable, not decorative: each `[n]` marker resolves to the exact
chunk the retriever supplied, and clicking it opens that text.

---

## Deploying

```bash
cd infra/terraform/envs/dev
cp terraform.tfvars.example terraform.tfvars    # fill in project_id, authorized_networks
cp backend.hcl.example backend.hcl              # state bucket

terraform init -backend-config=backend.hcl
terraform plan                                  # review before applying
terraform apply

eval "$(terraform output -raw get_credentials)"
```

Then push images and install the charts — `terraform output helm_values_hint`
prints the values you need (registry path, Cloud SQL connection name, the
service accounts to annotate for Workload Identity).

There are no service account keys anywhere in this system. Pods authenticate as
a Kubernetes service account bound to a Google service account through Workload
Identity, which removes the entire class of incident where a key ends up in an
image, a git history, or a log.

Other security posture: private GKE cluster with no external node IPs, Cloud SQL
on private IP only, NetworkPolicy restricting vLLM to backend pods, secrets in
Secret Manager, non-root containers with read-only root filesystems.

---

## Autoscaling on the right signal

vLLM scales on `vllm:num_requests_waiting`, not CPU.

A saturated vLLM replica is blocked on CUDA, not compute. Its CPU sits at 20-40%
while requests queue behind a full KV cache and p95 latency climbs. **A
CPU-target HPA in front of this workload never fires** — it is the most common
way an LLM serving tier ends up with autoscaling that looks configured and does
nothing.

`prometheus-adapter` exposes the queue-depth metric through the custom metrics
API. Verify the chain before trusting it:

```bash
kubectl describe hpa support-vllm -n support   # <unknown> means it is not scaling
```

Scaling behaviour is deliberately asymmetric — instant up, 10-minute stabilisation
down. A GPU replica takes minutes to become ready, so hesitating to add one
prolongs a backlog while removing one prematurely costs another cold start.

---

## Monitoring

Two dashboards, because they can disagree:

**Serving** — TTFT and inter-token latency percentiles, throughput, running vs
waiting requests, KV-cache utilisation, prefix-cache hit rate, preemptions.

**Product** — deflection rate, escalations broken down by reason, retrieval
relevance distribution, citation coverage, prompt token economics, active config
version.

A deployment can be green on every serving metric and useless: an empty
knowledge base produces a fast, idle GPU and an assistant that escalates
everything. Only the product dashboard shows that.

Thirteen alert rules ship in `observability/prometheus/alerts.yaml`, each with a
runbook line saying what to actually check. All PromQL — alerts and every
dashboard panel — is syntax-checked in CI, because a bad query renders as "No
data" rather than an error, which is indistinguishable from a quiet system.

---

## Verification

```bash
make test          # 65 backend tests + 18 frontend tests
make lint          # ruff, strict mypy, eslint, tsc
make e2e           # Playwright against the running stack
make check-observability
```

The end-to-end check that actually matters:

1. Set a company name and a distinctive refund policy in the console. Watch the
   prompt preview update.
2. Upload a policy document in the knowledge base; wait for it to index.
3. Ask a question that policy answers → the response uses the company name,
   follows the policy, and shows a citation chip that opens the right passage.
4. Change the policy and save → a new version appears; ask again and the answer
   changes.
5. Ask something the documents do not cover → a handoff, not an invented answer.
6. Roll back to the previous version in History → prior behaviour returns.

---

## Current status

| Component | State |
|---|---|
| Compression pipeline + quality gate | Complete, not yet run on real hardware |
| vLLM serving image and tuning | Complete |
| Backend gateway | Complete — 65 tests, strict mypy clean |
| Frontend console | Complete — 18 tests, builds clean |
| Terraform (dev + prod) | Complete — validates; not yet applied |
| Helm charts | Complete — lint, render and schema-validate |
| Dashboards and alerts | Complete — PromQL validated |
| k6 scenarios | Complete — awaiting a first real run |

Everything that can be verified without a GPU or a GCP project has been. The
numbers in `load-test/README.md` are blank on purpose: they should be measured
on your hardware, not estimated here.

## Not in scope yet

- **Authentication.** The console is unauthenticated behind cluster ingress. Add
  IAP or an OIDC proxy before exposing it beyond an internal network — the
  operator identity plumbing (`X-Forwarded-Email`) is already wired through to
  config attribution, so it starts working as soon as something populates it.
- **Reranking.** Vector-only retrieval first. Measure, then decide whether a
  cross-encoder earns its latency.
- **Multi-tenancy.** Single workspace, single active configuration.
