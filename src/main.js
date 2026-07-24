import { Chart, registerables } from 'chart.js';
import {
  initDB, loadData,
  getRegions, getFilteredTrend, getFilteredRegions,
  getFilteredProvinces, getHeatmapData, getYoyByRegion,
  getRankings, getKpis, getFilteredCount, getFilteredCSV,
} from './loader.js';

Chart.register(...registerables);

// ── Chart defaults (dark theme) ───────────────────────────────
Chart.defaults.color = '#7d8590';
Chart.defaults.borderColor = '#21262d';
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// ── DOM refs ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const overlay     = $('loading-overlay');
const loadingMsg  = $('loading-msg');
const statusEl    = $('status');
const statusText  = $('status-text');

// Filters
const yearMin     = $('yearMin');
const yearMax     = $('yearMax');
const yearMinLbl  = $('yearMinLabel');
const yearMaxLbl  = $('yearMaxLabel');
const regionFilter= $('regionFilter');
const heatmapMetric = $('heatmapMetric');

// Buttons
const applyBtn    = $('applyFilters');
const resetBtn    = $('resetFilters');
const exportBtn   = $('btnExport');
const exportModal = $('exportModal');
const closeModal  = $('closeModal');
const exportCSV   = $('exportCSV');
const exportJSON  = $('exportJSON');
const exportPNG   = $('exportPNG');

// ── State ─────────────────────────────────────────────────────
let conn = null;
let currentFilters = { yearMin: 2005, yearMax: 2024, region: '', rowTypes: ['region', 'province_city'] };
const charts = {};

// ── Helpers ───────────────────────────────────────────────────
function setStatus(state, msg) { statusEl.className = state; statusText.textContent = msg; }
function setLoading(msg) { loadingMsg.textContent = msg; }

function fmt(val, decimals = 1) {
  if (val == null) return '—';
  const n = Number(val);
  if (Math.abs(n) >= 1_000_000) return `₱${(n / 1_000_000).toFixed(decimals)}T`;
  if (Math.abs(n) >= 1_000)     return `₱${(n / 1_000).toFixed(decimals)}B`;
  return `₱${n.toFixed(decimals)}M`;
}

function fmtPct(val) {
  if (val == null) return null;
  const n = Number(val);
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

const PALETTE = [
  '#388bfd','#3fb950','#d29922','#bc8cff','#f85149',
  '#39c5cf','#ff9a00','#79c0ff','#56d364','#ff7b72',
  '#d2a8ff','#ffa657','#7ee787','#ffa198','#cae8ff','#e3b341',
];

// ── Tabs ──────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Filter controls ───────────────────────────────────────────
yearMin.addEventListener('input', () => {
  if (Number(yearMin.value) > Number(yearMax.value)) yearMin.value = yearMax.value;
  yearMinLbl.textContent = yearMin.value;
});
yearMax.addEventListener('input', () => {
  if (Number(yearMax.value) < Number(yearMin.value)) yearMax.value = yearMin.value;
  yearMaxLbl.textContent = yearMax.value;
});

function readFilters() {
  const rowTypes = [...document.querySelectorAll('#rowTypeFilter input:checked')].map(c => c.value);
  return {
    yearMin: Number(yearMin.value),
    yearMax: Number(yearMax.value),
    region: regionFilter.value,
    rowTypes,
  };
}

applyBtn.addEventListener('click', async () => {
  currentFilters = readFilters();
  setStatus('', 'Updating…');
  await renderAll();
  setStatus('ready', `Filtered · ${currentFilters.yearMin}–${currentFilters.yearMax}`);
});

resetBtn.addEventListener('click', () => {
  yearMin.value = 2005; yearMax.value = 2024;
  yearMinLbl.textContent = '2005'; yearMaxLbl.textContent = '2024';
  regionFilter.value = '';
  document.querySelectorAll('#rowTypeFilter input').forEach((c, i) => c.checked = i < 2);
  heatmapMetric.value = 'amount_millions';
  currentFilters = { yearMin: 2005, yearMax: 2024, region: '', rowTypes: ['region', 'province_city'] };
  applyBtn.click();
});

// ── Export ────────────────────────────────────────────────────
exportBtn.addEventListener('click', () => exportModal.classList.add('open'));
closeModal.addEventListener('click', () => exportModal.classList.remove('open'));
exportModal.addEventListener('click', (e) => { if (e.target === exportModal) exportModal.classList.remove('open'); });

exportCSV.addEventListener('click', async () => {
  exportModal.classList.remove('open');
  const data = await getFilteredCSV(conn, currentFilters);
  if (!data.length) return alert('No data with current filters');
  const headers = Object.keys(data[0]);
  const csv = [headers.join(','), ...data.map(r => headers.map(h => `"${r[h] ?? ''}"`).join(','))].join('\n');
  downloadFile(csv, 'bir_revenue_export.csv', 'text/csv');
});

exportJSON.addEventListener('click', async () => {
  exportModal.classList.remove('open');
  const data = await getFilteredCSV(conn, currentFilters);
  downloadFile(JSON.stringify(data, null, 2), 'bir_revenue_export.json', 'application/json');
});

exportPNG.addEventListener('click', async () => {
  exportModal.classList.remove('open');
  // Use html2canvas-like approach: convert main content to canvas
  const { default: html2canvas } = await import('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm');
  const mainEl = document.querySelector('.main-content');
  const canvas = await html2canvas(mainEl, { backgroundColor: '#0d1117', scale: 2 });
  const link = document.createElement('a');
  link.download = 'dashboard_screenshot.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
});

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Chart animation config ────────────────────────────────────
const ANIM = {
  duration: 600,
  easing: 'easeOutQuart',
};

// ══════════════════════════════════════════════════════════════
// RENDER FUNCTIONS
// ══════════════════════════════════════════════════════════════

async function renderKpis() {
  const kpi = await getKpis(conn, currentFilters);
  const count = await getFilteredCount(conn, currentFilters);

  $('kpi-net').textContent = fmt(kpi?.total_net);
  $('kpi-gross').textContent = fmt(kpi?.gross_total);
  $('kpi-refund').textContent = kpi?.tax_refund ? fmt(Math.abs(kpi.tax_refund)) : '—';
  $('kpi-records').textContent = count.toLocaleString();

  const yoyBadge = $('kpi-yoy');
  if (kpi?.total_net && kpi?.prev_total) {
    const pct = ((kpi.total_net - kpi.prev_total) / kpi.prev_total) * 100;
    yoyBadge.textContent = fmtPct(pct) + ' YoY';
    yoyBadge.className = 'kpi-badge ' + (pct >= 0 ? 'badge-up' : 'badge-down');
  } else { yoyBadge.textContent = '—'; yoyBadge.className = 'kpi-badge'; }

  $('kpi-top-region').textContent = kpi?.top_region
    ? kpi.top_region.replace(/^Region\s+\S+\s+\((.+)\)$/, '$1')
    : '—';
}

async function renderTrend() {
  destroyChart('trend');
  const data = await getFilteredTrend(conn, currentFilters);
  if (!data.length) return;

  const labels = data.map(d => d.year);
  const amounts = data.map(d => Number(d.amount));
  const yoys = data.map(d => d.avg_yoy != null ? Number(d.avg_yoy) : null);

  charts.trend = new Chart($('trendChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar', label: 'Net Collection (₱M)', data: amounts,
          backgroundColor: labels.map(y => y === 2020 || y === 2021 ? 'rgba(248,81,73,0.55)' : 'rgba(56,139,253,0.6)'),
          borderColor: labels.map(y => y === 2020 || y === 2021 ? '#f85149' : '#388bfd'),
          borderWidth: 1, yAxisID: 'yLeft',
        },
        {
          type: 'line', label: 'YoY %', data: yoys,
          borderColor: '#3fb950', backgroundColor: 'transparent',
          pointBackgroundColor: yoys.map(v => v != null && v < 0 ? '#f85149' : '#3fb950'),
          pointRadius: 4, tension: 0.3, yAxisID: 'yRight',
        },
      ],
    },
    options: {
      responsive: true, animation: ANIM,
      interaction: { mode: 'index' },
      plugins: { legend: { labels: { boxWidth: 12 } } },
      scales: {
        yLeft: { type: 'linear', position: 'left', ticks: { callback: v => fmt(v, 0) }, grid: { color: '#21262d' } },
        yRight: { type: 'linear', position: 'right', ticks: { callback: v => v != null ? `${v.toFixed(0)}%` : '' }, grid: { drawOnChartArea: false } },
        x: { grid: { color: '#21262d' } },
      },
    },
  });
}

async function renderRegionBar() {
  destroyChart('regionBar');
  const data = await getFilteredRegions(conn, currentFilters);
  if (!data.length) return;

  charts.regionBar = new Chart($('regionBarChart'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.region),
      datasets: [{
        data: data.map(d => Number(d.total)),
        backgroundColor: PALETTE.slice(0, data.length).map(c => c + 'bb'),
        borderColor: PALETTE.slice(0, data.length),
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: 'y', responsive: true, animation: ANIM,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${fmt(ctx.parsed.x)}` } } },
      scales: {
        x: { ticks: { callback: v => fmt(v, 0) }, grid: { color: '#21262d' } },
        y: { ticks: { font: { size: 11 } }, grid: { color: '#21262d' } },
      },
    },
  });
}

async function renderProvinces() {
  destroyChart('province');
  const data = await getFilteredProvinces(conn, currentFilters);
  if (!data.length) return;

  charts.province = new Chart($('provinceChart'), {
    type: 'bar',
    data: {
      labels: data.map(d => d.particulars),
      datasets: [{
        data: data.map(d => Number(d.total)),
        backgroundColor: 'rgba(188,140,255,0.6)',
        borderColor: '#bc8cff', borderWidth: 1,
      }],
    },
    options: {
      indexAxis: 'y', responsive: true, animation: ANIM,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${fmt(ctx.parsed.x)}` } } },
      scales: {
        x: { ticks: { callback: v => fmt(v, 0) }, grid: { color: '#21262d' } },
        y: { ticks: { font: { size: 10 } }, grid: { color: '#21262d' } },
      },
    },
  });
}

// ── Heatmap (HTML table with colour-coded cells + tooltip + legend) ──
async function renderHeatmap() {
  const metric = heatmapMetric.value;
  const metricLabels = { amount_millions: 'Revenue (₱M)', yoy_pct: 'YoY Growth (%)', share_of_national_pct: 'National Share (%)' };
  const metricAgg = { amount_millions: 'SUM', yoy_pct: 'AVG', share_of_national_pct: 'AVG' };
  $('heatmapTitle').textContent = `Region × Year Heatmap — ${metricLabels[metric] || metric}`;
  $('heatmapQueryMetric').textContent = `${metricAgg[metric] || 'SUM'}(${metric})`;

  const data = await getHeatmapData(conn, currentFilters, metric);
  if (!data.length) { $('heatmapContainer').innerHTML = '<p style="color:var(--muted);padding:2rem;text-align:center;">No data for current filters</p>'; return; }

  // Pivot: regions as rows, years as columns
  const regions = [...new Set(data.map(d => d.region))].sort();
  const years = [...new Set(data.map(d => d.year))].sort();
  const lookup = {};
  let minVal = Infinity, maxVal = -Infinity;
  for (const d of data) {
    const v = d.value != null ? Number(d.value) : null;
    lookup[`${d.region}_${d.year}`] = v;
    if (v != null) { minVal = Math.min(minVal, v); maxVal = Math.max(maxVal, v); }
  }

  // Update legend
  const legendGradient = $('legendGradient');
  const legendRange = $('legendRange');
  if (metric === 'yoy_pct') {
    legendGradient.style.background = 'linear-gradient(to right, #f85149, #21262d, #3fb950)';
    legendRange.textContent = `${minVal.toFixed(1)}% → ${maxVal.toFixed(1)}%`;
  } else {
    legendGradient.style.background = 'linear-gradient(to right, #1e3650, #388bfd)';
    legendRange.textContent = metric === 'amount_millions'
      ? `₱${(minVal/1000).toFixed(0)}B → ₱${(maxVal/1000).toFixed(0)}B`
      : `${minVal.toFixed(2)}% → ${maxVal.toFixed(2)}%`;
  }

  // Colour interpolation
  function heatColor(val) {
    if (val == null) return 'transparent';
    if (metric === 'yoy_pct') {
      if (val < 0) return `rgba(248,81,73,${Math.min(0.85, Math.abs(val) / 25 * 0.85)})`;
      return `rgba(63,185,80,${Math.min(0.85, val / 35 * 0.85)})`;
    }
    const t = maxVal === minVal ? 0.5 : (val - minVal) / (maxVal - minVal);
    return `rgba(56,139,253,${0.15 + t * 0.75})`;
  }

  function formatCell(val) {
    if (val == null) return '—';
    if (metric === 'amount_millions') return `${(val / 1000).toFixed(0)}B`;
    return `${Number(val).toFixed(1)}%`;
  }

  function formatTooltip(region, year, val) {
    if (val == null) return `<b>${region}</b><br>Year: ${year}<br>No data`;
    const formatted = metric === 'amount_millions'
      ? `₱${Number(val).toLocaleString('en-PH', { maximumFractionDigits: 2 })}M`
      : `${Number(val).toFixed(2)}%`;
    return `<b>${region}</b><br>Year: ${year}<br>${metricLabels[metric]}: ${formatted}`;
  }

  // Build table HTML
  let html = '<table class="heatmap-table"><thead><tr><th class="region-label">Region</th>';
  for (const y of years) html += `<th>${y}</th>`;
  html += '</tr></thead><tbody>';

  for (const region of regions) {
    html += `<tr><td class="region-label">${region}</td>`;
    for (const y of years) {
      const val = lookup[`${region}_${y}`];
      const display = formatCell(val);
      html += `<td style="background:${heatColor(val)};color:${val != null ? '#e6edf3' : 'var(--muted)'}"
                   data-region="${region}" data-year="${y}" data-val="${val ?? ''}"
                   data-tip="${formatTooltip(region, y, val).replace(/"/g, '&quot;')}">${display}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  $('heatmapContainer').innerHTML = html;

  // Attach tooltip behavior
  const tooltip = $('heatmapTooltip');
  const container = $('heatmapContainer');

  container.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('td[data-tip]');
    if (!cell || cell.classList.contains('region-label')) return;
    tooltip.innerHTML = cell.dataset.tip;
    tooltip.classList.add('visible');
  });

  container.addEventListener('mousemove', (e) => {
    tooltip.style.left = `${e.clientX + 12}px`;
    tooltip.style.top = `${e.clientY - 10}px`;
  });

  container.addEventListener('mouseleave', () => {
    tooltip.classList.remove('visible');
  });
}

// ── YoY multi-line chart ──────────────────────────────────────
async function renderYoy() {
  destroyChart('yoy');
  const data = await getYoyByRegion(conn, currentFilters);
  if (!data.length) return;

  const regionMap = {};
  const yearSet = new Set();
  for (const row of data) {
    yearSet.add(row.year);
    if (!regionMap[row.region]) regionMap[row.region] = {};
    regionMap[row.region][row.year] = row.yoy_pct != null ? Number(row.yoy_pct) : null;
  }
  const years = [...yearSet].sort();
  const regions = Object.keys(regionMap).sort();

  charts.yoy = new Chart($('yoyChart'), {
    type: 'line',
    data: {
      labels: years,
      datasets: regions.map((region, i) => ({
        label: region.replace(/^Region\s+\S+\s+\((.+)\)$/, '$1').replace('National Capital Region (NCR)', 'NCR'),
        data: years.map(y => regionMap[region][y] ?? null),
        borderColor: PALETTE[i % PALETTE.length],
        backgroundColor: 'transparent',
        pointRadius: 2, pointHoverRadius: 5,
        tension: 0.25, spanGaps: true, borderWidth: 2,
      })),
    },
    options: {
      responsive: true, animation: ANIM,
      interaction: { mode: 'index' },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 10 } } } },
      scales: {
        y: { ticks: { callback: v => `${v}%` }, grid: { color: '#21262d' } },
        x: { grid: { color: '#21262d' } },
      },
    },
  });
}

// ── Rankings horizontal bar ───────────────────────────────────
async function renderRankings() {
  destroyChart('rank');
  const data = await getRankings(conn, currentFilters);
  if (!data.length) return;

  charts.rank = new Chart($('rankChart'), {
    type: 'bar',
    data: {
      labels: data.map((d, i) => `${i + 1}. ${d.particulars}`),
      datasets: [{
        data: data.map(d => Number(d.total)),
        backgroundColor: data.map((d, i) => {
          if (i < 3) return 'rgba(63,185,80,0.7)';
          if (i < 10) return 'rgba(56,139,253,0.6)';
          return 'rgba(125,133,144,0.4)';
        }),
        borderWidth: 0,
      }],
    },
    options: {
      indexAxis: 'y', responsive: true, animation: ANIM,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${fmt(ctx.parsed.x)} · Avg YoY: ${fmtPct(data[ctx.dataIndex]?.avg_yoy)}` } },
      },
      scales: {
        x: { ticks: { callback: v => fmt(v, 0) }, grid: { color: '#21262d' } },
        y: { ticks: { font: { size: 10 } }, grid: { color: '#21262d' } },
      },
    },
  });
}

// ── Master render ─────────────────────────────────────────────
async function renderAll() {
  await Promise.all([
    renderKpis(),
    renderTrend(),
    renderRegionBar(),
    renderProvinces(),
    renderHeatmap(),
    renderYoy(),
    renderRankings(),
  ]);
}

// ── Init ──────────────────────────────────────────────────────
async function init() {
  try {
    setLoading('Initializing DuckDB WASM…');
    const db = await initDB();

    setLoading('Loading PSCG data…');
    conn = await loadData(db, (msg) => setLoading(msg));

    setLoading('Populating filters…');
    const regions = await getRegions(conn);
    regions.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r; opt.textContent = r;
      regionFilter.appendChild(opt);
    });

    setLoading('Rendering dashboard…');
    await renderAll();

    overlay.classList.add('hidden');
    setStatus('ready', `${regions.length} regions · 2005–2024`);

    // Listen for heatmap metric change
    heatmapMetric.addEventListener('change', renderHeatmap);

  } catch (err) {
    console.error(err);
    overlay.classList.add('hidden');
    setStatus('error', `Error: ${err.message}`);
  }
}

init();
