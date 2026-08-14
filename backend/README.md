# Support backend

FastAPI gateway between the console and the vLLM serving layer. It owns prompt
compilation, retrieval, guardrails, token accounting and metrics — everything
that has to be auditable in one place — and it is the only thing permitted to
talk to the model.

See the repository root `README.md` for architecture and `docs/` for the
prompt-cache contract that governs prompt assembly order.
