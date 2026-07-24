---
inclusion: manual
---

# PRD — BIR PSCG Revenue Dashboard

## Problem

The BIR Annual Collection dataset (PSCG 2005–2024) is distributed as a wide-format Excel pivot table with embedded headers, blank separator rows, footnote markers, mixed column types, and no row-type classification. It cannot be queried or visualized directly without a cleaning pass.

## Goal

Transform the raw xlsx into a clean, long-format dataset and render it as an interactive in-browser dashboard — no backend, no server-side DB — using DuckDB WASM for query and Chart.js for visualization.

---

## 1. Data Pipeline — Transform Rules

### 1.1 Source

| Property | Value |
|---|---|
| File | `20250331_Auunual_Collection_PSCG_2005_2024 (U).xlsx` |
| Served from | `/public/pscg.xlsx` (Vite static asset) |
| Loaded via | `fetch()` → `db.registerFileBuffer()` → `st_read()` (DuckDB spatial extension) |
| Unit | Million Pesos (PHP) |
| Years covered | CY 2005 – CY 2024 (20 columns) |

### 1.2 Row Filtering

| Rule | Action |
|---|---|
| Rows 1–4 (title, period, unit, blank) | Drop — detect by finding the row where `Field1 = 'PARTICULARS'` and skip everything before it |
| Blank separator rows (`Field1 IS NULL`) | Drop |
| Footnote / source rows (start with `*`, `Source`, `Notes:`, or digit+`/`) | Drop |
| Rows with no numeric values in any year column | Drop |
| Columns `Field22`–`Field36` (100% null) | Drop |

### 1.3 Name Cleaning

| Rule | Detail |
|---|---|
| Strip footnote suffixes | Remove trailing ` 1/` … ` 14/` via regex `\s+\d{1,2}\/\s*$` |
| Trim whitespace | `.trim()` + collapse internal runs to single space |
| Preserve `0` values | Treated as reported zero, not NULL (e.g. Muntinlupa pre-2009) |

### 1.4 Type Normalization

Raw year columns `Field2`–`Field19` are inferred as `VARCHAR` by the xlsx reader; `Field20`–`Field21` (2023–2024) are `DOUBLE`. All 20 year columns are cast to `DOUBLE` via `parseFloat()` during JS-side cleaning.

### 1.5 Row Classification

Each row is tagged with a `row_type` before unpivoting:

| `row_type` | Criteria |
|---|---|
| `region` | Name matches the known 17-region set or matches pattern `^(Region\|Cordillera\|National Capital\|Bangsamoro\|Large Taxpayer)` |
| `summary` | Name is one of: `Total BIR Operations`, `Total Non-BIR Operations`, `Total Gross Collection`, `Tax Refund`, `Total Collection - Net of Tax Refund`, `Others` |
| `province_city` | Everything else with numeric data |
| `blank` | Dropped before insert |

> **Double-counting guard:** Aggregations must filter to a single `row_type`. Summing `province_city` rows within a region equals the `region` row — never mix types in the same SUM.

### 1.6 Region Assignment (Carry-Forward)

The source file has no region foreign key on province/city rows. Region is inferred by carry-forward: each `province_city` row inherits the `region` value from the nearest preceding `region` row encountered during sequential iteration.

- `region` rows → `region = self`
- `summary` rows → `region = 'SUMMARY'`

### 1.7 Unpivot (Wide → Long)

Output schema after unpivoting:

```
collections (
  particulars      VARCHAR,   -- cleaned name
  region           VARCHAR,   -- carry-forward parent region
  row_type         VARCHAR,   -- region | province_city | summary
  year             INTEGER,   -- 2005–2024
  amount_millions  DOUBLE     -- nullable; NULL = not reported
)
```

One row per `(particulars, year)` — 20× expansion of the source row count.

### 1.8 Derived View — `collections_enriched`

Built as a DuckDB view on top of `collections`:

| Column | Formula |
|---|---|
| `yoy_pct` | `(amount - LAG(amount) OVER (PARTITION BY particulars ORDER BY year)) / LAG(...) * 100` |
| `share_of_national_pct` | `amount / national_total * 100` where `national_total` = `Total Collection - Net of Tax Refund` for the same year |
| `is_covid_year` | `year IN (2020, 2021)` |
| `is_ncr` | `region = 'National Capital Region (NCR)'` |

---

## 2. Dashboard — Key Visualizations

### 2.1 Controls

| Control | Behavior |
|---|---|
| Year slider (2005–2024) | Updates all charts and KPI cards for the selected year |
| Region dropdown | Filters the province/city breakdown chart; if blank, defaults to the top revenue region |

### 2.2 KPI Cards

| Card | Source query |
|---|---|
| Net Collection | `Total Collection - Net of Tax Refund` for selected year |
| Gross Collection | `Total Gross Collection` for selected year |
| Tax Refund | `Tax Refund` (absolute value) for selected year |
| YoY badge | Inline % change vs prior year on Net Collection |
| Top Region | `row_type = 'region'` ranked by `amount_millions DESC`, excluding Large Taxpayers Service |
| Top Province/City | `row_type = 'province_city'` ranked by `amount_millions DESC` |

### 2.3 Charts

**National Trend (full-width bar + line combo)**
- X-axis: year (2005–2024)
- Left Y-axis (bar): Net Collection in ₱M
- Right Y-axis (line): YoY growth %
- COVID years (2020–2021) rendered in red

**Revenue by Region (horizontal bar)**
- Filtered to selected year, `row_type = 'region'`
- Excludes Large Taxpayers Service (classified separately, not geographic)
- Sorted descending by collection amount

**Top Provinces / Cities (horizontal bar)**
- Filtered to selected year + selected region (or top region if none selected)
- `row_type = 'province_city'`, top 15 by amount
- Helps identify high-contributing cities within a region

**YoY Growth by Region (multi-line)**
- All regions as separate lines, years 2006–2024 on X-axis
- Highlights asymmetric recovery patterns across regions post-COVID
- `spanGaps: true` to handle missing intermediate values

---

## 3. Known Limitations

| Issue | Status |
|---|---|
| Las Piñas includes Muntinlupa data for 2005–2008 | Reflected in footnote; zero values for Muntinlupa those years are expected |
| Marikina includes portions of Rizal province | Data as published; no disaggregation possible |
| Large Taxpayers Service (LTS) is not a geographic region | Excluded from regional comparisons; included in national totals |
| Tax Refund only appears 2015 onwards | Prior years show zero; not a data error |
| BARMM structure changed via EO 001 s.2020 | Data continuity may be affected pre/post-2020 |

---

## 4. Stack

| Layer | Technology |
|---|---|
| Runtime | Browser (no backend) |
| Query engine | DuckDB WASM (`@duckdb/duckdb-wasm`) |
| File parsing | DuckDB spatial extension (`st_read`) |
| Charts | Chart.js v4 |
| Build tool | Vite 6 (COOP/COEP headers required for SharedArrayBuffer) |
| Language | Vanilla JS (ES Modules) |
