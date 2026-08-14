# Observability

Two dashboards, because they answer different questions and can disagree.

**`vllm-serving.json`** — is the GPU healthy? Latency percentiles, queue depth,
KV-cache utilisation, prefix-cache hit rate, preemptions.

**`support-kpis.json`** — is the assistant useful? Deflection rate, escalation
reasons, retrieval relevance, citation coverage, prompt economics.

A deployment can be perfectly green on the first and useless on the second: an
empty knowledge base produces a fast, idle GPU and an assistant that escalates
every question. Only the product dashboard shows that.

## Install

```bash
# Prometheus + Grafana
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm upgrade --install kube-prometheus-stack \
  prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace

# The adapter that lets the HPA read vLLM's queue depth
helm upgrade --install prometheus-adapter \
  prometheus-community/prometheus-adapter \
  -n monitoring -f observability/prometheus/adapter-values.yaml

kubectl apply -f observability/prometheus/alerts.yaml

# Dashboards: import the JSON files, or mount them as a ConfigMap with the
# grafana_dashboard label for sidecar auto-discovery.
kubectl create configmap support-dashboards \
  --from-file=observability/grafana/dashboards/ \
  -n monitoring --dry-run=client -o yaml \
  | kubectl label -f - --local -o yaml grafana_dashboard=1 \
  | kubectl apply -f -
```

## Autoscaling on queue depth, not CPU

This is the decision worth understanding before changing anything here.

A saturated vLLM replica is blocked on CUDA, not on compute. Its CPU sits at
something unremarkable — 20-40% — while requests pile up behind a full KV cache
and p95 latency climbs. A CPU-target HPA in front of this workload therefore
**never fires**. It is the most common way an LLM serving tier ends up with
autoscaling that looks configured and does nothing.

`vllm:num_requests_waiting` counts requests admitted to the engine but not yet
decoding. It rises the instant a replica runs out of capacity, which is exactly
when another replica is needed. `prometheus-adapter` exposes it through the
custom metrics API so the HPA can target it.

Verify the chain works before trusting it:

```bash
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/support/pods/*/vllm_num_requests_waiting" \
  | jq .

kubectl describe hpa support-vllm -n support   # metric must show a current value, not <unknown>
```

An HPA showing `<unknown>` is not scaling at all, regardless of what the events
log says.

The scaling behaviour is deliberately asymmetric — instant up, slow down. A GPU
replica takes minutes to become ready, so hesitating to add one prolongs a
backlog, while removing one prematurely costs another cold start.

## Metric names

Names are verified against vLLM 0.27.1. They have changed across releases, so
after a vLLM upgrade check the endpoint before trusting a silent dashboard:

```bash
kubectl port-forward -n support svc/support-vllm 8000:8000
curl -s localhost:8000/metrics | grep -E '^# HELP vllm' | sort
```

A panel querying a renamed metric renders as "No data" rather than an error —
which is easy to mistake for "nothing is happening".

## Reading the two dashboards together

Some failures only make sense across both:

- **Prefix cache hit rate drops, TTFT rises, config activations spike at the
  same moment.** Someone saved a configuration change. The compiled system
  prompt is the shared token prefix, so changing it invalidates cached prefill
  for every concurrent request. Expect recovery within minutes; if it does not
  recover, something per-request has leaked into the system prompt.

- **Queue depth high, GPU utilisation low.** The bottleneck is CPU-side —
  tokenization or scheduling — not the GPU. Adding GPU replicas will not help.

- **Escalation rate high, retrieval latency and serving latency both normal.**
  Infrastructure is fine; the knowledge base does not cover what customers are
  asking. Break down `support_escalations_total` by reason and look at the
  questions.

- **Deflection rate falls right after a config activation.** The prompt change
  made things worse. Conversations record which config version answered them,
  so roll back to the previous version in the console and compare.

## Validation

The alert expressions and every dashboard query are syntax-checked in CI with
`promtool`. A query with a typo renders as an empty panel rather than an error,
so catching it at review time is the only reliable moment.

```bash
make check-observability
```
