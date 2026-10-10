"""OpenAI-compatible proposer with strict JSON parsing and a local fallback."""

from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx


class ProposalError(ValueError):
    """The proposer did not return a valid structured design."""


class ModelDiscoveryError(ProposalError):
    """The OpenAI-compatible endpoint has no discoverable served model."""


class LLMClient:
    def __init__(
        self,
        base_url: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
        mode: str | None = None,
        timeout: float = 45.0,
    ) -> None:
        self.base_url = (base_url or os.getenv("ACCELTWIN_LLM_BASE_URL") or os.getenv("LLM_BASE_URL", "http://localhost:8000/v1")).rstrip("/")
        self.model = model or os.getenv("ACCELTWIN_LLM_MODEL") or os.getenv("LLM_MODEL")
        self.api_key = api_key or os.getenv("ACCELTWIN_LLM_API_KEY") or os.getenv("LLM_API_KEY", "local")
        explicit_mode = os.getenv("ACCELTWIN_LLM_MODE")
        if os.getenv("ACCELTWIN_MOCK_LLM", "false").lower() in {"1", "true", "yes"}:
            explicit_mode = "mock"
        self.mode = (mode or explicit_mode or "auto").lower()
        self.timeout = timeout

    def propose(self, prompt: str, schema: dict[str, Any], context: dict[str, Any] | None = None) -> dict[str, Any]:
        """Return exactly one JSON design object. `auto` falls back when vLLM is unavailable."""
        if self.mode in {"mock", "rule", "rules", "offline"}:
            return self._rule_proposal(context or {})
        try:
            return self._request(prompt, schema)
        except (httpx.HTTPError, ModelDiscoveryError):
            if self.mode in {"openai", "remote", "strict"}:
                raise
            return self._rule_proposal(context or {})

    def repair(self, prompt: str, invalid: str, error: str, schema: dict[str, Any]) -> dict[str, Any]:
        """Ask the model once to repair invalid JSON; the caller enforces the one-repair limit."""
        repair_prompt = (
            f"{prompt}\n\nYour previous response failed validation: {error}. "
            f"Return only one JSON object matching this schema: {json.dumps(schema)}. "
            f"Previous response:\n{invalid}"
        )
        return self._request(repair_prompt, schema)

    def _request(self, prompt: str, schema: dict[str, Any]) -> dict[str, Any]:
        model = self.model or self._discover_model()
        response = httpx.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": "Return exactly one JSON object. No markdown or commentary."},
                    {"role": "user", "content": f"{prompt}\n\nRequired JSON schema:\n{json.dumps(schema)}"},
                ],
                "response_format": {"type": "json_object"},
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        raw = payload["choices"][0]["message"]["content"]
        return self._parse_json(raw)

    def _discover_model(self) -> str:
        response = httpx.get(
            f"{self.base_url}/models",
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=min(self.timeout, 10.0),
        )
        response.raise_for_status()
        models = response.json().get("data", [])
        if not models or not isinstance(models[0].get("id"), str):
            raise ModelDiscoveryError("the local endpoint did not report a served model ID; set LLM_MODEL")
        self.model = models[0]["id"]
        return self.model

    @staticmethod
    def _parse_json(raw: str) -> dict[str, Any]:
        candidate = raw.strip()
        fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", candidate, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            candidate = fenced.group(1)
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError as exc:
            raise ProposalError(f"response is not valid JSON: {exc.msg}") from exc
        if not isinstance(value, dict):
            raise ProposalError("response must be a JSON object")
        return value

    @staticmethod
    def _rule_proposal(context: dict[str, Any]) -> dict[str, Any]:
        """Deterministic demo proposer; progressively changes one safe tuning knob."""
        round_index = int(context.get("round", 0))
        baseline_config = dict(context.get("baseline_config") or {})
        config = dict(baseline_config)
        # These knobs are illustrative defaults. The simulator owns allowed ranges and
        # the orchestration layer subjects every candidate to its hard gates.
        knobs = ("utilization", "hbm_bandwidth_tb_s", "peak_compute_tflops", "sbuf_gb", "dma_engines")
        knob = knobs[round_index % len(knobs)]
        current = config.get(knob)
        if knob == "utilization":
            config[knob] = min(0.95, round(float(current or 0.72) + 0.05, 2))
        elif knob == "hbm_bandwidth_tb_s":
            config[knob] = min(8.0, round(float(current or 2.9) + 0.4, 2))
        elif knob == "peak_compute_tflops":
            config[knob] = min(5000.0, round(float(current or 2500.0) * 1.15, 2))
        elif knob == "sbuf_gb":
            config[knob] = min(96.0, float(current or 24.0) + 4.0)
        else:
            config[knob] = min(16, int(current or 4) + 1)
        return {
            "name": f"rule-based candidate {round_index + 1}",
            "rationale": f"Explore a bounded increase to {knob}; hard gates remain authoritative.",
            "design": config,
        }

