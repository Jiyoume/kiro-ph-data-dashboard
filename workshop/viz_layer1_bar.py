"""
═══════════════════════════════════════════════════════════════════
LAYER 1: TOP REVENUE CONTRIBUTORS — HORIZONTAL BAR CHART
═══════════════════════════════════════════════════════════════════

DESIGN TIP:
  • Always sort bars descending — the viewer's eye starts at the top.
  • Cap at Top 10 max. Beyond that, the bottom bars become noise.
  • Use a single Deep Navy (#1E3A8A) for all bars, highlight Top 1
    in Dark Teal (#0F766E) to draw attention without visual clutter.

EXECUTIVE INSIGHT:
  "Our top 3 customers (Olive Santos, Victor Santos, Eva Lim) generate
   ₱1.1M or 32% of total portfolio revenue — a significant concentration
   risk that warrants diversification in Q4 pipeline planning."

═══════════════════════════════════════════════════════════════════
"""

import plotly.express as px
import pandas as pd

# ── Load from your cleaned Parquet ─────────────────────────────
df = pd.read_parquet('cleaned_dataset.parquet')

# ── Prepare: Top 10 by revenue, sorted descending ─────────────
top10 = (
    df.nlargest(10, 'revenue')
      .sort_values('revenue', ascending=True)  # ascending for horizontal bar layout
)

# ── Corporate colour: highlight #1 in teal, rest in navy ──────
colors = ['#1E3A8A'] * len(top10)
colors[-1] = '#0F766E'  # top performer (last bar when ascending)

# ── Build chart ───────────────────────────────────────────────
fig = px.bar(
    top10,
    x='revenue',
    y='full_name',
    orientation='h',
    text='revenue',
    color_discrete_sequence=['#1E3A8A'],
    labels={'revenue': 'Revenue (₱)', 'full_name': ''},
    title='Top 10 Customers by Revenue'
)

# Override colours per bar
fig.update_traces(
    marker_color=colors,
    texttemplate='₱%{text:,.0f}',
    textposition='outside',
    textfont_size=11
)

# ── Executive styling ─────────────────────────────────────────
fig.update_layout(
    font_family='Inter, system-ui, sans-serif',
    title_font_size=16,
    title_font_color='#1E293B',
    plot_bgcolor='white',
    paper_bgcolor='white',
    xaxis=dict(
        showgrid=True,
        gridcolor='#F1F5F9',
        tickformat='₱,.0f',
        title=None
    ),
    yaxis=dict(
        title=None,
        tickfont_size=12
    ),
    margin=dict(l=150, r=80, t=60, b=40),
    height=450,
    showlegend=False
)

# ── Export to JSON for web integration ────────────────────────
fig.write_json('charts/layer1_top_revenue.json')
fig.show()
