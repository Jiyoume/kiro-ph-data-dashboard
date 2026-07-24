"""
═══════════════════════════════════════════════════════════════════
LAYER 5: EXECUTIVE MACRO INSIGHT — NARRATIVE SYNTHESIS
═══════════════════════════════════════════════════════════════════

DESIGN TIP:
  • After 4 charts, close with a SINGLE summary card — not another graph.
  • Structure: Concentration → Disparity → Action.
  • Display as a styled KPI card on the dashboard (no chart.js needed).
  • Use large bold type for the headline stat, muted body for context.

This script generates the narrative and formats it as a dashboard-ready
JSON payload for the Next.js frontend.

═══════════════════════════════════════════════════════════════════
"""

import pandas as pd
import json

# ── Load ──────────────────────────────────────────────────────
df = pd.read_parquet('cleaned_dataset.parquet')

# ── Compute narrative metrics ─────────────────────────────────
total_rev = df['revenue'].sum()
top3_rev = df.nlargest(3, 'revenue')['revenue'].sum()
top3_pct = (top3_rev / total_rev * 100)

ncr_rev = df[df['region'] == 'NCR']['revenue'].sum()
ncr_pct = (ncr_rev / total_rev * 100)

enterprise_rev = df[df['segment'] == 'ENTERPRISE']['revenue'].sum()
sme_rev = df[df['segment'] == 'SME']['revenue'].sum()
enterprise_ratio = enterprise_rev / sme_rev

bottom5_rev = df.nsmallest(5, 'revenue')['revenue'].sum()
disparity_ratio = top3_rev / bottom5_rev

# ── Executive 3-sentence narrative ────────────────────────────
narrative = {
    "headline": f"₱{total_rev / 1_000_000:.1f}M Total Portfolio Revenue",
    "concentration": (
        f"Top 3 accounts drive {top3_pct:.0f}% of revenue (₱{top3_rev / 1_000_000:.1f}M), "
        f"while NCR alone contributes {ncr_pct:.0f}% — a dual concentration risk "
        f"across both customer and geography dimensions."
    ),
    "disparity": (
        f"Enterprise segment out-earns SME by {enterprise_ratio:.1f}x "
        f"(₱{enterprise_rev / 1_000_000:.1f}M vs ₱{sme_rev / 1_000_000:.1f}M). "
        f"The top 3 accounts collectively earn {disparity_ratio:.0f}x more than "
        f"the bottom 5 — indicating extreme revenue stratification."
    ),
    "action": (
        f"RECOMMENDATION: De-risk through (1) regional expansion into Visayas/Mindanao "
        f"where avg. revenue/customer already shows viability, (2) SME upsell programs "
        f"targeting accounts with >30 orders but <₱100K revenue, and (3) enterprise "
        f"retention investment in the top 5 accounts that represent >40% of the book."
    ),
    "kpis": {
        "total_revenue": f"₱{total_rev:,.0f}",
        "top3_concentration": f"{top3_pct:.0f}%",
        "ncr_share": f"{ncr_pct:.0f}%",
        "enterprise_sme_ratio": f"{enterprise_ratio:.1f}x",
        "customer_count": len(df),
        "region_count": df['region'].nunique()
    }
}

# ── Print for workshop participants ───────────────────────────
print("\n" + "═" * 60)
print("  EXECUTIVE MACRO INSIGHT — NARRATIVE SYNTHESIS")
print("═" * 60)
print(f"\n  📊 {narrative['headline']}\n")
print(f"  1. CONCENTRATION: {narrative['concentration']}\n")
print(f"  2. DISPARITY: {narrative['disparity']}\n")
print(f"  3. ACTION: {narrative['action']}\n")
print("═" * 60)

# ── Export as JSON for web dashboard ──────────────────────────
with open('charts/layer5_executive_narrative.json', 'w') as f:
    json.dump(narrative, f, indent=2)

print("\n  ✓ Narrative JSON exported → charts/layer5_executive_narrative.json\n")
