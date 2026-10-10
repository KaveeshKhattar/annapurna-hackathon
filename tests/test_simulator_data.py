import json

from app.models import HardwareDesign, RequestSpec, RequestTrace
from app.simulator import DigitalTwinSimulator, fixed_trace
from app.storage import Storage
from app.telemetry import NeuronMonitorAdapter, parse_vllm_metrics


def test_baseline_and_replay_are_deterministic():
    design = HardwareDesign.baseline()
    assert (design.compute_cores, design.hbm_gb, design.hbm_bandwidth_tb_s) == (4, 96, 2.9)
    sim = DigitalTwinSimulator()
    first = sim.evaluate(design, fixed_trace("A"))
    second = sim.evaluate(design, "A")
    assert first.model_dump() == second.model_dump()
    assert len(first.thermal_grid) == 8
    assert all(len(row) == 8 for row in first.thermal_grid)
    assert first.ttft_p99_ms >= first.ttft_p50_ms
    assert first.completed_requests == 12
    assert first.area_mm2 > 0
    assert first.max_temperature_c == max(max(row) for row in first.thermal_grid)


def test_memory_overflow_and_power_throttle_are_reported():
    design = HardwareDesign(model_size_b=100, hbm_gb=16, power_limit_w=100, cooling_capacity_w=120)
    trace = RequestTrace(name="tiny", requests=[RequestSpec(prompt_tokens=16, output_tokens=4)])
    result = DigitalTwinSimulator().evaluate(design, trace)
    assert not result.memory_fit
    assert result.throttling
    assert result.throttle_factor < 1


def test_sqlite_and_jsonl_round_trip(tmp_path):
    storage = Storage(tmp_path / "runs.db", tmp_path / "runs.jsonl")
    design = HardwareDesign.baseline()
    result = DigitalTwinSimulator().evaluate(design, "C")
    run_id = storage.create(result, design)
    saved = storage.get(run_id)
    assert saved["result"]["trace_name"] == "C"
    assert storage.list(limit=1)[0]["id"] == run_id
    lines = (tmp_path / "runs.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["id"] == run_id


def test_prometheus_parser_and_neuron_mock_fallback():
    metrics = parse_vllm_metrics(
        "# HELP vllm:num_requests_running requests\n"
        "vllm:num_requests_running{engine=\"0\"} 2\n"
        "vllm:num_requests_running{engine=\"1\"} 3\n"
        "vllm:time_to_first_token_seconds_sum 1.25\n"
    )
    assert metrics["vllm:num_requests_running"] == 5
    assert metrics["vllm:time_to_first_token_seconds_sum"] == 1.25
    adapter = NeuronMonitorAdapter()
    assert adapter.collect()["source"] == "mock"
    assert adapter.is_mock

