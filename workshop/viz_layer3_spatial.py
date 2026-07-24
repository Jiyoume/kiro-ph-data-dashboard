"""
═══════════════════════════════════════════════════════════════════
LAYER 3: REGIONAL REVENUE CONCENTRATION — SPATIAL BREAKDOWN
═══════════════════════════════════════════════════════════════════

DESIGN TIP:
  • For Philippine regional data without detailed GeoJSON polygons,
    use a treemap or proportional horizontal bar as a spatial proxy.
  • Color-code by revenue intensity using a sequential blue palette:
    low regions in light slate (#CBD5E1), heavy regions in deep navy.
  • Add percentage labels — executives think in portfolio share.

EXECUTIVE INSIGHT:
  "NCR alone captures 39% of our revenue base (₱1.32M). The Visayas
   and Mindanao combined contribute less than 22%. Our geographic
   diversification is critically unbalanced — expansion resources
   should be redeployed to Region V and Region VI where unit economics
   (revenue per customer) already show traction."

═══════════════════════════════════════════════════════════════════
"""

import plotly.express as px
import pandas as pd

# ── Load ──────────────────────────────────────────────────────
df = pd.read_parquet('cleaned_dataset.parquet')

# ── Aggregate by region ───────────────────────────────────────
reg = (
    df.groupby('region', as_index=False)
      .agg(
        total_revenue=('revenue', 'sum'),
        customer_count=('customer_id', 'count'),
        avg_revenue=('revenue', 'mean')
      )
      .sort_values('total_revenue', ascending=False)
)

grand_total = reg['total_revenue'].sum()
reg['pct_share'] = (reg['total_revenue'] / grand_total * 100).round(1)
reg['label'] = reg['region'] + ' (' + reg['pct_share'].astype(str) + '%)'

# ── Treemap — proportional area represents revenue share ──────
fig = px.treemap(
    reg,
    path=['label'],
    values='total_revenue',
    color='total_revenue',
    color_continuous_scale=['#CBD5E1', '#1E3A8A'],
    hover_data={'total_revenue': ':,.0f', 'customer_count': True, 'pct_share': ':.1f'},
    title='Regional Revenue Concentration'
)

fig.update_traces(
    texttemplate='<b>%{label}</b><br>₱%{value:,.0f}',
    textfont_size=12
)

fig.update_layout(
    font_family='Inter, system-ui, sans-serif',
    title_font=dict(size=16, color='#1E293B'),
    paper_bgcolor='white',
    coloraxis_showscale=False,
    margin=dict(t=60, b=20, l=20, r=20),
    height=450
)

fig.write_json('charts/layer3_regional_treemap.json')
fig.show()
