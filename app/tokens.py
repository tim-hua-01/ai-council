"""Real token counts via Anthropic's ``count_tokens`` endpoint (free, no generation).

Used for the token badges in the UI. Counts are exact for Claude models; for other
models the caller falls back to a Claude model, so the result is only approximate.
"""

from __future__ import annotations

from anthropic import AsyncAnthropic

from .config import ModelConfig

# Per-model fixed cost of the message framing, so we report just the text's tokens.
_framing_overhead: dict[str, int] = {}


async def count_text_tokens(model: ModelConfig, text: str) -> int:
    """Tokens in ``text`` according to ``model``'s tokenizer (an Anthropic-backend model)."""
    if not text:
        return 0

    client = AsyncAnthropic(api_key=model.backend.api_key, timeout=30)

    async def raw(content: str) -> int:
        result = await client.messages.count_tokens(
            model=model.model_name,
            messages=[{"role": "user", "content": content}],
        )
        return result.input_tokens

    if model.model_name not in _framing_overhead:
        _framing_overhead[model.model_name] = await raw("a") - 1  # "a" is one token
    return max(0, await raw(text) - _framing_overhead[model.model_name])
