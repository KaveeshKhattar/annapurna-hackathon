from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app import api
from app.agent import ChipDesignAgent
from app.llm_client import LLMClient
from app.models import HardwareDesign
from app.orchestrator import CampaignOrchestrator
from app.simulator import DigitalTwinSimulator

PLAN = {
    "name": "Wider memory, six clusters",
    "rationale": "Decode is bandwidth bound, so add HBM bandwidth and spread compute.",
    "changes": ["Raise HBM bandwidth to 3.6 TB/s", "Split compute into six clusters"],
    "targets": {"compute_clusters": 6, "compute_cores": 6, "hbm_stacks": 3, "hbm_bandwidth_tb_s": 3.6},
}
GOOD_LINKS = {"links": [["hbm-0", "noc-0", 1.2], ["hbm-1", "noc-0", 1.2], ["hbm-2", "noc-0", 1.2],
                        ["sbuf-0", "noc-0", 2], ["dma-0", "noc-0", 0.5], ["dma-1", "noc-0", 0.5],
                        ["dma-2", "noc-0", 0.5], ["dma-3", "noc-0", 0.5]]
              + [["noc-0", f"compute-{i}", 0.6] for i in range(6)]}


class ScriptedChat:
    """Answers each stage from a queue and records the prompts it saw."""

    def __init__(self, floorplans, links=(GOOD_LINKS,), plan=PLAN):
        self.plan, self.floorplans, self.links = plan, list(floorplans), list(links)
        self.prompts: list[str] = []

    def __call__(self, system, user, max_tokens):
        self.prompts.append(user)
        if "Return:\n{\"name\"" in user:
            return self.plan
        if "placements" in user:
            return self.floorplans.pop(0) if self.floorplans else {}
        return self.links.pop(0) if self.links else {}


def good_floorplan():
    return {"placements": {**{f"hbm-{i}": [0.02, 0.05 + i * 0.3, 0.15, 0.26] for i in range(3)},
                           **{f"compute-{i}": [0.22 + (i % 3) * 0.2, 0.2 + (i // 3) * 0.3, 0.17, 0.26] for i in range(6)},
                           "sbuf-0": [0.84, 0.2, 0.14, 0.5],
                           **{f"dma-{i}": [0.22 + i * 0.15, 0.85, 0.12, 0.1] for i in range(4)}}}


def test_staged_rounds_produce_a_valid_design_from_small_calls():
    chat = ScriptedChat([good_floorplan()])
    proposal = ChipDesignAgent(chat).run({"round": 0, "baseline_config": HardwareDesign.baseline().model_dump()})
    design = HardwareDesign.model_validate(proposal["design"])
    assert design.validate_topology() == []
    assert len(chat.prompts) == 3
    assert proposal["steps"] == ["plan", "floorplan", "interconnect"]
    assert sum(c.type == "compute_cluster" for c in design.components) == 6
    assert design.hbm_bandwidth_tb_s == 3.6
    assert proposal["changes"] == PLAN["changes"]
    # No single prompt carries the whole graph as JSON.
    assert all(len(prompt) < 6000 for prompt in chat.prompts)
    assert DigitalTwinSimulator().evaluate(design, "C").topology_valid


def test_bad_floorplan_gets_one_targeted_repair_then_falls_back():
    overlapping = good_floorplan()
    overlapping["placements"]["compute-1"] = overlapping["placements"]["compute-0"]
    chat = ScriptedChat([overlapping, good_floorplan()])
    proposal = ChipDesignAgent(chat).run({"round": 0, "baseline_config": HardwareDesign.baseline().model_dump()})
    assert proposal["steps"][1] == "floorplan (repaired)"
    assert "compute-0 overlaps compute-1" in chat.prompts[2]

    chat = ScriptedChat([overlapping, overlapping], links=({"links": []}, {"links": []}))
    proposal = ChipDesignAgent(chat).run({"round": 0, "baseline_config": HardwareDesign.baseline().model_dump()})
    assert proposal["steps"][1].startswith("floorplan (automatic fallback")
    assert proposal["steps"][2].startswith("interconnect (automatic fallback")
    assert HardwareDesign.model_validate(proposal["design"]).validate_topology() == []


def test_disconnected_wiring_is_reported_back_to_the_model():
    broken = {"links": [link for link in GOOD_LINKS["links"] if link[1] != "compute-5"]}
    chat = ScriptedChat([good_floorplan()], links=(broken, GOOD_LINKS))
    proposal = ChipDesignAgent(chat).run({"round": 0, "baseline_config": HardwareDesign.baseline().model_dump()})
    assert "compute-5 cannot reach any HBM stack" in chat.prompts[-1]
    assert proposal["steps"][-1] == "interconnect (repaired)"


def test_json_is_extracted_from_reasoning_prose():
    raw = 'Let me think. The best plan is {"name": "x", "targets": {"hbm_gb": 128}} and that is final.'
    assert LLMClient._parse_json(raw)["targets"]["hbm_gb"] == 128


def test_campaign_uses_staged_designer_and_records_changes():
    class StagedProposer:
        mode = "openai"
        model = "openai/gpt-oss-20b"

        def design_round(self, context):
            context["report"]("Round 1: planning the architecture")
            chat = ScriptedChat([good_floorplan()])
            return ChipDesignAgent(chat, report=context["report"]).run(context)

    api.orchestrator = CampaignOrchestrator(proposer=StagedProposer())
    with TestClient(api.app) as client:
        assert client.get("/api/config").json()["model"] == "openai/gpt-oss-20b"
        campaign_id = client.post("/api/campaigns", json={"max_rounds": 1}).json()["id"]
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            campaign = client.get(f"/api/campaigns/{campaign_id}?compact=1").json()
            if campaign["status"] in {"completed", "failed"}:
                break
            time.sleep(0.02)
    assert campaign["status"] == "completed"
    attempt = campaign["attempts"][0]
    assert attempt["changes"] == PLAN["changes"]
    assert "HBM bandwidth 2.9 → 3.6 TB/s" in attempt["deltas"]
    assert "Compute clusters 4 → 6" in attempt["deltas"]
    assert "compute-5" in attempt["changed_ids"]
    assert "request_outcomes" not in attempt["metrics"]
