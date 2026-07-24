/**
 * generate_charts.mjs
 *
 * Generates all 5 Plotly chart JSON files from cleaned_dataset.parquet
 * using Node.js + DuckDB. No Python required.
 *
 * Output: workshop/charts/*.json (consumed by the Next.js dashboard)
 */

import duckdb from 'duckdb';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PARQUET    = resolve(__dirname, 'cleaned_dataset.parquet').replace(/\\/g, '/');
const CHARTS_DIR = resolve(__dirname, 'charts');

if (!existsSync(CHARTS_DIR)) mkdirSync(CHARTS_DIR, { recursive: true });

const db   = new duckdb.Database(':memory:');
const conn = db.connect();
const q    = (sql) => new Promise((res, rej) =>
  conn.all(sql, (e, rows) => e ? rej(e) :
    res(rows.map(r => Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
    )))
  )
);

function save(name, fig) {
  const path = resolve(CHARTS_DIR, name);
  writeFileSync(path, JSON.stringify(fig, null, 2));
  console.log(`  ✓  ${name}`);
}

// ─────────────────────────────────────────────────────────────
async function generate() {
  console.log('\n━━━ Generating Chart JSONs ━━━\n');

  // ══════════════════════════════════════════════════════════
  // LAYER 1: Top 10 Customers — Horizontal Bar
  // ══════════════════════════════════════════════════════════
  const top10 = await q(`
    SELECT full_name, revenue::DOUBLE AS revenue
    FROM read_parquet('${PARQUET}')
    ORDER BY revenue DESC LIMIT 10
  `);

  const top10Sorted = [...top10].reverse(); // ascending for horizontal bar
  const colors = top10Sorted.map((_, i) =>
    i === top10Sorted.length - 1 ? '#0F766E' : '#1E3A8A'
  );

  save('layer1_top_revenue.json', {
    data: [{
      type: 'bar',
      orientation: 'h',
      x: top10Sorted.map(r => r.revenue),
      y: top10Sorted.map(r => r.full_name),
      text: top10Sorted.map(r => `₱${Number(r.revenue).toLocaleString('en-PH', { maximumFractionDigits: 0 })}`),
      textposition: 'outside',
      textfont: { size: 11 },
      marker: { color: colors },
      hovertemplate: '%{y}<br>₱%{x:,.0f}<extra></extra>'
    }],
    layout: {
      title: { text: 'Top 10 Customers by Revenue', font: { size: 16, color: '#1E293B' } },
      font: { family: 'Inter, system-ui, sans-serif' },
      paper_bgcolor: 'white',
      plot_bgcolor: 'white',
      xaxis: { showgrid: true, gridcolor: '#F1F5F9', tickformat: '₱,.0f', title: null },
      yaxis: { title: null, tickfont: { size: 12 } },
      margin: { l: 150, r: 80, t: 60, b: 40 },
      height: 450,
      showlegend: false
    }
  });

  // ══════════════════════════════════════════════════════════
  // LAYER 2: Segment Composition — Donut
  // ══════════════════════════════════════════════════════════
  const segments = await q(`
    SELECT segment, SUM(revenue::DOUBLE) AS total_revenue, COUNT(*) AS n
    FROM read_parquet('${PARQUET}')
    GROUP BY segment ORDER BY total_revenue DESC
  `);

  const grandTotal = segments.reduce((s, r) => s + r.total_revenue, 0);

  save('layer2_segment_donut.json', {
    data: [{
      type: 'pie',
      labels: segments.map(r => r.segment),
      values: segments.map(r => r.total_revenue),
      hole: 0.55,
      marker: { colors: ['#1E3A8A', '#0F766E'] },
      textinfo: 'label+percent',
      textfont: { size: 13 },
      hovertemplate: '%{label}<br>₱%{value:,.0f}<br>%{percent}<extra></extra>'
    }],
    layout: {
      title: { text: 'Revenue Composition by Segment', font: { size: 16, color: '#1E293B' } },
      font: { family: 'Inter, system-ui, sans-serif' },
      paper_bgcolor: 'white',
      annotations: [{
        text: `<b>₱${(grandTotal / 1_000_000).toFixed(1)}M</b><br><span style="font-size:11px;color:#64748B">Total Revenue</span>`,
        x: 0.5, y: 0.5,
        font: { size: 20, color: '#1E293B' },
        showarrow: false,
        xref: 'paper', yref: 'paper'
      }],
      showlegend: true,
      legend: { orientation: 'h', y: -0.05, x: 0.3 },
      height: 400,
      margin: { t: 60, b: 40, l: 40, r: 40 }
    }
  });

  // ══════════════════════════════════════════════════════════
  // LAYER 3: Regional Concentration — Treemap
  // ══════════════════════════════════════════════════════════
  const regions = await q(`
    SELECT region, SUM(revenue::DOUBLE) AS total_revenue, COUNT(*) AS n
    FROM read_parquet('${PARQUET}')
    GROUP BY region ORDER BY total_revenue DESC
  `);

  const regTotal = regions.reduce((s, r) => s + r.total_revenue, 0);
  const regLabels = regions.map(r => {
    const pct = ((r.total_revenue / regTotal) * 100).toFixed(1);
    return `${r.region} (${pct}%)`;
  });

  save('layer3_regional_treemap.json', {
    data: [{
      type: 'treemap',
      labels: regLabels,
      parents: regLabels.map(() => ''),
      values: regions.map(r => r.total_revenue),
      texttemplate: '<b>%{label}</b><br>₱%{value:,.0f}',
      textfont: { size: 12 },
      marker: {
        colors: regions.map(r => r.total_revenue),
        colorscale: [[0, '#CBD5E1'], [1, '#1E3A8A']],
        showscale: false
      },
      hovertemplate: '%{label}<br>₱%{value:,.0f}<br>Customers: ' +
        regions.map(r => r.n).join(',') + '<extra></extra>'
    }],
    layout: {
      title: { text: 'Regional Revenue Concentration', font: { size: 16, color: '#1E293B' } },
      font: { family: 'Inter, system-ui, sans-serif' },
      paper_bgcolor: 'white',
      margin: { t: 60, b: 20, l: 20, r: 20 },
      height: 450
    }
  });

  // ══════════════════════════════════════════════════════════
  // LAYER 4: Enterprise Exception — Bubble Scatter
  // ══════════════════════════════════════════════════════════
  const enterprise = await q(`
    SELECT full_name, region, revenue::DOUBLE AS revenue, order_count
    FROM read_parquet('${PARQUET}')
    WHERE segment = 'ENTERPRISE'
    ORDER BY revenue DESC
  `);

  const medianRev = enterprise.map(r => r.revenue).sort((a, b) => a - b);
  const median = medianRev[Math.floor(medianRev.length / 2)];

  // Assign colours per region
  const regionColors = ['#1E3A8A', '#0F766E', '#D97706', '#DC2626', '#7C3AED', '#0891B2', '#059669'];
  const uniqueRegions = [...new Set(enterprise.map(r => r.region))];
  const colorMap = Object.fromEntries(uniqueRegions.map((r, i) => [r, regionColors[i % regionColors.length]]));

  save('layer4_enterprise_exception.json', {
    data: [{
      type: 'scatter',
      mode: 'markers',
      x: enterprise.map(r => r.order_count),
      y: enterprise.map(r => r.revenue),
      text: enterprise.map(r => r.full_name),
      marker: {
        size: enterprise.map(r => Math.max(10, r.order_count / 2)),
        color: enterprise.map(r => colorMap[r.region]),
        opacity: 0.8
      },
      hovertemplate: '<b>%{text}</b><br>Revenue: ₱%{y:,.0f}<br>Orders: %{x}<extra></extra>'
    }],
    layout: {
      title: { text: 'Enterprise: Revenue vs. Engagement', font: { size: 16, color: '#1E293B' } },
      font: { family: 'Inter, system-ui, sans-serif' },
      paper_bgcolor: 'white',
      plot_bgcolor: '#FAFBFC',
      xaxis: { title: 'Order Count', gridcolor: '#F1F5F9' },
      yaxis: { title: 'Revenue (₱)', gridcolor: '#F1F5F9', tickformat: '₱,.0f' },
      shapes: [{
        type: 'line', x0: 0, x1: 1, xref: 'paper',
        y0: median, y1: median,
        line: { color: '#94A3B8', dash: 'dash', width: 1.5 }
      }],
      annotations: [{
        x: 1, xref: 'paper', y: median,
        text: `Median: ₱${median.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`,
        showarrow: false, font: { size: 11, color: '#64748B' },
        xanchor: 'right'
      }],
      height: 450,
      margin: { t: 60, b: 50, l: 80, r: 40 },
      showlegend: false
    }
  });

  // ══════════════════════════════════════════════════════════
  // LAYER 5: Executive Narrative — JSON payload
  // ══════════════════════════════════════════════════════════
  const allData = await q(`
    SELECT revenue::DOUBLE AS revenue, segment, region, order_count, full_name
    FROM read_parquet('${PARQUET}')
    ORDER BY revenue DESC
  `);

  const totalRev = allData.reduce((s, r) => s + r.revenue, 0);
  const top3Rev  = allData.slice(0, 3).reduce((s, r) => s + r.revenue, 0);
  const top3Pct  = ((top3Rev / totalRev) * 100).toFixed(0);
  const ncrRev   = allData.filter(r => r.region === 'NCR').reduce((s, r) => s + r.revenue, 0);
  const ncrPct   = ((ncrRev / totalRev) * 100).toFixed(0);
  const entRev   = allData.filter(r => r.segment === 'ENTERPRISE').reduce((s, r) => s + r.revenue, 0);
  const smeRev   = allData.filter(r => r.segment === 'SME').reduce((s, r) => s + r.revenue, 0);
  const entRatio = (entRev / smeRev).toFixed(1);
  const bot5Rev  = allData.slice(-5).reduce((s, r) => s + r.revenue, 0);
  const disparity = Math.round(top3Rev / bot5Rev);

  save('layer5_executive_narrative.json', {
    headline: `₱${(totalRev / 1_000_000).toFixed(1)}M Total Portfolio Revenue`,
    concentration: `Top 3 accounts drive ${top3Pct}% of revenue (₱${(top3Rev / 1_000_000).toFixed(1)}M), while NCR alone contributes ${ncrPct}% — a dual concentration risk across both customer and geography dimensions.`,
    disparity: `Enterprise segment out-earns SME by ${entRatio}x (₱${(entRev / 1_000_000).toFixed(1)}M vs ₱${(smeRev / 1_000_000).toFixed(1)}M). The top 3 accounts collectively earn ${disparity}x more than the bottom 5 — indicating extreme revenue stratification.`,
    action: `RECOMMENDATION: De-risk through (1) regional expansion into Visayas/Mindanao, (2) SME upsell programs targeting accounts with >30 orders but <₱100K revenue, and (3) enterprise retention investment in the top 5 accounts that represent >40% of the book.`,
    kpis: {
      total_revenue: `₱${totalRev.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`,
      top3_concentration: `${top3Pct}%`,
      ncr_share: `${ncrPct}%`,
      enterprise_sme_ratio: `${entRatio}x`,
      customer_count: allData.length,
      region_count: new Set(allData.map(r => r.region)).size
    }
  });

  conn.close();
  db.close(() => {
    console.log(`\n━━━ All 5 chart JSONs generated → workshop/charts/ ━━━\n`);
  });
}

generate().catch(e => { console.error('✗', e.message); process.exit(1); });
