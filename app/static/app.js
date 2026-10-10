(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const NS = 'http://www.w3.org/2000/svg';
  const graph = $('#chip-graph');
  const roundsNode = $('#round-list');
  const svg = $('#chip-canvas');
  const campaignButton = $('#start-campaign');
  const die = { x: 58, y: 47, width: 884, height: 510 };
  const history = [];
  let currentDesign = null;
  let currentMetrics = null;
  let currentTopologyErrors = [];
  let selectedComponentId = null;
  let eventSource = null;
  let fallbackTimer = null;
  let fallbackIndex = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Local examples are complete graphs, so static/offline mode demonstrates the builder itself.
  const examples = [
    {name:'Balanced inference die',rationale:'Two compute clusters share a central SRAM bank and dual HBM channels through a compact fabric.',components:[
      {id:'compute-0',type:'compute',label:'Compute cluster 0',x:.27,y:.18,width:.27,height:.28,compute_tflops:680,utilization:.64,area_mm2:118},
      {id:'compute-1',type:'compute',label:'Compute cluster 1',x:.56,y:.18,width:.27,height:.28,compute_tflops:680,utilization:.79,area_mm2:118},
      {id:'sram-0',type:'sram',label:'Shared SRAM',x:.39,y:.53,width:.22,height:.17,capacity_gb:24,bandwidth_tb_s:4.2,area_mm2:24},
      {id:'hbm-0',type:'hbm',label:'HBM stack 0',x:.035,y:.25,width:.16,height:.42,capacity_gb:48,bandwidth_tb_s:1.45,area_mm2:58},
      {id:'hbm-1',type:'hbm',label:'HBM stack 1',x:.805,y:.25,width:.16,height:.42,capacity_gb:48,bandwidth_tb_s:1.45,area_mm2:58},
      {id:'fabric-0',type:'interconnect',label:'Die fabric',x:.31,y:.79,width:.38,height:.1,bandwidth_tb_s:5.8,area_mm2:21}
    ],connections:[{id:'link-h0',source:'hbm-0',target:'sram-0',bandwidth_tb_s:1.45},{id:'link-h1',source:'hbm-1',target:'sram-0',bandwidth_tb_s:1.45},{id:'link-c0',source:'sram-0',target:'compute-0',bandwidth_tb_s:2.9},{id:'link-c1',source:'sram-0',target:'compute-1',bandwidth_tb_s:2.9},{id:'link-f',source:'fabric-0',target:'sram-0',bandwidth_tb_s:5.8}]},
    {name:'Memory-first wide die',rationale:'Four HBM stacks feed a broad central fabric, with three smaller compute tiles placed around the memory spine.',components:[
      {id:'hbm-nw',type:'hbm',label:'HBM NW',x:.035,y:.06,width:.17,height:.29,capacity_gb:32,bandwidth_tb_s:1.2},
      {id:'hbm-sw',type:'hbm',label:'HBM SW',x:.035,y:.63,width:.17,height:.29,capacity_gb:32,bandwidth_tb_s:1.2},
      {id:'hbm-ne',type:'hbm',label:'HBM NE',x:.795,y:.06,width:.17,height:.29,capacity_gb:32,bandwidth_tb_s:1.2},
      {id:'hbm-se',type:'hbm',label:'HBM SE',x:.795,y:.63,width:.17,height:.29,capacity_gb:32,bandwidth_tb_s:1.2},
      {id:'fabric-spine',type:'fabric',label:'Memory fabric',x:.25,y:.39,width:.5,height:.2,bandwidth_tb_s:8.0},
      {id:'compute-n',type:'compute',label:'Compute north',x:.35,y:.1,width:.3,height:.21,compute_tflops:520,utilization:.72},
      {id:'compute-c',type:'compute',label:'Compute center',x:.35,y:.395,width:.3,height:.19,compute_tflops:520,utilization:.88},
      {id:'compute-s',type:'compute',label:'Compute south',x:.35,y:.69,width:.3,height:.21,compute_tflops:520,utilization:.61}
    ],connections:[{id:'l1',source:'hbm-nw',target:'fabric-spine',bandwidth_tb_s:1.2},{id:'l2',source:'hbm-sw',target:'fabric-spine',bandwidth_tb_s:1.2},{id:'l3',source:'hbm-ne',target:'fabric-spine',bandwidth_tb_s:1.2},{id:'l4',source:'hbm-se',target:'fabric-spine',bandwidth_tb_s:1.2},{id:'l5',source:'fabric-spine',target:'compute-n',bandwidth_tb_s:2.4},{id:'l6',source:'fabric-spine',target:'compute-c',bandwidth_tb_s:2.4},{id:'l7',source:'fabric-spine',target:'compute-s',bandwidth_tb_s:2.4}]},
    {name:'Chiplet mesh',rationale:'Four chiplets connect through a mesh ring; local caches reduce pressure on the two HBM stacks.',components:[
      {id:'chiplet-0',type:'compute',label:'Compute chiplet 0',x:.22,y:.13,width:.24,height:.26,compute_tflops:760,utilization:.55},
      {id:'chiplet-1',type:'compute',label:'Compute chiplet 1',x:.54,y:.13,width:.24,height:.26,compute_tflops:760,utilization:.69},
      {id:'chiplet-2',type:'compute',label:'Compute chiplet 2',x:.22,y:.61,width:.24,height:.26,compute_tflops:760,utilization:.82},
      {id:'chiplet-3',type:'compute',label:'Compute chiplet 3',x:.54,y:.61,width:.24,height:.26,compute_tflops:760,utilization:.73},
      {id:'cache-0',type:'sram',label:'L3 cache west',x:.04,y:.37,width:.16,height:.18,capacity_gb:18,bandwidth_tb_s:3.1},
      {id:'cache-1',type:'sram',label:'L3 cache east',x:.80,y:.37,width:.16,height:.18,capacity_gb:18,bandwidth_tb_s:3.1},
      {id:'hbm-a',type:'hbm',label:'HBM A',x:.29,y:.38,width:.16,height:.16,capacity_gb:64,bandwidth_tb_s:1.8},
      {id:'hbm-b',type:'hbm',label:'HBM B',x:.55,y:.38,width:.16,height:.16,capacity_gb:64,bandwidth_tb_s:1.8}
    ],connections:[{id:'m1',source:'chiplet-0',target:'chiplet-1',bandwidth_tb_s:2.5},{id:'m2',source:'chiplet-1',target:'chiplet-3',bandwidth_tb_s:2.5},{id:'m3',source:'chiplet-3',target:'chiplet-2',bandwidth_tb_s:2.5},{id:'m4',source:'chiplet-2',target:'chiplet-0',bandwidth_tb_s:2.5},{id:'m5',source:'chiplet-0',target:'cache-0',bandwidth_tb_s:1.5},{id:'m6',source:'chiplet-2',target:'cache-0',bandwidth_tb_s:1.5},{id:'m7',source:'chiplet-1',target:'cache-1',bandwidth_tb_s:1.5},{id:'m8',source:'chiplet-3',target:'cache-1',bandwidth_tb_s:1.5},{id:'m9',source:'hbm-a',target:'chiplet-0',bandwidth_tb_s:1.8},{id:'m10',source:'hbm-b',target:'chiplet-3',bandwidth_tb_s:1.8}]}
  ];

  const format = (value, digits=1) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined,{maximumFractionDigits:digits}) : '—';
  const normalize = (design) => {
    if (!design || typeof design !== 'object') return null;
    const inner = design.design && typeof design.design === 'object' ? design.design : design;
    const components = inner.components;
    const connections = inner.connections;
    if (!Array.isArray(components) || !Array.isArray(connections)) return { ...inner, components:[], connections:[], legacy:true };
    return {...inner, components, connections, legacy:false};
  };
  const esc = (value) => String(value ?? '');
  const svgNode = (name, attrs={}) => {
    const node = document.createElementNS(NS,name);
    Object.entries(attrs).forEach(([key,value])=>node.setAttribute(key,String(value)));
    return node;
  };
  const appendText = (parent, x, y, text, className, anchor='middle') => {
    const node=svgNode('text',{x,y,'text-anchor':anchor,class:className}); node.textContent=esc(text); parent.append(node); return node;
  };
  const metricFor = (id) => currentMetrics?.component_metrics?.[id] || currentMetrics?.component_metrics?.find?.(item=>item.component_id===id || item.id===id) || {};
  const componentHeat = (component) => {
    const m=metricFor(component.id); const temp=Number(m.temperature_c ?? m.temp_c ?? currentMetrics?.component_temperatures?.[component.id]);
    const util=Number(m.utilization ?? m.utilization_fraction ?? component.utilization);
    if (Number.isFinite(temp)) return temp>=90?'hot':temp>=75?'warm':'cool';
    if (Number.isFinite(util)) return util>=.85?'hot':util>=.65?'warm':'cool';
    return '';
  };
  const kind = (type) => {
    const s=String(type||'other').toLowerCase();
    if (/compute|core|tensor/.test(s)) return 'compute';
    if (/hbm|memory|dram/.test(s)) return 'memory';
    if (/sram|cache|buffer/.test(s)) return 'cache';
    if (/fabric|interconnect|switch|noc|dma|io/.test(s)) return 'fabric';
    return 'other';
  };
  const topologyCheck = (design, extraErrors=[]) => {
    const errors=[]; const ids=new Set();
    const backendErrors=[...(design.topology_errors || design.validation_errors || []),...(currentMetrics?.topology_errors || []),...(extraErrors||[])];
    if (Array.isArray(backendErrors)) errors.push(...backendErrors.map(String));
    design.components.forEach((c,i)=>{
      if (!c || !c.id) { errors.push(`Component ${i+1} is missing an ID.`); return; }
      const id=String(c.id); if(ids.has(id)) errors.push(`Duplicate component ID: ${id}.`); ids.add(id);
      const box=['x','y','width','height'].map(k=>Number(c[k]));
      if(!box.every(Number.isFinite) || box[0]<0 || box[1]<0 || box[2]<=0 || box[3]<=0 || box[0]+box[2]>1.00001 || box[1]+box[3]>1.00001) errors.push(`${id} has invalid die geometry.`);
    });
    design.connections.forEach((link,i)=>{
      const src=link.source ?? link.from; const dst=link.target ?? link.to;
      if(!ids.has(String(src)) || !ids.has(String(dst))) errors.push(`Connection ${link.id || i+1} points to a missing component.`);
      if(String(src)===String(dst)) errors.push(`Connection ${link.id || i+1} loops back to itself.`);
    });
    return [...new Set(errors)];
  };
  const summaryDiff = (before, after) => {
    if (!before) return `${after.components.length} components and ${after.connections.length} links in the first proposed topology.`;
    const oldC=new Map(before.components.map(c=>[String(c.id),c])); const newC=new Map(after.components.map(c=>[String(c.id),c]));
    const added=[...newC.keys()].filter(id=>!oldC.has(id)); const removed=[...oldC.keys()].filter(id=>!newC.has(id));
    const moved=[];
    for(const [id,c] of newC){const old=oldC.get(id); if(old && ['x','y','width','height'].some(k=>Math.abs(Number(old[k])-Number(c[k]))>.005)) moved.push(id);}
    const oldLinks=new Set(before.connections.map(c=>`${c.source ?? c.from}>${c.target ?? c.to}`));
    const newLinks=new Set(after.connections.map(c=>`${c.source ?? c.from}>${c.target ?? c.to}`));
    const addedLinks=[...newLinks].filter(l=>!oldLinks.has(l)).length; const removedLinks=[...oldLinks].filter(l=>!newLinks.has(l)).length;
    const parts=[];
    if(added.length) parts.push(`added ${added.length} block${added.length===1?'':'s'} (${added.slice(0,2).join(', ')})`);
    if(removed.length) parts.push(`removed ${removed.length} block${removed.length===1?'':'s'} (${removed.slice(0,2).join(', ')})`);
    if(moved.length) parts.push(`repositioned ${moved.length} block${moved.length===1?'':'s'}`);
    if(addedLinks || removedLinks) parts.push(`${addedLinks} links added, ${removedLinks} removed`);
    if(!parts.length) parts.push('component positions and connections match the previous proposal');
    return parts.join(' · ')+'.';
  };
  const point = (component, side) => {
    const x=die.x+Number(component.x)*die.width, y=die.y+Number(component.y)*die.height;
    const w=Number(component.width)*die.width, h=Number(component.height)*die.height;
    if(side==='left')return{x,y:y+h/2}; if(side==='right')return{x:x+w,y:y+h/2}; if(side==='top')return{x:x+w/2,y}; if(side==='bottom')return{x:x+w/2,y:y+h};
    return{x:x+w/2,y:y+h/2};
  };
  const connectionPath = (a,b) => {
    const p=point(a,'center'),q=point(b,'center'); const bendX=Math.round((p.x+q.x)/2);
    return `M ${p.x} ${p.y} H ${bendX} V ${q.y} H ${q.x}`;
  };
  const showValidation = (errors, legacy=false) => {
    const box=$('#validation-box'); const ul=$('#validation-messages'); ul.replaceChildren();
    box.classList.toggle('valid',!legacy&&!errors.length); box.classList.toggle('invalid',legacy||errors.length>0);
    $('#validation-title').textContent=legacy?'Legacy design':errors.length?'Invalid topology':'Topology valid';
    const messages=legacy?['This proposal has scalar hardware settings but no components / connections graph.']:errors.length?errors:['All component IDs, connection endpoints, and die bounds are valid.'];
    messages.forEach(msg=>{const li=document.createElement('li');li.textContent=msg;ul.append(li);});
    $('#schema-status').className=`schema-status ${legacy||errors.length?'invalid':'valid'}`;
    $('#schema-status span').textContent=legacy?'Legacy fields only':errors.length?'Topology errors':'Components + connections';
    $('#topology-status').className=`validity-chip ${legacy||errors.length?'invalid':'valid'}`;
    $('#topology-status span').textContent=legacy?'Legacy design':errors.length?'Invalid topology':'Topology valid';
  };

  const drawDesign = (design, options={}) => {
    const normalized=normalize(design); if(!normalized)return;
    const previous=currentDesign; currentDesign=normalized;
    if(options.resetMetrics){currentMetrics=null;currentTopologyErrors=[];}
    if(options.topologyErrors) currentTopologyErrors=options.topologyErrors;
    if(options.metrics) currentMetrics=options.metrics;
    const legacy=normalized.legacy;
    const errors=legacy?[]:topologyCheck(normalized,currentTopologyErrors);
    $('#design-title').textContent=normalized.name || options.title || 'LLM proposed accelerator';
    $('#design-name').textContent=normalized.name || `Round ${options.round || '—'}`;
    $('#design-rationale').textContent=normalized.rationale || options.feedback || (legacy?'This saved design predates the component topology schema.':'Exact component geometry from the current LLM proposal.');
    $('#design-round').textContent=options.badge || (options.round ? `ROUND ${options.round}` : 'DESIGN');
    $('#canvas-count').textContent=legacy?'NO GRAPH':`${normalized.components.length} COMPONENTS · ${normalized.connections.length} LINKS`;
    $('#canvas-empty').hidden=!legacy;
    $('#canvas-caption').innerHTML=legacy?'<i class="pulse-dot"></i>Topology graph unavailable':'<i class="pulse-dot"></i>Showing exact proposed component geometry';
    if(legacy){graph.replaceChildren();$('#empty-detail').textContent='This is a legacy scalar-only design. The application will not invent a chip diagram; a component graph is required.';}
    else renderGraph(normalized,errors);
    showValidation(errors,legacy);
    $('#change-summary').textContent=legacy?'This design has no graph to compare. Add components and connections to visualize the proposed chip.':summaryDiff(previous && !previous.legacy ? previous : null,normalized);
    if(options.metrics) applyMetrics(options.metrics);
    renderConnections(normalized,errors);
    updateInspector(selectedComponentId);
    if(options.animate && !reducedMotion){graph.classList.remove('design-fade'); void graph.getBoundingClientRect(); graph.classList.add('design-fade');}
  };

  const renderGraph = (design, errors) => {
    graph.replaceChildren();
    graph.append(svgNode('rect',{x:die.x,y:die.y,width:die.width,height:die.height,rx:20,class:'die-outline'}));
    graph.append(svgNode('rect',{x:die.x+8,y:die.y+8,width:die.width-16,height:die.height-16,rx:14,class:'die-outline-inner'}));
    appendText(graph,die.x+12,die.y-15,'DIE FLOORPLAN','die-label-svg','start');
    appendText(graph,die.x+die.width-12,die.y-15,`${design.components.length} BLOCKS`,'die-label-svg','end');
    const byId=new Map(design.components.filter(c=>c?.id).map(c=>[String(c.id),c]));
    const invalidIDs=new Set();
    design.connections.forEach((link,i)=>{const a=byId.get(String(link.source ?? link.from));const b=byId.get(String(link.target ?? link.to));if(!a||!b){if(a)invalidIDs.add(String(a.id));if(b)invalidIDs.add(String(b.id));return;}
      const pathD=connectionPath(a,b); const path=svgNode('path',{d:pathD,class:'connection-path flow-dash','marker-end':'url(#arrowhead)'});path.dataset.connection=link.id||i;path.setAttribute('aria-label',`${link.source ?? link.from} to ${link.target ?? link.to}`);graph.append(path);
      const midpoint=svgNode('circle',{r:3,class:'flow-dot'});const animate=svgNode('animateMotion',{dur:'2.4s',repeatCount:'indefinite',path:pathD});midpoint.append(animate);graph.append(midpoint);
      if(Number.isFinite(Number(link.bandwidth_tb_s))) appendText(graph,(point(a,'center').x+point(b,'center').x)/2,(point(a,'center').y+point(b,'center').y)/2-5,`${format(link.bandwidth_tb_s,2)} TB/s`,'component-util');
    });
    const bottlenecks=new Set([...(currentMetrics?.bottleneck_component_ids||[]),...(currentMetrics?.bottleneck_components||[]).map(v=>typeof v==='string'?v:v.id)] .filter(Boolean).map(String));
    const invalidIDFromErrors=(id)=>errors.some(error=>String(error).includes(id));
    design.components.slice().sort((a,b)=>Number(a?.layer||0)-Number(b?.layer||0)).forEach((c,index)=>{
      if(!c || !Number.isFinite(Number(c.x))||!Number.isFinite(Number(c.y))||!Number.isFinite(Number(c.width))||!Number.isFinite(Number(c.height)))return;
      const x=die.x+Number(c.x)*die.width,y=die.y+Number(c.y)*die.height,w=Math.max(3,Number(c.width)*die.width),h=Math.max(3,Number(c.height)*die.height);
      const g=svgNode('g',{class:`component-group${bottlenecks.has(String(c.id))?' bottleneck':''}${invalidIDs.has(String(c.id))||invalidIDFromErrors(c.id)?' invalid':''}${selectedComponentId===String(c.id)?' selected':''}`,tabindex:'0',role:'button','aria-label':`${c.label||c.id}, ${c.type||'component'}`, 'data-component-id':c.id});
      g.append(svgNode('rect',{x,y,width:w,height:h,rx:Math.min(9,Math.max(3,h*.09)),class:`component-shell ${kind(c.type)} ${componentHeat(c)?`heat-${componentHeat(c)}`:''}`}));
      if(bottlenecks.has(String(c.id)))appendText(g,x+w-9,y+15,'!','bottleneck-badge');
      if(invalidIDs.has(String(c.id))||invalidIDFromErrors(c.id))appendText(g,x+9,y+15,'×','invalid-mark','start');
      const label=String(c.label||c.name||c.id); const maxChars=Math.max(7,Math.floor(w/7));
      appendText(g,x+w/2,y+h/2-2,label.length>maxChars?`${label.slice(0,maxChars-1)}…`:label,'component-label');
      const facts=[]; if(c.capacity_gb!=null)facts.push(`${format(c.capacity_gb,1)} GB`);if(c.compute_tflops!=null)facts.push(`${format(c.compute_tflops,0)} TFLOP/s`);if(c.bandwidth_tb_s!=null)facts.push(`${format(c.bandwidth_tb_s,2)} TB/s`);
      if(facts.length&&h>45)appendText(g,x+w/2,y+h/2+15,facts.slice(0,2).join(' · '),'component-sub-label');
      const m=metricFor(c.id);const util=Number(m.utilization??m.utilization_fraction??c.utilization);
      if(Number.isFinite(util)&&h>56)appendText(g,x+w/2,y+h-8,`${Math.round(util*100)}% utilization`,'component-util');
      const click=()=>{selectedComponentId=String(c.id);updateInspector(selectedComponentId);graph.querySelectorAll('.component-group').forEach(n=>n.classList.toggle('selected',n.dataset.componentId===selectedComponentId));};
      g.addEventListener('click',click);g.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();click();}});graph.append(g);
    });
  };
  const renderConnections=(design,errors)=>{
    const list=$('#connection-list');list.replaceChildren();
    if(design.legacy||!design.connections.length){const span=document.createElement('span');span.className='muted';span.textContent=design.legacy?'No graph available in legacy design':'No links in this design';list.append(span);return;}
    const ids=new Set(design.components.map(c=>String(c.id)));
    design.connections.forEach((link,i)=>{const row=document.createElement('div');const from=String(link.source??link.from??'?'),to=String(link.target??link.to??'?');const invalid=!ids.has(from)||!ids.has(to);row.className=`connection-item${invalid?' invalid':''}`;
      const strong=document.createElement('b');strong.textContent=`${from} → ${to}`;row.append(strong);
      const info=[];if(link.bandwidth_tb_s!=null)info.push(`${format(link.bandwidth_tb_s,2)} TB/s`);if(link.latency_ns!=null)info.push(`${format(link.latency_ns,1)} ns`);if(link.label)info.push(String(link.label));const detail=document.createElement('span');detail.textContent=` · ${info.join(' · ')||link.id||`Link ${i+1}`}`;row.append(detail);list.append(row);
    });
  };
  const updateInspector=(id)=>{
    const c=currentDesign&&!currentDesign.legacy?currentDesign.components.find(item=>String(item.id)===String(id)):null;
    $('#inspector-count').textContent=`${currentDesign?.components.length||0} blocks`;
    $('#inspector-empty').hidden=!!c;$('#inspector-content').hidden=!c;if(!c)return;
    $('#component-name').textContent=c.label||c.name||c.id;$('#component-type').textContent=c.type||'component';
    const icons={compute:'▦',memory:'▤',cache:'▥',fabric:'⌘',other:'◇'};$('#component-icon').textContent=icons[kind(c.type)];
    const rows=[['ID',c.id],['Position',`${format(c.x*100,1)}%, ${format(c.y*100,1)}%`],['Footprint',`${format(c.width*100,1)}% × ${format(c.height*100,1)}%`],['Compute',c.compute_tflops==null?null:`${format(c.compute_tflops,1)} TFLOP/s`],['Capacity',c.capacity_gb==null?null:`${format(c.capacity_gb,1)} GB`],['Bandwidth',c.bandwidth_tb_s==null?null:`${format(c.bandwidth_tb_s,2)} TB/s`],['DMA engines',c.dma_engines],['Area',c.area_mm2==null?null:`${format(c.area_mm2,1)} mm²`],['Layer',c.layer]];
    const dl=$('#component-properties');dl.replaceChildren();rows.filter(([,v])=>v!=null).forEach(([label,value])=>{const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=String(value);dl.append(dt,dd);});
    const m=metricFor(c.id);const temp=m.temperature_c??m.temp_c??currentMetrics?.component_temperatures?.[c.id];const util=m.utilization??m.utilization_fraction??c.utilization;const bottleneck=Boolean((currentMetrics?.bottleneck_component_ids||[]).map(String).includes(String(c.id)));
    const parts=[];if(temp!=null)parts.push(`Simulated temperature ${format(temp,1)} °C`);if(util!=null)parts.push(`Utilization ${format(Number(util)*100,0)}%`);if(bottleneck)parts.push('Checker bottleneck: this block is limiting the current design.');$('#component-telemetry').textContent=parts.join(' · ')||'No component-specific simulation telemetry yet.';
  };
  const applyMetrics=(metrics)=>{
    if(!metrics)return;currentMetrics=metrics;
    const value=(...keys)=>{for(const key of keys)if(metrics[key]!=null)return metrics[key];return null;};
    $('#metric-ttft').textContent=format(value('ttft_p99_ms','p99_ttft_ms','predicted_p99_ttft_ms'));
    $('#metric-throughput').textContent=format(value('throughput_tokens_s','throughput_tokens_per_second','throughput_toks_s'),0);
    $('#metric-power').textContent=format(value('power_w','power_watts'),0);
    $('#metric-temp').textContent=format(value('max_temperature_c','temperature_c','temp_c'),1);
    $('#metric-area').textContent=format(value('area_mm2','estimated_area_mm2'),1);
    const gates=metrics.gate_results;const accepted=metrics.accepted;
    $('#checker-note').textContent=metrics.feedback||metrics.rationale||(accepted===true?'This design passed the simulation gates.':accepted===false?'This candidate did not pass every simulation gate.':gates?`Checker gates: ${Object.entries(gates).map(([k,v])=>`${k} ${v?'pass':'fail'}`).join(' · ')}`:'Simulation metrics are attached to this design.');
    if(currentDesign&&!currentDesign.legacy){const errors=topologyCheck(currentDesign,currentTopologyErrors);renderGraph(currentDesign,errors);updateInspector(selectedComponentId);}
  };
  const renderHistory=()=>{
    roundsNode.replaceChildren();$('#round-counter').textContent=`${history.length} proposal${history.length===1?'':'s'}`;
    if(!history.length){const empty=document.createElement('div');empty.className='round-empty';empty.textContent='Each LLM proposal and checker result will appear here.';roundsNode.append(empty);return;}
    history.slice().reverse().forEach((entry,index)=>{const originalIndex=history.length-index;const row=document.createElement('button');row.type='button';row.className=`round-item ${entry.status}${entry.selected?' selected':''}`;
      const n=document.createElement('span');n.className='round-index';n.textContent=String(entry.round||originalIndex);const copy=document.createElement('span');copy.className='round-copy';const b=document.createElement('b');b.textContent=entry.name||`Design round ${entry.round||originalIndex}`;const sm=document.createElement('small');sm.textContent=entry.status==='proposed'?'LLM proposed · awaiting simulation':entry.feedback||entry.status;copy.append(b,sm);const score=document.createElement('span');score.className='round-score';const strong=document.createElement('strong');strong.textContent=entry.status==='proposed'?'PENDING':entry.status==='rejected'?'REJECTED':entry.improved?'BEST':'EVALUATED';const meta=entry.metrics?.ttft_p99_ms??entry.metrics?.p99_ttft_ms;if(meta!=null)score.append(strong,document.createTextNode(`${format(meta,1)} ms`));else score.append(strong);row.append(n,copy,score);
      row.addEventListener('click',()=>{history.forEach(e=>e.selected=false);entry.selected=true;drawDesign(entry.design,{round:entry.round,badge:entry.improved?'BEST DESIGN':`ROUND ${entry.round||originalIndex}`,metrics:entry.metrics,topologyErrors:entry.topologyErrors,feedback:entry.feedback,title:entry.name,animate:true});renderHistory();});roundsNode.append(row);
    });
  };
  const upsertHistory=(data,status)=>{
    const round=Number(data.round||data.attempt?.round||1);const design=normalize(data.design||data.attempt?.design||data);if(!design)return null;
    let entry=history.find(item=>item.round===round);if(!entry){entry={id:data.id||data.attempt_id||data.attempt?.id,round,design,status:'proposed',name:data.name||data.attempt?.name||design.name,selected:true};history.forEach(e=>e.selected=false);history.push(entry);}else{entry.id=data.id||data.attempt_id||data.attempt?.id||entry.id;entry.design=design;entry.name=data.name||data.attempt?.name||entry.name||design.name;}
    entry.status=status||entry.status;entry.feedback=data.feedback||data.attempt?.feedback||entry.feedback;entry.metrics=data.metrics||data.attempt?.metrics||entry.metrics;entry.topologyErrors=data.topology_errors||data.attempt?.topology_errors||entry.topologyErrors||[];entry.improved=Boolean(data.improved||data.attempt?.improved);entry.accepted=data.accepted??data.attempt?.accepted??entry.accepted;
    renderHistory();return entry;
  };
  const applyState=(state)=>{
    if(!state||typeof state!=='object')return;
    const design=state.design||state.current_design||state.best_design||state.best_attempt?.design||state.campaign?.best_attempt?.design;
    const metrics=state.metrics||state.simulation||state.best_attempt?.metrics||state.campaign?.best_attempt?.metrics;
    if(design)drawDesign(design,{metrics,round:state.round||state.campaign?.current_round,badge:state.best_design?'BEST DESIGN':undefined});else if(metrics)applyMetrics(metrics);
    if(state.connected===false){$('#connection-label').textContent='Demo mode';$('.live-status').classList.add('disconnected');}
    else if(state.connected===true){$('#connection-label').textContent='API connected';$('.live-status').classList.remove('disconnected');}
    if(state.campaign)applyCampaign(state.campaign);
  };
  const applyCampaign=(campaign)=>{
    if(!campaign)return;const count=campaign.rounds??campaign.current_step??campaign.total_steps??0;
    if(campaign.status==='running'){campaignButton.disabled=true;$('#campaign-button-label').textContent='Building…';$('#loop-status').className='loop-status running';$('#loop-status span:last-child').textContent=`Round ${count||1} · simulation loop running`;}
    else if(campaign.status==='completed'){campaignButton.disabled=false;$('#campaign-button-label').textContent='Build another chip';$('#loop-status').className='loop-status done';$('#loop-status span:last-child').textContent='Design loop complete';}
    else {campaignButton.disabled=false;$('#campaign-button-label').textContent='Build and test chip';}
  };
  const api=async(path,options={})=>{const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});if(!response.ok)throw new Error(`${path}: ${response.status}`);return response.status===204?null:response.json();};
  const stopFallback=()=>{if(fallbackTimer){clearInterval(fallbackTimer);fallbackTimer=null;}};
  const startFallback=()=>{
    $('#connection-label').textContent='Example designs';$('.live-status').classList.add('disconnected');
    const show=()=>{const design=examples[fallbackIndex%examples.length];fallbackIndex+=1;drawDesign(design,{round:fallbackIndex,badge:'EXAMPLE',metrics:{component_metrics:Object.fromEntries(design.components.map(c=>[c.id,{utilization:c.utilization??.42,temperature_c:c.utilization?55+c.utilization*35:58}]))},animate:true});$('#design-title').textContent=design.name;$('#design-name').textContent=design.name;};
    show();fallbackTimer=setInterval(show,8500);
  };
  const connect=async()=>{
    for(const path of ['/api/state','/api/overview']){try{const state=await api(path);stopFallback();applyState(state);$('#connection-label').textContent='API connected';$('.live-status').classList.remove('disconnected');return;}catch(_){}}
    try{await api('/api/health');$('#connection-label').textContent='API connected';$('.live-status').classList.remove('disconnected');}catch(_){startFallback();}
  };
  const connectEvents=(campaignId)=>{
    if(!('EventSource'in window))return;
    if(eventSource)eventSource.close();eventSource=new EventSource(`/api/events/${encodeURIComponent(campaignId)}`);
    eventSource.onopen=()=>{$('#connection-label').textContent='Live AI loop';$('.live-status').classList.remove('disconnected');};
    const handle=async(event)=>{let data;try{data=JSON.parse(event.data);}catch(_){return;}
      if(event.type==='design.proposed'){
        stopFallback();const entry=upsertHistory(data,'proposed');if(entry)drawDesign(entry.design,{round:entry.round,badge:`ROUND ${entry.round}`,feedback:data.rationale,metrics:data.metrics,resetMetrics:true,animate:true});$('#loop-status').className='loop-status running';$('#loop-status span:last-child').textContent=`Round ${data.round||1} · proposed by AI`;$('#connection-label').textContent='LLM proposed design';
      }else if(event.type==='design.evaluated'||event.type==='design.rejected'){
        const status=event.type==='design.rejected'?'rejected':'evaluated';const entry=upsertHistory(data,status);if(entry){drawDesign(entry.design,{round:entry.round,badge:`ROUND ${entry.round}`,metrics:entry.metrics,topologyErrors:entry.topologyErrors,feedback:entry.feedback,animate:true});if(entry.metrics)applyMetrics(entry.metrics);}
        $('#loop-status').className='loop-status running';$('#loop-status span:last-child').textContent=`Round ${data.round||1} · checker feedback received`;
      }else if(event.type==='campaign.best_updated'){
        const attemptId=String(data.attempt_id||data.id||'');const entry=(data.design||data.attempt?.design)?upsertHistory(data,'evaluated'):history.find(item=>attemptId&&String(item.id)===attemptId);
        if(entry){entry.improved=true;history.forEach(item=>item.selected=item===entry);renderHistory();drawDesign(entry.design,{round:entry.round,badge:'BEST DESIGN',metrics:data.metrics||entry.metrics,topologyErrors:entry.topologyErrors,feedback:entry.feedback,animate:true});}
        else {$('#design-round').textContent='BEST DESIGN';if(data.metrics)applyMetrics(data.metrics);}
        $('#loop-status').className='loop-status running';$('#loop-status span:last-child').textContent='Best feasible design updated';
      }else if(event.type==='campaign.completed'){
        applyCampaign({status:'completed',rounds:data.rounds});$('#loop-status').className='loop-status done';$('#loop-status span:last-child').textContent=data.stop_reason||'Design loop complete';
        try{const finalCampaign=await api(`/api/campaigns/${encodeURIComponent(campaignId)}`);const best=finalCampaign.best_attempt;if(best?.design){const entry=upsertHistory(best,'evaluated');if(entry){entry.improved=true;history.forEach(item=>item.selected=item===entry);renderHistory();drawDesign(entry.design,{round:entry.round,badge:'BEST DESIGN',metrics:entry.metrics,topologyErrors:entry.topologyErrors,feedback:entry.feedback,animate:true});}}}catch(_){}
        eventSource.close();
      }else if(event.type==='campaign.started'){$('#loop-status').className='loop-status running';$('#loop-status span:last-child').textContent='LLM preparing first design';}
    };
    ['campaign.started','design.proposed','design.evaluated','design.rejected','campaign.best_updated','campaign.completed'].forEach(type=>eventSource.addEventListener(type,handle));
    eventSource.onerror=()=>{if(eventSource.readyState===EventSource.CONNECTING)$('#connection-label').textContent='Reconnecting…';};
  };

  $('#start-campaign').addEventListener('click',async()=>{
    stopFallback();campaignButton.disabled=true;$('#campaign-button-label').textContent='Starting…';const trace=$('#workload-select').value;let result;
    const goal=$('#design-goal').value.trim()||'Minimize p99 TTFT without reducing throughput';
    for(const path of ['/api/campaigns','/api/campaigns/start','/api/campaign/start']){try{result=await api(path,{method:'POST',body:JSON.stringify({goal,trace,max_rounds:5,constraints:{max_power_w:600,max_temperature_c:90,max_area_mm2:700}})});break;}catch(_){}}
    if(result){applyCampaign(result.campaign||result);if(result.id)connectEvents(result.id);$('#connection-label').textContent='Campaign started';}
    else{campaignButton.disabled=false;$('#campaign-button-label').textContent='Build and test chip';$('#loop-status').className='loop-status';$('#loop-status span:last-child').textContent='Service unavailable · showing example designs';startFallback();}
  });
  const marker=svgNode('defs');const markerArrow=svgNode('marker',{id:'arrowhead',viewBox:'0 0 10 10',refX:'8',refY:'5',markerWidth:'5',markerHeight:'5',orient:'auto-start-reverse'});markerArrow.append(svgNode('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#73bdf2'}));marker.append(markerArrow);svg.insertBefore(marker,graph);
  connect();
})();
