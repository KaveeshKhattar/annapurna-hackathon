"""Prometheus vLLM telemetry parsing and optional Neuron monitoring."""

from __future__ import annotations

import logging
import re
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)
_SAMPLE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|NaN|[+-]?Inf)(?:\s+\d+)?$")


def parse_vllm_metrics(text: str) -> Dict[str, float]:
    """Parse Prometheus exposition samples into a flat metric-name mapping.

    Label sets are ignored and duplicate samples are summed, which is useful
    for common per-engine counters. Histogram buckets remain individual names.
    """
    parsed: Dict[str, float] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = _SAMPLE.match(line)
        if not match:
            continue
        name, raw_value = match.groups()
        try:
            value = float(raw_value)
        except ValueError:
            continue
        parsed[name] = parsed.get(name, 0.0) + value
    return parsed


def collect_vllm_metrics(url: str = "http://localhost:8000/metrics", timeout: float = 1.5) -> Dict[str, float]:
    """Fetch and parse a vLLM Prometheus endpoint; return an empty map offline."""
    try:
        request = urllib.request.Request(url, headers={"Accept": "text/plain"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return parse_vllm_metrics(response.read().decode("utf-8", errors="replace"))
    except Exception as exc:  # graceful fallback is expected when server is absent
        logger.debug("Could not collect vLLM metrics from %s: %s", url, exc)
        return {}


class NeuronMonitorAdapter:
    """Optional adapter for AWS Neuron monitoring, with deterministic mock mode.

    The adapter accepts an injected monitor to keep the core app independent
    of the optional ``neuron-monitor`` package and to make deployments testable.
    """

    def __init__(self, monitor: Any = None, mock_fallback: bool = True):
        self.monitor = monitor
        self.mock_fallback = mock_fallback
        self.is_mock = monitor is None

    def collect(self) -> Dict[str, Any]:
        if self.monitor is not None:
            try:
                raw = self.monitor.get_metrics() if hasattr(self.monitor, "get_metrics") else self.monitor()
                if isinstance(raw, dict):
                    self.is_mock = False
                    return raw
            except Exception as exc:
                logger.debug("Neuron monitor unavailable: %s", exc)
        if not self.mock_fallback:
            return {}
        self.is_mock = True
        return {"source": "mock", "neuron_utilization": 0.0, "neuron_memory_used_gb": 0.0, "temperature_c": 0.0}


NeuronMonitor = NeuronMonitorAdapter

