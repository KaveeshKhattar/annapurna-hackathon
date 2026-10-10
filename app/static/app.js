(() => {
  const $ = (selector) => document.querySelector(selector);
  const dieGrid = $('#die-grid');
  const activityList = $('#activity-list');
  const campaignButton = $('#start-campaign');
  let baselineMetrics = null;
  const fmt = (value, fallback) => value == null ? fallback : value;
  const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  // A deterministic tile map keeps the hardware view useful even without telemetry.
  for (let i = 0; i < 64; i += 1) {
    const tile = document.createElement('span');
    tile.className = `compute-tile ${i % 13 === 0 ? 'hot' : i % 4 === 0 ? 'warm' : ''}`;
    tile.setAttribute('aria-hidden', 'true');
    dieGrid.append(tile);
  }

  const addActivity = (title, detail, kind = 'info') => {
    if (!activityList) return;
    const iconClass = kind === 'good' ? 'icon-good' : kind === 'run' ? 'icon-run' : 'icon-info';
    const icon = kind === 'good' ? '✓' : kind === 'run' ? '↗' : '⌁';
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.innerHTML = `<span class="activity-icon ${iconClass}" aria-hidden="true">${icon}</span><span class="activity-copy"><b></b><small></small></span><time>Just now</time>`;
    item.querySelector('b').textContent = title;
    item.querySelector('small').textContent = detail || '';
    activityList.prepend(item);
    while (activityList.children.length > 6) activityList.lastElementChild.remove();
  };

  const applyState = (state) => {
    if (!state || typeof state !== 'object') return;
    const metrics = state.metrics || state;
    $('#metric-ttft').textContent = fmt(metrics.p99_ttft_ms ?? metrics.ttft_p99_ms, '184');
    $('#metric-throughput').textContent = fmt(metrics.throughput_tokens_per_second ?? metrics.throughput_tokens_s ?? metrics.throughput_toks_s, '2,840');
    $('#metric-power').textContent = fmt(metrics.power_watts ?? metrics.power_w, '642');
    $('#metric-temp').textContent = fmt(metrics.temperature_c ?? metrics.temp_c, '68');
    $('#metric-memory').textContent = fmt(metrics.memory_bandwidth_tb_s ?? state.design?.hbm_bandwidth_tb_s ?? metrics.memory_tb_s, '2.1');
    $('#waterfall-total').textContent = fmt(metrics.ttft_p99_ms ?? metrics.p99_latency_ms ?? metrics.request_latency_ms, '842');
    const deltas = document.querySelectorAll('.metric-card .delta');
    const pct = (current, baseline, lowerIsBetter) => {
      if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(baseline)) || Number(baseline) === 0) return null;
      const change = (Number(current) - Number(baseline)) / Number(baseline) * 100;
      const good = lowerIsBetter ? change <= 0 : change >= 0;
      const arrow = good ? (lowerIsBetter ? '↓' : '↑') : (lowerIsBetter ? '↑' : '↓');
      return `${arrow} ${Math.abs(change).toFixed(1)}%`;
    };
    if (baselineMetrics && deltas.length >= 3) {
      deltas[0].textContent = pct(metrics.ttft_p99_ms, baselineMetrics.ttft_p99_ms, true) || deltas[0].textContent;
      deltas[1].textContent = pct(metrics.throughput_tokens_s, baselineMetrics.throughput_tokens_s, false) || deltas[1].textContent;
      deltas[2].textContent = pct(metrics.power_w, baselineMetrics.power_w, true) || deltas[2].textContent;
    }
    const thermal = Array.isArray(metrics.thermal_grid) ? metrics.thermal_grid.flat() : [];
    if (thermal.length) {
      const low = Math.min(...thermal);
      const high = Math.max(...thermal);
      state.tile_utilization = thermal.map(value => (value - low) / Math.max(high - low, 0.001));
    }
    if (state.baseline_id) $('#baseline-select').dataset.baselineId = state.baseline_id;
    const label = state.connected === false ? 'Demo mode' : 'Telemetry connected';
    $('#connection-label').textContent = label;
    $('#last-sync').textContent = state.updated_at ? new Date(state.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'just now';
    if (Array.isArray(state.tile_utilization)) {
      [...dieGrid.children].forEach((tile, i) => {
        const util = Number(state.tile_utilization[i] ?? 0);
        tile.className = `compute-tile ${util > 0.78 ? 'hot' : util > 0.42 ? 'warm' : ''}`;
        tile.title = `Tile ${i + 1}: ${Math.round(util * 100)}% utilization`;
      });
    }
    if (state.campaign) applyCampaign(state.campaign);
  };

  const applyCampaign = (campaign) => {
    if (!campaign) return;
    const step = Number(campaign.step ?? campaign.current_step ?? 4);
    const total = Number(campaign.total_steps ?? campaign.max_rounds ?? 5);
    $('#progress-label').textContent = `Step ${step} of ${total}`;
    $('#progress-bar').style.width = `${Math.max(0, Math.min(100, Number(campaign.progress_percent ?? (step / total * 100))))}%`;
    if (campaign.status === 'running') {
      $('#campaign-button-label').textContent = 'Campaign running';
      campaignButton.disabled = true;
    } else if (campaign.status === 'completed') {
      $('#campaign-button-label').textContent = 'Run again';
      campaignButton.disabled = false;
    }
  };

  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  };

  const connect = async () => {
    // Try the canonical state route first; older demo backends may expose /api/overview.
    for (const path of ['/api/state', '/api/overview']) {
      try {
        const state = await api(path);
        applyState(state);
        $('#connection-label').textContent = 'API connected';
        $('#connection-label').parentElement.classList.add('connected');
        return;
      } catch (_) { /* no backend at this route; continue to the next known route */ }
    }
    try {
      await api('/api/health');
      $('#connection-label').textContent = 'API connected';
      $('#connection-label').parentElement.classList.add('connected');
      return;
    } catch (_) { /* static demo mode remains available without a service */ }
    $('#connection-label').textContent = 'Demo mode';
    // A light deterministic animation gives the static demo a sense of live telemetry.
    window.setInterval(() => {
      const tiles = [...dieGrid.children];
      const tile = tiles[Math.floor(Math.random() * tiles.length)];
      if (tile) tile.classList.toggle('hot');
      $('#last-sync').textContent = 'just now';
    }, 2800);
  };

  const connectEvents = (campaignId) => {
    if (!('EventSource' in window)) return;
    const events = new EventSource(`/api/events/${encodeURIComponent(campaignId)}`);
    events.onopen = () => { $('#connection-label').textContent = 'Live campaign'; };
    const handleEvent = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (_) { return; }
      if (event.type === 'campaign.completed') {
        applyCampaign({ status: 'completed', step: data.rounds || 5, total_steps: data.rounds || 5, progress_percent: 100 });
        addActivity('Campaign completed', `Optimization finished after ${data.rounds || 'several'} rounds`, 'good');
        events.close();
      } else if (event.type.startsWith('design.')) {
        const round = Number(data.round || 1);
        applyCampaign({ status: 'running', step: round, total_steps: 5, progress_percent: round / 5 * 100 });
        addActivity(event.type === 'design.rejected' ? `Design attempt ${round} rejected` : `Design attempt ${round} evaluated`, data.feedback || 'Checker results received', event.type === 'design.rejected' ? 'info' : 'good');
        if (data.metrics) applyState({ metrics: data.metrics, design: data.design, measurement_source: 'modeled' });
      } else if (event.type === 'campaign.started') {
        addActivity('Optimization campaign started', `Trace ${data.trace || 'A'} · up to ${data.max_rounds || 5} rounds`, 'run');
      }
    };
    for (const type of ['campaign.started', 'design.rejected', 'design.evaluated', 'campaign.best_updated', 'campaign.completed']) events.addEventListener(type, handleEvent);
    events.onerror = () => { if (events.readyState === EventSource.CONNECTING) $('#connection-label').textContent = 'Reconnecting…'; };
  };

  campaignButton.addEventListener('click', async () => {
    const trace = $('#workload-select').value;
    campaignButton.disabled = true;
    $('#campaign-button-label').textContent = 'Starting…';
    try {
      let result;
      for (const path of ['/api/campaigns', '/api/campaigns/start', '/api/campaign/start']) {
        try {
          result = await api(path, { method: 'POST', body: JSON.stringify({
            trace,
            max_rounds: 5,
            constraints: { max_power_w: 600, max_temperature_c: 90, max_area_mm2: 700 }
          }) });
          break;
        } catch (_) { /* try compatibility endpoint */ }
      }
      if (result) {
        baselineMetrics = result.baseline_metrics || null;
        applyCampaign(result.campaign || result);
        addActivity(`Campaign ${String(result.id || '').slice(0, 8)} started`, `Evaluation trace ${trace} · baseline captured`, 'run');
        $('#campaign-button-label').textContent = 'Campaign running';
        connectEvents(result.id);
      } else {
        // Keep controls demonstrable when running the static UI outside the service.
        applyCampaign({ status: 'running', step: 1, total_steps: 8, progress_percent: 12 });
        addActivity('Demo campaign started', `Evaluation trace ${trace} · baseline captured`, 'run');
        window.setTimeout(() => {
          applyCampaign({ status: 'completed', step: 8, total_steps: 8, progress_percent: 100 });
          $('#campaign-button-label').textContent = 'Run again';
          addActivity('Demo campaign completed', 'Optimization results are ready to compare', 'good');
        }, 6500);
      }
    } finally {
      if ($('#campaign-button-label').textContent === 'Starting…') {
        campaignButton.disabled = false;
        $('#campaign-button-label').textContent = 'Run campaign';
      }
    }
  });

  $('#compare-button').addEventListener('click', () => {
    document.querySelector('.comparison-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.querySelector('.comparison-panel').classList.add('panel-highlight');
    window.setTimeout(() => document.querySelector('.comparison-panel').classList.remove('panel-highlight'), 1000);
  });

  connect();
})();
