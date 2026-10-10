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
| `ACCELTWIN_LLM_TIMEOUT` | `240` | Seconds per model call |
| `ACCELTWIN_LLM_MAX_TOKENS` | `3000` | Output budget per call, including gpt-oss reasoning |
| `ACCELTWIN_LLM_REASONING_EFFORT` | `low` | gpt-oss reasoning effort; empty to omit |
| `ACCELTWIN_LLM_JSON_MODE` | `false` | Send `response_format: json_object` |
| `ACCELTWIN_REPLAY_REQUESTS` | `8` | Requests replayed to measure the live workload |
| `ACCELTWIN_REPLAY_CONCURRENCY` | `4` | Requests in flight during the replay |
| `ACCELTWIN_NEURON_TRACE_DIR` | `/workspace/neuron-trace` | Neuron Explorer capture to summarize |

## Scenarios

The page frames each run as problem → measurement → exploration → solution.
Pick one of five problems (`app/scenarios.py`); each sets the objective, the hard
budget, and how the measured workload is reshaped before simulation:

| Scenario | Objective | Budget / guard | Workload |
| --- | --- | --- | --- |
| Interactive chat | lower p99 TTFT | 600 W, 85 °C, 650 mm²; throughput ≥ today | as measured, 80% load |
| Long-context RAG | lower p99 TTFT | same | 4× prompts, ½ outputs |
| Batch throughput | higher tokens/s | same; p99 TTFT ≤ today | 2× outputs, saturated |
| Power-capped part | lower p99 TTFT | 350 W, 75 °C, 450 mm²; ≥ 70% of today's throughput | 60% load |
| Cost-down | smaller die | same as chat; p99 TTFT and throughput ≤/≥ today | as measured |

When today's chip breaks a scenario's budget, the first design that passes every
check wins, and later designs must beat it. The planner gets objective-specific
guidance (e.g. an area breakdown for cost-down) so latency advice never pulls an
area search the wrong way.

While a run is live, the page streams the replay (per-request prefill/decode
progress, tokens/s, NeuronCore utilization, KV cache) and every model call the
agent makes (stage, tokens streamed, duration).

## What the checker measures

Each run starts by replaying a short burst (8 requests, 4 at a time) against the
live vLLM server and measuring it three ways:

| Source | What is used |
| --- | --- |
| vLLM Prometheus `/metrics` (before/after deltas) | TTFT p50/p99, queue, prefill, per-output-token time, prompt and output tokens per request, KV-cache peak, model weight size |
| `neuron-monitor` (1 s samples during the replay) | NeuronCore utilization, device memory in use |
| Neuron Explorer system trace (`neuron-explorer view --output-format json`) | over the traffic window: NeuronCore busy %, on-device prefill and decode-step time, share of execution in collectives and host copies, HBM in use |

vllm-neuron writes the runtime profile only when its workers shut down, so a
trace is a one-off capture (it is summarized once, then cached next to it):

```bash
/workspace/serve.sh --stop
VLLM_NEURON_WORKER_TERMINATION_TIMEOUT=60 NEURON_RT_INSPECT_ENABLE=1 \
NEURON_RT_INSPECT_OUTPUT_DIR=/workspace/neuron-trace \
MODEL=unsloth/gpt-oss-20b-BF16 TP=4 MAX_MODEL_LEN=8192 /workspace/serve.sh
# send some traffic (or start one design run), then flush the profile:
/workspace/serve.sh --stop
MODEL=unsloth/gpt-oss-20b-BF16 TP=4 MAX_MODEL_LEN=8192 /workspace/serve.sh   # back to normal
```

This captures the system profile only. Arithmetic intensity and HBM bandwidth
utilization need device profiles; if those are present they are read too.
vllm-neuron does not populate its FLOPs/bytes counters, so without them the
compute- vs memory-bound split comes from the calibrated simulator. Missing
sources are shown as such.

The measurements calibrate the simulator (prefill and decode time scales, model
size, spill share) and shape the evaluation workload: 32 requests in bursts at
about 80% of the baseline's capacity. Every design is scored on p99 TTFT and must
pass throughput, memory, power, temperature, area and layout gates. Failures go
back to the model with the limiting resource and an absolute target, e.g.
"decode is memory-bound … raise HBM bandwidth" or "fits at compute_cores <= 7".

## How a design round works

`gpt-oss-20b` is served with an 8k context, so one round is split into small,
validated calls (`app/agent.py`) instead of one call for the whole chip graph:

1. **Plan** picks architecture totals (clusters, cores, TFLOPS, HBM, SRAM, DMA,
   utilization, power, cooling) and states the intended changes.
2. **Floorplan** assigns each block to a die region (an edge or the centre);
   code packs regions into exact, overlap-free boxes and keeps unchanged regions
   where they were.
3. **Interconnect** wires the placed blocks; wiring that cannot carry the HBM
   bandwidth to compute is sent back, then widened.

Code derives each block's resources from the plan totals, so the graph always
matches its scalar fields. Each stage that fails validation gets one repair call
with the exact errors. If the repair still fails, a deterministic layout or wiring
is used and the round's `steps` record it.

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
