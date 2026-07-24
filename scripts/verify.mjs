/**
 * scripts/verify.mjs
 *
 * Quick DuckDB verification suite for all exported Parquet files.
 * Runs against data/exports/*.parquet — no DB connection needed.
 *
 * Checks:
 *   1.  File presence & size
 *   2.  Row counts per file
 *   3.  Schema / column completeness
 *   4.  NULL audit on critical columns
 *   5.  Referential integrity (province rows → valid regions)
 *   6.  Business logic spot-checks
 *       a. 2024 national net collection
 *       b. YoY math: computed vs stored
 *       c. COVID year flags
 *       d. Rank uniqueness per year
 *       e. CAGR reasonableness
 *       f. Rolling average monotonicity guard
 *       g. Decade bucket coverage
 *       h. KPI table cross-check vs collections_clean
 */

import duckdb from 'duckdb';
import { existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, '..');
const EXPORT_DIR = resolve(ROOT, 'data', 'exports');

// ── DuckDB in-memory instance (reads Parquet directly) ────────
const db   = new duckdb.Database(':memory:');
const conn = db.connect();

function q(sql) {
  return new Promise((res, rej) =>
    conn.all(sql, (e, rows) => e ? rej(e) :
      res(rows.map(r => Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
      )))
    )
  );
}

function p(file) {
  return `'${resolve(EXPORT_DIR, file).replace(/\\/g, '/')}'`;
}

// ── Result tracker ────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;

function pass(label, detail = '') {
  console.log(`  ✓  ${label}${detail ? '  →  ' + detail : ''}`);
  passed++;
}
function fail(label, detail = '') {
  console.error(`  ✗  ${label}${detail ? '  →  ' + detail : ''}`);
  failed++;
}
function warn(label, detail = '') {
  console.warn(`  ⚠  ${label}${detail ? '  →  ' + detail : ''}`);
  warned++;
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}`);
}

// ─────────────────────────────────────────────────────────────
// 1. File presence & size
// ─────────────────────────────────────────────────────────────
section('1. File presence & size');

const EXPECTED_FILES = {
  'collections_clean.parquet':   { minRows: 2400, minBytes: 50_000  },
  'agg_national_trend.parquet':  { minRows: 20,   minBytes: 1_000   },
  'agg_region_year.parquet':     { minRows: 300,  minBytes: 5_000   },
  'agg_province_rank.parquet':   { minRows: 2000, minBytes: 30_000  },
  'agg_decade.parquet':          { minRows: 400,  minBytes: 5_000   },
  'agg_covid_impact.parquet':    { minRows: 100,  minBytes: 3_000   },
  'agg_cagr.parquet':            { minRows: 100,  minBytes: 2_000   },
  'agg_kpi_by_year.parquet':     { minRows: 20,   minBytes: 1_000   },
  'agg_yoy_heatmap.parquet':     { minRows: 300,  minBytes: 2_000   },
};

for (const [file, { minBytes }] of Object.entries(EXPECTED_FILES)) {
  const path = resolve(EXPORT_DIR, file);
  if (!existsSync(path)) {
    fail(`Missing: ${file}`);
  } else {
    const size = statSync(path).size;
    if (size < minBytes) {
      warn(`${file}`, `size ${size}B < expected min ${minBytes}B`);
    } else {
      pass(`${file}`, `${(size/1024).toFixed(1)} KB`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 2. Row counts
// ─────────────────────────────────────────────────────────────
section('2. Row counts');

for (const [file, { minRows }] of Object.entries(EXPECTED_FILES)) {
  if (!existsSync(resolve(EXPORT_DIR, file))) continue;
  const [{ n }] = await q(`SELECT COUNT(*) AS n FROM read_parquet(${p(file)})`);
  if (n < minRows) {
    fail(`${file} row count`, `${n} < expected min ${minRows}`);
  } else {
    pass(`${file}`, `${n.toLocaleString()} rows`);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. Schema completeness — collections_clean
// ─────────────────────────────────────────────────────────────
section('3. Schema — collections_clean.parquet');

const REQUIRED_COLS = [
  ['particulars',           'VARCHAR'],
  ['region',                'VARCHAR'],
  ['row_type',              'VARCHAR'],
  ['year',                  'SMALLINT'],
  ['amount_millions',       'DOUBLE'],
  ['yoy_pct',               'DOUBLE'],
  ['yoy_change_millions',   'DOUBLE'],
  ['national_total',        'DOUBLE'],
  ['share_of_national_pct', 'DOUBLE'],
  ['rolling_3yr_avg',       'DOUBLE'],
  ['cagr_from_base',        'DOUBLE'],
  ['national_rank',         'BIGINT'],
  ['regional_rank',         'BIGINT'],
  ['vs_peer_avg',           'DOUBLE'],
  ['decade_bucket',         'VARCHAR'],
  ['is_covid_year',         'BOOLEAN'],
  ['is_ncr',                'BOOLEAN'],
  ['is_lts',                'BOOLEAN'],
];

const schemaRows = await q(`DESCRIBE SELECT * FROM read_parquet(${p('collections_clean.parquet')})`);
const schemaMap  = Object.fromEntries(schemaRows.map(r => [r.column_name, r.column_type]));

for (const [col, expectedType] of REQUIRED_COLS) {
  if (!(col in schemaMap)) {
    fail(`Missing column: ${col}`);
  } else if (schemaMap[col] !== expectedType) {
    warn(`${col} type`, `expected ${expectedType}, got ${schemaMap[col]}`);
  } else {
    pass(`${col}`, schemaMap[col]);
  }
}

// ─────────────────────────────────────────────────────────────
// 4. NULL audit — critical columns
// ─────────────────────────────────────────────────────────────
section('4. NULL audit');

const nullAudit = await q(`
  SELECT
    COUNT(*) FILTER (WHERE particulars      IS NULL) AS particulars_null,
    COUNT(*) FILTER (WHERE row_type         IS NULL) AS row_type_null,
    COUNT(*) FILTER (WHERE year             IS NULL) AS year_null,
    COUNT(*) FILTER (WHERE amount_millions  IS NULL) AS amount_null,
    COUNT(*) FILTER (WHERE decade_bucket    IS NULL) AS decade_null,
    COUNT(*) FILTER (WHERE is_covid_year    IS NULL) AS covid_null,
    COUNT(*) FILTER (WHERE is_ncr           IS NULL) AS ncr_null,
    COUNT(*) FILTER (WHERE region IS NULL AND row_type = 'province_city') AS orphan_provinces
  FROM read_parquet(${p('collections_clean.parquet')})
`);
const na = nullAudit[0];

na.particulars_null === 0  ? pass('particulars: no NULLs')       : fail('particulars NULLs', na.particulars_null);
na.row_type_null   === 0   ? pass('row_type: no NULLs')           : fail('row_type NULLs', na.row_type_null);
na.year_null       === 0   ? pass('year: no NULLs')               : fail('year NULLs', na.year_null);
na.decade_null     === 0   ? pass('decade_bucket: no NULLs')      : fail('decade_bucket NULLs', na.decade_null);
na.covid_null      === 0   ? pass('is_covid_year: no NULLs')      : fail('is_covid_year NULLs', na.covid_null);
na.ncr_null        === 0   ? pass('is_ncr: no NULLs')             : fail('is_ncr NULLs', na.ncr_null);
na.orphan_provinces === 0  ? pass('province rows: all have region'): fail('orphan province rows', na.orphan_provinces);

// amount_millions NULLs are expected (pre-2009 Muntinlupa)
if (na.amount_null > 0 && na.amount_null <= 20) {
  warn(`amount_millions: ${na.amount_null} NULLs (expected — pre-2009 Muntinlupa zeros)`);
} else if (na.amount_null > 20) {
  fail(`amount_millions: ${na.amount_null} NULLs — more than expected`);
} else {
  pass('amount_millions: no NULLs');
}

// ─────────────────────────────────────────────────────────────
// 5. Referential integrity
// ─────────────────────────────────────────────────────────────
section('5. Referential integrity');

// Every province row's region must appear as a region row
const orphans = await q(`
  SELECT COUNT(DISTINCT particulars) AS n
  FROM read_parquet(${p('collections_clean.parquet')}) pc
  WHERE pc.row_type = 'province_city'
    AND pc.region NOT IN (
      SELECT DISTINCT particulars
      FROM read_parquet(${p('collections_clean.parquet')})
      WHERE row_type = 'region'
    )
    AND pc.region != 'SUMMARY'
    AND pc.region IS NOT NULL
`);
orphans[0].n === 0
  ? pass('All province regions reference a valid region row')
  : fail(`${orphans[0].n} province rows reference a non-existent region`);

// Year range must be exactly 2005–2024
const yr = await q(`
  SELECT MIN(year) y1, MAX(year) y2, COUNT(DISTINCT year) yrs
  FROM read_parquet(${p('collections_clean.parquet')})
`);
(yr[0].y1 === 2005 && yr[0].y2 === 2024 && yr[0].yrs === 20)
  ? pass('Year range', `${yr[0].y1}–${yr[0].y2} (${yr[0].yrs} distinct years)`)
  : fail('Year range mismatch', JSON.stringify(yr[0]));

// Row type values must be only known values
const rtypes = await q(`
  SELECT DISTINCT row_type FROM read_parquet(${p('collections_clean.parquet')})
`);
const KNOWN_TYPES = new Set(['region', 'province_city', 'summary']);
const unknownTypes = rtypes.map(r => r.row_type).filter(t => !KNOWN_TYPES.has(t));
unknownTypes.length === 0
  ? pass('row_type values', `only: ${[...KNOWN_TYPES].join(', ')}`)
  : fail('Unknown row_type values', unknownTypes.join(', '));

// ─────────────────────────────────────────────────────────────
// 6a. Business logic — 2024 national net collection
// ─────────────────────────────────────────────────────────────
section('6a. 2024 national net collection');

const net2024 = await q(`
  SELECT net_collection, net_yoy_pct, top_region, top_province
  FROM read_parquet(${p('agg_kpi_by_year.parquet')})
  WHERE year = 2024
`);
const k = net2024[0];
const EXPECTED_NET_2024 = 2_851_603;
const diff = Math.abs(Number(k.net_collection) - EXPECTED_NET_2024);
diff < 10
  ? pass(`net_collection 2024`, `₱${Number(k.net_collection).toLocaleString('en-PH',{maximumFractionDigits:0})}M`)
  : fail(`net_collection 2024 mismatch`, `got ${k.net_collection}, expected ~${EXPECTED_NET_2024}`);

k.net_yoy_pct > 0 && k.net_yoy_pct < 30
  ? pass(`net_yoy_pct 2024`, `${k.net_yoy_pct}% (reasonable positive growth)`)
  : warn(`net_yoy_pct 2024 out of expected range`, k.net_yoy_pct);

k.top_region === 'National Capital Region (NCR)'
  ? pass('top_region 2024', k.top_region)
  : warn('top_region 2024 unexpected', k.top_region);

k.top_province === 'City of Makati'
  ? pass('top_province 2024', k.top_province)
  : warn('top_province 2024 unexpected', k.top_province);

// ─────────────────────────────────────────────────────────────
// 6b. YoY math: stored yoy_pct vs recomputed from prev_amount
// ─────────────────────────────────────────────────────────────
section('6b. YoY calculation accuracy');

const yoyCheck = await q(`
  SELECT COUNT(*) AS mismatches FROM (
    SELECT
      particulars, year, yoy_pct,
      ROUND(((amount_millions - prev_amount) / NULLIF(prev_amount, 0)) * 100, 4) AS recomputed
    FROM read_parquet(${p('collections_clean.parquet')})
    WHERE prev_amount IS NOT NULL AND prev_amount != 0
      AND yoy_pct IS NOT NULL
  )
  WHERE ABS(yoy_pct - recomputed) > 0.01   -- allow 0.01% rounding tolerance
`);
yoyCheck[0].mismatches === 0
  ? pass('YoY pct matches recomputed from prev_amount (tolerance ±0.01%)')
  : fail(`${yoyCheck[0].mismatches} YoY mismatches vs recomputed values`);

// ─────────────────────────────────────────────────────────────
// 6c. COVID year flags
// ─────────────────────────────────────────────────────────────
section('6c. COVID year flags');

const covidFlagCheck = await q(`
  SELECT
    COUNT(*) FILTER (WHERE year IN (2020,2021) AND is_covid_year = false) AS wrong_true,
    COUNT(*) FILTER (WHERE year NOT IN (2020,2021) AND is_covid_year = true) AS wrong_false
  FROM read_parquet(${p('collections_clean.parquet')})
`);
covidFlagCheck[0].wrong_true  === 0 ? pass('COVID years (2020-2021) all flagged TRUE')  : fail('Some 2020/2021 rows flagged FALSE', covidFlagCheck[0].wrong_true);
covidFlagCheck[0].wrong_false === 0 ? pass('Non-COVID years all flagged FALSE')          : fail('Some non-COVID rows flagged TRUE',  covidFlagCheck[0].wrong_false);

// ─────────────────────────────────────────────────────────────
// 6d. Rank uniqueness per year (province_city)
// ─────────────────────────────────────────────────────────────
section('6d. Rank uniqueness');

const rankDupes = await q(`
  SELECT COUNT(*) AS dupes FROM (
    SELECT year, national_rank, COUNT(*) n
    FROM read_parquet(${p('collections_clean.parquet')})
    WHERE row_type = 'province_city' AND national_rank IS NOT NULL
    GROUP BY year, national_rank
    HAVING n > 1
  )
`);
// DuckDB RANK() can produce ties — warn rather than fail
rankDupes[0].dupes === 0
  ? pass('national_rank: no duplicate ranks per year')
  : warn(`national_rank: ${rankDupes[0].dupes} tied ranks (expected for equal amounts)`);

// ─────────────────────────────────────────────────────────────
// 6e. CAGR reasonableness
// ─────────────────────────────────────────────────────────────
section('6e. CAGR reasonableness (2005–2024)');

const cagrCheck = await q(`
  SELECT
    COUNT(*) FILTER (WHERE cagr_2005_2024_pct < -10)  AS extreme_negative,
    COUNT(*) FILTER (WHERE cagr_2005_2024_pct > 50)   AS extreme_positive,
    MIN(cagr_2005_2024_pct)   AS min_cagr,
    MAX(cagr_2005_2024_pct)   AS max_cagr,
    AVG(cagr_2005_2024_pct)   AS avg_cagr
  FROM read_parquet(${p('agg_cagr.parquet')})
  WHERE cagr_2005_2024_pct IS NOT NULL
`);
const cc = cagrCheck[0];
cc.extreme_negative === 0
  ? pass('No extreme negative CAGR (<-10%)')
  : warn(`${cc.extreme_negative} entities with CAGR < -10%`, `min: ${cc.min_cagr?.toFixed(2)}%`);
cc.extreme_positive === 0
  ? pass('No extreme positive CAGR (>50%)')
  : warn(`${cc.extreme_positive} entities with CAGR > 50%`, `max: ${cc.max_cagr?.toFixed(2)}%`);
pass('CAGR range', `min ${Number(cc.min_cagr).toFixed(2)}%  max ${Number(cc.max_cagr).toFixed(2)}%  avg ${Number(cc.avg_cagr).toFixed(2)}%`);

// ─────────────────────────────────────────────────────────────
// 6f. Rolling average: must not exceed max of the window
// ─────────────────────────────────────────────────────────────
section('6f. Rolling average bounds');

const rollCheck = await q(`
  SELECT COUNT(*) AS violations FROM (
    WITH windowed AS (
      SELECT particulars, year, amount_millions, rolling_3yr_avg,
             MAX(amount_millions) OVER (
               PARTITION BY particulars
               ORDER BY year
               ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
             ) AS window_max,
             MIN(amount_millions) OVER (
               PARTITION BY particulars
               ORDER BY year
               ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
             ) AS window_min
      FROM read_parquet(${p('collections_clean.parquet')})
      WHERE rolling_3yr_avg IS NOT NULL
        AND amount_millions  IS NOT NULL
    )
    SELECT * FROM windowed
    WHERE rolling_3yr_avg > window_max + 0.001   -- +tolerance for float precision
       OR rolling_3yr_avg < window_min - 0.001
  )
`);
rollCheck[0].violations === 0
  ? pass('rolling_3yr_avg always within window min/max bounds')
  : fail(`${rollCheck[0].violations} rolling avg values outside window bounds`);

// ─────────────────────────────────────────────────────────────
// 6g. Decade bucket coverage
// ─────────────────────────────────────────────────────────────
section('6g. Decade bucket coverage');

const decades = await q(`
  SELECT decade_bucket, COUNT(*) AS n
  FROM read_parquet(${p('collections_clean.parquet')})
  WHERE decade_bucket IS NOT NULL
  GROUP BY decade_bucket
  ORDER BY decade_bucket
`);
const EXPECTED_DECADES = ['2005–2009','2010–2014','2015–2019','2020–2024'];
const foundDecades = decades.map(r => r.decade_bucket);
for (const d of EXPECTED_DECADES) {
  foundDecades.includes(d)
    ? pass(`Decade bucket present: ${d}`, `${decades.find(r=>r.decade_bucket===d).n} rows`)
    : fail(`Decade bucket missing: ${d}`);
}

// ─────────────────────────────────────────────────────────────
// 6h. KPI table cross-check vs collections_clean
// ─────────────────────────────────────────────────────────────
section('6h. KPI table cross-check vs collections_clean');

const crossCheck = await q(`
  SELECT COUNT(*) AS mismatches FROM (
    SELECT k.year, k.net_collection, c.amount_millions
    FROM read_parquet(${p('agg_kpi_by_year.parquet')}) k
    JOIN read_parquet(${p('collections_clean.parquet')}) c
      ON k.year = c.year
     AND c.particulars = 'Total Collection - Net of Tax Refund'
    WHERE ABS(k.net_collection - c.amount_millions) > 0.01
  )
`);
crossCheck[0].mismatches === 0
  ? pass('agg_kpi_by_year net_collection matches collections_clean for all 20 years')
  : fail(`${crossCheck[0].mismatches} KPI/collections_clean net_collection mismatches`);

// Also verify COVID impact pct_drop math
const covidMath = await q(`
  SELECT COUNT(*) AS mismatches FROM (
    SELECT
      ci.particulars,
      ci.pct_drop_2020,
      ROUND((ci.y2020 - ci.y2019) / NULLIF(ci.y2019, 0) * 100, 2) AS recomputed
    FROM read_parquet(${p('agg_covid_impact.parquet')}) ci
    WHERE ci.pct_drop_2020 IS NOT NULL
  )
  WHERE ABS(pct_drop_2020 - recomputed) > 0.01
`);
covidMath[0].mismatches === 0
  ? pass('agg_covid_impact pct_drop_2020 matches recomputed from y2019/y2020')
  : fail(`${covidMath[0].mismatches} pct_drop_2020 math mismatches`);

// ─────────────────────────────────────────────────────────────
// Final report
// ─────────────────────────────────────────────────────────────
conn.close();
db.close(() => {
  const total = passed + failed + warned;
  console.log('\n' + '─'.repeat(58));
  console.log(`  Passed : ${passed}  |  Failed : ${failed}  |  Warnings : ${warned}  |  Total : ${total}`);
  console.log('─'.repeat(58));
  if (failed > 0) {
    console.error(`\n  ✗ Verification FAILED — ${failed} check(s) need attention\n`);
    process.exit(1);
  } else if (warned > 0) {
    console.warn(`\n  ⚠ Verification passed with ${warned} warning(s)\n`);
  } else {
    console.log(`\n  ✓ All checks passed\n`);
  }
});
