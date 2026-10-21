"""FastAPI server for the multi-model comparison panel.

Models and providers are defined entirely in ``config/models.yaml`` (see
``app.config``). This module just loads that config, exposes it to the frontend
via ``/api/models`` / ``/api/config``, and dispatches chat requests to the
generic backend handlers in ``app.api_clients``.
"""

from __future__ import annotations

import asyncio
import os
import sys

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .api_clients import call_model
from .config import AppConfig, load_config
from .tokens import count_text_tokens

# API keys are read straight from the environment (os.getenv in app.config).
# Set OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY before starting.

# Optional per-machine startup hook (gitignored), e.g. to fetch gateway credentials.
try:
    from . import local_hooks  # noqa: F401
except ModuleNotFoundError as e:
    if e.name != f"{__package__}.local_hooks":
        raise

# Resolve paths relative to the project root so the server runs from any CWD.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class NoCacheStaticFiles(StaticFiles):
    """Static files that browsers must revalidate (ETag => cheap 304) on every load.

    Without a Cache-Control header Chrome heuristically reuses a stale copy of
    script.js/style.css, so edits don't show up on a normal reload or relaunch.
    """

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app = FastAPI(title="AI4AIS Multi-Model Comparison Panel")
app.mount("/static", NoCacheStaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# Loaded once at import. Edit config/models.yaml and restart (or use --reload).
CONFIG: AppConfig = load_config()


class Panel(BaseModel):
    model: str
    messages: list[dict]
    enabled: bool
    reasoning_effort: str | None = None  # per-panel override; None => model default


class ChatRequest(BaseModel):
    panels: list[Panel]


class CountRequest(BaseModel):
    text: str
    model: str | None = None  # model id; non-Claude (or unknown) ids use a Claude reference


@app.get("/")
async def home(request: Request):
    # ?v=<mtime> in the asset URLs busts any stale copy the browser cached earlier.
    def _version(name: str) -> int:
        return int(os.path.getmtime(os.path.join(BASE_DIR, "static", name)))

    response = templates.TemplateResponse(
        "index.html",
        {"request": request, "css_v": _version("style.css"), "js_v": _version("script.js")},
    )
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/models")
async def list_models():
    """Model catalog for the frontend dropdowns and reasoning-effort selectors."""
    return {"models": CONFIG.model_summaries()}


@app.get("/api/config")
async def get_config():
    """UI defaults: which models populate panels on load, panel count, etc."""
    return {
        "default_panel_models": CONFIG.default_panel_models,
        "panel_count": CONFIG.panel_count,
        "reasoning_effort_options": CONFIG.reasoning_effort_options,
    }


async def _run_panel(panel: Panel) -> dict | None:
    """Execute one panel's request, returning a result dict (or None if skipped)."""
    if not panel.enabled:
        return None

    if not panel.model:
        return {"content": "Error: Model not selected", "thinking": None, "duration": 0}

    model = CONFIG.models.get(panel.model)
    if model is None:
        return {"content": f"Error: Unknown model '{panel.model}'", "thinking": None, "duration": 0}

    if not panel.messages:
        return {"content": "Error: No messages to send", "thinking": None, "duration": 0}

    api_key = model.backend.api_key
    if not api_key or api_key.startswith("your_"):
        return {
            "content": f"Error: API key not configured ({model.backend.api_key_env})",
            "thinking": None,
            "duration": 0,
        }

    effort = model.resolved_effort(panel.reasoning_effort)
    try:
        response_data, duration = await call_model(model, panel.messages, api_key, effort)
    except Exception as exc:  # noqa: BLE001 - never let one panel break the batch
        print(f"Error calling model {panel.model}: {exc}", file=sys.stderr)
        return {"content": f"Error: {type(exc).__name__}: {exc}", "thinking": None, "duration": 0}

    return {
        "content": response_data.get("content", ""),
        "thinking": response_data.get("thinking"),
        "usage": response_data.get("usage"),
        "duration": round(float(duration), 2),
    }


@app.post("/api/count_tokens")
async def count_tokens(request: CountRequest):
    """Token count for ``text``, via Anthropic's count_tokens API.

    Exact when ``model`` is an Anthropic-backend model; otherwise counted with the
    first Anthropic model in the config and flagged ``exact: false``.
    """
    model = CONFIG.models.get(request.model or "")
    exact = model is not None and model.backend.type == "anthropic"
    if not exact:
        model = next((m for m in CONFIG.models.values() if m.backend.type == "anthropic"), None)
    if model is None or not model.backend.api_key:
        return {"error": "No Anthropic model/API key configured for token counting"}
    try:
        return {
            "tokens": await count_text_tokens(model, request.text),
            "exact": exact,
            "counted_with": model.label,
        }
    except Exception as exc:  # noqa: BLE001 - the badge just stays blank on failure
        return {"error": f"{type(exc).__name__}: {str(exc)[:200]}"}


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """Run all enabled panels in parallel and return their results in order."""
    if not request.panels:
        return {"error": "No panels provided", "results": []}

    results = await asyncio.gather(
        *(_run_panel(panel) for panel in request.panels),
        return_exceptions=True,
    )

    formatted: list[dict | None] = []
    for result in results:
        if isinstance(result, BaseException):
            formatted.append(
                {"content": f"Error: {type(result).__name__}: {result}", "thinking": None, "duration": 0}
            )
        else:
            formatted.append(result)

    return {"results": formatted}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
