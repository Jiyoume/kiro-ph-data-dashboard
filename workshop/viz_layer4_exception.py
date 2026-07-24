"""
═══════════════════════════════════════════════════════════════════
LAYER 4: EXCEPTION / PRIORITY DRILL-DOWN — FILTERED FOCUS CHART
═══════════════════════════════════════════════════════════════════

DESIGN TIP:
  • Executive exception reporting isolates the signal from the noise.
    Filter to ONE critical segment or threshold and visualise deeply.
  • Use a scatter plot with bubble size = order_count and colour
    encoding segment. This shows revenue concentration AND engagement.
  • Add reference lines (median revenue) to separate outperformers
    from underperformers in a single glance.

EXECUTIVE INSIGHT:
  "Among our Enterprise segment, 4 accounts exceed ₱250K yet only
   2 of them have order counts above 80 — indicating that high-revenue
   does not always mean high-engagement. Accounts C015 and C022 may
   represent one-time large contracts rather than recurring relationships."

═══════════════════════════════════════════════════════════════════
"""

import plotly.express as px
import pandas as pd

# ── Load ──────────────────────────────────────────────────────
df = pd.read_parquet('cleaned_dataset.parquet')

# ── Filter: Enterprise segment only (the high-priority segment) ──
enterprise = df[df['segment'] == 'ENTERPRISE'].copy()

# ── Bubble chart: Revenue vs Order Count, size = order_count ──
fig = px.scatter(
    enterprise,
    x='order_count',
    y='revenue',
    size='order_count',
    color='region',
    hover_name='full_name',
    hover_data={'revenue': ':,.0f', 'order_count': True, 'region': True},
    title='Enterprise Segment: Revenue vs. Engagement',
    labels={
        'revenue': 'Revenue (₱)',
        'order_count': 'Order Count',
        'region': 'Region'
    },
    size_max=40
)

# ── Add median reference line ─────────────────────────────────
median_rev = enterprise['revenue'].median()
fig.add_hline(
    y=median_rev,
    line_dash='dash',
    line_color='#94A3B8',
    annotation_text=f'Median: ₱{median_rev:,.0f}',
    annotation_position='top right',
    annotation_font_color='#64748B'
)

fig.update_layout(
    font_family='Inter, system-ui, sans-serif',
    title_font=dict(size=16, color='#1E293B'),
    plot_bgcolor='#FAFBFC',
    paper_bgcolor='white',
    xaxis=dict(gridcolor='#F1F5F9'),
    yaxis=dict(gridcolor='#F1F5F9', tickformat='₱,.0f'),
    height=450,
    margin=dict(t=60, b=50, l=80, r=40)
)

fig.write_json('charts/layer4_enterprise_exception.json')
fig.show()
