# Chip Builder AI (AccelTwin)

Chip Builder AI is an agent that designs accelerator architectures for a real LLM
workload. On every round, the locally hosted LLM returns a complete, structured
chip proposal: compute clusters, HBM stacks, on-chip SRAM, DMA engines, NoC,
connections, bandwidths, and physical placement. The application renders that
exact proposal as the central artifact, checks it, simulates it, and sends concrete
failures or bottlenecks back to the model for the next design.

The central demo question is deliberately concrete:

> If the model, serving stack, and request trace stay fixed, what hardware change
> most improves p99 time-to-first-token without sacrificing throughput or crossing
> memory, power, temperature, or area limits?

This is rapid architecture exploration, not fabrication-ready chip design. It does
not generate RTL, complete place-and-route, timing closure, or sign-off. Measured
values are labeled **MEASURED**; simulated values are labeled **MODELED**.

## What the demo does

1. Starts from a Trainium2-like baseline graph sized for the assigned 96 GB device.
2. Captures the fixed LLM workload from vLLM Prometheus, with an offline fallback.
3. Asks a locally served LLM to build one complete hardware graph and floorplan.
4. Validates physical bounds, overlap, resource totals, endpoints, and every
   compute-to-memory path before simulation.
5. Simulates topology-aware queueing, prefill, decode, bandwidth, power, placement,
   and temperature; the checker sends actionable findings into the next round.
6. Streams each exact model-authored design into an interactive SVG chip view and
   finishes on the best feasible architecture with a downloadable decision report.

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

Open port `8080`, enter a design brief, then click **Build and test chip**.

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
  simulator.py      graph-aware workload, physical, power, and thermal checker
  telemetry.py      vLLM/Neuron observation adapters
  storage.py        SQLite and JSONL persistence
  report.py         decision report generation
  static/           exact component-graph and floorplan renderer
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

1. Show the locally hosted LLM responding on Trainium.
2. Enter a brief such as “minimize p99 TTFT without reducing throughput.”
3. Click **Build and test chip**. The first full component graph appears immediately.
4. Watch blocks, links, bandwidths, and placement change after checker feedback;
   click any component to inspect the model-authored values and live simulation.
5. Open a rejected proposal to show that the checker—not the LLM—owns feasibility.
6. Finish on the highlighted best chip and its p99, throughput, power, temperature,
   area, topology validation, design diff, and downloadable report.

For a reliable stage demo, run the flow once beforehand so model weights and
Neuron compilation artifacts are warm.
