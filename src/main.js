import { Chart, registerables } from 'chart.js';
import {
  initDB, loadAndClean,
  getNationalTrend, getRegionBreakdown, getProvinceDetail,
  getYoyHeatmap, getKpis, getRegions,
} from './loader.js';

Chart.register(...registerables);

// ── Shared chart defaults ─────────────────────────────────────
Chart.defaults.color = '#7d8590';
Chart.defaults.borderColor = '#30363d';
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// ── DOM refs ─────────────────────────────────────────────────
const overlay      = document.getElementById('loading-overlay');
const loadingMsg   = document.getElementById('loading-msg');
const statusEl     = document.getElementById('status');
const statusText   = document.getElementById('status-text');
const yearSlider   = document.getElementById('yearSlider');
const yearDisplay  = document.getElementById('yearDisplay');
const regionSelect = document.getElementById('regionSelect');

function setStatus(state, msg) {
  statusEl.className = state;
  statusText.textContent = msg;
}

function setLoading(msg) {
  loadingMsg.textContent = msg;
}

// ── Formatting helpers ────────────────────────────────────────
function fmt(val, decimals = 1) {
  if (val === null || val === undefined) return '—';
  const n = Number(val);
  if (Math.abs(n) >= 1_000_000) return `₱${(n / 1_000_000).toFixed(decimals)}T`;
  if (Math.abs(n) >= 1_000)     return `₱${(n / 1_000).toFixed(decimals)}B`;
  return `₱${n.toFixed(decimals)}M`;
}

function fmtPct(val) {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

// ── Chart instances (kept for destroy-on-update) ──────────────
const charts = {};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

// ── Colour palettes ───────────────────────────────────────────
const PALETTE = [
  '#388bfd','#3fb950','#d29922','#bc8cff',
  '#f85149','#39c5cf','#ff9a00','#79c0ff',
  '#56d364','#ff7b72','#d2a8ff','#ffa657',
  '#7ee787','#ffa198','#cae8ff','#e3b341',
];

function palette(n) {
  return Array.from({ length: n }, (_, i) => PALETTE[i % PALETTE.length]);
}

// ─────────────────────────────────────────────────────────────
// Chart builders
// ─────────────────────────────────────────────────────────────

function buildTrendChart(data) {
  destroyChart('trend');
  const labels = data.map(d => d.year);
  const amounts = data.map(d => Number(d.amount_millions));
  const yoys = data.map(d => d.yoy_pct !== null ? Number(d.yoy_pct) : null);

  charts.trend = new Chart(document.getElementById('trendChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          type: 'bar',
          label: 'Net Collection (₱M)',
          data: amounts,
          backgroundColor: labels.map(y =>
            (y === 2020 || y === 2021)
              ? 'rgba(248,81,73,0.55)'
              : 'rgba(56,139,253,0.65)'
          ),
          borderColor: labels.map(y =>
            (y === 2020 || y === 2021) ? '#f85149' : '#388bfd'
          ),
          borderWidth: 1,
          yAxisID: 'yLeft',
        },
        {
          type: 'line',
          label: 'YoY Growth %',
          data: yoys,
          borderColor: '#3fb950',
          backgroundColor: 'transparent',
          pointBackgroundColor: yoys.map(v => v !== null && v < 0 ? '#f85149' : '#3fb950'),
          pointRadius: 4,
          tension: 0.3,
          yAxisID: 'yRight',
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index' },
      plugins: {
        legend: { labels: { color: '#7d8590', boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.datasetIndex === 0) return ` ${fmt(ctx.parsed.y)}`;
              return ctx.parsed.y !== null ? ` YoY: ${fmtPct(ctx.parsed.y)}` : '';
            },
          },
        },
      },
      scales: {
        yLeft: {
          type: 'linear', position: 'left',
          ticks: { callback: v => fmt(v, 0) },
          grid: { color: '#21262d' },
        },
        yRight: {
          type: 'linear', position: 'right',
          ticks: { callback: v => v !== null ? `${v}%` : '' },
          grid: { drawOnChartArea: false },
        },
        x: { ticks: { color: '#7d8590' }, grid: { color: '#21262d' } },
      },
    },
  });
}

function buildRegionBar(data, year) {
  destroyChart('regionBar');
  document.getElementById('regionBarTitle').textContent =
    `Revenue by Region — ${year}`;

  const labels = data.map(d => d.region);
  const amounts = data.map(d => Number(d.amount_millions));

  charts.regionBar = new Chart(document.getElementById('regionBarChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Net Collection (₱M)',
        data: amounts,
        backgroundColor: palette(labels.length).map(c => c + 'bb'),
        borderColor: palette(labels.length),
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${fmt(ctx.parsed.x)}` } },
      },
      scales: {
        x: {
          ticks: { callback: v => fmt(v, 0) },
          grid: { color: '#21262d' },
        },
        y: { ticks: { color: '#e6edf3', font: { size: 11 } }, grid: { color: '#21262d' } },
      },
    },
  });
}

function buildProvinceChart(data, region, year) {
  destroyChart('province');
  const title = region
    ? `Top Cities / Provinces — ${region.replace(/Region .+ \((.+)\)/, '$1')} · ${year}`
    : `Top Cities / Provinces — ${year}`;
  document.getElementById('provinceTitle').textContent = title;

  const labels = data.map(d => d.particulars);
  const amounts = data.map(d => Number(d.amount_millions));

  charts.province = new Chart(document.getElementById('provinceChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Collection (₱M)',
        data: amounts,
        backgroundColor: 'rgba(188,140,255,0.65)',
        borderColor: '#bc8cff',
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${fmt(ctx.parsed.x)}` } },
      },
      scales: {
        x: {
          ticks: { callback: v => fmt(v, 0) },
          grid: { color: '#21262d' },
        },
        y: { ticks: { color: '#e6edf3', font: { size: 11 } }, grid: { color: '#21262d' } },
      },
    },
  });
}

function buildYoyChart(data) {
  destroyChart('yoy');

  // Pivot: regions as datasets, years as x-axis
  const regionMap = {};
  const yearSet = new Set();

  for (const row of data) {
    yearSet.add(row.year);
    if (!regionMap[row.region]) regionMap[row.region] = {};
    regionMap[row.region][row.year] = row.yoy_pct !== null ? Number(row.yoy_pct) : null;
  }

  const years = [...yearSet].sort();
  const regions = Object.keys(regionMap).sort();

  const datasets = regions.map((region, i) => ({
    label: region.replace(/^Region\s+\S+\s+\((.+)\)$/, '$1').replace('National Capital Region (NCR)', 'NCR'),
    data: years.map(y => regionMap[region][y] ?? null),
    borderColor: PALETTE[i % PALETTE.length],
    backgroundColor: 'transparent',
    pointRadius: 3,
    tension: 0.25,
    spanGaps: true,
  }));

  charts.yoy = new Chart(document.getElementById('yoyChart'), {
    type: 'line',
    data: { labels: years, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index' },
      plugins: {
        legend: {
          labels: { color: '#7d8590', boxWidth: 10, font: { size: 10 } },
        },
        tooltip: {
          callbacks: {
            label: ctx =>
              ctx.parsed.y !== null
                ? ` ${ctx.dataset.label}: ${fmtPct(ctx.parsed.y)}`
                : '',
          },
        },
      },
      scales: {
        y: {
          ticks: { callback: v => `${v}%` },
          grid: { color: '#21262d' },
        },
        x: { ticks: { color: '#7d8590' }, grid: { color: '#21262d' } },
      },
    },
  });
}

// ── KPI updater ───────────────────────────────────────────────
function updateKpis(kpi) {
  document.getElementById('kpi-net').textContent = fmt(kpi.total_net);
  document.getElementById('kpi-gross').textContent = fmt(kpi.gross_total);
  document.getElementById('kpi-refund').textContent =
    kpi.tax_refund ? fmt(Math.abs(kpi.tax_refund)) : '—';

  const yoyBadge = document.getElementById('kpi-yoy');
  if (kpi.total_net && kpi.prev_total) {
    const pct = ((kpi.total_net - kpi.prev_total) / kpi.prev_total) * 100;
    yoyBadge.textContent = fmtPct(pct) + ' vs prior year';
    yoyBadge.className = 'kpi-badge ' + (pct >= 0 ? 'badge-up' : 'badge-down');
  } else {
    yoyBadge.textContent = '—';
    yoyBadge.className = 'kpi-badge';
  }

  document.getElementById('kpi-top-region').textContent =
    kpi.top_region
      ? kpi.top_region.replace(/^Region\s+\S+\s+\((.+)\)$/, '$1')
      : '—';
  document.getElementById('kpi-top-province').textContent = kpi.top_province || '—';
}

// ── Main init ─────────────────────────────────────────────────
async function init() {
  try {
    setLoading('Initializing DuckDB WASM…');
    const db = await initDB();

    setLoading('Fetching & cleaning PSCG data…');
    const conn = await loadAndClean(db, (msg) => setLoading(msg));

    setLoading('Building charts…');

    // Populate region dropdown
    const regions = await getRegions(conn);
    regions.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      regionSelect.appendChild(opt);
    });

    // Initial render
    let currentYear = 2024;
    let currentRegion = '';

    async function render(year, region) {
      const [trend, regionData, kpi, yoy] = await Promise.all([
        getNationalTrend(conn),
        getRegionBreakdown(conn, year),
        getKpis(conn, year),
        getYoyHeatmap(conn),
      ]);

      // Province detail: use selected region or top region
      const detailRegion = region ||
        (regionData[0] ? regionData[0].region : null);
      const provinceData = detailRegion
        ? await getProvinceDetail(conn, detailRegion, year)
        : [];

      updateKpis(kpi);
      buildTrendChart(trend);
      buildRegionBar(regionData, year);
      buildProvinceChart(provinceData, detailRegion, year);
      buildYoyChart(yoy);
    }

    await render(currentYear, currentRegion);

    // Hide loading overlay
    overlay.classList.add('hidden');
    setStatus('ready', `Data loaded — ${regions.length} regions · CY 2005–2024`);

    // ── Interactive controls ──────────────────────────────────
    yearSlider.addEventListener('input', async () => {
      currentYear = parseInt(yearSlider.value);
      yearDisplay.textContent = currentYear;
      setStatus('loading', 'Updating…');
      await render(currentYear, currentRegion);
      setStatus('ready', `CY ${currentYear}`);
    });

    regionSelect.addEventListener('change', async () => {
      currentRegion = regionSelect.value;
      setStatus('loading', 'Updating…');
      await render(currentYear, currentRegion);
      setStatus('ready', `CY ${currentYear}`);
    });

  } catch (err) {
    console.error(err);
    overlay.classList.add('hidden');
    setStatus('error', `Error: ${err.message}`);
  }
}

init();
