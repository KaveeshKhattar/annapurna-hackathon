# AccelTwin

AccelTwin is a trace-guided accelerator design agent for AWS Trainium. It observes
a fixed LLM inference workload, builds a calibrated digital twin, proposes bounded
hardware changes, rejects invalid designs, and renders each iteration as an
animated chip floorplan.

The central demo question is deliberately concrete:

> If the model, serving stack, and request trace stay fixed, what hardware change
> most improves p99 time-to-first-token without sacrificing throughput or crossing
> memory, power, temperature, or area limits?

AccelTwin is a counterfactual design tool, not a claim that software telemetry can
perfectly predict unbuilt silicon. Measured values are labeled **MEASURED**;
calibrated and counterfactual values are labeled **MODELED**.

## What the demo does

1. Captures a baseline from vLLM's Prometheus endpoint, with an offline fallback.
2. Replays deterministic calibration and bursty evaluation traces.
3. Fits a small phase-aware model for queueing, prefill, decode, memory, power, and
   an 8x8 thermal grid.
4. Calls a locally served OpenAI-compatible LLM to propose one structured hardware
   design at a time. If the model is unavailable, a deterministic proposer keeps
   the demo runnable.
5. Scores every design against hard feasibility gates and streams progress to the
   browser.
6. Produces an animated before/after die, latency waterfall, attempt history, and a
   Markdown decision report.

## Quick start

### In the hackathon pod

Keep the model server running in one shell. The preferred qualification target is
`openai/gpt-oss-20b` using all four visible logical NeuronCores. If it does not
compile reliably within 30 minutes, use the supplied Qwen model—the product logic
does not depend on a particular LLM.

```bash
cd /workspace
MODEL=openai/gpt-oss-20b TP=4 MAX_MODEL_LEN=8192 ./serve.sh
```

In a second shell:

```bash
cd /workspace/acceltwin
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.api:app --host 0.0.0.0 --port 8080
```

Open port `8080`, click **Capture baseline**, then **Start optimization**.

### Offline/local demo

Set `ACCELTWIN_MOCK_LLM=true` and `ACCELTWIN_MOCK_TELEMETRY=true`. This uses a
repeatable baseline and proposal sequence, so the complete UI works without
Trainium or a model endpoint.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACCELTWIN_LLM_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible vLLM endpoint |
| `ACCELTWIN_LLM_MODEL` | `openai/gpt-oss-20b` | Proposer model name |
| `ACCELTWIN_MOCK_LLM` | `false` | Use deterministic local proposer |
| `ACCELTWIN_VLLM_METRICS_URL` | `http://127.0.0.1:8000/metrics` | Measured serving metrics |
| `ACCELTWIN_MOCK_TELEMETRY` | `false` | Use deterministic measurements |
| `ACCELTWIN_DB_PATH` | `./data/acceltwin.db` | Local SQLite database |
| `ACCELTWIN_EVENT_LOG` | `./data/events.jsonl` | Append-only audit trail |
| `ACCELTWIN_MAX_ROUNDS` | `5` | Safety cap for the design loop |

## Project map

```text
app/
  api.py            FastAPI endpoints and static UI hosting
  orchestrator.py   bounded propose-check-score loop
  llm_client.py     structured local-LLM and deterministic proposers
  simulator.py      trace replay and calibrated digital twin
  telemetry.py      vLLM/Neuron observation adapters
  storage.py        SQLite and JSONL persistence
  report.py         decision report generation
  static/           animated dashboard
tests/               deterministic unit and API tests
k8s/                 pod-side deployment manifest
```

## Scoring contract

The primary score is modeled p99 TTFT on the held-out burst trace. A candidate is
eligible only when all gates pass:

- throughput is at least the measured baseline;
- model weights plus KV cache fit in HBM with reserve;
- power, peak junction temperature, and area proxy remain under configured caps;
- all hardware values remain inside the bounded search space.

The simulator is intentionally transparent. It separates queue delay, prefill,
first-decode, and network overhead; uses compute and bandwidth rooflines; and
shows which bottleneck caused the result.

## Demo script

1. Show the live Trainium model responding.
2. Capture a baseline and point out the **MEASURED** badge.
3. Start optimization; watch the agent alter HBM bandwidth, compute, SRAM, and
   cooling while the thermal map and latency waterfall respond.
4. Open a rejected attempt to show that the checker, not the LLM, owns feasibility.
5. Finish on the winning design and download the report.

For a reliable stage demo, run the flow once beforehand so model weights and
Neuron compilation artifacts are warm.
