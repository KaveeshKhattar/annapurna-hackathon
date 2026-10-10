"""Human-readable campaign report rendering."""

from __future__ import annotations

from typing import Any


def render_campaign_report(campaign: dict[str, Any]) -> str:
    baseline = campaign.get("baseline_metrics") or {}
    attempts = campaign.get("attempts") or []
    winner = campaign.get("best_attempt") or {}
    lines = [
        f"# AccelTwin campaign: {campaign.get('id', 'unknown')}",
        "",
        f"Status: **{campaign.get('status', 'unknown')}**",
        f"Objective: minimize predicted p99 TTFT; throughput must meet or exceed baseline.",
        "Evidence labels: request telemetry is measured when available; hardware, power, area, and thermal counterfactuals are modeled.",
        "",
        "## Baseline",
        "",
        f"- Predicted p99 TTFT: {baseline.get('predicted_p99_ttft_ms', baseline.get('ttft_p99_ms', 'n/a'))} ms",
        f"- Throughput: {baseline.get('throughput_tokens_per_sec', baseline.get('throughput_tokens_s', 'n/a'))} tokens/s",
        f"- Memory: {baseline.get('memory_gb', 'n/a')} GB",
        f"- Modeled power: {baseline.get('power_w', 'n/a')} W",
        f"- Modeled peak temperature: {baseline.get('max_temperature_c', 'n/a')} °C",
        f"- Modeled area proxy: {baseline.get('area_mm2', 'n/a')} mm²",
        "",
        "## Attempts",
        "",
        "| Round | Candidate | p99 TTFT (ms) | Throughput (tokens/s) | Gates | Accepted |",
        "|---:|---|---:|---:|---|:---:|",
    ]
    for attempt in attempts:
        metrics = attempt.get("metrics") or {}
        gates = attempt.get("gate_results") or {}
        gate_text = ", ".join(f"{key}={'pass' if value else 'fail'}" for key, value in gates.items()) or "n/a"
        lines.append(
            f"| {attempt.get('round', 'n/a')} | {attempt.get('name', attempt.get('id', 'candidate'))} "
            f"| {metrics.get('predicted_p99_ttft_ms', metrics.get('ttft_p99_ms', 'n/a'))} "
            f"| {metrics.get('throughput_tokens_per_sec', metrics.get('throughput_tokens_s', 'n/a'))} "
            f"| {gate_text} | {'yes' if attempt.get('accepted') else 'no'} |"
        )
    if not attempts:
        lines.append("| — | No candidates evaluated | — | — | — | — |")
    winner_metrics = winner.get("metrics") or {}
    lines += [
        "",
        "## Result",
        "",
        f"Best candidate: **{winner.get('name', 'baseline')}**",
        f"Predicted p99 TTFT: {winner_metrics.get('predicted_p99_ttft_ms', winner_metrics.get('ttft_p99_ms', baseline.get('predicted_p99_ttft_ms', baseline.get('ttft_p99_ms', 'n/a'))))} ms",
        f"Throughput: {winner_metrics.get('throughput_tokens_s', 'n/a')} tokens/s",
        f"Modeled power / peak temperature / area: {winner_metrics.get('power_w', 'n/a')} W / {winner_metrics.get('max_temperature_c', 'n/a')} °C / {winner_metrics.get('area_mm2', 'n/a')} mm²",
        f"Rounds evaluated: {len(attempts)}",
        "",
    ]
    return "\n".join(lines)

