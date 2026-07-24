"""
═══════════════════════════════════════════════════════════════════
LAYER 2: SEGMENT COMPOSITION — DONUT CHART
═══════════════════════════════════════════════════════════════════

DESIGN TIP:
  • Max 5 slices in a donut. Two slices (ENTERPRISE / SME) is ideal.
  • Place the Grand Total (₱3.41M) as center annotation — gives
    immediate context without legends or tooltips.
  • Use high-contrast fill: #1E3A8A (Enterprise) vs #0F766E (SME).
    Never use gradients or 3D effects.

EXECUTIVE INSIGHT:
  "Enterprise accounts represent 48% of customers but drive 76% of
   revenue (₱2.6M vs ₱805K). Our SME segment is high-volume,
   low-yield — warranting either pricing uplift or upsell programs."

═══════════════════════════════════════════════════════════════════
"""

import plotly.graph_objects as go
import pandas as pd

# ── Load ──────────────────────────────────────────────────────
df = pd.read_parquet('cleaned_dataset.parquet')

# ── Aggregate by segment ──────────────────────────────────────
seg = (
    df.groupby('segment', as_index=False)
      .agg(total_revenue=('revenue', 'sum'), customer_count=('customer_id', 'count'))
)

grand_total = seg['total_revenue'].sum()

# ── Build donut chart ─────────────────────────────────────────
fig = go.Figure(go.Pie(
    labels=seg['segment'],
    values=seg['total_revenue'],
    hole=0.55,
    marker=dict(colors=['#1E3A8A', '#0F766E']),
    textinfo='label+percent',
    textfont_size=13,
    hovertemplate='%{label}<br>₱%{value:,.0f}<br>%{percent}<extra></extra>'
))

# ── Center annotation: Grand Total ───────────────────────────
fig.add_annotation(
    text=f'<b>₱{grand_total/1_000_000:.1f}M</b><br><span style="font-size:11px;color:#64748B">Total Revenue</span>',
    x=0.5, y=0.5,
    font_size=20,
    font_color='#1E293B',
    showarrow=False,
    xref='paper',
    yref='paper'
)

fig.update_layout(
    title='Revenue Composition by Segment',
    title_font=dict(size=16, color='#1E293B', family='Inter, sans-serif'),
    font_family='Inter, system-ui, sans-serif',
    paper_bgcolor='white',
    plot_bgcolor='white',
    showlegend=True,
    legend=dict(orientation='h', y=-0.05, x=0.3),
    height=400,
    margin=dict(t=60, b=40, l=40, r=40)
)

fig.write_json('charts/layer2_segment_donut.json')
fig.show()
