"""Bounded, checker-driven design campaign orchestration."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import time
import uuid
from typing import Any

from .llm_client import LLMClient, ProposalError
from .report import render_campaign_report


def _plain(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "dict"):
        return value.dict()
    if isinstance(value, dict):
        return value
    if hasattr(value, "__dict__"):
        return {k: v for k, v in vars(value).items() if not k.startswith("_")}
    return value


def _get(value: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(value, dict) and name in value:
            return value[name]
        if hasattr(value, name):
            return getattr(value, name)
    return default


class CampaignOrchestrator:
    """Owns in-process campaign state and delegates simulation/persistence."""

    def __init__(self, simulator: Any = None, storage: Any = None, proposer: Any = None) -> None:
        self.simulator = simulator or self._make_simulator()
        self.storage = storage or self._make_storage()
        self.proposer = proposer or LLMClient()
        self.baselines: dict[str, dict[str, Any]] = {}
        self.calibrations: dict[str, dict[str, Any]] = {}
        self.campaigns: dict[str, dict[str, Any]] = {}
        self.designs: dict[str, dict[str, Any]] = {}

    @staticmethod
    def _make_simulator() -> Any:
        try:
            from .simulator import DigitalTwinSimulator
            return DigitalTwinSimulator()
        except (ImportError, AttributeError):
            return None

    @staticmethod
    def _make_storage() -> Any:
        try:
            from .storage import Storage
            return Storage()
        except (ImportError, AttributeError):
            return None

    def _models(self) -> tuple[Any, Any]:
        try:
            from .models import HardwareDesign
            from .simulator import fixed_trace
            return HardwareDesign, fixed_trace
        except (ImportError, AttributeError):
            return None, None

    def _build_design(self, data: dict[str, Any]) -> Any:
        model, _ = self._models()
        if model is None:
            return dict(data)
        allowed = set(getattr(model, "model_fields", getattr(model, "__fields__", {})))
        unknown = set(data) - allowed
        if unknown:
            raise ValueError(f"design contains unsupported fields: {', '.join(sorted(unknown))}")
        if hasattr(model, "model_validate"):
            return model.model_validate(data)
        return model.parse_obj(data)

    @staticmethod
    def _topology_errors(design: Any, metrics: Any = None) -> list[str]:
        """Return structural errors from both the design model and checker."""
        errors: list[str] = []
        validator = getattr(design, "validate_topology", None)
        if callable(validator):
            try:
                errors.extend(str(error) for error in (validator() or []))
            except Exception as exc:
                errors.append(f"topology validation failed: {exc}")
        metric_errors = _get(metrics, "topology_errors", "topology_violations", default=[])
        if isinstance(metric_errors, str):
            metric_errors = [metric_errors]
        if isinstance(metric_errors, (list, tuple)):
            errors.extend(str(error) for error in metric_errors)
        return list(dict.fromkeys(errors))

    @staticmethod
    def _has_topology(design: Any, metrics: Any = None) -> bool:
        return (_get(design, "components") is not None or _get(design, "connections") is not None
                or _get(metrics, "topology_valid") is not None)

    @staticmethod
    def _design_diff(previous: Any, current: Any) -> dict[str, Any]:
        """Explain what physically changed between two complete design graphs."""
        before, after = _plain(previous) or {}, _plain(current) or {}
        keys = set(before) | set(after)
        scalar_changes = {key: {"from": before.get(key), "to": after.get(key)}
                          for key in sorted(keys - {"components", "connections"})
                          if before.get(key) != after.get(key)}
        def indexed(items: Any) -> dict[str, Any]:
            return {str(item.get("id")): item for item in items or [] if isinstance(item, dict) and item.get("id") is not None}
        old_components, new_components = indexed(before.get("components")), indexed(after.get("components"))
        old_connections, new_connections = indexed(before.get("connections")), indexed(after.get("connections"))
        def changes(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
            return {"added": [new[key] for key in sorted(new.keys() - old.keys())],
                    "removed": [old[key] for key in sorted(old.keys() - new.keys())],
                    "modified": [{"id": key, "from": old[key], "to": new[key]}
                                 for key in sorted(old.keys() & new.keys()) if old[key] != new[key]]}
        return {"scalars": scalar_changes, "components": changes(old_components, new_components),
                "connections": changes(old_connections, new_connections)}

    def _default_design(self) -> Any:
        model, _ = self._models()
        if model is None:
            return {}
        baseline = getattr(model, "baseline", None)
        return baseline() if callable(baseline) else model()

    def _trace(self, trace: Any) -> Any:
        if trace is None:
            return "A"
        model, fixed_trace = self._models()
        if fixed_trace and isinstance(trace, str):
            try:
                return fixed_trace(trace)
            except (ValueError, KeyError):
                return trace
        return trace

    async def _evaluate(self, design: Any, trace: Any) -> Any:
        if self.simulator is None:
            raise RuntimeError("DigitalTwinSimulator is unavailable")
        fn = getattr(self.simulator, "evaluate", None) or getattr(self.simulator, "run", None)
        if fn is None:
            raise RuntimeError("simulator must provide evaluate(design, trace)")
        if inspect.iscoroutinefunction(fn):
            return await fn(design, trace)
        return await asyncio.to_thread(fn, design, trace)

    def _save_result(self, result: Any, design: Any) -> str:
        if self.storage is not None and callable(getattr(self.storage, "create", None)):
            try:
                stored = self.storage.create(result, design=design)
                if isinstance(stored, str):
                    return stored
                return str(_get(stored, "id", "run_id", default=uuid.uuid4()))
            except TypeError:
                stored = self.storage.create(result, design)
                if isinstance(stored, str):
                    return stored
                return str(_get(stored, "id", "run_id", default=uuid.uuid4()))
        return str(uuid.uuid4())

    async def run_baseline(self, request: dict[str, Any]) -> dict[str, Any]:
        design_data = request.get("design")
        design = self._build_design(design_data) if design_data else self._default_design()
        trace = self._trace(request.get("trace", request.get("trace_name", "A")))
        result = await self._evaluate(design, trace)
        measured: dict[str, Any] = {}
        measurement_source = "modeled"
        if os.getenv("ACCELTWIN_MOCK_TELEMETRY", "false").lower() not in {"1", "true", "yes"}:
            try:
                from .telemetry import NeuronMonitorAdapter, collect_vllm_metrics
                metrics_url = os.getenv("ACCELTWIN_VLLM_METRICS_URL", "http://127.0.0.1:8000/metrics")
                vllm = collect_vllm_metrics(metrics_url)
                neuron = NeuronMonitorAdapter(mock_fallback=False).collect()
                if vllm or neuron:
                    measured = {"vllm": vllm, "neuron": neuron}
                    measurement_source = "measured+modeled"
            except Exception:
                # Disconnected demos retain the deterministic simulator baseline.
                pass
        run_id = self._save_result(result, design)
        record = {
            "id": run_id,
            "design": _plain(design),
            "trace": _plain(trace),
            "metrics": _plain(result),
            "measured_telemetry": measured,
            "measurement_source": measurement_source,
            "created_at": time.time(),
        }
        self.baselines[run_id] = record
        return record

    def get_baseline(self, baseline_id: str) -> dict[str, Any] | None:
        if baseline_id in self.baselines:
            return self.baselines[baseline_id]
        stored = self._storage_get(baseline_id)
        return stored

    def create_calibration(self, request: dict[str, Any]) -> dict[str, Any]:
        baseline_id = request.get("baseline_id")
        baseline = self.get_baseline(baseline_id) if baseline_id else None
        if baseline_id and baseline is None:
            raise KeyError("baseline not found")
        record = {
            "id": str(uuid.uuid4()),
            "baseline_id": baseline_id,
            "observed_metrics": request.get("observed_metrics", request.get("metrics", {})),
            "source": request.get("source", "manual"),
            "notes": request.get("notes"),
            "created_at": time.time(),
        }
        self.calibrations[record["id"]] = record
        return record

    async def create_campaign(self, request: dict[str, Any]) -> dict[str, Any]:
        baseline_id = request.get("baseline_id")
        baseline = self.get_baseline(baseline_id) if baseline_id else None
        if baseline_id and baseline is None:
            raise KeyError("baseline not found")
        if baseline is None:
            baseline = await self.run_baseline({"trace": request.get("trace", "A")})
            baseline_id = baseline["id"]
        # Re-evaluate the unchanged baseline hardware on the campaign trace so
        # candidates are never compared against a different workload.
        campaign_trace = request.get("trace", "C")
        baseline_design = self._build_design(baseline.get("design", {}))
        campaign_baseline_result = await self._evaluate(baseline_design, self._trace(campaign_trace))
        campaign_baseline_metrics = _plain(campaign_baseline_result)
        constraints = request.get("constraints", {})
        if not isinstance(constraints, dict):
            raise ValueError("constraints must be a JSON object")
        constraints = dict(constraints)
        for cap in ("max_power_w", "max_temperature_c", "max_area_mm2"):
            if cap in request and cap not in constraints:
                constraints[cap] = request[cap]
            if cap in constraints:
                try:
                    constraints[cap] = float(constraints[cap])
                except (ValueError, TypeError) as exc:
                    raise ValueError(f"{cap} must be a non-negative number") from exc
                if constraints[cap] < 0:
                    raise ValueError(f"{cap} must be a non-negative number")
        campaign_id = str(uuid.uuid4())
        rounds = min(5, max(1, int(request.get("max_rounds", 5))))
        try:
            patience = max(1, int(request.get("early_stop_patience", 2)))
        except (TypeError, ValueError) as exc:
            raise ValueError("early_stop_patience must be an integer") from exc
        campaign = {
            "id": campaign_id,
            "status": "queued",
            "baseline_id": baseline_id,
            "baseline_design": baseline.get("design", {}),
            "baseline_metrics": campaign_baseline_metrics,
            "source_baseline_metrics": baseline.get("metrics", {}),
            "trace": campaign_trace,
            "goal": request.get("goal", "Minimize p99 TTFT without reducing throughput"),
            "max_rounds": rounds,
            "early_stop_patience": patience,
            "constraints": constraints,
            "attempts": [],
            "events": [],
            "best_attempt": None,
            "latest_design": baseline.get("design", {}),
            "created_at": time.time(),
        }
        self.campaigns[campaign_id] = campaign
        self._emit(campaign, "campaign.started", {"max_rounds": rounds, "baseline_id": baseline_id, "trace": campaign_trace})
        asyncio.create_task(self._run_campaign(campaign, request))
        return campaign

    async def _run_campaign(self, campaign: dict[str, Any], request: dict[str, Any]) -> None:
        campaign["status"] = "running"
        baseline_metrics = campaign["baseline_metrics"]
        baseline_throughput = self._metric(baseline_metrics, "throughput_tokens_s", "throughput_tokens_per_sec")
        baseline_p99 = self._metric(baseline_metrics, "ttft_p99_ms", "predicted_p99_ttft_ms")
        best_p99 = baseline_p99
        best_design = campaign["baseline_design"]
        seen: set[str] = set()
        stale_rounds = 0
        design_schema = self._design_schema()
        for round_no in range(1, campaign["max_rounds"] + 1):
            prompt = self._prompt(campaign, round_no, best_design, best_p99)
            context = {
                "round": round_no - 1,
                "baseline_config": best_design,
                "baseline_metrics": baseline_metrics,
                "feedback": campaign["attempts"][-1].get("feedback") if campaign["attempts"] else None,
                "current_design": campaign.get("latest_design", best_design),
                "baseline_design": campaign.get("baseline_design", {}),
            }
            raw: dict[str, Any] = {}
            try:
                raw = self.proposer.propose(prompt, design_schema, context)
                design = self._extract_design(raw)
                design = self._build_design(design)
            except Exception as first_error:
                self._emit(campaign, "proposal.invalid", {"round": round_no, "error": str(first_error)})
                # Exactly one repair attempt. If the local model is unavailable in
                # auto mode, its deterministic fallback keeps the demo runnable.
                try:
                    raw = self.proposer.repair(prompt, json.dumps(raw), str(first_error), design_schema)
                    design = self._build_design(self._extract_design(raw))
                except Exception as repair_error:
                    if getattr(self.proposer, "mode", "") in {"mock", "rule", "rules", "offline"}:
                        raw = self.proposer._rule_proposal(context)
                        design = self._build_design(self._extract_design(raw))
                    else:
                        campaign["status"] = "failed"
                        campaign["error"] = f"proposal failed after one repair: {repair_error}"
                        self._emit(campaign, "campaign.failed", {"error": campaign["error"]})
                        return

            design_data = _plain(design)
            # Canonical full-design serialization includes all component positions,
            # dimensions, layers, and links, so a topology edit is never collapsed
            # into a duplicate scalar configuration.
            fingerprint = json.dumps(design_data, sort_keys=True, separators=(",", ":"), default=str)
            if fingerprint in seen or fingerprint == json.dumps(best_design, sort_keys=True, separators=(",", ":"), default=str):
                attempt = {
                    "id": str(uuid.uuid4()), "round": round_no, "name": _get(raw, "name", default=f"candidate {round_no}"),
                    "design": design_data, "accepted": False, "duplicate": True,
                    "feedback": "Duplicate design rejected without simulation.",
                }
                campaign["attempts"].append(attempt)
                self.designs[attempt["id"]] = attempt
                self._emit(campaign, "design.rejected", attempt)
                campaign["stop_reason"] = "duplicate design"
                break
            seen.add(fingerprint)
            previous_design = campaign.get("latest_design", campaign.get("baseline_design", {}))
            design_diff = self._design_diff(previous_design, design_data)
            campaign["latest_design"] = design_data
            self._emit(campaign, "design.proposed", {
                "round": round_no,
                "name": _get(raw, "name", default=f"candidate {round_no}"),
                "rationale": _get(raw, "rationale", default=""),
                "design": design_data,
                "design_diff": design_diff,
            })
            try:
                result = await self._evaluate(design, self._trace(campaign["trace"]))
                metrics = _plain(result)
            except Exception as exc:
                attempt = {"id": str(uuid.uuid4()), "round": round_no, "design": design_data,
                           "accepted": False, "design_diff": design_diff,
                           "feedback": f"Simulation failed: {exc}"}
                campaign["attempts"].append(attempt)
                self.designs[attempt["id"]] = attempt
                self._emit(campaign, "design.evaluated", attempt)
                continue

            topology_errors = self._topology_errors(design, metrics)
            gates = self._gate_results(metrics, baseline_throughput, campaign["constraints"],
                                       topology_required=self._has_topology(design, metrics),
                                       topology_errors=topology_errors)
            p99 = self._metric(metrics, "ttft_p99_ms", "predicted_p99_ttft_ms")
            accepted = all(gates.values())
            improved = accepted and (best_p99 is None or p99 is not None and p99 < best_p99)
            attempt_id = self._save_result(result, design)
            attempt = {
                "id": attempt_id, "round": round_no,
                "name": _get(raw, "name", default=f"candidate {round_no}"),
                "rationale": _get(raw, "rationale", default=""),
                "design": design_data, "metrics": metrics, "gate_results": gates,
                "accepted": accepted, "improved": improved,
                "topology_errors": topology_errors,
                "design_diff": design_diff,
                "baseline_design_diff": self._design_diff(campaign.get("baseline_design", {}), design_data),
                "feedback": self._feedback(gates, metrics, baseline_throughput, best_p99, topology_errors),
            }
            campaign["attempts"].append(attempt)
            self.designs[attempt_id] = attempt
            self._emit(campaign, "design.evaluated", attempt)
            if improved:
                best_p99 = p99
                best_design = design_data
                campaign["best_attempt"] = attempt
                stale_rounds = 0
                self._emit(campaign, "campaign.best_updated", {"attempt_id": attempt_id, "p99_ttft_ms": p99,
                            "design": design_data, "design_diff": attempt["design_diff"],
                            "baseline_design_diff": attempt["baseline_design_diff"]})
            else:
                stale_rounds += 1
            target = campaign["constraints"].get("target_p99_ttft_ms")
            if target is not None and best_p99 is not None and best_p99 <= float(target):
                campaign["stop_reason"] = "target p99 TTFT reached"
                break
            if stale_rounds >= campaign["early_stop_patience"]:
                campaign["stop_reason"] = "no accepted improvement"
                break
        campaign["status"] = "completed"
        campaign["completed_at"] = time.time()
        campaign["report"] = render_campaign_report(campaign)
        self._emit(campaign, "campaign.completed", {"stop_reason": campaign.get("stop_reason"), "rounds": len(campaign["attempts"])})

    @staticmethod
    def _extract_design(proposal: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(proposal, dict):
            raise ProposalError("proposal must be an object")
        extra = set(proposal) - {"name", "rationale", "design"}
        if extra:
            raise ProposalError(f"proposal contains unexpected fields: {', '.join(sorted(extra))}")
        if "name" in proposal and not isinstance(proposal["name"], str):
            raise ProposalError("proposal name must be a string")
        if "rationale" in proposal and not isinstance(proposal["rationale"], str):
            raise ProposalError("proposal rationale must be a string")
        design = proposal.get("design")
        if not isinstance(design, dict) or not design:
            raise ProposalError("proposal must include a non-empty design object")
        return design

    def _design_schema(self) -> dict[str, Any]:
        model, _ = self._models()
        if model is not None:
            schema = model.model_json_schema() if hasattr(model, "model_json_schema") else model.schema()
            schema["additionalProperties"] = False
            return {"type": "object", "properties": {
                "name": {"type": "string"}, "rationale": {"type": "string"}, "design": schema
            }, "required": ["design"], "additionalProperties": False}
        return {"type": "object", "properties": {"name": {"type": "string"}, "rationale": {"type": "string"},
                "design": {"type": "object", "properties": {
                    "components": {"type": "array", "items": {"type": "object"}},
                    "connections": {"type": "array", "items": {"type": "object"}},
                }, "required": ["components", "connections"]}}, "required": ["design"], "additionalProperties": False}

    @staticmethod
    def _metric(metrics: Any, *names: str) -> float | None:
        value = _get(metrics, *names)
        try:
            return None if value is None else float(value)
        except (ValueError, TypeError):
            return None

    @classmethod
    def _gate_results(cls, metrics: Any, baseline_throughput: float | None, constraints: dict[str, Any],
                      topology_required: bool = False, topology_errors: list[str] | None = None) -> dict[str, bool]:
        throughput = cls._metric(metrics, "throughput_tokens_s", "throughput_tokens_per_sec")
        memory_fit = _get(metrics, "memory_fit", "memory_fits", default=False)
        power = cls._metric(metrics, "power_w", "power_watts")
        temp = cls._metric(metrics, "max_temperature_c", "temperature_c", "peak_temperature_c")
        if temp is None:
            grid = _get(metrics, "thermal_grid")
            if isinstance(grid, list):
                vals = [v for row in grid if isinstance(row, list) for v in row if isinstance(v, (int, float))]
                temp = max(vals) if vals else None
        area = cls._metric(metrics, "area_mm2", "area")
        gates = {
            "throughput_at_least_baseline": throughput is not None and (baseline_throughput is None or throughput >= baseline_throughput),
            "memory_fit": bool(memory_fit),
        }
        if topology_required:
            reported_topology_valid = _get(metrics, "topology_valid", default=not topology_errors)
            gates["topology_valid"] = bool(reported_topology_valid) and not bool(topology_errors)
        for gate, metric, cap in (("power_cap", power, "max_power_w"), ("temperature_cap", temp, "max_temperature_c"), ("area_cap", area, "max_area_mm2")):
            if cap in constraints:
                gates[gate] = metric is not None and metric <= float(constraints[cap])
        return gates

    @classmethod
    def _feedback(cls, gates: dict[str, bool], metrics: Any, baseline_throughput: float | None,
                  best_p99: float | None, topology_errors: list[str] | None = None) -> str:
        issues = [key for key, passed in gates.items() if not passed]
        details = list(topology_errors or [])
        disconnected = _get(metrics, "disconnected_component_ids", "disconnected_components", default=[])
        bottlenecks = _get(metrics, "bottleneck_component_ids", "bottlenecks", default=[])
        if not disconnected:
            disconnected = sorted({component_id for error in details
                                   for component_id in re.findall(r"compute component ([^ ]+) has no HBM path", error)})
        if isinstance(disconnected, (list, tuple)) and disconnected:
            details.append("Disconnected component IDs: " + ", ".join(map(str, disconnected)))
        if isinstance(bottlenecks, (list, tuple)) and bottlenecks:
            ids_text = ", ".join(map(str, bottlenecks))
            details.append("Resource/bandwidth bottleneck component IDs: " + ids_text)
            details.append("Inspect or widen the constrained links incident to: " + ids_text)
        if _get(metrics, "thermal_bottleneck_component_ids"):
            details.append("Thermal bottleneck component IDs: " + ", ".join(map(str, _get(metrics, "thermal_bottleneck_component_ids"))))
        if _get(metrics, "bandwidth_bottleneck_component_ids"):
            details.append("Bandwidth bottleneck component IDs: " + ", ".join(map(str, _get(metrics, "bandwidth_bottleneck_component_ids"))))
        component_temperatures = _get(metrics, "component_temperatures", default={}) or {}
        if isinstance(component_temperatures, dict) and component_temperatures:
            hottest = max(float(value) for value in component_temperatures.values())
            hot_ids = [str(component_id) for component_id, value in component_temperatures.items()
                       if float(value) >= hottest - 0.5]
            details.append(f"Hottest component IDs ({hottest:g} °C): " + ", ".join(hot_ids))
        if issues:
            prefix = "Hard gate failure: " + ", ".join(issues)
            if details:
                prefix += ". Checker findings: " + "; ".join(details)
            actions = []
            if "topology_valid" in issues:
                actions.append("repair listed topology violations, reconnect all component IDs, and preserve scalar/topology consistency")
            if "memory_fit" in issues:
                actions.append("increase HBM capacity or reduce model/KV allocation")
            if "throughput_at_least_baseline" in issues:
                actions.append("increase the active compute or memory-bandwidth path")
            if "temperature_cap" in issues or "power_cap" in issues:
                actions.append("reduce hotspot activity or improve cooling without violating other caps")
            if "area_cap" in issues:
                actions.append("reduce component count or footprint")
            return prefix + (". Next round: " + "; ".join(actions) + "." if actions else "")
        p99 = cls._metric(metrics, "ttft_p99_ms", "predicted_p99_ttft_ms")
        if p99 is not None and best_p99 is not None and p99 >= best_p99:
            return f"All hard gates pass; p99 TTFT ({p99:g} ms) did not improve on best ({best_p99:g} ms)."
        return "All hard gates pass; candidate improves predicted p99 TTFT."

    @staticmethod
    def _prompt(campaign: dict[str, Any], round_no: int, best_design: dict[str, Any], best_p99: float | None) -> str:
        return (
            "Act as a chip-builder AI. Propose the complete physical accelerator design as strict JSON fields name, rationale, design. "
            "Every round must provide the full components array (IDs, type, x/y, width/height, layer and relevant capacities) and "
            "connections array (source/target IDs and bandwidth); return the entire graph, not a scalar-only patch. "
            "Change the actual layout/topology in response to checker findings. The design must satisfy the model schema and topology validator. "
            f"User design brief: {campaign.get('goal', 'Minimize p99 TTFT without reducing throughput')}. "
            "Primary scored objective: lower predicted p99 TTFT. Hard gates: topology validity, throughput at least baseline, memory fit, and all specified power, temperature, and area caps. "
            f"Round {round_no} of at most {campaign['max_rounds']}. Baseline metrics: "
            f"{json.dumps(campaign['baseline_metrics'], default=str)}. Current best p99 TTFT: {best_p99}. "
            f"Current best design: {json.dumps(best_design, default=str)}. Latest proposed design: {json.dumps(campaign.get('latest_design', best_design), default=str)}. "
            f"Checker feedback: {json.dumps(campaign['attempts'][-1].get('feedback') if campaign['attempts'] else None)}. "
            "Return a complete corrected graph with every connection endpoint referencing an existing component ID."
        )

    @staticmethod
    def _emit(campaign: dict[str, Any], event_type: str, data: dict[str, Any]) -> None:
        campaign["events"].append({"id": len(campaign["events"]) + 1, "event": event_type, "data": data, "time": time.time()})

    def _storage_get(self, item_id: str) -> dict[str, Any] | None:
        if self.storage is None or not callable(getattr(self.storage, "get", None)):
            return None
        try:
            value = self.storage.get(item_id)
            if not value:
                return None
            record = _plain(value)
            if isinstance(record, dict) and "result" in record and "metrics" not in record:
                record["metrics"] = record["result"]
            return record
        except (KeyError, LookupError):
            return None

    def get_design(self, attempt_id: str) -> dict[str, Any] | None:
        return self.designs.get(attempt_id) or self._storage_get(attempt_id)

    def get_campaign(self, campaign_id: str) -> dict[str, Any] | None:
        return self.campaigns.get(campaign_id)

    def get_report(self, campaign_id: str) -> str | None:
        campaign = self.get_campaign(campaign_id)
        if not campaign:
            return None
        return campaign.get("report") or render_campaign_report(campaign)

    def event_snapshot(self, campaign_id: str, after_id: int = 0) -> tuple[list[dict[str, Any]], bool]:
        campaign = self.get_campaign(campaign_id)
        if not campaign:
            raise KeyError("campaign not found")
        events = [event for event in campaign["events"] if event["id"] > after_id]
        return events, campaign["status"] in {"completed", "failed"}

