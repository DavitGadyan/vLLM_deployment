.DEFAULT_GOAL := help
SHELL := /bin/bash

COMPOSE := docker compose
ENV_FILE := .env

# Model/compression knobs (override on the command line, e.g. `make quantize CALIB_SAMPLES=1024`)
BASE_MODEL_ID  ?= Qwen/Qwen2.5-7B-Instruct
OUTPUT_DIR     ?= model/output/qwen2.5-7b-instruct-w4a16
RECIPE         ?= model/recipes/w4a16.yaml
CALIB_SAMPLES  ?= 512

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

$(ENV_FILE):
	@cp .env.example $(ENV_FILE)
	@echo "Created $(ENV_FILE) from .env.example — review it before running 'make dev'."

# ---------------------------------------------------------------------------
# Local development
# ---------------------------------------------------------------------------

.PHONY: dev
dev: $(ENV_FILE) ## Start the full local stack (postgres, embeddings, vllm, backend, frontend)
	$(COMPOSE) up --build

.PHONY: dev-no-gpu
dev-no-gpu: $(ENV_FILE) ## Start everything except vLLM (point VLLM_BASE_URL at a remote GPU box)
	$(COMPOSE) up --build postgres embeddings backend frontend

.PHONY: down
down: ## Stop the stack
	$(COMPOSE) down

.PHONY: clean
clean: ## Stop the stack and delete volumes (destroys local database)
	$(COMPOSE) down -v

.PHONY: logs
logs: ## Tail logs from all services
	$(COMPOSE) logs -f

# ---------------------------------------------------------------------------
# Model compression
# ---------------------------------------------------------------------------

.PHONY: calibration
calibration: ## Build the support-domain calibration dataset
	cd model && python calibration/build_dataset.py --samples $(CALIB_SAMPLES) --out data/calibration.jsonl

.PHONY: quantize
quantize: ## Quantize the base model to INT4 W4A16 (requires a GPU)
	cd model && python compress.py \
		--model $(BASE_MODEL_ID) \
		--recipe $(patsubst model/%,%,$(RECIPE)) \
		--calibration data/calibration.jsonl \
		--output $(patsubst model/%,%,$(OUTPUT_DIR))

.PHONY: quantize-sparse
quantize-sparse: ## Quantize WITH 2:4 pruning (opt-in; needs a recovery finetune for production)
	$(MAKE) quantize RECIPE=model/recipes/w4a16_sparse24.yaml \
		OUTPUT_DIR=model/output/qwen2.5-7b-instruct-w4a16-sparse24

.PHONY: evaluate
evaluate: ## Run the quality gate against the FP16 baseline
	cd model && python evaluate.py \
		--candidate $(patsubst model/%,%,$(OUTPUT_DIR)) \
		--baseline-id $(BASE_MODEL_ID)

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

.PHONY: test
test: test-backend test-frontend ## Run all unit tests

.PHONY: test-backend
test-backend: ## Run backend tests
	cd backend && python -m pytest -q

.PHONY: test-frontend
test-frontend: ## Run frontend unit tests
	cd frontend && npm run test -- --run

.PHONY: e2e
e2e: ## Run Playwright end-to-end tests against the running stack
	cd frontend && npm run test:e2e

.PHONY: check-observability
check-observability: ## Syntax-check all PromQL in alerts and dashboards (needs promtool)
	python3 observability/check.py

.PHONY: lint
lint: ## Lint and type-check everything
	cd backend && ruff check . && ruff format --check . && mypy app
	cd frontend && npm run lint && npm run typecheck

.PHONY: fmt
fmt: ## Auto-format everything
	cd backend && ruff check --fix . && ruff format .
	cd frontend && npm run format

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

.PHONY: migrate
migrate: ## Apply database migrations
	cd backend && alembic upgrade head

.PHONY: migration
migration: ## Create a new migration: make migration M="add foo"
	cd backend && alembic revision --autogenerate -m "$(M)"

.PHONY: seed
seed: ## Load a demo company config and sample knowledge base
	cd backend && python -m app.scripts.seed

# ---------------------------------------------------------------------------
# Load testing
# ---------------------------------------------------------------------------

.PHONY: load-test
load-test: ## Steady-state load test
	k6 run load-test/k6/steady.js

.PHONY: load-test-burst
load-test-burst: ## Burst load test (validates HPA and queue behaviour)
	k6 run load-test/k6/burst.js

.PHONY: bench-prefix-cache
bench-prefix-cache: ## Measure the prefix-cache win (cold vs warm)
	k6 run load-test/k6/prefix-cache.js

# ---------------------------------------------------------------------------
# Infrastructure
# ---------------------------------------------------------------------------

ENV ?= dev

.PHONY: tf-init
tf-init: ## terraform init for $(ENV)
	terraform -chdir=infra/terraform/envs/$(ENV) init

.PHONY: tf-plan
tf-plan: ## terraform plan for $(ENV)
	terraform -chdir=infra/terraform/envs/$(ENV) plan

.PHONY: tf-apply
tf-apply: ## terraform apply for $(ENV)
	terraform -chdir=infra/terraform/envs/$(ENV) apply

.PHONY: tf-fmt
tf-fmt: ## Format all Terraform
	terraform fmt -recursive infra/terraform
