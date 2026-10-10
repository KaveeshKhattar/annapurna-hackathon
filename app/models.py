"""Shared data models for the AccelTwin simulator."""

from __future__ import annotations

from typing import Any, Dict, List

from pydantic import BaseModel, ConfigDict, Field


class HardwareDesign(BaseModel):
    """A compact, editable description of an accelerator instance.

    Values use decimal TB/s and GB. ``peak_compute_tflops`` is aggregate BF16
    throughput for the logical device described by ``compute_cores``.
    """

    name: str = "Trainium2-like baseline"
    compute_cores: int = Field(default=4, gt=0)
    peak_compute_tflops: float = Field(default=2500.0, gt=0)
    hbm_gb: float = Field(default=96.0, gt=0)
    hbm_bandwidth_tb_s: float = Field(default=2.9, gt=0)
    sbuf_gb: float = Field(default=24.0, ge=0)
    dma_engines: int = Field(default=4, ge=0)
    power_limit_w: float = Field(default=600.0, gt=0)
    cooling_capacity_w: float = Field(default=650.0, gt=0)
    model_size_b: float = Field(default=13.0, gt=0)
    weight_bytes_per_parameter: float = Field(default=2.0, gt=0)
    kv_bytes_per_token: float = Field(default=0.0005, gt=0)
    utilization: float = Field(default=0.72, gt=0, le=1)

    model_config = ConfigDict(extra="ignore")

    @classmethod
    def baseline(cls) -> "HardwareDesign":
        """Return the required four-core, 96 GB, 2.9 TB/s reference design."""
        return cls()

    @classmethod
    def trainium2_baseline(cls) -> "HardwareDesign":
        return cls.baseline()


class RequestSpec(BaseModel):
    request_id: str = ""
    prompt_tokens: int = Field(default=512, ge=1)
    output_tokens: int = Field(default=128, ge=1)
    arrival_ms: float = Field(default=0.0, ge=0)

    model_config = ConfigDict(extra="ignore")


class RequestTrace(BaseModel):
    name: str
    description: str = ""
    requests: List[RequestSpec]

    model_config = ConfigDict(extra="ignore")


class RequestOutcome(BaseModel):
    request_id: str
    arrival_ms: float
    first_token_ms: float
    completion_ms: float
    ttft_ms: float
    output_tokens: int


class SimulationResult(BaseModel):
    trace_name: str
    ttft_p50_ms: float
    ttft_p95_ms: float
    ttft_p99_ms: float
    throughput_tokens_s: float
    memory_fit: bool
    peak_memory_gb: float
    power_w: float
    area_mm2: float = 0.0
    max_temperature_c: float = 0.0
    thermal_grid: List[List[float]]
    throttling: bool
    throttle_factor: float = 1.0
    duration_ms: float = 0.0
    completed_requests: int = 0
    request_outcomes: List[RequestOutcome] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")

