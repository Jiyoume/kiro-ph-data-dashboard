/**
 * scripts/transform.mjs
 *
 * SQL-first transform pipeline on data/pscg.db.
 * Runs in sequence — safe to re-run (all objects use CREATE OR REPLACE).
 *
 * What this does:
 *   1.  Deduplicate — remove exact duplicate (particulars, year) pairs
 *   2.  Cast & normalise — enforce correct types on every column
 *   3.  Repair NULLs — fill is_covid_year / is_ncr from first principles
 *   4.  collections_clean — canonical cleaned table (replaces raw collections)
 *   5.  Derived columns — 3-yr rolling avg, CAGR, decade bucket, LTS flag
 *   6.  Precomputed aggregations — 8 materialised summary tables for the dashboard
 *   7.  Final views — thin query-ready wrappers used by src/loader.js
 *
 * Run:  node scripts/transform.mjs
 */

import duckdb from 'duckdb';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = resolve(__dirname, '..', 'data', 'pscg.db');

if (!existsSync(DB_PATH)) {
  console.error(`\n✗ DB not found: ${DB_PATH}`);
  console.error(`  Run 'npm run ingest:db' first.\n`);
  process.exit(1);
}

// ── DB helpers ────────────────────────────────────────────────
const db   = new duckdb.Database(DB_PATH);
const conn = db.connect();

function run(sql) {
  return new Promise((res, rej) => conn.run(sql, (e) => e ? rej(e) : res()));
}
function query(sql) {
  return new Promise((res, rej) =>
    conn.all(sql, (e, rows) => e ? rej(e) : res(
      rows.map(r => Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
      ))
    ))
  );
}

const step  = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok    = (msg)    => console.log(`    ✓  ${msg}`);
const warn  = (msg)    => console.warn(`    ⚠  ${msg}`);

// ─────────────────────────────────────────────────────────────
// STEP 1 — Deduplicate
// ─────────────────────────────────────────────────────────────
step(1, 'Deduplication');

// Check for duplicate (particulars, year) keys
const dupeCheck = await query(`
  SELECT COUNT(*) AS n FROM (
    SELECT particulars, year
    FROM collections
    GROUP BY particulars, year
    HAVING COUNT(*) > 1
  )
`);
const dupeCount = dupeCheck[0].n;

if (dupeCount > 0) {
  warn(`Found ${dupeCount} duplicate (particulars, year) pair(s) — keeping first occurrence`);
  await run(`
    CREATE OR REPLACE TABLE collections_deduped AS
    SELECT * FROM (
      SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY particulars, year
               ORDER BY amount_millions DESC NULLS LAST
             ) AS _rn
      FROM collections
    )
    WHERE _rn = 1
  `);
  await run(`DROP TABLE IF EXISTS collections`);
  await run(`ALTER TABLE collections_deduped RENAME TO collections`);
  ok(`Deduplication done — removed ${dupeCount} duplicate(s)`);
} else {
  ok('No duplicates found — skipping dedup step');
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — Cast & normalise types → collections_typed
// ─────────────────────────────────────────────────────────────
step(2, 'Type casting and normalisation');

await run(`
  CREATE OR REPLACE TABLE collections_typed AS
  SELECT
    -- Identifiers (VARCHAR, trimmed)
    TRIM(particulars)                          AS particulars,
    TRIM(region)                               AS region,
    TRIM(row_type)                             AS row_type,

    -- Year as SMALLINT (2 bytes, sufficient for 2005–2099)
    CAST(year AS SMALLINT)                     AS year,

    -- Amounts: round to 6 dp, NULL-safe
    ROUND(CAST(amount_millions     AS DOUBLE), 6) AS amount_millions,
    ROUND(CAST(prev_amount         AS DOUBLE), 6) AS prev_amount,
    ROUND(CAST(national_total      AS DOUBLE), 6) AS national_total,

    -- Derived ratios: round to 4 dp
    ROUND(CAST(yoy_pct             AS DOUBLE), 4) AS yoy_pct,
    ROUND(CAST(share_of_national_pct AS DOUBLE), 4) AS share_of_national_pct,

    -- Booleans — cast explicitly to avoid NULLs
    COALESCE(CAST(is_covid_year AS BOOLEAN), FALSE)  AS is_covid_year,
    COALESCE(CAST(is_ncr        AS BOOLEAN), FALSE)  AS is_ncr
  FROM collections
`);

const [{ typed_n }] = await query(`SELECT COUNT(*) AS typed_n FROM collections_typed`);
ok(`collections_typed — ${typed_n.toLocaleString()} rows cast`);

// ─────────────────────────────────────────────────────────────
// STEP 3 — Repair derived booleans from first principles
//           (is_covid_year / is_ncr may be wrong after type coerce)
// ─────────────────────────────────────────────────────────────
step(3, 'Repairing derived boolean columns');

await run(`
  UPDATE collections_typed
  SET
    is_covid_year = (year IN (2020, 2021)),
    is_ncr        = (region = 'National Capital Region (NCR)')
`);
ok('is_covid_year and is_ncr recalculated from source values');

// ─────────────────────────────────────────────────────────────
// STEP 4 — Canonical clean table with added derived columns
// ─────────────────────────────────────────────────────────────
step(4, 'Building collections_clean with derived columns');

await run(`
  CREATE OR REPLACE TABLE collections_clean AS
  WITH base AS (
    SELECT * FROM collections_typed
  ),

  -- 3-year rolling average of amount_millions per entity
  rolling AS (
    SELECT
      particulars,
      year,
      ROUND(
        AVG(amount_millions) OVER (
          PARTITION BY particulars
          ORDER BY year
          ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
        ), 4
      ) AS rolling_3yr_avg
    FROM base
  ),

  -- CAGR from first available non-zero year to current year
  first_nonzero AS (
    SELECT particulars,
           MIN(year) AS base_year,
           MIN(amount_millions) FILTER (WHERE amount_millions > 0) AS base_amount
    FROM base
    GROUP BY particulars
  ),
  cagr_calc AS (
    SELECT
      b.particulars,
      b.year,
      CASE
        WHEN b.year = f.base_year OR f.base_amount IS NULL OR f.base_amount = 0
          THEN NULL
        WHEN b.amount_millions IS NULL OR b.amount_millions <= 0
          THEN NULL
        ELSE ROUND(
          (POWER(b.amount_millions / f.base_amount,
                 1.0 / NULLIF(b.year - f.base_year, 0)) - 1) * 100
        , 4)
      END AS cagr_from_base
    FROM base b
    LEFT JOIN first_nonzero f USING (particulars)
  ),

  -- Decade bucket
  decade AS (
    SELECT particulars, year,
      CASE
        WHEN year BETWEEN 2005 AND 2009 THEN '2005–2009'
        WHEN year BETWEEN 2010 AND 2014 THEN '2010–2014'
        WHEN year BETWEEN 2015 AND 2019 THEN '2015–2019'
        WHEN year BETWEEN 2020 AND 2024 THEN '2020–2024'
      END AS decade_bucket
    FROM base
  )

  SELECT
    b.*,

    -- 3-year rolling average
    r.rolling_3yr_avg,

    -- CAGR from first non-zero year to current year
    c.cagr_from_base,

    -- Decade bucket for period comparisons
    d.decade_bucket,

    -- Large Taxpayers Service flag (NCR-adjacent, non-geographic)
    (b.particulars = 'Large Taxpayers Service') AS is_lts,

    -- Absolute YoY change in million pesos
    ROUND(b.amount_millions - b.prev_amount, 6) AS yoy_change_millions,

    -- Rank within region for same year (province_city rows only)
    CASE WHEN b.row_type = 'province_city'
      THEN RANK() OVER (
        PARTITION BY b.region, b.year
        ORDER BY b.amount_millions DESC NULLS LAST
      )
    END AS regional_rank,

    -- Rank nationally for same year (province_city rows only)
    CASE WHEN b.row_type = 'province_city'
      THEN RANK() OVER (
        PARTITION BY b.year
        ORDER BY b.amount_millions DESC NULLS LAST
      )
    END AS national_rank,

    -- Above/below national average for same year and row_type
    ROUND(
      b.amount_millions - AVG(b.amount_millions) OVER (
        PARTITION BY b.row_type, b.year
      )
    , 4) AS vs_peer_avg

  FROM base b
  LEFT JOIN rolling    r USING (particulars, year)
  LEFT JOIN cagr_calc  c USING (particulars, year)
  LEFT JOIN decade     d USING (particulars, year)
`);

const [{ clean_n }] = await query(`SELECT COUNT(*) AS clean_n FROM collections_clean`);
ok(`collections_clean — ${clean_n.toLocaleString()} rows with derived columns`);

// Verify derived columns are populated
const derivedCheck = await query(`
  SELECT
    COUNT(*) FILTER (WHERE rolling_3yr_avg   IS NOT NULL) AS has_rolling,
    COUNT(*) FILTER (WHERE cagr_from_base    IS NOT NULL) AS has_cagr,
    COUNT(*) FILTER (WHERE yoy_change_millions IS NOT NULL) AS has_yoy_change,
    COUNT(*) FILTER (WHERE regional_rank     IS NOT NULL) AS has_reg_rank,
    COUNT(*) FILTER (WHERE national_rank     IS NOT NULL) AS has_nat_rank,
    COUNT(*) FILTER (WHERE decade_bucket     IS NOT NULL) AS has_decade
  FROM collections_clean
`);
const dc = derivedCheck[0];
ok(`rolling_3yr_avg populated:    ${dc.has_rolling.toLocaleString()}`);
ok(`cagr_from_base populated:     ${dc.has_cagr.toLocaleString()}`);
ok(`yoy_change_millions populated: ${dc.has_yoy_change.toLocaleString()}`);
ok(`regional_rank populated:      ${dc.has_reg_rank.toLocaleString()}`);
ok(`national_rank populated:      ${dc.has_nat_rank.toLocaleString()}`);
ok(`decade_bucket populated:      ${dc.has_decade.toLocaleString()}`);

// ─────────────────────────────────────────────────────────────
// STEP 5 — Precomputed aggregation tables
// ─────────────────────────────────────────────────────────────
step(5, 'Building precomputed aggregation tables');

// 5a. National trend (one row per year) — drives trend chart
await run(`
  CREATE OR REPLACE TABLE agg_national_trend AS
  SELECT
    year,
    ROUND(MAX(amount_millions) FILTER (WHERE particulars = 'Total Collection - Net of Tax Refund'), 4)
                                                        AS net_collection,
    ROUND(MAX(amount_millions) FILTER (WHERE particulars = 'Total Gross Collection'), 4)
                                                        AS gross_collection,
    ROUND(ABS(MAX(amount_millions) FILTER (WHERE particulars = 'Tax Refund')), 4)
                                                        AS tax_refund,
    ROUND(MAX(yoy_pct) FILTER (WHERE particulars = 'Total Collection - Net of Tax Refund'), 4)
                                                        AS net_yoy_pct,
    ROUND(MAX(yoy_change_millions) FILTER (WHERE particulars = 'Total Collection - Net of Tax Refund'), 4)
                                                        AS net_yoy_change,
    ROUND(MAX(rolling_3yr_avg) FILTER (WHERE particulars = 'Total Collection - Net of Tax Refund'), 4)
                                                        AS rolling_3yr_avg,
    MAX(is_covid_year) FILTER (WHERE particulars = 'Total Collection - Net of Tax Refund')
                                                        AS is_covid_year
  FROM collections_clean
  GROUP BY year
  ORDER BY year
`);
const [{ nat_n }] = await query(`SELECT COUNT(*) AS nat_n FROM agg_national_trend`);
ok(`agg_national_trend — ${nat_n} rows (one per year)`);

// 5b. Region × year totals — drives regional bar chart
await run(`
  CREATE OR REPLACE TABLE agg_region_year AS
  SELECT
    region,
    year,
    ROUND(SUM(amount_millions), 4)               AS total_amount,
    COUNT(DISTINCT particulars)                   AS province_count,
    ROUND(AVG(amount_millions), 4)                AS avg_province_amount,
    ROUND(MAX(amount_millions), 4)                AS max_province_amount,
    ROUND(MIN(amount_millions) FILTER (WHERE amount_millions > 0), 4) AS min_province_amount,
    ROUND(AVG(yoy_pct), 4)                        AS avg_yoy_pct,
    ROUND(AVG(share_of_national_pct), 4)          AS avg_share_of_national,
    MAX(is_covid_year)                            AS is_covid_year
  FROM collections_clean
  WHERE row_type = 'province_city'
  GROUP BY region, year
  ORDER BY year, total_amount DESC
`);
const [{ reg_n }] = await query(`SELECT COUNT(*) AS reg_n FROM agg_region_year`);
ok(`agg_region_year — ${reg_n} rows`);

// 5c. Province rankings per year — drives province bar chart
await run(`
  CREATE OR REPLACE TABLE agg_province_rank AS
  SELECT
    particulars,
    region,
    year,
    ROUND(amount_millions, 4)         AS amount_millions,
    ROUND(yoy_pct, 4)                 AS yoy_pct,
    ROUND(yoy_change_millions, 4)     AS yoy_change_millions,
    ROUND(rolling_3yr_avg, 4)         AS rolling_3yr_avg,
    ROUND(share_of_national_pct, 4)   AS share_of_national_pct,
    ROUND(vs_peer_avg, 4)             AS vs_peer_avg,
    national_rank,
    regional_rank,
    is_covid_year,
    is_ncr
  FROM collections_clean
  WHERE row_type = 'province_city'
  ORDER BY year, national_rank
`);
const [{ prov_n }] = await query(`SELECT COUNT(*) AS prov_n FROM agg_province_rank`);
ok(`agg_province_rank — ${prov_n} rows`);

// 5d. Decade summaries — drives period comparison chart
await run(`
  CREATE OR REPLACE TABLE agg_decade AS
  SELECT
    particulars,
    region,
    row_type,
    decade_bucket,
    ROUND(SUM(amount_millions), 4)          AS decade_total,
    ROUND(AVG(amount_millions), 4)          AS decade_avg,
    ROUND(AVG(yoy_pct), 4)                  AS decade_avg_yoy,
    ROUND(MAX(amount_millions), 4)          AS decade_peak,
    ROUND(MIN(amount_millions) FILTER (WHERE amount_millions > 0), 4) AS decade_trough,
    COUNT(*)                                AS year_count
  FROM collections_clean
  WHERE decade_bucket IS NOT NULL
  GROUP BY particulars, region, row_type, decade_bucket
  ORDER BY particulars, decade_bucket
`);
const [{ dec_n }] = await query(`SELECT COUNT(*) AS dec_n FROM agg_decade`);
ok(`agg_decade — ${dec_n} rows`);

// 5e. COVID impact — drives COVID impact chart
await run(`
  CREATE OR REPLACE TABLE agg_covid_impact AS
  SELECT
    particulars,
    region,
    row_type,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2018), 4) AS y2018,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2019), 4) AS y2019,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2020), 4) AS y2020,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2021), 4) AS y2021,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2022), 4) AS y2022,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2023), 4) AS y2023,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2024), 4) AS y2024,
    -- Drop from 2019 → 2020
    ROUND(
      (MAX(amount_millions) FILTER (WHERE year = 2020) -
       MAX(amount_millions) FILTER (WHERE year = 2019)) /
      NULLIF(MAX(amount_millions) FILTER (WHERE year = 2019), 0) * 100
    , 2) AS pct_drop_2020,
    -- Recovery: 2022 vs 2019 baseline
    ROUND(
      (MAX(amount_millions) FILTER (WHERE year = 2022) -
       MAX(amount_millions) FILTER (WHERE year = 2019)) /
      NULLIF(MAX(amount_millions) FILTER (WHERE year = 2019), 0) * 100
    , 2) AS pct_recovery_vs_2019,
    -- Full recovery flag (2022 >= 2019)
    (MAX(amount_millions) FILTER (WHERE year = 2022) >=
     MAX(amount_millions) FILTER (WHERE year = 2019)) AS recovered_by_2022
  FROM collections_clean
  WHERE row_type IN ('region', 'province_city', 'summary')
  GROUP BY particulars, region, row_type
  ORDER BY pct_drop_2020 ASC NULLS LAST
`);
const [{ cov_n }] = await query(`SELECT COUNT(*) AS cov_n FROM agg_covid_impact`);
ok(`agg_covid_impact — ${cov_n} rows`);

// 5f. CAGR summary (2005→2024 growth story per entity)
await run(`
  CREATE OR REPLACE TABLE agg_cagr AS
  SELECT
    particulars,
    region,
    row_type,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2005), 4) AS amt_2005,
    ROUND(MAX(amount_millions) FILTER (WHERE year = 2024), 4) AS amt_2024,
    ROUND(
      (POWER(
        MAX(amount_millions) FILTER (WHERE year = 2024) /
        NULLIF(MAX(amount_millions) FILTER (WHERE year = 2005), 0),
        1.0 / 19          -- 19 periods between 2005 and 2024
      ) - 1) * 100
    , 4) AS cagr_2005_2024_pct,
    ROUND(
      MAX(amount_millions) FILTER (WHERE year = 2024) -
      MAX(amount_millions) FILTER (WHERE year = 2005)
    , 4) AS absolute_growth
  FROM collections_clean
  WHERE row_type IN ('region', 'province_city', 'summary')
  GROUP BY particulars, region, row_type
  ORDER BY cagr_2005_2024_pct DESC NULLS LAST
`);
const [{ cagr_n }] = await query(`SELECT COUNT(*) AS cagr_n FROM agg_cagr`);
ok(`agg_cagr — ${cagr_n} rows`);

// 5g. KPI snapshot per year — all dashboard KPI card values in one table
await run(`
  CREATE OR REPLACE TABLE agg_kpi_by_year AS
  WITH net AS (
    SELECT year, amount_millions AS net_collection, yoy_pct, yoy_change_millions,
           rolling_3yr_avg
    FROM collections_clean
    WHERE particulars = 'Total Collection - Net of Tax Refund'
  ),
  gross AS (
    SELECT year, amount_millions AS gross_collection
    FROM collections_clean
    WHERE particulars = 'Total Gross Collection'
  ),
  refund AS (
    SELECT year, ABS(amount_millions) AS tax_refund
    FROM collections_clean
    WHERE particulars = 'Tax Refund'
  ),
  top_region AS (
    SELECT year, FIRST(region ORDER BY amount_millions DESC) AS top_region,
                 FIRST(amount_millions ORDER BY amount_millions DESC) AS top_region_amount
    FROM collections_clean
    WHERE row_type = 'region'
      AND particulars != 'Large Taxpayers Service'
    GROUP BY year
  ),
  top_province AS (
    SELECT year, FIRST(particulars ORDER BY amount_millions DESC) AS top_province,
                 FIRST(amount_millions ORDER BY amount_millions DESC) AS top_province_amount,
                 FIRST(region ORDER BY amount_millions DESC) AS top_province_region
    FROM collections_clean
    WHERE row_type = 'province_city'
    GROUP BY year
  )
  SELECT
    n.year,
    n.net_collection,
    n.yoy_pct                    AS net_yoy_pct,
    n.yoy_change_millions        AS net_yoy_change,
    n.rolling_3yr_avg            AS net_rolling_3yr,
    g.gross_collection,
    COALESCE(r.tax_refund, 0)    AS tax_refund,
    ROUND(g.gross_collection - COALESCE(r.tax_refund, 0), 4) AS net_check,
    tr.top_region,
    tr.top_region_amount,
    tp.top_province,
    tp.top_province_amount,
    tp.top_province_region,
    (n.year IN (2020, 2021))     AS is_covid_year
  FROM net n
  LEFT JOIN gross     g  USING (year)
  LEFT JOIN refund    r  USING (year)
  LEFT JOIN top_region  tr USING (year)
  LEFT JOIN top_province tp USING (year)
  ORDER BY year
`);
const [{ kpi_n }] = await query(`SELECT COUNT(*) AS kpi_n FROM agg_kpi_by_year`);
ok(`agg_kpi_by_year — ${kpi_n} rows (one per year, all KPI values)`);

// 5h. YoY heatmap data — all regions × all years, for the line chart
await run(`
  CREATE OR REPLACE TABLE agg_yoy_heatmap AS
  SELECT
    particulars   AS region_name,
    region,
    year,
    ROUND(amount_millions, 4)     AS amount_millions,
    ROUND(yoy_pct, 4)             AS yoy_pct,
    ROUND(yoy_change_millions, 4) AS yoy_change_millions,
    is_covid_year
  FROM collections_clean
  WHERE row_type = 'region'
    AND year > 2005            -- first year has no YoY
  ORDER BY particulars, year
`);
const [{ yoy_n }] = await query(`SELECT COUNT(*) AS yoy_n FROM agg_yoy_heatmap`);
ok(`agg_yoy_heatmap — ${yoy_n} rows`);

// ─────────────────────────────────────────────────────────────
// STEP 6 — Final query views (used by src/loader.js)
// ─────────────────────────────────────────────────────────────
step(6, 'Creating final query views');

// Canonical enriched view — replaces the old collections_enriched
await run(`
  CREATE OR REPLACE VIEW collections_enriched AS
  SELECT * FROM collections_clean
`);
ok('View: collections_enriched → collections_clean');

// Convenience: regions only
await run(`
  CREATE OR REPLACE VIEW v_regions AS
  SELECT DISTINCT particulars AS region
  FROM collections_clean
  WHERE row_type = 'region'
  ORDER BY particulars
`);
ok('View: v_regions');

// Convenience: province_city detail for a given region+year
// (parameterised at query time; view just filters row_type)
await run(`
  CREATE OR REPLACE VIEW v_province_detail AS
  SELECT
    particulars, region, year,
    amount_millions, yoy_pct, yoy_change_millions,
    rolling_3yr_avg, share_of_national_pct,
    national_rank, regional_rank, vs_peer_avg,
    cagr_from_base, is_covid_year, is_ncr
  FROM collections_clean
  WHERE row_type = 'province_city'
`);
ok('View: v_province_detail');

// ─────────────────────────────────────────────────────────────
// STEP 7 — Final validation
// ─────────────────────────────────────────────────────────────
step(7, 'Validation');

const tables = await query(`
  SELECT table_name, table_type
  FROM information_schema.tables
  WHERE table_schema = 'main'
  ORDER BY table_type DESC, table_name
`);
const tbls  = tables.filter(t => t.table_type === 'BASE TABLE').map(t => t.table_name);
const views = tables.filter(t => t.table_type === 'VIEW').map(t => t.table_name);
ok(`Tables : ${tbls.join(', ')}`);
ok(`Views  : ${views.join(', ')}`);

// Spot-check collections_clean
const scCheck = await query(`
  SELECT
    COUNT(*)                                               AS total_rows,
    COUNT(*) FILTER (WHERE rolling_3yr_avg   IS NOT NULL) AS has_rolling,
    COUNT(*) FILTER (WHERE national_rank     IS NOT NULL) AS has_nat_rank,
    COUNT(*) FILTER (WHERE decade_bucket     IS NOT NULL) AS has_decade,
    COUNT(*) FILTER (WHERE amount_millions   IS NULL)     AS null_amounts,
    COUNT(*) FILTER (WHERE region            IS NULL)     AS null_region
  FROM collections_clean
`);
const sc = scCheck[0];
ok(`collections_clean rows   : ${sc.total_rows.toLocaleString()}`);
ok(`rolling_3yr_avg present  : ${sc.has_rolling.toLocaleString()}`);
ok(`national_rank present    : ${sc.has_nat_rank.toLocaleString()}`);
ok(`decade_bucket present    : ${sc.has_decade.toLocaleString()}`);
if (sc.null_amounts > 0) warn(`NULL amount_millions: ${sc.null_amounts}`);
if (sc.null_region  > 0) warn(`NULL region: ${sc.null_region}`);

// KPI spot-check for 2024
const kpi2024 = await query(`
  SELECT year, net_collection, net_yoy_pct, top_region, top_province
  FROM agg_kpi_by_year
  WHERE year = 2024
`);
const k = kpi2024[0];
ok(`2024 KPI — Net: ₱${Number(k.net_collection).toLocaleString('en-PH',{maximumFractionDigits:0})}M  YoY: ${k.net_yoy_pct}%  Top region: ${k.top_region}  Top province: ${k.top_province}`);

// COVID impact check — top 3 hardest hit regions
const covidTop = await query(`
  SELECT particulars, pct_drop_2020, recovered_by_2022
  FROM agg_covid_impact
  WHERE row_type = 'region'
  ORDER BY pct_drop_2020 ASC NULLS LAST
  LIMIT 3
`);
ok('Top 3 COVID-hit regions:');
covidTop.forEach(r =>
  console.log(`          ${r.particulars.substring(0,42).padEnd(44)} drop: ${r.pct_drop_2020}%  recovered by 2022: ${r.recovered_by_2022}`)
);

// CAGR top 3 fastest-growing provinces 2005→2024
const cagrTop = await query(`
  SELECT particulars, region, cagr_2005_2024_pct
  FROM agg_cagr
  WHERE row_type = 'province_city'
    AND cagr_2005_2024_pct IS NOT NULL
  ORDER BY cagr_2005_2024_pct DESC
  LIMIT 3
`);
ok('Top 3 fastest-growing provinces (CAGR 2005–2024):');
cagrTop.forEach((r, i) =>
  console.log(`          ${i+1}. ${r.particulars.substring(0,38).padEnd(40)} ${r.cagr_2005_2024_pct}% CAGR`)
);

conn.close();
db.close(() => {
  console.log('\n━━━ Transform complete ━━━\n');
});
