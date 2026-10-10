"""Staged chip designer that fits a small-context local model.

One design round is split into short, focused model calls instead of asking
for the whole component graph at once:

1. plan        - pick architecture totals and explain the intended changes
2. floorplan   - place the blocks that the plan implies
3. interconnect - wire the placed blocks

Code, not the model, derives per-block resources from the plan totals, so the
graph always matches its scalar fields. Each stage is validated on its own and
gets one targeted repair call with the exact errors; if that still fails, a
deterministic layout or wiring keeps the round usable and the step log says so.
"""

from __future__ import annotations

import json
import math
from typing import Any, Callable

from .llm_client import ProposalError
from .models import Component, Connection, HardwareDesign

# (system prompt, user prompt, max output tokens) -> parsed JSON object
ChatFn = Callable[[str, str, int], dict]

SYSTEM = (
    "You are a senior AI-accelerator architect working with a chip simulator. "
    "Reply with exactly one JSON object and nothing else: no prose, no markdown."
)

# Bounded search space. The checker still owns feasibility; these bounds only
# keep a single proposal from wandering into meaningless territory.
BOUNDS: dict[str, tuple[float, float, type]] = {
    "compute_clusters": (1, 8, int),
    "compute_cores": (2, 16, int),
    "peak_compute_tflops": (1000.0, 5000.0, float),
    "hbm_stacks": (1, 6, int),
    "hbm_gb": (32.0, 192.0, float),
    "hbm_bandwidth_tb_s": (1.0, 8.0, float),
    "sbuf_gb": (8.0, 96.0, float),
    "dma_engines": (1, 16, int),
    "utilization": (0.4, 0.95, float),
    "power_limit_w": (300.0, 1000.0, float),
    "cooling_capacity_w": (300.0, 1000.0, float),
}
SCALARS = [key for key in BOUNDS if key not in {"compute_clusters", "hbm_stacks"}]
MAX_DMA_BLOCKS = 4
NOC_AREA_MM2 = 120.0
MIN_GAP = 0.02


def _num(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _round(value: float, digits: int = 4) -> float:
    return float(round(value, digits))


class ChipDesignAgent:
    def __init__(self, chat: ChatFn, report: Callable[[str], None] | None = None,
                 max_tokens: int = 3000) -> None:
        self.chat = chat
        self.report = report or (lambda _text: None)
        self.max_tokens = max_tokens
        self.steps: list[str] = []

    # ------------------------------------------------------------------ public

    def run(self, context: dict[str, Any]) -> dict[str, Any]:
        start = dict(context.get("baseline_config") or HardwareDesign.baseline().model_dump(mode="json"))
        round_no = int(context.get("round", 0)) + 1

        self.report(f"Round {round_no}: planning the architecture")
        plan = self._plan(context, start)
        totals = plan["targets"]

        self.report(f"Round {round_no}: placing blocks on the die")
        blocks = self._blocks(totals)
        placements = self._floorplan(blocks, start, plan["rationale"])

        self.report(f"Round {round_no}: wiring the interconnect")
        links = self._interconnect(blocks, placements, totals, start)

        design = self._assemble(start, totals, blocks, placements, links)
        return {
            "name": plan["name"],
            "rationale": plan["rationale"],
            "changes": plan["changes"],
            "design": design,
            "steps": self.steps,
            "source": "model",
        }

    # -------------------------------------------------------------- stage 1

    def _plan(self, context: dict[str, Any], start: dict[str, Any]) -> dict[str, Any]:
        current = self._current_totals(start)
        prompt = self._plan_prompt(context, start, current)
        errors: list[str] = []
        for attempt in range(2):
            text = prompt if not errors else (
                prompt + "\n\nYour previous reply was rejected: " + "; ".join(errors)
                + ". Return the corrected JSON object.")
            try:
                raw = self.chat(SYSTEM, text, self.max_tokens)
                plan = self._parse_plan(raw, current)
                self.steps.append("plan" if attempt == 0 else "plan (repaired)")
                return plan
            except ProposalError as exc:
                errors = [str(exc)]
        raise ProposalError(f"model could not produce a valid plan: {errors[0]}")

    def _plan_prompt(self, context: dict[str, Any], start: dict[str, Any], current: dict[str, Any]) -> str:
        constraints = context.get("constraints") or {}
        baseline = context.get("baseline_metrics") or {}
        best = context.get("best_metrics") or baseline
        caps = []
        if "max_power_w" in constraints:
            caps.append(f"power <= {constraints['max_power_w']:g} W")
        if "max_temperature_c" in constraints:
            caps.append(f"peak temperature <= {constraints['max_temperature_c']:g} C")
        if "max_area_mm2" in constraints:
            caps.append(f"area <= {constraints['max_area_mm2']:g} mm2")
        history = context.get("history") or []
        history_lines = "\n".join(
            f"- round {item.get('round')}: {item.get('name')} | changes: {'; '.join(item.get('changes') or []) or 'n/a'}"
            f" | {item.get('outcome')}" for item in history[-4:]) or "- none yet"
        bounds = ", ".join(f"{key} {lo:g}-{hi:g}" for key, (lo, hi, _kind) in BOUNDS.items())
        return f"""Design brief: {context.get('goal') or 'Minimize p99 time-to-first-token without reducing throughput.'}

Workload: a {start.get('model_size_b', 13):g}B-parameter LLM with {start.get('weight_bytes_per_parameter', 2):g}-byte weights, served under a bursty request trace.
Score: lower simulated p99 time-to-first-token (TTFT) is better.
Hard checks: throughput >= {self._fmt(baseline.get('throughput_tokens_s'))} tokens/s (baseline), weights + KV cache fit in HBM{', ' + ', '.join(caps) if caps else ''}.

How the simulator behaves:
- prefill and decode time = max(compute time, HBM traffic time); compute time scales with 1 / (TFLOPS x utilization)
- usable HBM bandwidth is capped by the max flow from HBM stacks to compute clusters through the links
- power ~= 85 + 420 x utilization x min(TFLOPS / 2500, 1.8) W; above min(power_limit_w, cooling_capacity_w) the chip throttles
- area ~= 42 mm2 per core + 1.45 mm2 per GB HBM + 0.65 mm2 per GB SRAM + 3.5 mm2 per DMA engine + 120 mm2 NoC
- compute clusters placed close together or at the die centre run hotter

Current best design totals: {json.dumps(current)}
Its simulated result: {self._metrics_line(best)}
Last checker feedback: {context.get('feedback') or 'none'}
Earlier rounds:
{history_lines}

Allowed ranges: {bounds}. compute_clusters must not exceed compute_cores.
Change one to three things that address the biggest bottleneck. Do not repeat a rejected idea.

Return:
{{"name": "<=6 word design name", "rationale": "one or two sentences on why", "changes": ["up to 4 short concrete changes"], "targets": {{{', '.join(f'"{key}": <number>' for key in BOUNDS)}}}}}"""

    def _parse_plan(self, raw: Any, current: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ProposalError("reply must be a JSON object")
        targets = raw.get("targets")
        if not isinstance(targets, dict):
            raise ProposalError('missing "targets" object')
        resolved: dict[str, Any] = {}
        for key, (lo, hi, kind) in BOUNDS.items():
            value = _num(targets.get(key))
            if value is None:
                value = current[key]
            value = min(hi, max(lo, value))
            resolved[key] = int(round(value)) if kind is int else _round(value, 4)
        resolved["compute_clusters"] = min(resolved["compute_clusters"], resolved["compute_cores"])
        changes = raw.get("changes")
        if isinstance(changes, str):
            changes = [changes]
        changes = [str(item).strip() for item in changes or [] if str(item).strip()][:4]
        rationale = str(raw.get("rationale") or "").strip()
        name = str(raw.get("name") or "").strip()[:60] or "Untitled design"
        return {"name": name, "rationale": rationale, "changes": changes, "targets": resolved}

    # -------------------------------------------------------------- stage 2

    @staticmethod
    def _blocks(totals: dict[str, Any]) -> list[dict[str, Any]]:
        """List every block the plan implies, with its resources and area."""
        blocks: list[dict[str, Any]] = []
        clusters, cores = totals["compute_clusters"], totals["compute_cores"]
        for i in range(clusters):
            share = cores // clusters + (1 if i < cores % clusters else 0)
            blocks.append({"id": f"compute-{i}", "type": "compute_cluster", "label": f"Compute {i + 1}",
                           "core_count": share, "compute_tflops": totals["peak_compute_tflops"] / clusters,
                           "area_mm2": share * 42.0})
        stacks = totals["hbm_stacks"]
        for i in range(stacks):
            gb = totals["hbm_gb"] / stacks
            blocks.append({"id": f"hbm-{i}", "type": "hbm", "label": f"HBM {i + 1}", "capacity_gb": gb,
                           "bandwidth_tb_s": totals["hbm_bandwidth_tb_s"] / stacks, "area_mm2": gb * 1.45})
        blocks.append({"id": "sbuf-0", "type": "sbuf", "label": "SRAM", "capacity_gb": totals["sbuf_gb"],
                       "area_mm2": totals["sbuf_gb"] * 0.65})
        dma_blocks = min(totals["dma_engines"], MAX_DMA_BLOCKS)
        for i in range(dma_blocks):
            engines = totals["dma_engines"] // dma_blocks + (1 if i < totals["dma_engines"] % dma_blocks else 0)
            blocks.append({"id": f"dma-{i}", "type": "dma", "label": f"DMA {i + 1}", "dma_engines": engines,
                           "area_mm2": engines * 3.5})
        blocks.append({"id": "noc-0", "type": "noc", "label": "Interconnect", "area_mm2": NOC_AREA_MM2})
        return blocks

    def _floorplan(self, blocks: list[dict[str, Any]], start: dict[str, Any], rationale: str) -> dict[str, list[float]]:
        placeable = [block for block in blocks if block["type"] != "noc"]
        total_area = sum(block["area_mm2"] for block in placeable) or 1.0
        rows = []
        for block in placeable:
            side = math.sqrt(0.55 * block["area_mm2"] / total_area)
            rows.append(f"- {block['id']} ({block['type']}), about {side:.2f} x {side:.2f}")
        previous = {c.get("id"): [_round(float(c.get(k, 0)), 3) for k in ("x", "y", "width", "height")]
                    for c in start.get("components") or [] if c.get("type") != "noc"}
        prompt = f"""Place the blocks of an accelerator die. Coordinates are normalized 0..1 (x to the right, y downward). Each block is [x, y, width, height].

Rules:
- every block lies fully inside the die: x >= 0, y >= 0, x + width <= 1, y + height <= 1
- blocks must not overlap; leave a gap of at least {MIN_GAP} between them
- keep the suggested sizes roughly
- put HBM stacks on the die edges next to the compute clusters they feed
- spread compute clusters apart to avoid hotspots; keep SRAM next to compute; DMA near an edge
- the interconnect (noc-0) is drawn automatically underneath; do not place it

Blocks:
{chr(10).join(rows)}

Previous placement, for reference: {json.dumps(previous)}
Design intent: {rationale or 'n/a'}

Return: {{"placements": {{"<block id>": [x, y, width, height]}}}} listing every block above."""
        ids = [block["id"] for block in placeable]
        errors: list[str] = []
        for attempt in range(2):
            text = prompt if not errors else (
                prompt + "\n\nYour previous placement was rejected:\n- " + "\n- ".join(errors[:8])
                + "\nFix these problems and return the full placement again.")
            try:
                raw = self.chat(SYSTEM, text, self.max_tokens)
            except ProposalError as exc:
                errors = [str(exc)]
                continue
            placements, errors = self._check_placements(raw, ids)
            if not errors:
                self.steps.append("floorplan" if attempt == 0 else "floorplan (repaired)")
                placements["noc-0"] = self._noc_box(placements)
                return placements
        self.steps.append("floorplan (automatic fallback: " + (errors[0] if errors else "no reply") + ")")
        return self._fallback_layout(blocks)

    @staticmethod
    def _check_placements(raw: Any, ids: list[str]) -> tuple[dict[str, list[float]], list[str]]:
        boxes = raw.get("placements") if isinstance(raw, dict) else None
        if not isinstance(boxes, dict):
            return {}, ['missing "placements" object']
        placements: dict[str, list[float]] = {}
        errors: list[str] = []
        for block_id in ids:
            box = boxes.get(block_id)
            if isinstance(box, dict):
                box = [box.get(k) for k in ("x", "y", "width", "height")]
            values = [_num(v) for v in box] if isinstance(box, list) and len(box) == 4 else None
            if not values or any(v is None for v in values):
                errors.append(f"{block_id} needs [x, y, width, height]")
                continue
            x, y, w, h = values
            if w < 0.03 or h < 0.03:
                errors.append(f"{block_id} is too small")
                continue
            # Forgive tiny overshoots by sliding the block back onto the die.
            x = min(max(x, 0.0), 1.0 - w) if x + w <= 1.03 and x >= -0.03 else x
            y = min(max(y, 0.0), 1.0 - h) if y + h <= 1.03 and y >= -0.03 else y
            if x < 0 or y < 0 or x + w > 1 or y + h > 1 or w > 1 or h > 1:
                errors.append(f"{block_id} extends outside the die")
                continue
            placements[block_id] = [_round(x), _round(y), _round(w), _round(h)]
        keys = list(placements)
        for i, a in enumerate(keys):
            ax, ay, aw, ah = placements[a]
            for b in keys[i + 1:]:
                bx, by, bw, bh = placements[b]
                if min(ax + aw, bx + bw) - max(ax, bx) > 0.01 and min(ay + ah, by + bh) - max(ay, by) > 0.01:
                    errors.append(f"{a} overlaps {b}")
        return placements, errors

    @staticmethod
    def _noc_box(placements: dict[str, list[float]]) -> list[float]:
        """Span the interconnect overlay across the compute region."""
        compute = [box for key, box in placements.items() if key.startswith("compute-")] or list(placements.values())
        x0 = max(0.0, min(b[0] for b in compute) - 0.02)
        y0 = max(0.0, min(b[1] for b in compute) - 0.02)
        x1 = min(1.0, max(b[0] + b[2] for b in compute) + 0.02)
        y1 = min(1.0, max(b[1] + b[3] for b in compute) + 0.02)
        return [_round(x0), _round(y0), _round(x1 - x0), _round(y1 - y0)]

    @staticmethod
    def _fallback_layout(blocks: list[dict[str, Any]]) -> dict[str, list[float]]:
        """Deterministic, overlap-free layout: HBM on the sides, compute grid centre."""
        placements: dict[str, list[float]] = {}
        hbm = [b["id"] for b in blocks if b["type"] == "hbm"]
        compute = [b["id"] for b in blocks if b["type"] == "compute_cluster"]
        dma = [b["id"] for b in blocks if b["type"] == "dma"]
        columns = [hbm[: math.ceil(len(hbm) / 2)], hbm[math.ceil(len(hbm) / 2):]]
        for column, x in zip(columns, (0.03, 0.81)):
            if not column:
                continue
            height = (0.64 - MIN_GAP * (len(column) - 1)) / len(column)
            for i, block_id in enumerate(column):
                placements[block_id] = [x, _round(0.18 + i * (height + MIN_GAP)), 0.16, _round(height)]
        cols = math.ceil(math.sqrt(len(compute))) if compute else 1
        rows = math.ceil(len(compute) / cols) if compute else 1
        cell_w = (0.52 - MIN_GAP * (cols - 1)) / cols
        cell_h = (0.60 - MIN_GAP * (rows - 1)) / rows
        for i, block_id in enumerate(compute):
            r, c = divmod(i, cols)
            placements[block_id] = [_round(0.24 + c * (cell_w + MIN_GAP)), _round(0.20 + r * (cell_h + MIN_GAP)),
                                    _round(cell_w), _round(cell_h)]
        placements["sbuf-0"] = [0.24, 0.03, 0.52, 0.13]
        if dma:
            width = (0.52 - MIN_GAP * (len(dma) - 1)) / len(dma)
            for i, block_id in enumerate(dma):
                placements[block_id] = [_round(0.24 + i * (width + MIN_GAP)), 0.86, _round(width), 0.08]
        placements["noc-0"] = [0.22, 0.17, 0.56, 0.66]
        return placements

    # -------------------------------------------------------------- stage 3

    def _interconnect(self, blocks: list[dict[str, Any]], placements: dict[str, list[float]],
                      totals: dict[str, Any], start: dict[str, Any]) -> list[Connection]:
        bandwidth = totals["hbm_bandwidth_tb_s"]
        rows = []
        for block in blocks:
            x, y, w, h = placements[block["id"]]
            rows.append(f"- {block['id']} ({block['type']}) centre ({x + w / 2:.2f}, {y + h / 2:.2f})")
        previous = [[c.get("source"), c.get("target"), c.get("bandwidth_tb_s")] for c in start.get("connections") or []]
        prompt = f"""Wire an accelerator die. The blocks are already placed:
{chr(10).join(rows)}

HBM provides {bandwidth:g} TB/s in total across {totals['hbm_stacks']} stacks ({bandwidth / totals['hbm_stacks']:.3g} TB/s each); there are {totals['compute_clusters']} compute clusters.

Rules:
- every compute cluster must reach at least one HBM stack, directly or through noc-0
- connect sbuf-0 and every DMA block to noc-0 or to a compute cluster
- each link is [source id, target id, bandwidth in TB/s] with bandwidth between 0.05 and {2 * bandwidth:g}
- the simulator scores the max flow from HBM to compute, the average hop count, and wire length: short direct HBM-to-compute links help, but links wider than the HBM can feed add nothing

Previous links, for reference: {json.dumps(previous)}

Return: {{"links": [["hbm-0", "noc-0", 1.0], ...]}}"""
        ids = {block["id"]: block["type"] for block in blocks}
        errors: list[str] = []
        for attempt in range(2):
            text = prompt if not errors else (
                prompt + "\n\nYour previous wiring was rejected:\n- " + "\n- ".join(errors[:8])
                + "\nFix these problems and return all links again.")
            try:
                raw = self.chat(SYSTEM, text, self.max_tokens)
            except ProposalError as exc:
                errors = [str(exc)]
                continue
            links, errors = self._check_links(raw, ids, bandwidth)
            if not errors:
                self.steps.append("interconnect" if attempt == 0 else "interconnect (repaired)")
                return links
        self.steps.append("interconnect (automatic fallback: " + (errors[0] if errors else "no reply") + ")")
        return self._fallback_links(blocks, totals)

    @staticmethod
    def _check_links(raw: Any, ids: dict[str, str], bandwidth: float) -> tuple[list[Connection], list[str]]:
        items = raw.get("links") if isinstance(raw, dict) else None
        if not isinstance(items, list) or not items:
            return [], ['missing "links" list']
        merged: dict[tuple[str, str], float] = {}
        errors: list[str] = []
        for item in items:
            if isinstance(item, dict):
                item = [item.get("source"), item.get("target"), item.get("bandwidth_tb_s", item.get("bandwidth"))]
            if not isinstance(item, list) or len(item) != 3:
                errors.append(f"link {item!r} must be [source, target, bandwidth]")
                continue
            source, target, value = str(item[0]), str(item[1]), _num(item[2])
            if source not in ids or target not in ids:
                errors.append(f"link {source} -> {target} references an unknown block")
                continue
            if source == target:
                continue
            if value is None or value <= 0:
                errors.append(f"link {source} -> {target} needs a positive bandwidth")
                continue
            key = (source, target)
            merged[key] = merged.get(key, 0.0) + min(max(value, 0.05), 2 * bandwidth)
        adjacency: dict[str, set[str]] = {block_id: set() for block_id in ids}
        for source, target in merged:
            adjacency[source].add(target)
            adjacency[target].add(source)
        hbm = {block_id for block_id, kind in ids.items() if kind == "hbm"}
        for block_id, kind in ids.items():
            if kind == "compute_cluster":
                seen, todo = {block_id}, [block_id]
                while todo:
                    for nxt in adjacency[todo.pop()]:
                        if nxt not in seen:
                            seen.add(nxt)
                            todo.append(nxt)
                if not seen & hbm:
                    errors.append(f"{block_id} cannot reach any HBM stack")
            elif kind in {"sbuf", "dma", "hbm"} and not adjacency[block_id]:
                errors.append(f"{block_id} is not connected")
        links = [Connection(id=f"{source}--{target}", source=source, target=target,
                            bandwidth_tb_s=_round(value, 4), latency_ns=8 if "hbm" in source + target else 10)
                 for (source, target), value in merged.items()]
        return links, errors

    @staticmethod
    def _fallback_links(blocks: list[dict[str, Any]], totals: dict[str, Any]) -> list[Connection]:
        bandwidth = totals["hbm_bandwidth_tb_s"]
        links = []
        for block in blocks:
            kind, block_id = block["type"], block["id"]
            if kind == "noc":
                continue
            if kind == "hbm":
                links.append(Connection(id=f"{block_id}--noc-0", source=block_id, target="noc-0",
                                        bandwidth_tb_s=_round(block["bandwidth_tb_s"]), latency_ns=8))
            elif kind == "compute_cluster":
                links.append(Connection(id=f"noc-0--{block_id}", source="noc-0", target=block_id,
                                        bandwidth_tb_s=_round(bandwidth / totals["compute_clusters"]), latency_ns=10))
            elif kind == "sbuf":
                links.append(Connection(id="sbuf-0--noc-0", source="sbuf-0", target="noc-0",
                                        bandwidth_tb_s=_round(bandwidth), latency_ns=6))
            else:
                links.append(Connection(id=f"{block_id}--noc-0", source=block_id, target="noc-0",
                                        bandwidth_tb_s=_round(max(bandwidth / MAX_DMA_BLOCKS, 0.05)), latency_ns=8))
        return links

    # ------------------------------------------------------------- assembly

    def _assemble(self, start: dict[str, Any], totals: dict[str, Any], blocks: list[dict[str, Any]],
                  placements: dict[str, list[float]], links: list[Connection]) -> dict[str, Any]:
        def build(boxes: dict[str, list[float]], edges: list[Connection]) -> HardwareDesign:
            components = []
            for block in blocks:
                x, y, w, h = boxes[block["id"]]
                components.append(Component(
                    id=block["id"], type=block["type"], label=block["label"], x=x, y=y, width=w, height=h,
                    layer=0 if block["type"] == "noc" else 1,
                    core_count=block.get("core_count", 0), compute_tflops=_round(block.get("compute_tflops", 0)),
                    capacity_gb=_round(block.get("capacity_gb", 0)), bandwidth_tb_s=_round(block.get("bandwidth_tb_s", 0)),
                    dma_engines=block.get("dma_engines", 0), area_mm2=_round(block["area_mm2"], 2)))
            fields = {key: value for key, value in start.items() if key not in {"components", "connections", "name"}}
            fields.update({key: totals[key] for key in SCALARS})
            return HardwareDesign(**fields, components=components, connections=edges)

        design = build(placements, links)
        errors = design.validate_topology()
        if errors:
            # The stage checks should make this unreachable; stay safe anyway.
            self.steps.append("assembly fallback: " + errors[0])
            design = build(self._fallback_layout(blocks), self._fallback_links(blocks, totals))
        return design.model_dump(mode="json")

    # -------------------------------------------------------------- helpers

    @staticmethod
    def _current_totals(start: dict[str, Any]) -> dict[str, Any]:
        defaults = HardwareDesign.baseline().model_dump(mode="json")
        components = start.get("components") or []
        totals = {key: start.get(key, defaults.get(key)) for key in SCALARS}
        totals["compute_clusters"] = sum(1 for c in components if c.get("type") == "compute_cluster") or 4
        totals["hbm_stacks"] = sum(1 for c in components if c.get("type") == "hbm") or 2
        return {key: totals[key] for key in BOUNDS}

    @staticmethod
    def _fmt(value: Any) -> str:
        number = _num(value)
        return "n/a" if number is None else f"{number:.4g}"

    @classmethod
    def _metrics_line(cls, metrics: dict[str, Any]) -> str:
        return (f"p99 TTFT {cls._fmt(metrics.get('ttft_p99_ms'))} ms, throughput {cls._fmt(metrics.get('throughput_tokens_s'))} tokens/s, "
                f"power {cls._fmt(metrics.get('power_w'))} W, peak temperature {cls._fmt(metrics.get('max_temperature_c'))} C, "
                f"area {cls._fmt(metrics.get('area_mm2'))} mm2, throttling {bool(metrics.get('throttling'))}")
