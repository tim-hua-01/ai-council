"""Generic, config-driven API clients.

Two handlers cover every provider:

* :func:`call_openai_compatible` — any ``/chat/completions`` endpoint (OpenAI,
  OpenRouter, and anything else OpenAI-compatible), via ``httpx``.
* :func:`call_anthropic` — Anthropic Messages via the official SDK.

Both take a :class:`~app.config.ModelConfig` plus the conversation and an optional
per-request ``effort`` override, and return ``(response_dict, duration_seconds)``
where ``response_dict`` has ``content`` and ``thinking`` keys. :func:`call_model`
dispatches to the right one based on the backend type.

Reasoning effort is encoded per the model's ``reasoning_style`` (see
``config/models.yaml``), building per-backend sampling params from the model config.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Optional, Tuple

import httpx

from .config import ModelConfig

# Piggyback on uvicorn's handler so these INFO lines show up in the server log.
logger = logging.getLogger("uvicorn.error")


def format_response(
    content: Optional[str],
    thinking: Optional[str] = None,
    error: Optional[str] = None,
    usage: Optional[dict] = None,
) -> dict:
    """Shape every handler returns: ``{"content", "thinking", "usage"}``.

    ``usage`` is ``{"input", "cached", "cache_write", "output"}`` token counts (any
    may be ``None`` if the provider didn't report it), used to verify prompt caching.
    """
    if error:
        return {"content": error, "thinking": None, "usage": None}
    return {
        "content": content or "Error: No content in response",
        "thinking": thinking,
        "usage": usage,
    }


def _log_usage(model: ModelConfig, usage: Optional[dict]) -> None:
    if usage:
        logger.info(
            "usage %s: input=%s cached=%s cache_write=%s output=%s",
            model.id, usage["input"], usage["cached"], usage["cache_write"], usage["output"],
        )


def _effort_is_active(effort: Optional[str]) -> bool:
    return effort is not None and effort.strip().lower() not in {"", "none", "default"}


# --- OpenAI-compatible backends ------------------------------------------------


def _build_openai_payload(
    model: ModelConfig, messages: list, effort: Optional[str]
) -> dict[str, Any]:
    """Assemble the request body for an OpenAI-compatible chat completion."""
    backend = model.backend
    payload: dict[str, Any] = {
        "model": model.model_name,
        "messages": messages,
    }
    if model.max_tokens is not None:
        payload[backend.max_tokens_param] = model.max_tokens
    if model.temperature is not None:
        payload["temperature"] = model.temperature
    if model.top_p is not None:
        payload["top_p"] = model.top_p

    # Reasoning effort, encoded per the resolved style.
    if _effort_is_active(effort):
        if model.reasoning_style == "effort":
            payload["reasoning_effort"] = effort
        elif model.reasoning_style == "openrouter":
            payload["reasoning"] = {"effort": effort}
        # styles "none"/anthropic-only => nothing sent here

    # OpenRouter provider routing, e.g. "atlas-cloud/fp8".
    if model.openrouter_provider:
        slug, _, quant = model.openrouter_provider.partition("/")
        provider_routing: dict[str, Any] = {"order": [slug], "allow_fallbacks": False}
        if quant:
            provider_routing["quantizations"] = [quant]
        payload["provider"] = provider_routing

    return payload


def _extract_openai_message(data: dict) -> Tuple[str, Optional[str]]:
    """Pull (content, thinking) out of an OpenAI-compatible response."""
    if not data.get("choices"):
        raise ValueError("API returned empty choices array")
    message = data["choices"][0].get("message")
    if not isinstance(message, dict):
        raise ValueError("API response missing message field")
    content = message.get("content") or ""
    # Different providers expose reasoning under different keys.
    thinking = (
        message.get("reasoning_content")
        or message.get("reasoning")
        or None
    )
    if not content and not thinking:
        raise ValueError("API returned no content or reasoning")
    return content, thinking


def _extract_chat_usage(data: dict) -> Optional[dict]:
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("prompt_tokens_details") or {}
    return {
        "input": usage.get("prompt_tokens"),
        "cached": details.get("cached_tokens"),
        "cache_write": details.get("cache_write_tokens"),
        "output": usage.get("completion_tokens"),
    }


# --- OpenAI Responses API ------------------------------------------------------
# Chat Completions never returns reasoning text for OpenAI models (only a
# reasoning_tokens count); the Responses API can return reasoning *summaries*.


def _build_responses_payload(
    model: ModelConfig, messages: list, effort: Optional[str]
) -> dict[str, Any]:
    payload: dict[str, Any] = {"model": model.model_name, "input": messages}
    if model.max_tokens is not None:
        payload["max_output_tokens"] = model.max_tokens
    if model.temperature is not None:
        payload["temperature"] = model.temperature
    if model.top_p is not None:
        payload["top_p"] = model.top_p
    if _effort_is_active(effort) and model.reasoning_style == "effort":
        payload["reasoning"] = {"effort": effort, "summary": "auto"}
    return payload


def _extract_responses_message(data: dict) -> Tuple[str, Optional[str]]:
    """Pull (content, thinking) out of a Responses API result."""
    if data.get("error"):
        raise ValueError(f"API error: {json.dumps(data['error'])[:300]}")
    texts: list[str] = []
    summaries: list[str] = []
    for item in data.get("output") or []:
        if item.get("type") == "message":
            for part in item.get("content") or []:
                if part.get("type") == "output_text" and part.get("text"):
                    texts.append(part["text"])
        elif item.get("type") == "reasoning":
            for part in item.get("summary") or []:
                if part.get("text"):
                    summaries.append(part["text"])
    content = "".join(texts)
    thinking = "\n\n".join(summaries) or None
    if not content and not thinking:
        reason = (data.get("incomplete_details") or {}).get("reason")
        raise ValueError(f"API returned no content{f' (incomplete: {reason})' if reason else ''}")
    return content, thinking


def _extract_responses_usage(data: dict) -> Optional[dict]:
    usage = data.get("usage")
    if not isinstance(usage, dict):
        return None
    details = usage.get("input_tokens_details") or {}
    return {
        "input": usage.get("input_tokens"),
        "cached": details.get("cached_tokens"),
        "cache_write": details.get("cache_write_tokens"),
        "output": usage.get("output_tokens"),
    }


async def call_openai_compatible(
    model: ModelConfig,
    messages: list,
    api_key: str,
    effort: Optional[str] = None,
) -> Tuple[dict, float]:
    """Call an OpenAI-compatible ``/chat/completions`` (or ``/responses``) endpoint."""
    start = time.time()
    backend = model.backend
    base_url = backend.resolved_base_url
    if not base_url:
        raise ValueError(f"Backend {backend.name!r} has no base_url for OpenAI-compatible calls")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        **backend.extra_headers,
    }
    use_responses = backend.api == "responses"
    url = f"{base_url.rstrip('/')}/{'responses' if use_responses else 'chat/completions'}"
    payload = (
        _build_responses_payload(model, messages, effort)
        if use_responses
        else _build_openai_payload(model, messages, effort)
    )
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                url,
                headers=headers,
                json=payload,
                timeout=model.timeout,
            )
            response.raise_for_status()
            data = response.json()
            if use_responses:
                content, thinking = _extract_responses_message(data)
                usage = _extract_responses_usage(data)
            else:
                content, thinking = _extract_openai_message(data)
                usage = _extract_chat_usage(data)
            _log_usage(model, usage)
            return format_response(content, thinking=thinking, usage=usage), time.time() - start
    except httpx.TimeoutException:
        return (
            format_response("", error=f"Error: Request timeout after {model.timeout:g}s"),
            time.time() - start,
        )
    except httpx.HTTPStatusError as exc:
        error_msg = f"Error: HTTP {exc.response.status_code} - {exc.response.text[:300]}"
        return format_response("", error=error_msg), time.time() - start
    except json.JSONDecodeError:
        return format_response("", error="Error: Invalid JSON response from API"), time.time() - start
    except Exception as exc:  # noqa: BLE001 - surface any failure to the panel
        return (
            format_response("", error=f"Error: {type(exc).__name__}: {exc}"),
            time.time() - start,
        )


# --- Anthropic backend ---------------------------------------------------------


def _extract_anthropic_content(content_blocks: list) -> Tuple[Optional[str], Optional[str]]:
    """Return (thinking, content) from Anthropic response content blocks."""
    # Adaptive thinking can interleave several thinking/text blocks; keep them all.
    thinking_parts: list[str] = []
    text_parts: list[str] = []
    for block in content_blocks:
        block_type = getattr(block, "type", None)
        if block_type == "thinking":
            if getattr(block, "thinking", None):
                thinking_parts.append(block.thinking)
        elif block_type == "text":
            if getattr(block, "text", None):
                text_parts.append(block.text)
    return "\n\n".join(thinking_parts) or None, "".join(text_parts) or None


def _with_cache_breakpoint(convo: list) -> list:
    """Copy of ``convo`` with a ``cache_control`` breakpoint on the last content block.

    Anthropic caching is opt-in and prefix-based (tools -> system -> messages), so a
    single breakpoint on the final block caches the whole conversation so far; the next
    turn reads that prefix back. Prefixes below the model's minimum cacheable size are
    silently not cached, which is harmless.
    """
    if not convo:
        return convo
    last = dict(convo[-1])
    content = last.get("content")
    if isinstance(content, str):
        if not content.strip():
            return convo  # cache_control on an empty text block is rejected
        last["content"] = [
            {"type": "text", "text": content, "cache_control": {"type": "ephemeral"}}
        ]
    elif isinstance(content, list) and content:
        blocks = list(content)
        blocks[-1] = {**blocks[-1], "cache_control": {"type": "ephemeral"}}
        last["content"] = blocks
    else:
        return convo
    return [*convo[:-1], last]


def _extract_anthropic_usage(response: Any) -> Optional[dict]:
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    return {
        "input": getattr(usage, "input_tokens", None),
        "cached": getattr(usage, "cache_read_input_tokens", None),
        "cache_write": getattr(usage, "cache_creation_input_tokens", None),
        "output": getattr(usage, "output_tokens", None),
    }


def _build_anthropic_kwargs(
    model: ModelConfig, messages: list, effort: Optional[str]
) -> dict[str, Any]:
    """Assemble create() kwargs, splitting out the system message and reasoning.

    ``adaptive`` style => adaptive thinking + ``output_config.effort`` (current
    Opus models). ``budget`` style => manual extended thinking via
    ``thinking_budget_tokens`` (older models). Otherwise no thinking.
    """
    system_message: Optional[str] = None
    convo = messages
    if messages and messages[0].get("role") == "system":
        system_message = messages[0].get("content")
        convo = messages[1:]

    kwargs: dict[str, Any] = {
        "model": model.model_name,
        "max_tokens": model.max_tokens or 16000,
        "messages": _with_cache_breakpoint(convo),
    }
    if model.temperature is not None:
        kwargs["temperature"] = model.temperature
    if system_message:
        kwargs["system"] = system_message

    if model.reasoning_style == "budget" and model.thinking_budget_tokens:
        budget = model.thinking_budget_tokens
        if budget >= kwargs["max_tokens"]:
            kwargs["max_tokens"] = budget + 4096
        kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
    elif model.reasoning_style == "adaptive" and _effort_is_active(effort):
        # display defaults to "omitted" (empty thinking text) on current models, so
        # ask for the summary explicitly.
        kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}
        kwargs["output_config"] = {"effort": effort}

    return kwargs


async def call_anthropic(
    model: ModelConfig,
    messages: list,
    api_key: str,
    effort: Optional[str] = None,
) -> Tuple[dict, float]:
    """Call the Anthropic Messages API via the official async SDK."""
    from anthropic import AsyncAnthropic

    start = time.time()
    try:
        client = AsyncAnthropic(api_key=api_key, timeout=model.timeout)
        response = await client.messages.create(
            **_build_anthropic_kwargs(model, messages, effort)
        )
        if not response.content:
            raise ValueError("Anthropic API returned empty content")
        thinking, content = _extract_anthropic_content(response.content)
        usage = _extract_anthropic_usage(response)
        _log_usage(model, usage)
        return format_response(content, thinking=thinking, usage=usage), time.time() - start
    except Exception as exc:  # noqa: BLE001 - surface any failure to the panel
        return (
            format_response("", error=f"Error: {type(exc).__name__}: {str(exc)[:300]}"),
            time.time() - start,
        )


# --- Dispatch ------------------------------------------------------------------


async def call_model(
    model: ModelConfig,
    messages: list,
    api_key: str,
    effort: Optional[str] = None,
) -> Tuple[dict, float]:
    """Route to the correct backend handler based on ``model.backend.type``."""
    if model.backend.type == "anthropic":
        return await call_anthropic(model, messages, api_key, effort)
    return await call_openai_compatible(model, messages, api_key, effort)
