# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ai4ais-1** is a Jupyter-based project using the `inspect-ai` framework. The primary technology stack includes:
- Python 3.11
- `inspect-ai` (>=0.3.174) - AI inspection/evaluation framework
- Jupyter environment (ipykernel, ipython, ipywidgets)
- Data science tools (pandas, matplotlib, statsmodels)
- Utility: python-dotenv for environment management, tqdm for progress bars

## Development Setup

### Environment Management
- **Python Version:** 3.11 (defined in `.python-version`)
- **Package Manager:** `uv` (modern Python package manager)
- **Virtual Environment:** `.venv` directory in project root

### Common Commands

#### Install dependencies
```bash
uv sync
```

#### Run Jupyter notebooks
```bash
jupyter notebook
```

#### Run Python scripts
```bash
python <script_name>.py
```

#### Run the multi-model comparison web app
```bash
uv run uvicorn app.main:app --reload --port 8000
```
Then open `http://localhost:8000` in your browser.

## Multi-Model Comparison Panel Web Application

The project includes a FastAPI-based web application for comparing responses from multiple LLMs side-by-side. It is **config-driven**: models and providers are defined in `config/models.yaml`, not in code.

### Architecture
- **Config**: `config/models.yaml` - single source of truth for models, backends, and UI defaults.
- **Config loader**: `app/config.py` - parses the YAML into typed dataclasses (`ModelConfig`, `BackendConfig`, `AppConfig`).
- **API Clients**: `app/api_clients.py` - two generic handlers, `call_openai_compatible` (httpx) and `call_anthropic` (SDK), with `call_model()` dispatching by backend type.
- **Backend**: `app/main.py` - FastAPI server. Endpoints: `/api/models`, `/api/config`, `/api/chat`.
- **Frontend**: `templates/index.html`, `static/style.css`, `static/script.js` - loads the model catalog from `/api/models` at runtime; nothing about models is hardcoded.

### Bundled models
fable-5.1, fable-5 (Anthropic); gpt-6-astra (OpenAI); gemini-3.8-flash, gemini-4-argon, muse-wonder, kimi-k3, glm-5.3, grok-4.6, deepseek-v4-pro (all via OpenRouter). Only the six in `default_panel_models` populate panels on load — everything else is available from each panel's model dropdown. See `config/models.yaml`.

### Local model overrides
`config/models.local.yaml` (gitignored, optional) is merged over `config/models.yaml` at startup: extra models, changed fields on existing models (matched by `id`), per-backend tweaks such as `model_prefix`, and a replacement `default_panel_models`. See `config/models.local.example.yaml`. Restart the server after editing — `--reload` only watches `.py` files. Point at a different file with `AI4AIS_LOCAL_CONFIG`.

### Reasoning effort
Each model has a default `reasoning_effort`; the UI dropdown overrides it per panel. The wire encoding is set by the backend/model `reasoning_style`: `effort` (OpenAI), `openrouter` (`reasoning: {effort}`), `adaptive` (Anthropic adaptive + `output_config.effort`), `budget` (Anthropic `thinking_budget_tokens`), or `none`.

### Setup
API keys are read from the **environment** (no `.env`/dotenv) — set the relevant vars before starting the server. Relevant vars: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` (GLM/Kimi/Gemini/Grok/DeepSeek all route through OpenRouter). Override the config path with `AI4AIS_CONFIG`.

To point requests at a proxy or gateway instead of the public APIs, export
`OPENAI_BASE_URL` and/or `OPENROUTER_BASE_URL` — the `openai`/`openrouter` backends in
`config/models.yaml` read these at call time via `base_url_env` and use them in place of the
YAML `base_url` whenever they're set. `ANTHROPIC_BASE_URL` needs no such wiring: the Anthropic
SDK already picks it up from the environment on its own. If the gateway expects different model
names, set them in `config/models.local.yaml` (per-model `model_name`, or a backend-wide
`model_prefix`).

### Implementation Notes
- OpenAI-compatible calls use `httpx.AsyncClient`; Anthropic uses the official async SDK.
- Requests executed in parallel via `asyncio.gather`; timing measured server-side.
- Each handler returns `(response_dict, duration_seconds)` where the dict has `content` and `thinking` keys.
- Errors are returned as `Error: ...` content strings and shown in the panel, never raised to the client.
- `test_models.py` is a config-driven smoke test (`python test_models.py [model_id ...]`).

## Key Framework: inspect-ai

This project uses the `inspect-ai` framework for AI inspection/evaluation tasks. When working with this codebase:
- Refer to inspect-ai documentation for evaluation setup and task definitions
- Tasks typically involve creating inspection workflows and running evaluations
- Results may involve data analysis with pandas and visualization with matplotlib
