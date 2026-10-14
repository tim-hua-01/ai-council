# AI4AIS Multi-Model Comparison Panel

A local web app for comparing responses from multiple LLMs side-by-side. Send the
same prompt to up to 6 models at once and compare their answers, reasoning, and
latency.

Everything about *which* models exist and *how* they're called lives in a single
YAML file — **`config/models.yaml`**. Adding a model or a whole new provider is a
config edit, not a code change.

## Features

- **Fully config-driven**: models, providers, and defaults all come from `config/models.yaml`.
- **Per-model reasoning effort**: set a default in the config, and override it per
  panel at runtime from a dropdown in the panel header.
- **Multi-provider**: OpenAI, Anthropic, and anything OpenAI-compatible via
  OpenRouter (GLM, Kimi/Moonshot, Gemini, Grok, and DeepSeek all run through
  OpenRouter here).
- **Proxy-friendly**: the `openai`/`openrouter` backends' base URLs can be
  overridden with `OPENAI_BASE_URL`/`OPENROUTER_BASE_URL` env vars (e.g. to
  route through a company proxy); Anthropic picks up `ANTHROPIC_BASE_URL`
  automatically via its SDK. See "Setup & running" below.
- **Up to 6 panels**, each with its own model, reasoning effort, and conversation.
- **Extended thinking / reasoning** shown in a collapsible dropdown per response.
- **System messages** — global (all panels) or per-panel.
- **Markdown rendering**, response timing, parallel requests.

## Bundled models

| Panel id | Provider | Backend | Wire model name | Default effort | In default panels |
|---|---|---|---|---|---|
| `fable-5.1` | Anthropic | anthropic | `claude-fable-5-1` | high (adaptive) | yes |
| `gpt-6-astra` | OpenAI | openai | `gpt-6-astra` | high | yes |
| `gemini-3.8-flash` | Google | openrouter | `google/gemini-3.8-flash` | high | yes |
| `kimi-k3` | Moonshot | openrouter | `moonshotai/kimi-k3` | high | yes |
| `glm-5.3` | Z.AI | openrouter | `z-ai/glm-5.3` | high | yes |
| `grok-4.6` | xAI | openrouter | `x-ai/grok-4.6` | high | yes |
| `gemini-4-argon` | Google | openrouter | `google/gemini-4-argon` | high | no — pick it from a panel's dropdown |
| `muse-wonder` | Meta | openrouter | `meta/muse-wonder` | high | no — pick it from a panel's dropdown |
| `deepseek-v4-pro` | DeepSeek | openrouter | `deepseek/deepseek-v4-pro` | high | no — pick it from a panel's dropdown |

## Setup & running

API keys are read **straight from the environment** (no `.env` / dotenv). Set the
relevant vars for the providers you use, then start the server:

```bash
export OPENAI_API_KEY=...        # OpenAI models
export ANTHROPIC_API_KEY=...     # Claude models
export OPENROUTER_API_KEY=...    # GLM, Kimi/Moonshot, Gemini, Grok, DeepSeek (all via OpenRouter)

uv sync
uv run uvicorn app.main:app --reload --port 8000
# then open http://localhost:8000
```

To point at a different config file, set `AI4AIS_CONFIG=/path/to/your.yaml`.

For per-machine changes — extra models, different wire names, a different default
lineup — create `config/models.local.yaml` (gitignored). It is merged over
`config/models.yaml` at startup; see `config/models.local.example.yaml` for the
format. Restart the server after editing it.

To route requests through a proxy (e.g. an internal gateway) instead of the
public OpenAI/OpenRouter APIs, additionally export `OPENAI_BASE_URL` and/or
`OPENROUTER_BASE_URL` — the backends read these at request time and use them
in place of the YAML `base_url`. For Anthropic, just set `ANTHROPIC_BASE_URL`;
the SDK reads it on its own, no app-side wiring needed. The API key vars above
double as wherever the proxy expects its token.

### Smoke test

`test_models.py` sends a short prompt (with a system message) to every configured
model that has an API key, and checks it responds:

```bash
python test_models.py                    # all configured models
python test_models.py glm-5.3 fable-5.1  # only these ids
```

## Configuring models

Open `config/models.yaml`. It has three sections:

- **`defaults`** — app-wide fallbacks (max_tokens, timeout, panel count, and the
  list of reasoning-effort options shown in the UI).
- **`backends`** — providers. Each defines a `type` (`openai`-compatible or
  `anthropic`), `base_url` (with an optional `base_url_env` override for
  proxies), `api_key_env`, and a `reasoning_style` that controls how reasoning
  effort is encoded on the wire.
- **`models`** — selectable models, each pointing at a backend.

### Add a model

```yaml
models:
  - id: my-model
    label: My Model
    backend: openrouter          # must match a key under `backends:`
    model_name: vendor/my-model  # the provider's own id
    reasoning_effort: high
    max_tokens: 32000
```

### Add a provider

```yaml
backends:
  my-provider:
    type: openai                 # OpenAI-compatible /chat/completions
    base_url: https://api.example.com/v1
    api_key_env: MY_PROVIDER_API_KEY
    reasoning_style: effort      # or "openrouter" / "none"
    max_tokens_param: max_tokens
```

### Reasoning effort

Each model has a default `reasoning_effort`; the panel dropdown lets you override
it per request (`default` keeps the model's configured value). How it's sent
depends on the backend's (or model's) `reasoning_style`:

| `reasoning_style` | Encoding |
|---|---|
| `effort` | `reasoning_effort: <value>` (OpenAI native) |
| `openrouter` | `reasoning: {effort: <value>}` (OpenRouter unified) |
| `adaptive` | Anthropic adaptive thinking + `output_config.effort` (Opus 4.7/4.8+) |
| `budget` | Anthropic manual extended thinking via `thinking_budget_tokens` |
| `none` | no reasoning params sent |

An effort of `none`/`default` (or empty) sends no reasoning parameter.

## Architecture

```
app/
  config.py        # YAML -> typed dataclasses (models, backends, defaults)
  api_clients.py   # generic handlers: call_openai_compatible / call_anthropic
  main.py          # FastAPI: /api/models, /api/config, /api/chat
config/
  models.yaml      # the single source of truth for models & providers
static/            # script.js, style.css (vanilla JS frontend)
templates/         # index.html
test_models.py     # config-driven smoke test
```

- **Backend dispatch**: `call_model()` routes to `call_anthropic` (official SDK)
  or `call_openai_compatible` (`httpx`) based on the backend type. This mirrors
  how a generic multi-backend LLM client builds per-backend sampling params.
- **Frontend** fetches `/api/models` and `/api/config` on load, so the model
  dropdowns and reasoning selectors are populated entirely from the server.
- **Concurrency**: all enabled panels run in parallel via `asyncio.gather`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Cmd/Ctrl+Enter | Send to all models |
| Enter (panel input) | Send to that panel |
| Shift+Enter | Newline |

## Notes & limitations

- Conversations live in browser memory (cleared on refresh).
- Model slugs (e.g. Gemini/GLM versions) change over time on OpenRouter; if a
  model 400s with "not a valid model ID", update its `model_name` in the YAML.
- No auth/persistence; intended for local use.
