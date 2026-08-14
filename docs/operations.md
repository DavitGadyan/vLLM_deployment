# Operations

Runbook for the people who get paged.

## Deploying a code change

```bash
TAG=$(git rev-parse --short HEAD)
REGISTRY=$(terraform -chdir=infra/terraform/envs/prod output -raw registry_url)

docker build -t $REGISTRY/support-backend:$TAG backend/
docker build -t $REGISTRY/support-frontend:$TAG frontend/
docker push $REGISTRY/support-backend:$TAG
docker push $REGISTRY/support-frontend:$TAG

helm upgrade --install support-backend deploy/helm/backend \
  -n support --set image.tag=$TAG --wait
helm upgrade --install support-frontend deploy/helm/frontend \
  -n support --set image.tag=$TAG --wait
```

Migrations run as a Helm `pre-upgrade` hook and block the release if they fail —
rather than letting a fleet of pods start against a schema the database does not
have.

## Deploying a new model

The model image is versioned independently of application code, so a prompt fix
never forces a 5.5 GB re-push.

```bash
# On the GPU box
make calibration && make quantize && make evaluate   # gate must pass

docker build -f model/Dockerfile.model \
  --build-arg ARTIFACT_DIR=model/output/qwen2.5-7b-instruct-w4a16 \
  --build-arg MODEL_VERSION=$TAG \
  -t $REGISTRY/support-model:$TAG .
docker push $REGISTRY/support-model:$TAG

helm upgrade --install support-vllm deploy/helm/vllm \
  -n support --set modelImage.tag=$TAG --wait --timeout 20m
```

The 20-minute timeout is not padding. A new replica pulls a 5.5 GB image, loads
weights and captures CUDA graphs before it reports Ready, and the rollout uses
`maxUnavailable: 0` so old replicas keep serving throughout.

Watch the prefix-cache hit rate afterwards. A new model means a cold cache; it
should refill within minutes.

## Rolling back a configuration change

Not a deploy. Open the console → Configuration → History, pick the previous
version, review the prompt diff, activate. New conversations use it immediately.

Every conversation records which config version answered it, so if quality
dropped after a save, the comparison is available rather than inferred.

## Alerts

Each rule in `observability/prometheus/alerts.yaml` carries a `runbook`
annotation. The ones worth knowing before they fire:

### `VLLMQueueBacklog`

Requests have been queueing for 10 minutes. The HPA should have added capacity.

```bash
# Is the HPA reading the metric at all?
kubectl describe hpa support-vllm -n support
kubectl get --raw \
  "/apis/custom.metrics.k8s.io/v1beta1/namespaces/support/pods/*/vllm_num_requests_waiting"
```

`<unknown>` in the HPA means prometheus-adapter is broken and no scaling is
happening — that is the problem, not vLLM. If the metric reads fine, check for
Pending pods: the node pool may be at `gpu_max_nodes`, or the zone may be out of
L4 capacity.

### `PrefixCacheHitRateCollapsed`

Almost always a configuration save — the compiled prompt changed, so the shared
prefix must refill. Correlate with `support_config_activations_total` on the
product dashboard. If it does not recover within ~10 minutes, something
per-request has leaked into the system prompt; check the ordering contract in
`backend/app/services/assembler.py`.

### `EscalationRateHigh`

A product problem, not an infrastructure one. Break down by reason:

- `low_retrieval_confidence` — the knowledge base does not cover what customers
  ask. Read the questions; add documents.
- `no_documents` — nothing indexed at all.
- `model_sentinel` — retrieval found passages but the model judged them
  insufficient. Consider whether the relevance floor is too permissive, letting
  weak matches through to a model that then correctly refuses them.

### `VLLMPreemptingRequests`

`max-num-seqs` is above what the KV cache can hold, so the GPU is discarding and
recomputing work. Lower it in the Helm values, or scale out. The sizing
arithmetic is in `serving/entrypoint.sh`.

## Common failures

**Pods stuck in `ContainerCreating` on GPU nodes.** Usually missing drivers.
Check `gpu_driver_installation_config` is present in the node pool — the
Terraform provider documents it as optional but nodes come up without drivers if
it is omitted.

**vLLM OOMs during startup.** `gpu_memory_utilization` too high for the model
plus activation peak, or another process on the GPU. Lower to 0.85 and retry.

**Every chat request fails with a transport error.** Check the NetworkPolicy. If
the backend's pod labels changed, the policy silently stops allowing the
connection.

**Retrieval returns nothing after a deploy.** Almost certainly the embedding
model changed without a re-index. Query and document vectors must come from the
same model or every similarity score is meaningless. The dimension check in
`embeddings.py` catches a size change, but not a same-size different model.

**Uploads stuck in `processing`.** Check backend logs for `ingest_failed`. The
usual cause is a scanned PDF with no extractable text; the error is stored on
the document row and shown in the console.

## Data retention

Conversations are stored PII-redacted (`backend/app/core/redaction.py`), applied
on the write path so raw PII never lands in the table — rather than as a
reporting-time filter someone can forget to apply.

Redaction is pattern-based and therefore best-effort. It is a meaningful
reduction in stored PII, not a guarantee of its absence. Set a retention policy
appropriate to your jurisdiction; there is no automatic purge yet.

```sql
-- Example: 90-day retention
DELETE FROM conversations WHERE created_at < now() - interval '90 days';
```

## Cost

The dominant cost is GPU-hours. On GCP, one `g2-standard-8` (1× L4) runs roughly
$0.85/hour on-demand at the time of writing — check current pricing.

- Dev scales the GPU pool to zero when idle. The trade is a several-minute cold
  start on the first request after a quiet period.
- Prod keeps `gpu_min_nodes >= 1`. Scaling to zero in production means a traffic
  spike arrives to an empty serving tier and the queue is already deep before
  the first replica can serve anything.

To reduce cost meaningfully, lower `max_model_len` (more conversations fit per
GPU) before adding replicas, and check the prefix-cache hit rate — a low one
means you are paying to prefill the same tokens repeatedly.
