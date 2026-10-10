from __future__ import annotations

from app.models import HardwareDesign
from app.orchestrator import CampaignOrchestrator
from app.simulator import DigitalTwinSimulator
from app.telemetry import hist_quantile, scrape_prometheus, summarize_trace_json, summarize_vllm

M = 'model_name="gpt-oss"'


def exposition(ttft_counts, prompt_total, gen_total, prefill_sum, count):
    bounds = ["0.1", "0.25", "0.5", "1.0", "+Inf"]
    lines = ["# TYPE vllm:time_to_first_token_seconds histogram"]
    lines += [f'vllm:time_to_first_token_seconds_bucket{{engine="0",le="{b}",{M}}} {c}' for b, c in zip(bounds, ttft_counts)]
    lines += [f'vllm:time_to_first_token_seconds_sum{{engine="0",{M}}} {0.3 * count}',
              f'vllm:time_to_first_token_seconds_count{{engine="0",{M}}} {count}',
              f'vllm:request_prefill_time_seconds_bucket{{engine="0",le="+Inf",{M}}} {count}',
              f'vllm:request_prefill_time_seconds_sum{{engine="0",{M}}} {prefill_sum}',
              f'vllm:request_prefill_time_seconds_count{{engine="0",{M}}} {count}',
              f'vllm:prompt_tokens_total{{engine="0",{M}}} {prompt_total}',
              f'vllm:generation_tokens_total{{engine="0",{M}}} {gen_total}',
              f'vllm:request_success_total{{engine="0",finished_reason="stop",{M}}} {count}',
              f'vllm:request_success_total{{engine="0",finished_reason="length",{M}}} 0',
              f'vllm:kv_cache_usage_perc{{engine="0",{M}}} 0.0',
              f'vllm_neuron:model_load_size_bytes{{{M}}} 4.7e10']
    return "\n".join(lines)


def test_prometheus_deltas_give_per_replay_latency_and_tokens():
    before = scrape_prometheus(exposition([0, 2, 4, 4, 4], 1000, 400, 1.0, 4))
    after = scrape_prometheus(exposition([0, 2, 10, 12, 12], 5000, 1680, 3.4, 12))
    assert before["hists"]["vllm:time_to_first_token_seconds"]["count"] == 4
    summary = summarize_vllm(before, after, wall_s=10.0, kv_peak=0.31)
    assert summary["requests"] == 8
    assert 250 < summary["ttft_p50_ms"] < 500            # 6 of the 8 new requests land in 0.25-0.5 s
    assert summary["prefill_ms"] == 300.0                  # (3.4 - 1.0) s over 8 requests
    assert summary["throughput_tokens_s"] == (4000 + 1280) / 10.0
    assert summary["kv_cache_peak_pct"] == 31.0
    assert summary["model_weights_gb"] == 47.0
    assert hist_quantile({"buckets": {}, "sum": 0, "count": 0}, 0.5) is None


def test_system_trace_summary_names_the_memory_bound():
    payload = {"summaries": [{"mm_arithmetic_intensity": 40.0, "peak_flops_bandwidth_ratio": 860.0,
                              "mbu_estimated_percent": 70.0, "hbm_read_bytes": 9e9, "hbm_write_bytes": 1e9,
                              "spill_save_bytes": 5e8, "spill_reload_bytes": 5e8},
                             {"mm_arithmetic_intensity": 60.0, "peak_flops_bandwidth_ratio": 860.0,
                              "mbu_estimated_percent": 50.0}]}
    summary = summarize_trace_json(payload)
    assert summary["available"] and summary["profiles"] == 2
    assert summary["arithmetic_intensity"] == 50.0 and summary["ridge_point"] == 860.0
    assert summary["spill_fraction"] == 0.1
    assert summarize_trace_json({"nothing": 1})["available"] is False


def test_calibration_fits_simulator_to_measured_prefill_and_decode():
    orchestrator = CampaignOrchestrator(simulator=DigitalTwinSimulator())
    telemetry = {"vllm": {"available": True, "prefill_ms": 250.0, "inter_token_ms": 30.0,
                          "prompt_tokens_mean": 600, "generation_tokens_mean": 150, "model_weights_gb": 47.4},
                 "system_trace": {"available": True, "spill_fraction": 0.12}}
    calibration, trace, design = orchestrator._calibrate(telemetry)
    assert design.model_size_b == 23.7
    assert calibration["spill_source"] == "system trace"
    assert trace.name == "live" and len(trace.requests) == 32
    result = orchestrator.simulator.evaluate(design, trace)
    # The calibrated roofline reproduces the measured per-token decode time.
    assert abs(max(result.decode_compute_ms, result.decode_memory_ms) - 30.0) < 0.5
    assert result.decode_bound == "memory"
    signals = orchestrator._signals({"telemetry": {**telemetry, "vllm": {**telemetry["vllm"], "ttft_p50_ms": 300}},
                                     "baseline_metrics": result.model_dump()})
    assert any("vLLM on Trainium (measured)" in line for line in signals)


def test_checker_feedback_names_the_change_that_fixes_power():
    design = HardwareDesign(peak_compute_tflops=4000, utilization=0.9).model_dump()
    metrics = {"power_w": 600, "raw_power_w": 690, "throughput_tokens_s": 100, "memory_fit": True,
               "decode_bound": "memory", "decode_compute_ms": 1.0, "decode_memory_ms": 9.0,
               "prefill_bound": "compute", "prefill_compute_ms": 40, "prefill_memory_ms": 20}
    gates = {"throughput_at_least_baseline": True, "memory_fit": True, "power_cap": False}
    text = CampaignOrchestrator._feedback(gates, metrics, 90, 50, design=design, constraints={"max_power_w": 600})
    assert "peak compute must be at most 3406 TFLOPS" in text
    assert "Decode is memory-bound" in text
    rows = CampaignOrchestrator._checks(metrics, design, 90, {"max_power_w": 550})
    power = next(row for row in rows if row["key"] == "power_cap")
    assert power["passed"] is False and power["limit"] == 550


def test_area_feedback_gives_absolute_targets_not_relative_steps():
    design = HardwareDesign(compute_cores=8).model_dump()
    gates = {"throughput_at_least_baseline": True, "memory_fit": True, "area_cap": False}
    text = CampaignOrchestrator._feedback(gates, {"area_mm2": 654}, 90, 50, design=design,
                                          constraints={"max_area_mm2": 650})
    assert "compute_cores <= 7" in text and "hbm_gb <= 93" in text
