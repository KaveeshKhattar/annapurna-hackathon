'use strict';

// Hard budget sent with every campaign; the checker enforces it.
const CONSTRAINTS = { max_power_w: 600, max_temperature_c: 85, max_area_mm2: 650 };
const MAX_ROUNDS = 5;
const POLL_MS = 1500;

const GATE_TEXT = {
  throughput_at_least_baseline: 'throughput below baseline',
  memory_fit: 'model does not fit in HBM',
  topology_valid: 'invalid layout or wiring',
  power_cap: 'over power budget',
  temperature_cap: 'over temperature budget',
  area_cap: 'over area budget',
};

const BLOCK_STYLE = {
  compute_cluster: ['var(--compute-fill)', 'var(--compute-stroke)', 'Compute'],
  hbm: ['var(--hbm-fill)', 'var(--hbm-stroke)', 'HBM'],
  sbuf: ['var(--sbuf-fill)', 'var(--sbuf-stroke)', 'SRAM'],
  dma: ['var(--dma-fill)', 'var(--dma-stroke)', 'DMA'],
  router: ['#f1f2f4', '#8a9099', 'Router'],
  io: ['#f1f2f4', '#8a9099', 'I/O'],
};

const state = { campaignId: null, rendered: new Set(), timer: null, baseline: null };
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- DOM helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
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

// ------------------------------------------------------------------ formatting

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function fmtMs(v) {
  if (num(v) === null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} s`;
  return v < 10 ? `${v.toFixed(2)} ms` : v < 100 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
}
const fmtInt = (v, unit) => (num(v) === null ? '—' : `${Math.round(v).toLocaleString()}${unit}`);

function pctChange(value, base) {
  if (num(value) === null || !num(base)) return null;
  return ((value - base) / base) * 100;
}

// ------------------------------------------------------------------- diagram

function blockLabel(component) {
  const style = BLOCK_STYLE[component.type];
  const index = Number(String(component.id).split('-').pop());
  if (component.type === 'sbuf') return 'SRAM';
  return Number.isFinite(index) ? `${style ? style[2] : component.type} ${index + 1}` : component.id;
}

function blockValue(component) {
  if (component.type === 'compute_cluster' && component.compute_tflops) return `${Math.round(component.compute_tflops)} TF`;
  if ((component.type === 'hbm' || component.type === 'sbuf') && component.capacity_gb) return `${+component.capacity_gb.toFixed(1)} GB`;
  if (component.type === 'dma' && component.dma_engines > 1) return `×${component.dma_engines}`;
  return '';
}

function drawDiagram(design, changedIds = []) {
  const S = 300, P = 10;
  const root = svg('svg', { viewBox: `0 0 ${S + 2 * P} ${S + 2 * P}`, role: 'img', 'aria-label': 'Chip floorplan' });
  const components = (design && design.components) || [];
  const connections = (design && design.connections) || [];
  const changed = new Set(changedIds);
  const box = (c) => ({ x: P + c.x * S, y: P + c.y * S, w: c.width * S, h: c.height * S });

  root.append(svg('rect', { x: P, y: P, width: S, height: S, rx: 10, fill: '#fafafa', stroke: '#dcdfe3' }));

  for (const c of components.filter((c) => c.type === 'noc')) {
    const b = box(c);
    root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill: '#f2f3f5',
      stroke: '#c9ced6', 'stroke-dasharray': '4 3' }));
  }

  const byId = Object.fromEntries(components.map((c) => [c.id, c]));
  const maxBw = Math.max(0.01, ...connections.map((e) => e.bandwidth_tb_s || 0));
  for (const edge of connections) {
    const a = byId[edge.source], b = byId[edge.target];
    if (!a || !b) continue;
    const pa = box(a), pb = box(b);
    root.append(svg('line', {
      x1: pa.x + pa.w / 2, y1: pa.y + pa.h / 2, x2: pb.x + pb.w / 2, y2: pb.y + pb.h / 2,
      stroke: '#8f97a3', 'stroke-opacity': 0.45, 'stroke-linecap': 'round',
      'stroke-width': (0.8 + 2.4 * (edge.bandwidth_tb_s || 0) / maxBw).toFixed(2),
    }));
  }

  for (const c of components.filter((c) => c.type !== 'noc')) {
    const b = box(c);
    const [fill, stroke] = BLOCK_STYLE[c.type] || BLOCK_STYLE.io;
    const isChanged = changed.has(c.id);
    root.append(svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 5, fill,
      stroke: isChanged ? 'var(--changed)' : stroke, 'stroke-width': isChanged ? 2.4 : 1.2 }));
    const size = Math.max(6, Math.min(11, b.w / 6.5, b.h / 2.4));
    const value = blockValue(c);
    const twoLines = value && b.h > size * 3.2;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    root.append(svg('text', { x: cx, y: twoLines ? cy - size * 0.25 : cy + size * 0.35, 'text-anchor': 'middle',
      'font-size': size, 'font-weight': 600, fill: '#2a2e35' }, blockLabel(c)));
    if (twoLines) {
      root.append(svg('text', { x: cx, y: cy + size * 1.05, 'text-anchor': 'middle', 'font-size': size * 0.9,
        fill: '#6b7079' }, value));
    }
  }
  return root;
}

// --------------------------------------------------------------------- cards

function verdict(attempt, isBaseline) {
  if (isBaseline) return { text: 'Starting point', cls: '' };
  if (attempt.duplicate) return { text: 'Duplicate', cls: 'fail' };
  if (!attempt.metrics) return { text: 'No design', cls: 'fail' };
  if (!attempt.accepted) return { text: 'Rejected', cls: 'fail' };
  return attempt.improved ? { text: 'Passed · new best', cls: 'pass' } : { text: 'Passed · not faster', cls: 'pass' };
}

function resultsBlock(metrics, baseMetrics, gates) {
  if (!metrics) return null;
  const change = baseMetrics ? pctChange(metrics.ttft_p99_ms, baseMetrics.ttft_p99_ms) : null;
  const delta = change === null || Math.abs(change) < 0.05 ? null
    : el('span', { class: `delta ${change < 0 ? 'good' : 'bad'}` }, `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%`);
  const failed = Object.entries(gates || {}).filter(([, ok]) => !ok).map(([gate]) => GATE_TEXT[gate] || gate);
  if (metrics.topology_valid === false) {
    return el('section', {}, el('h4', {}, 'Simulated performance'),
      el('p', { class: 'note fail' }, 'Not simulated: ' + (metrics.topology_errors || ['invalid design']).slice(0, 2).join('; ')));
  }
  return el('section', {},
    el('h4', {}, 'Simulated performance'),
    el('dl', { class: 'results' },
      el('div', {}, el('dt', {}, 'p99 time to first token'), el('dd', {}, fmtMs(metrics.ttft_p99_ms), delta)),
      el('div', {}, el('dt', {}, 'Throughput'), el('dd', {}, fmtInt(metrics.throughput_tokens_s, ' tok/s')))),
    el('p', { class: 'secondary' },
      `${fmtInt(metrics.power_w, ' W')} · ${num(metrics.max_temperature_c) === null ? '—' : metrics.max_temperature_c.toFixed(0) + ' °C'} · ${fmtInt(metrics.area_mm2, ' mm²')}`
      + (metrics.throttling ? ' · throttling' : '')),
    failed.length ? el('p', { class: 'note fail' }, 'Rejected: ' + failed.join(', ')) : null);
}

function card(attempt, { isBaseline = false, label } = {}) {
  const v = verdict(attempt, isBaseline);
  const changes = isBaseline ? ['Trainium2-like reference: 4 compute clusters, 2 HBM stacks, 96 GB at 2.9 TB/s.']
    : (attempt.changes && attempt.changes.length ? attempt.changes : [attempt.rationale || attempt.feedback || 'No description.']);
  const deltas = attempt.deltas || [];
  const node = el('article', { class: `iteration${!isBaseline && v.cls === 'fail' ? ' rejected' : ''}`, 'data-id': attempt.id || 'baseline' },
    el('figure', { class: 'diagram', style: 'margin:0' }, attempt.design ? drawDiagram(attempt.design, attempt.changed_ids) : null),
    el('div', { class: 'details' },
      el('header', {}, el('span', { class: 'eyebrow' }, label || (isBaseline ? 'Baseline' : `Iteration ${attempt.round}`)),
        el('span', { class: `pill ${v.cls}` }, v.text)),
      el('h3', {}, attempt.name || 'Untitled design'),
      el('section', {}, el('h4', {}, isBaseline ? 'Design' : 'Changes'),
        el('ul', { class: 'changes' }, changes.map((text) => el('li', {}, text))),
        deltas.length ? el('ul', { class: 'deltas' }, deltas.map((text) => el('li', {}, text))) : null),
      resultsBlock(attempt.metrics, isBaseline ? null : state.baseline, attempt.gate_results),
      attempt.source === 'offline' ? el('p', { class: 'note' }, 'Proposed by the offline fallback, not the model.') : null));
  return node;
}

// ------------------------------------------------------------------- campaign

function setStatus(text, kind = 'running') {
  const status = $('status');
  status.hidden = !text;
  status.textContent = text || '';
  status.className = `status ${kind}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail || detail; } catch (_) { /* keep statusText */ }
    throw new Error(detail);
  }
  return response.json();
}

async function start(event) {
  event.preventDefault();
  clearTimeout(state.timer);
  state.rendered.clear();
  $('iterations').replaceChildren();
  $('final').hidden = true;
  $('timeline').hidden = true;
  $('start').disabled = true;
  setStatus('Measuring the baseline');
  try {
    const campaign = await api('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({ goal: $('goal').value.trim(), max_rounds: MAX_ROUNDS, constraints: CONSTRAINTS }),
    });
    state.campaignId = campaign.id;
    state.baseline = campaign.baseline_metrics;
    $('timeline').hidden = false;
    $('iterations').append(card({ id: 'baseline', name: 'Baseline', design: campaign.baseline_design,
      metrics: campaign.baseline_metrics }, { isBaseline: true }));
    poll();
  } catch (error) {
    setStatus(`Could not start: ${error.message}`, 'error');
    $('start').disabled = false;
  }
}

async function poll() {
  let campaign;
  try {
    campaign = await api(`/api/campaigns/${encodeURIComponent(state.campaignId)}?compact=1`);
  } catch (error) {
    setStatus(`Lost connection, retrying (${error.message})`);
    state.timer = setTimeout(poll, POLL_MS * 2);
    return;
  }
  for (const attempt of campaign.attempts || []) {
    if (state.rendered.has(attempt.id)) continue;
    state.rendered.add(attempt.id);
    $('iterations').append(card(attempt));
  }
  if (campaign.status === 'completed') return finish(campaign);
  if (campaign.status === 'failed') {
    setStatus(campaign.error || 'The design run failed.', 'error');
    $('start').disabled = false;
    return;
  }
  const done = (campaign.attempts || []).length;
  setStatus(`${campaign.activity || 'Working'} · ${done} of up to ${campaign.max_rounds} iterations done`);
  state.timer = setTimeout(poll, POLL_MS);
}

function finish(campaign) {
  $('start').disabled = false;
  setStatus('');
  const best = campaign.best_attempt;
  const winnerId = best ? best.id : 'baseline';
  const winnerCard = document.querySelector(`.iteration[data-id="${CSS.escape(winnerId)}"]`);
  if (winnerCard) winnerCard.classList.add('winner');

  const report = el('a', { href: `/api/reports/${encodeURIComponent(campaign.id)}`, download: 'chip-design-report.md' }, 'Download report');
  if (best && best.metrics) {
    const change = pctChange(best.metrics.ttft_p99_ms, state.baseline.ttft_p99_ms);
    $('final-summary').replaceChildren(
      `Iteration ${best.round} wins: p99 time to first token ${fmtMs(state.baseline.ttft_p99_ms)} → ${fmtMs(best.metrics.ttft_p99_ms)}`
      + (change === null ? '' : ` (${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%)`)
      + ', within budget and without losing throughput.', report);
    $('final-card').replaceChildren(card(best, { label: `Iteration ${best.round} · Final` }));
  } else {
    $('final-summary').replaceChildren('No iteration beat the baseline within budget, so the baseline stays the best design.', report);
    $('final-card').replaceChildren(card({ id: 'baseline', name: 'Baseline', design: campaign.baseline_design,
      metrics: campaign.baseline_metrics }, { isBaseline: true, label: 'Baseline · Final' }));
  }
  $('final-card').firstChild.classList.add('winner');
  $('final-card').firstChild.querySelector('.pill').className = 'pill best';
  $('final-card').firstChild.querySelector('.pill').textContent = 'Winner';
  $('final').hidden = false;
  $('final').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadConfig() {
  try {
    const config = await api('/api/config');
    const name = String(config.model || 'model').replace(/^openai\//, '');
    $('model-label').textContent = config.mode === 'mock' ? `${name} · offline mode` : name;
  } catch (_) { /* label keeps its default */ }
}

$('brief-form').addEventListener('submit', start);
loadConfig();
