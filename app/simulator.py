"""Deterministic phase-aware roofline and queue replay simulator."""

from __future__ import annotations

import math
from typing import Dict, Iterable, List, Sequence, Union

from .models import HardwareDesign, RequestOutcome, RequestSpec, RequestTrace, SimulationResult


def _make_trace(name: str, counts: Sequence[tuple[int, int, float]], description: str) -> RequestTrace:
    return RequestTrace(
        name=name,
        description=description,
        requests=[
            RequestSpec(request_id=f"{name.lower()}-{i + 1:03d}", prompt_tokens=p, output_tokens=o, arrival_ms=a)
            for i, (p, o, a) in enumerate(counts)
        ],
    )


# Fixed and reproducible request streams. Inter-arrival times are milliseconds.
TRACE_A = _make_trace("A", [(512, 128, i * 90.0) for i in range(12)], "Interactive chat, short context")
TRACE_B = _make_trace("B", [(4096, 256, i * 250.0) for i in range(8)], "Long-context generation")
TRACE_C = _make_trace("C", [(1024, 64, i * 8.0) for i in range(48)], "High-concurrency short answers")
TRACES: Dict[str, RequestTrace] = {"A": TRACE_A, "B": TRACE_B, "C": TRACE_C}


def fixed_trace(name: str) -> RequestTrace:
    """Return a fresh copy of fixed trace A, B, or C (case insensitive)."""
    key = str(name).strip().upper().removeprefix("TRACE_")
    if key not in TRACES:
        raise ValueError(f"Unknown request trace {name!r}; choose A, B, or C")
    return TRACES[key].model_copy(deep=True)


def _percentile(values: Sequence[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * percentile
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


class DigitalTwinSimulator:
    """Replay a fixed arrival stream through a deterministic FCFS device model."""

    def __init__(self, design: HardwareDesign | None = None):
        self.design = design or HardwareDesign.baseline()

    def _prefill_ms(self, prompt_tokens: int) -> float:
        d = self.design
        params = d.model_size_b * 1e9
        # Attention makes prefill work grow faster than a linear token pass.
        flops = 2.0 * params * prompt_tokens * (1.0 + min(prompt_tokens, 8192) / 4096.0)
        compute_ms = flops / (d.peak_compute_tflops * 1e12 * d.utilization) * 1000.0
        # A streaming weight pass plus activation traffic; bytes and bandwidth
        # use decimal units so the stated 2.9 TB/s baseline is literal.
        bytes_moved = params * d.weight_bytes_per_parameter + prompt_tokens * 4096.0
        memory_ms = bytes_moved / (d.hbm_bandwidth_tb_s * 1e12) * 1000.0
        return max(compute_ms, memory_ms, 0.05)

    def _decode_token_ms(self, concurrent: int = 1) -> float:
        d = self.design
        params = d.model_size_b * 1e9
        flops = 2.0 * params
        compute_ms = flops / (d.peak_compute_tflops * 1e12 * d.utilization) * 1000.0
        # Each step streams weights once and reads per-sequence KV state.
        bytes_moved = params * d.weight_bytes_per_parameter + concurrent * 4096.0
        memory_ms = bytes_moved / (d.hbm_bandwidth_tb_s * 1e12) * 1000.0
        return max(compute_ms, memory_ms, 0.01)

    def evaluate(
        self,
        design: HardwareDesign | None = None,
        trace: Union[RequestTrace, str, None] = None,
    ) -> SimulationResult:
        # Support both evaluate(design, trace) and evaluate(trace) on a simulator
        # that already owns its design.
        if trace is None and isinstance(design, (str, RequestTrace)):
            trace, design = design, None
        if trace is None:
            trace = "A"
        if design is not None:
            self.design = design if isinstance(design, HardwareDesign) else HardwareDesign.parse_obj(design)
        workload = fixed_trace(trace) if isinstance(trace, str) else trace
        if not workload.requests:
            return self._empty_result(workload.name)

        d = self.design
        raw_power = 85.0 + d.utilization * min(d.peak_compute_tflops / 2500.0, 1.8) * 420.0
        power_cap = min(d.power_limit_w, d.cooling_capacity_w)
        throttling = raw_power > power_cap
        factor = min(1.0, power_cap / raw_power) if throttling else 1.0
        ordered = sorted(enumerate(workload.requests), key=lambda item: (item[1].arrival_ms, item[0]))
        # Estimate peak resident memory from weights, the largest active KV
        # allocation, and a fixed work-buffer allowance.
        weight_gb = d.model_size_b * 1e9 * d.weight_bytes_per_parameter / 1e9
        max_kv_gb = max((r.prompt_tokens + r.output_tokens) * d.kv_bytes_per_token for r in workload.requests)
        peak_memory = weight_gb + max_kv_gb + min(d.sbuf_gb, 8.0)
        memory_fit = peak_memory <= d.hbm_gb

        # FCFS queue replay: requests are admitted by arrival time, then each
        # receives a prefill phase followed by serial autoregressive decode.
        # Overload is represented through queue delay and the memory-fit flag.
        now_ms = 0.0
        outcomes: List[RequestOutcome] = []
        total_tokens = 0
        for index, request in ordered:
            start = max(now_ms, request.arrival_ms)
            prefill = self._prefill_ms(request.prompt_tokens) / factor
            first_token = start + prefill
            decode = request.output_tokens * self._decode_token_ms() / factor
            complete = first_token + decode
            request_id = request.request_id or f"{workload.name.lower()}-{index + 1:03d}"
            outcomes.append(RequestOutcome(
                request_id=request_id,
                arrival_ms=request.arrival_ms,
                first_token_ms=first_token,
                completion_ms=complete,
                ttft_ms=max(0.0, first_token - request.arrival_ms),
                output_tokens=request.output_tokens,
            ))
            now_ms = complete
            total_tokens += request.prompt_tokens + request.output_tokens

        duration = max(now_ms - min(r.arrival_ms for r in workload.requests), 0.001)
        power = min(raw_power, power_cap)

        # Coarse package-area proxy used only as a transparent architectural
        # constraint. It is not a physical-design estimate.
        area_mm2 = (
            120.0
            + d.compute_cores * 42.0
            + d.hbm_gb * 1.45
            + d.sbuf_gb * 0.65
            + d.dma_engines * 3.5
        )

        # A stable spatial gradient provides an 8x8 thermal proxy. Temperatures
        # rise with power and are hottest near the center of the package.
        base_c = 28.0 + power / 32.0
        grid = []
        for row in range(8):
            cells = []
            for col in range(8):
                radial = abs(row - 3.5) + abs(col - 3.5)
                cells.append(round(base_c + max(0.0, 4.0 - radial) * 1.7, 2))
            grid.append(cells)

        return SimulationResult(
            trace_name=workload.name,
            ttft_p50_ms=round(_percentile([o.ttft_ms for o in outcomes], 0.50), 3),
            ttft_p95_ms=round(_percentile([o.ttft_ms for o in outcomes], 0.95), 3),
            ttft_p99_ms=round(_percentile([o.ttft_ms for o in outcomes], 0.99), 3),
            throughput_tokens_s=round(total_tokens / (duration / 1000.0), 3),
            memory_fit=memory_fit,
            peak_memory_gb=round(peak_memory, 3),
            power_w=round(power, 2),
            area_mm2=round(area_mm2, 2),
            max_temperature_c=max(max(row) for row in grid),
            thermal_grid=grid,
            throttling=throttling,
            throttle_factor=round(factor, 4),
            duration_ms=round(duration, 3),
            completed_requests=len(outcomes),
            request_outcomes=outcomes,
        )

    def _empty_result(self, trace_name: str) -> SimulationResult:
        return SimulationResult(
            trace_name=trace_name, ttft_p50_ms=0, ttft_p95_ms=0, ttft_p99_ms=0,
            throughput_tokens_s=0, memory_fit=True, peak_memory_gb=0, power_w=0,
            area_mm2=0, max_temperature_c=0,
            thermal_grid=[[0.0 for _ in range(8)] for _ in range(8)], throttling=False,
        )

