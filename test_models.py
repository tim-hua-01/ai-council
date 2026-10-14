#!/usr/bin/env python3
"""Smoke-test every configured model with a system message.

Reads config/models.yaml (the same config the server uses), sends a short prompt
with a system instruction to each model that has an API key configured, and
checks the model both responds and honours the system message.

    python test_models.py                 # test all configured models
    python test_models.py glm-5.3 fable-5.1   # test specific model ids
"""

import asyncio
import sys

from app.api_clients import call_model
from app.config import load_config

# API keys come from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY).

# System message asks for a specific behaviour so we can verify compliance.
TEST_MESSAGES = [
    {
        "role": "system",
        "content": "Today is the user's birthday! You must congratulate them by saying 'Happy Birthday!' in your response.",
    },
    {"role": "user", "content": "What is 2+2?"},
]


async def test_model(model, api_key) -> bool:
    print(f"\n🧪 Testing {model.id} ({model.label}) via {model.backend.name}...")
    try:
        response_data, duration = await call_model(model, TEST_MESSAGES, api_key)
        content = response_data.get("content", "")

        if content.startswith("Error:"):
            print(f"❌ {model.id}: API ERROR\n   {content[:200]}")
            return False

        followed = "birthday" in content.lower()
        marker = "✅" if followed else "⚠️ "
        print(f"{marker} {model.id}: {'followed system message' if followed else 'responded but ignored system message'}")
        print(f"   Duration: {duration:.2f}s")
        print(f"   Response: {content[:120]}...")
        if response_data.get("thinking"):
            print(f"   Thinking: {response_data['thinking'][:80]}...")
        return followed
    except Exception as exc:  # noqa: BLE001
        print(f"❌ {model.id}: FAILED\n   {type(exc).__name__}: {str(exc)[:200]}")
        return False


async def run_tests(model_ids: list[str]) -> None:
    config = load_config()
    selected = model_ids or list(config.models)

    print("=" * 60)
    print("Model Provider Smoke Test (system-message compliance)")
    print("=" * 60)

    results: list[tuple[str, bool | None]] = []
    for model_id in selected:
        model = config.models.get(model_id)
        if model is None:
            print(f"\n❓ Unknown model id: {model_id} (skipping)")
            results.append((model_id, None))
            continue
        api_key = model.backend.api_key
        if not api_key or api_key.startswith("your_"):
            print(f"\n⏭️  {model_id}: no API key ({model.backend.api_key_env}) — skipping")
            results.append((model_id, None))
            continue
        results.append((model_id, await test_model(model, api_key)))

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for name, result in results:
        status = {True: "✅ PASS", False: "❌ FAIL", None: "⏭️  SKIP"}[result]
        print(f"{status}: {name}")


if __name__ == "__main__":
    asyncio.run(run_tests(sys.argv[1:]))
