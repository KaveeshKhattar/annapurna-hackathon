'use strict';

// Hard limits sent with every run; the checker enforces them.
const CONSTRAINTS = { max_power_w: 600, max_temperature_c: 85, max_area_mm2: 650 };
const MAX_ROUNDS = 5;
const POLL_MS = 1500;
const STEPS = ['measure', 'calibrate', 'plan', 'floorplan', 'wire', 'simulate', 'done'];

const BLOCK_STYLE = {
  compute_cluster: ['var(--compute-fill)', 'var(--compute-stroke)', 'Compute'],
  hbm: ['var(--hbm-fill)', 'var(--hbm-stroke)', 'HBM'],
  sbuf: ['var(--sbuf-fill)', 'var(--sbuf-stroke)', 'SRAM'],
  dma: ['var(--dma-fill)', 'var(--dma-stroke)', 'DMA'],
  router: ['#f4f4f5', '#a1a1aa', 'Router'],
  io: ['#f4f4f5', '#a1a1aa', 'I/O'],
};
const SHORT = {
  'HBM bandwidth': 'HBM BW', 'HBM capacity': 'HBM', 'Compute cores': 'Cores', 'Compute': 'TFLOPS',
  'On-chip SRAM': 'SRAM', 'DMA engines': 'DMA', 'Utilization': 'Util', 'Power limit': 'Power cap',
  'Cooling': 'Cooling', 'Compute clusters': 'Clusters', 'HBM stacks': 'HBM stacks', 'Links': 'Links',
};

const state = { campaignId: null, rendered: new Set(), entries: new Map(), selected: null, timer: null, baseline: null };
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (v, digits = 0) => (num(v) === null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const short = (v) => (num(v) === null ? '—' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : +v.toPrecision(3));

function fmtMs(v) {
  if (num(v) === null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} s`;
  return v < 10 ? `${v.toFixed(2)} ms` : `${Math.round(v)} ms`;
}
function pct(value, base) {
  return num(value) === null || !num(base) ? null : ((value - base) / base) * 100;
}
const signed = (p, digits = 1) => `${p > 0 ? '+' : '−'}${Math.abs(p).toFixed(digits)}%`;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function countUp(node, to, render, ms = 900) {
  if (num(to) === null || reducedMotion()) { node.textContent = render(to); return; }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / ms);
    node.textContent = render(to * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function transition(update) {
  if (document.startViewTransition && !reducedMotion()) document.startViewTransition(update);
  else update();
}

// ------------------------------------------------------------------ diagram

function blockLabel(c) {
  const index = Number(String(c.id).split('-').pop());
  if (c.type === 'sbuf') return 'SRAM';
  const name = (BLOCK_STYLE[c.type] || [])[2] || c.type;
  return Number.isFinite(index) ? `${name} ${index + 1}` : c.id;
}
function blockValue(c) {
  if (c.type === 'compute_cluster' && c.compute_tflops) return `${Math.round(c.compute_tflops)} TF`;
  if (c.type === 'hbm' && c.capacity_gb) return `${+c.capacity_gb.toFixed(1)} GB · ${+c.bandwidth_tb_s.toFixed(2)} TB/s`;
  if (c.type === 'sbuf' && c.capacity_gb) return `${+c.capacity_gb.toFixed(1)} GB`;
  if (c.type === 'dma' && c.dma_engines > 1) return `×${c.dma_engines}`;
  return '';
}

function drawDiagram(design, changedIds = [], previousBoxes = {}) {
  const S = 300, P = 10;
  const root = svg('svg', { viewBox: `0 0 ${S + 2 * P} ${S + 2 * P}`, role: 'img', 'aria-label': 'Chip floorplan' });
  const components = (design && design.components) || [];
  const connections = (design && design.connections) || [];
  const changed = new Set(changedIds || []);
  const box = (c) => ({ x: P + c.x * S, y: P + c.y * S, w: c.width * S, h: c.height * S });

  root.append(svg('rect', { x: P, y: P, width: S, height: S, rx: 12, fill: '#fff', stroke: '#e4e4e7' }));
  for (const c of components.filter((c) => c.type === 'noc')) {
    const b = box(c);
    root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill: '#f4f4f5', stroke: '#d4d4d8', 'stroke-dasharray': '4 3' }));
  }

  const byId = Object.fromEntries(components.map((c) => [c.id, c]));
  const maxBw = Math.max(0.01, ...connections.map((e) => e.bandwidth_tb_s || 0));
  for (const edge of connections) {
    const a = byId[edge.source], b = byId[edge.target];
    if (!a || !b) continue;
    const pa = box(a), pb = box(b);
    root.append(svg('line', { class: 'link-line', x1: pa.x + pa.w / 2, y1: pa.y + pa.h / 2, x2: pb.x + pb.w / 2, y2: pb.y + pb.h / 2,
      'stroke-width': (0.8 + 2.6 * (edge.bandwidth_tb_s || 0) / maxBw).toFixed(2) }));
  }

  // Ghost outlines where moved blocks used to sit.
  for (const [id, [x, y, w, h]] of Object.entries(previousBoxes || {})) {
    const now = byId[id];
    if (!now || (Math.abs(now.x - x) < 0.006 && Math.abs(now.y - y) < 0.006 && Math.abs(now.width - w) < 0.006)) continue;
    root.append(svg('rect', { class: 'ghost', x: P + x * S, y: P + y * S, width: w * S, height: h * S, rx: 5 }));
  }

  components.filter((c) => c.type !== 'noc').forEach((c, i) => {
    const b = box(c);
    const [fill, stroke] = BLOCK_STYLE[c.type] || BLOCK_STYLE.io;
    const isChanged = changed.has(c.id);
    const g = svg('g', { class: isChanged ? 'blk blk-changed' : 'blk', style: `animation-delay:${i * 25}ms` });
    g.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 5, fill,
      stroke: isChanged ? 'var(--changed)' : stroke, 'stroke-width': isChanged ? 2.4 : 1.2 }));
    const size = Math.max(6, Math.min(11, b.w / 6.5, b.h / 2.4));
    const value = blockValue(c);
    // Only draw the value line when it fits inside the block at this size.
    const twoLines = value && b.h > size * 3.2 && b.w - 6 > value.length * size * 0.85 * 0.62;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    g.append(svg('text', { x: cx, y: twoLines ? cy - size * 0.25 : cy + size * 0.35, 'text-anchor': 'middle',
      'font-size': size, 'font-weight': 600, 'font-family': 'Geist, sans-serif', fill: '#18181b' }, blockLabel(c)));
    if (twoLines) {
      g.append(svg('text', { x: cx, y: cy + size * 1.05, 'text-anchor': 'middle', 'font-size': size * 0.85,
        'font-family': 'Geist Mono, monospace', fill: '#71717a' }, value));
    }
    root.append(g);
  });
  return root;
}

// ------------------------------------------------------------- attempt bits

const failedChecks = (attempt) => (attempt.checks || []).filter((row) => row.passed === false);

function checkText(row) {
  if (row.key === 'topology_valid') return 'Invalid layout or wiring';
  return `${row.label} ${short(row.value)} ${row.op === '≥' ? '<' : '>'} ${short(row.limit)} ${row.unit}`;
}

function verdict(entry) {
  const a = entry.attempt;
  if (entry.isBaseline) return { text: 'Baseline', cls: '' };
  if (a.duplicate) return { text: 'Duplicate', cls: 'fail' };
  if (!a.metrics) return { text: 'No design', cls: 'fail' };
  if (!a.accepted) return { text: 'Rejected', cls: 'fail' };
  return a.improved ? { text: 'New best', cls: 'pass' } : { text: 'Not faster', cls: '' };
}

function deltaChip(d) {
  if (d.kind === 'layout' || num(d.pct) === null) return el('span', { class: 'chip layout' }, d.text.replace('Moved or resized', 'Moved'));
  const arrow = d.pct > 0 ? el('span', { class: 'up' }, '▲') : el('span', { class: 'down' }, '▼');
  return el('span', { class: 'chip' }, `${SHORT[d.label] || d.label} ${short(d.before)}→${short(d.after)}${d.unit ? ' ' + d.unit : ''} `, arrow);
}

function outcome(entry) {
  const a = entry.attempt;
  const m = a.metrics;
  if (entry.isBaseline) return el('div', { class: 'outcome' }, el('span', {}, 'p99 TTFT'), el('b', {}, fmtMs(m && m.ttft_p99_ms)));
  if (!m) return el('div', { class: 'outcome' }, el('span', {}, 'No design produced'), el('b', { class: 'bad' }, '✕'));
  const failed = failedChecks(a);
  if (failed.length) return el('div', { class: 'outcome' }, el('b', { class: 'bad' }, '✕'), el('span', { class: 'why' }, checkText(failed[0])));
  const change = pct(m.ttft_p99_ms, state.baseline && state.baseline.ttft_p99_ms);
  return el('div', { class: 'outcome' }, el('span', {}, 'p99 vs baseline'),
    el('b', { class: change !== null && change < -0.05 ? 'good' : change > 0.05 ? 'bad' : '' }, change === null ? '—' : signed(change)));
}

// --------------------------------------------------------------------- tiles

function addTile(entry, index) {
  state.entries.set(entry.id, entry);
  const a = entry.attempt;
  const v = verdict(entry);
  const item = el('li', { class: `tile${v.cls === 'fail' ? ' rejected' : ''}`, 'data-id': entry.id, style: `animation-delay:${Math.min(index, 4) * 60}ms` },
    el('button', { type: 'button', 'aria-label': `${entry.label}: show details` },
      el('div', { class: 'tile-top' }, el('span', { class: 'tile-num' }, entry.label), el('span', { class: `pill ${v.cls}` }, v.text)),
      el('div', { class: 'tile-title', title: a.name || '' }, entry.isBaseline ? 'Trainium2-like reference' : (a.name || 'Untitled design')),
      el('div', { class: 'diagram-wrap' }, a.design ? drawDiagram(a.design, a.changed_ids, a.previous_boxes)
        : el('div', { class: 'skeleton', style: 'animation:none' })),
      el('div', { class: 'chips' }, entry.isBaseline ? el('span', { class: 'chip' }, 'Starting point') : (a.deltas || []).slice(0, 2).map(deltaChip)),
      outcome(entry)));
  item.querySelector('button').addEventListener('click', () => select(entry.id));
  $('iterations').insertBefore(item, $('iterations').querySelector('.tile.working'));
}

function setWorkingTile(campaign) {
  let tile = $('iterations').querySelector('.tile.working');
  const next = (campaign.attempts || []).length + 1;
  const running = campaign.status === 'running' && campaign.baseline_metrics && next <= campaign.max_rounds;
  if (!running) { if (tile) tile.remove(); return; }
  if (!tile) {
    tile = el('li', { class: 'tile working' },
      el('button', { type: 'button', disabled: 'true', tabindex: '-1' },
        el('div', { class: 'tile-top' }, el('span', { class: 'tile-num' }), el('span', { class: 'pill' }, 'Designing')),
        el('div', { class: 'tile-title' }, 'The model is working…'),
        el('div', { class: 'skeleton' }),
        el('div', { class: 'working-step' })));
    $('iterations').append(tile);
  }
  tile.querySelector('.tile-num').textContent = `Iteration ${next}`;
  tile.querySelector('.working-step').textContent = (campaign.activity || '').replace(/^Round \d+: /, '');
}

function select(id) {
  const same = state.selected === id;
  transition(() => {
    state.selected = same ? null : id;
    for (const tile of document.querySelectorAll('.tile[data-id]')) tile.setAttribute('aria-current', String(tile.dataset.id === state.selected));
    if (same) { $('detail').hidden = true; return; }
    $('detail').replaceChildren(detailCard(state.entries.get(id)));
    $('detail').hidden = false;
  });
  if (!same) setTimeout(() => $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
}

// -------------------------------------------------------------------- detail

function deltaRows(deltas) {
  if (!deltas || !deltas.length) return el('p', { class: 'why-text' }, 'No parameter changes.');
  return el('div', { class: 'delta-rows' }, deltas.map((d) => el('div', { class: 'delta-row' },
    el('span', { class: 'name' }, d.kind === 'layout' && num(d.pct) === null ? d.text : d.label),
    el('span', { class: 'vals' }, d.kind === 'layout' && num(d.pct) === null ? ''
      : `${short(d.before)} → ${short(d.after)} ${d.unit || ''}${num(d.pct) === null ? '' : '  ' + signed(d.pct, 0)}`),
    num(d.pct) === null ? null : el('span', { class: 'bar' }, el('i', { style: `width:${Math.min(100, Math.max(4, Math.abs(d.pct)))}%` })))));
}

function checkList(checks) {
  return el('ul', { class: 'checks' }, (checks || []).map((row) => el('li', { class: row.passed ? '' : 'fail' },
    el('span', { class: 'icon' }, row.passed ? '✓' : '✕'),
    el('span', {}, row.key === 'topology_valid' ? 'Valid layout & wiring' : `${row.label} ${row.op} ${short(row.limit)} ${row.unit}`),
    el('span', { class: 'val' }, row.key === 'topology_valid' ? 'invalid' : `${short(row.value)} ${row.unit}`))));
}

function stepChips(steps) {
  return el('div', { class: 'steps' }, steps.map((s) => el('span', {
    class: `chip ${s.includes('fallback') ? 'fallback' : s.includes('repaired') ? 'repaired' : ''}` }, s.replace(/ \(automatic fallback.*/, ' · fallback'))));
}

function metricsBlock(m, isBaseline, animate) {
  if (m.topology_valid === false) return el('p', { class: 'why-text' }, 'Not simulated: the layout or wiring was invalid.');
  const change = isBaseline ? null : pct(m.ttft_p99_ms, state.baseline && state.baseline.ttft_p99_ms);
  const p99 = el('span', {}, fmtMs(m.ttft_p99_ms));
  const tput = el('span', {}, fmt(m.throughput_tokens_s));
  if (animate) {
    countUp(p99, m.ttft_p99_ms, fmtMs);
    countUp(tput, m.throughput_tokens_s, (v) => fmt(v));
  }
  return el('dl', { class: 'metric-row' },
    el('div', { class: 'metric' }, el('dt', {}, 'p99 time to first token'),
      el('dd', {}, p99, change === null ? null : el('small', { class: change < 0 ? 'good' : 'bad' }, signed(change)))),
    el('div', { class: 'metric' }, el('dt', {}, 'Throughput (tok/s)'), el('dd', {}, tput)),
    el('div', { class: 'metric' }, el('dt', {}, 'Bottleneck'),
      el('dd', { style: 'font-size:13px;font-weight:500;margin-top:8px' }, `prefill ${m.prefill_bound || '—'} · decode ${m.decode_bound || '—'}`)));
}

function detailCard(entry, { winner = false } = {}) {
  const a = entry.attempt;
  const v = verdict(entry);
  const pill = winner ? el('span', { class: 'pill best' }, 'Winner') : el('span', { class: `pill ${v.cls}` }, v.text);
  const deltas = winner && !entry.isBaseline ? a.baseline_deltas : a.deltas;
  const why = entry.isBaseline
    ? 'The reference chip: 4 compute clusters, 2 HBM stacks with 96 GB at 2.9 TB/s, 24 GB SRAM. Every iteration starts from the best chip found so far.'
    : (a.rationale || (a.changes || [])[0] || a.feedback || '');

  const story = el('div', { class: 'detail-col' },
    el('div', { class: 'detail-head' }, el('span', { class: 'tile-num' }, entry.label), pill),
    el('h3', {}, entry.isBaseline ? 'Baseline' : (a.name || 'Untitled design')),
    why ? el('section', {}, el('h4', {}, 'Why'), el('p', { class: 'why-text' }, why)) : null,
    entry.isBaseline ? null : el('section', {}, el('h4', {}, winner ? 'What changed vs. baseline' : 'What changed'), deltaRows(deltas)),
    a.steps && a.steps.length ? el('section', {}, el('h4', {}, 'Model calls this round'), stepChips(a.steps)) : null);

  const result = el('div', { class: 'detail-col' },
    a.metrics ? el('section', {}, el('h4', {}, 'Simulated result'), metricsBlock(a.metrics, entry.isBaseline, winner)) : null,
    a.checks && a.checks.length ? el('section', {}, el('h4', {}, 'Checker'), checkList(a.checks)) : null,
    a.feedback && !entry.isBaseline ? el('section', {}, el('h4', {}, 'Feedback sent to the model'), el('pre', { class: 'feedback' }, a.feedback)) : null);

  const withDiagram = winner && a.design;
  return el('article', { class: `card detail-card${withDiagram ? ' with-diagram' : ''}${winner ? ' winner-card' : ''}` },
    withDiagram ? el('div', { class: 'diagram-wrap' }, drawDiagram(a.design, a.changed_ids, a.previous_boxes)) : null,
    story, result);
}

// ------------------------------------------------------------------- checker

function kv(rows) {
  return el('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}

function source(title, data, rows, captureHint) {
  const ok = data && data.available;
  return el('div', { class: 'source' },
    el('div', { class: 'source-head' }, el('span', {}, title), el('span', { class: `tag ${ok ? 'measured' : 'missing'}` }, ok ? 'measured' : 'not available')),
    ok ? kv(rows) : el('p', { class: 'missing-note' }, (data && data.reason) || 'Not collected.',
      captureHint ? ['. To capture it, start vLLM with ', el('code', {}, captureHint), '.'] : null));
}

function renderChecker(campaign) {
  const t = campaign.telemetry || {};
  const v = t.vllm || {}, n = t.neuron_monitor || {}, s = t.system_trace || {};
  const cal = campaign.calibration || {};
  const base = campaign.baseline_metrics || {};

  const measured = el('div', { class: 'card checker-col', style: '--i:0' },
    el('h3', {}, el('span', { class: 'num' }, '1'), 'Measured on your Trainium'),
    source('vLLM · Prometheus /metrics', v, [
      ['TTFT p50 / p99', `${fmtMs(v.ttft_p50_ms)} / ${fmtMs(v.ttft_p99_ms)}`],
      ['Queue · prefill', `${fmtMs(v.queue_ms)} · ${fmtMs(v.prefill_ms)}`],
      ['Per output token', fmtMs(v.inter_token_ms)],
      ['Tokens in / out', `${fmt(v.prompt_tokens_mean)} / ${fmt(v.generation_tokens_mean)}`],
      ['KV cache peak', `${fmt(v.kv_cache_peak_pct, 1)}%`],
      ['Replay', `${v.requests || 0} requests in ${fmt(v.wall_s, 1)} s`],
    ]),
    source('neuron-monitor', n, [
      ['NeuronCore busy', `${fmt(n.core_utilization_pct)}% avg · ${fmt(n.core_utilization_peak_pct)}% peak`],
      ['Device memory', `${fmt(n.device_memory_gb, 1)} / ${fmt(n.device_memory_total_gb)} GB`],
      num(n.effective_tflops) !== null ? ['Effective TFLOPS', fmt(n.effective_tflops, 1)] : null,
      ['Device', `${n.device_type || '—'} · ${n.cores || '—'} cores`],
    ]),
    source('Neuron Explorer system trace', s, [
      ['Arithmetic intensity', `${fmt(s.arithmetic_intensity, 1)} FLOP/B`],
      ['Ridge point', `${fmt(s.ridge_point)} FLOP/B`],
      ['HBM bandwidth used (MBU)', `${fmt(s.mbu_pct)}%`],
      ['DMA active', `${fmt(s.dma_active_pct)}%`],
      ['SRAM spill share', `${fmt((s.spill_fraction || 0) * 100, 1)}%`],
    ], 'NEURON_RT_INSPECT_ENABLE=1 NEURON_RT_INSPECT_OUTPUT_DIR=/workspace/neuron-trace'));

  const live = cal.live;
  const calibrated = el('div', { class: 'card checker-col', style: '--i:1' },
    el('h3', {}, el('span', { class: 'num' }, '2'), 'Simulator, calibrated to it'),
    el('div', { class: 'source' },
      el('div', { class: 'source-head' }, el('span', {}, 'Fitted to the measurements'),
        el('span', { class: `tag ${live ? 'modeled' : 'missing'}` }, live ? 'calibrated' : 'defaults')),
      kv([
        ['Prefill time scale', `×${fmt(cal.prefill_scale, 2)}`],
        ['Decode time scale', `×${fmt(cal.decode_scale, 2)}`],
        ['SRAM spill share', `${fmt((cal.spill_fraction || 0) * 100, 1)}% (${cal.spill_source || 'default'})`],
        ['Model weights', num(cal.model_weights_gb) === null ? 'default' : `${fmt(cal.model_weights_gb, 1)} GB`],
      ])),
    el('div', { class: 'source' },
      el('div', { class: 'source-head' }, el('span', {}, live ? 'Replayed workload' : 'Workload'), el('span', { class: 'tag modeled' }, 'modeled')),
      kv([
        ['Requests', live ? `32 · one every ${fmtMs(cal.arrival_interval_ms)}` : 'fixed trace C'],
        ['Tokens in / out', `${fmt(cal.prompt_tokens)} / ${fmt(cal.generation_tokens)}`],
        ['Baseline p99 TTFT', fmtMs(base.ttft_p99_ms)],
        ['Baseline throughput', `${fmt(base.throughput_tokens_s)} tok/s`],
      ])),
    el('div', { class: 'bound-chips' },
      base.prefill_bound ? el('span', { class: `bound ${base.prefill_bound}` }, `prefill: ${base.prefill_bound}-bound`) : null,
      base.decode_bound ? el('span', { class: `bound ${base.decode_bound}` }, `decode: ${base.decode_bound}-bound`) : null));

  const gates = (campaign.baseline_checks || []).map((row) => el('li', {},
    el('span', {}, row.label), el('span', {}, `${row.op} ${short(row.limit)} ${row.unit}`)));
  const checker = el('div', { class: 'card checker-col', style: '--i:2' },
    el('h3', {}, el('span', { class: 'num' }, '3'), 'Checker'),
    el('p', { class: 'objective' }, 'Score: ', el('b', {}, 'lower p99 time-to-first-token'), ' on the replayed workload.'),
    el('div', { class: 'source' }, el('div', { class: 'source-head' }, el('span', {}, 'Every design must pass')),
      el('ul', { class: 'gate-list' }, gates, el('li', {}, el('span', {}, 'Layout & wiring'), el('span', {}, 'valid')))),
    el('p', { class: 'missing-note' }, 'A failed or slower design goes back to the model with the limiting resource and the size of change that would fix it.'));

  $('checker-grid').replaceChildren(measured, calibrated, checker);
  $('checker').hidden = false;
}

// --------------------------------------------------------------------- chart

function renderChart(campaign) {
  const base = campaign.baseline_metrics;
  const points = [{ x: 0, y: base.ttft_p99_ms, kind: 'base' }];
  for (const a of campaign.attempts || []) {
    if (!a.metrics || a.metrics.topology_valid === false) continue;
    points.push({ x: a.round, y: a.metrics.ttft_p99_ms, kind: a.accepted ? (a.improved ? 'best' : 'ok') : 'bad', id: a.id });
  }
  const card = $('chart');
  if (points.length < 2) { card.hidden = true; return; }
  const key = JSON.stringify([points, campaign.status]);
  if (card.dataset.key === key) return;
  card.dataset.key = key;
  card.hidden = false;
  const W = Math.max(320, card.clientWidth - 32), H = 140, L = 58, R = 16, T = 10, B = 22;
  const maxX = Math.max(campaign.max_rounds, ...points.map((p) => p.x));
  const ys = points.map((p) => p.y);
  const lo = Math.min(...ys) * 0.92, hi = Math.max(...ys) * 1.04;
  const sx = (x) => L + (x / maxX) * (W - L - R);
  const sy = (y) => T + (1 - (y - lo) / Math.max(hi - lo, 1e-6)) * (H - T - B);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}` });
  const label = { 'font-size': 10, fill: '#a1a1aa', 'font-family': 'Geist Mono, monospace' };

  for (const tick of [lo, (lo + hi) / 2, hi]) {
    root.append(svg('line', { x1: L, x2: W - R, y1: sy(tick), y2: sy(tick), stroke: '#f4f4f5' }));
    root.append(svg('text', { ...label, x: L - 8, y: sy(tick) + 4, 'text-anchor': 'end' }, fmtMs(tick)));
  }
  for (let i = 0; i <= maxX; i++) root.append(svg('text', { ...label, x: sx(i), y: H - 4, 'text-anchor': 'middle' }, i === 0 ? 'base' : `#${i}`));
  root.append(svg('line', { x1: L, x2: W - R, y1: sy(base.ttft_p99_ms), y2: sy(base.ttft_p99_ms), stroke: '#d4d4d8', 'stroke-dasharray': '3 4' }));

  // Best-so-far staircase.
  let best = base.ttft_p99_ms, d = `M ${sx(0)} ${sy(best)}`;
  for (const p of points.slice(1)) {
    if (p.kind === 'best' && p.y < best) { d += ` H ${sx(p.x)} V ${sy(p.y)}`; best = p.y; } else d += ` H ${sx(p.x)}`;
  }
  root.append(svg('path', { d, class: 'draw', pathLength: 1, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));

  const winnerId = campaign.status === 'completed' && campaign.best_attempt ? campaign.best_attempt.id : null;
  points.forEach((p, i) => {
    const color = p.kind === 'bad' ? 'var(--bad)' : p.kind === 'best' ? 'var(--accent)' : p.kind === 'base' ? '#71717a' : '#a1a1aa';
    root.append(svg('circle', { class: 'pt', cx: sx(p.x), cy: sy(p.y), r: p.id && p.id === winnerId ? 6 : 4,
      fill: p.kind === 'bad' ? '#fff' : color, stroke: color, 'stroke-width': 1.6, style: `animation-delay:${200 + i * 80}ms` }));
  });

  const change = pct(best, base.ttft_p99_ms);
  card.replaceChildren(
    el('div', { class: 'chart-title' }, el('span', {}, 'p99 time to first token by iteration · lower is better'),
      el('span', {}, 'Best so far ', el('b', {}, fmtMs(best)), change !== null && change < -0.05 ? ` (${signed(change)})` : '')),
    root);
}

// ------------------------------------------------------------------ pipeline

function stepFor(campaign) {
  if (campaign.status === 'completed') return 'done';
  const a = (campaign.activity || '').toLowerCase();
  if (a.includes('measuring')) return 'measure';
  if (a.includes('calibrat')) return 'calibrate';
  if (a.includes('placing')) return 'floorplan';
  if (a.includes('wiring')) return 'wire';
  if (a.includes('simulating')) return 'simulate';
  return campaign.baseline_metrics ? 'plan' : 'measure';
}

function setPipeline(step) {
  const pipeline = $('pipeline');
  pipeline.hidden = false;
  const index = STEPS.indexOf(step);
  for (const li of pipeline.children) {
    const i = STEPS.indexOf(li.dataset.step);
    li.classList.toggle('done', i < index || step === 'done');
    li.classList.toggle('active', i === index && step !== 'done');
  }
}

function setStatus(text, kind = 'running') {
  const status = $('status');
  status.hidden = !text;
  status.textContent = text || '';
  status.className = `status ${kind}`;
}

// ------------------------------------------------------------------ campaign

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail || detail; } catch (_) { /* keep statusText */ }
    throw new Error(detail);
  }
  return response.json();
}

function reset() {
  clearTimeout(state.timer);
  Object.assign(state, { rendered: new Set(), entries: new Map(), selected: null, baseline: null });
  $('iterations').replaceChildren();
  delete $('chart').dataset.key;
  for (const id of ['detail', 'final', 'timeline', 'checker', 'chart']) $(id).hidden = true;
}

// The run ID lives in the URL, so a refresh or a shared link reopens the same run.
function watch(id) {
  state.campaignId = id;
  history.replaceState(null, '', `?run=${encodeURIComponent(id)}`);
  poll();
}

async function start(event) {
  event.preventDefault();
  reset();
  $('start').disabled = true;
  setPipeline('measure');
  setStatus('Checking the model');
  try {
    const campaign = await api('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ goal: $('goal').value.trim(), max_rounds: MAX_ROUNDS, constraints: CONSTRAINTS }),
    });
    watch(campaign.id);
  } catch (error) {
    $('pipeline').hidden = true;
    setStatus(`Could not start: ${error.message}`, 'error');
    $('start').disabled = false;
  }
}

function baselineEntry(campaign) {
  return { id: 'baseline', isBaseline: true, label: 'Baseline', attempt: {
    name: 'Baseline', design: campaign.baseline_design, metrics: campaign.baseline_metrics, checks: campaign.baseline_checks } };
}

async function poll() {
  let campaign;
  try {
    campaign = await api(`/api/campaigns/${encodeURIComponent(state.campaignId)}?compact=1`);
  } catch (error) {
    if (/not found/i.test(error.message)) {
      history.replaceState(null, '', location.pathname);
      $('pipeline').hidden = true;
      setStatus('That run is no longer on the server. Start a new one.', 'error');
      $('start').disabled = false;
      return;
    }
    setStatus(`Lost connection, retrying (${error.message})`);
    state.timer = setTimeout(poll, POLL_MS * 2);
    return;
  }
  if (campaign.baseline_metrics && !state.baseline) {
    state.baseline = campaign.baseline_metrics;
    renderChecker(campaign);
    $('timeline').hidden = false;
    addTile(baselineEntry(campaign), 0);
  }
  let index = state.rendered.size + 1;
  for (const attempt of campaign.attempts || []) {
    if (state.rendered.has(attempt.id)) continue;
    state.rendered.add(attempt.id);
    addTile({ id: attempt.id, label: `Iteration ${attempt.round}`, attempt }, index++);
  }
  setWorkingTile(campaign);
  if (state.baseline) renderChart(campaign);

  if (campaign.status === 'completed') return finish(campaign);
  if (campaign.status === 'failed') {
    setStatus(campaign.error || 'The design run failed.', 'error');
    $('start').disabled = false;
    return;
  }
  setPipeline(stepFor(campaign));
  const done = (campaign.attempts || []).length;
  setStatus(campaign.baseline_metrics
    ? `${campaign.activity || 'Working'} · ${done} of up to ${campaign.max_rounds} iterations done`
    : `${campaign.activity || 'Measuring'} · replaying requests on the live model`);
  state.timer = setTimeout(poll, POLL_MS);
}

function finish(campaign) {
  $('start').disabled = false;
  setPipeline('done');
  setStatus(campaign.stop_reason ? `Finished: ${campaign.stop_reason}.` : 'Finished.', '');
  const best = campaign.best_attempt;
  const winner = best ? state.entries.get(best.id) || { id: best.id, label: `Iteration ${best.round}`, attempt: best }
    : state.entries.get('baseline') || baselineEntry(campaign);
  const tile = document.querySelector(`.tile[data-id="${CSS.escape(winner.id)}"]`);
  if (tile) {
    tile.classList.add('winner');
    const pill = tile.querySelector('.pill');
    pill.className = 'pill best';
    pill.textContent = 'Winner';
  }
  const m = winner.attempt.metrics || {};
  const change = pct(m.ttft_p99_ms, state.baseline.ttft_p99_ms);
  const summary = best
    ? el('p', { class: 'winner-summary' }, `${winner.label} cut p99 time-to-first-token from `,
      el('b', {}, fmtMs(state.baseline.ttft_p99_ms)), ' to ', el('b', {}, fmtMs(m.ttft_p99_ms)),
      change === null ? '' : ` (${signed(change)})`, ' while passing every check.')
    : el('p', { class: 'winner-summary' }, 'No iteration beat the baseline while passing every check, so the baseline stays the best design.');
  $('report-link').href = `/api/reports/${encodeURIComponent(campaign.id)}`;
  $('final-card').replaceChildren(el('div', { style: 'display:flex;flex-direction:column;gap:12px' }, summary, detailCard(winner, { winner: true })));
  transition(() => { $('final').hidden = false; });
  setTimeout(() => $('final').scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
}

async function loadConfig() {
  const badge = $('model-badge');
  try {
    const config = await api('/api/config');
    const name = String(config.model || 'model').replace(/^openai\//, '');
    if (config.mode === 'mock') {
      $('model-label').textContent = `${name} · offline mode`;
    } else if (config.ready) {
      badge.classList.add('live');
      $('model-label').textContent = name;
    } else {
      badge.classList.add('down');
      $('model-label').textContent = `${name} · not reachable`;
      setStatus(config.error, 'error');
    }
  } catch (_) { /* badge keeps its default */ }
}

$('brief-form').addEventListener('submit', start);
loadConfig();
const resumeId = new URLSearchParams(location.search).get('run');
if (resumeId) {
  reset();
  $('start').disabled = true;
  setPipeline('measure');
  watch(resumeId);
}
