/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WORKSHOP — STEP 1: DATA QUALITY ASSESSMENT & DIAGNOSTICS
 * ─────────────────────────────────────────────────────────────────────────────
 * Role: Data Engineering Manager / Technical Mentor
 * Goal: Audit raw_dataset.csv BEFORE touching the data.
 *       Never clean what you haven't measured.
 *
 * 📌 DE INSIGHT — Why server-side DuckDB instead of loading into the browser?
 *    DuckDB reads CSV/Parquet in a columnar, streaming fashion using vectorised
 *    execution, so only the columns you SELECT are materialised in memory —
 *    a 10 M-row file audited here never exceeds a few MB of RAM.
 *    Handing a pre-validated, typed Parquet to DuckDB-WASM means the browser
 *    worker starts with zero cleaning overhead and full query performance.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import duckdb from 'duckdb';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = resolve(__dirname, 'raw_dataset.csv').replace(/\\/g, '/');

// ── DB helpers ────────────────────────────────────────────────
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

const divider = (t) => console.log(`\n${'═'.repeat(60)}\n  ${t}\n${'═'.repeat(60)}`);
const sub     = (t) => console.log(`\n  ── ${t}`);

// ─────────────────────────────────────────────────────────────
async function audit() {
  divider('STEP 1 · DATA QUALITY ASSESSMENT & DIAGNOSTICS');

  // ── 1A. Load raw CSV (DuckDB infers schema automatically) ──
  sub('1A. Ingest raw CSV');
  await q(`CREATE OR REPLACE TABLE raw AS SELECT * FROM read_csv_auto('${RAW}', header=true)`);

  const [{ total_rows }] = await q(`SELECT COUNT(*) AS total_rows FROM raw`);
  console.log(`  Total rows loaded : ${total_rows}`);

  // ── 1B. Schema inspection — inferred types ─────────────────
  sub('1B. Inferred column types (auto-detected by DuckDB)');
  const schema = await q(`DESCRIBE raw`);
  console.log('');
  console.log('  Column                  Inferred Type  Nullable');
  console.log('  ' + '─'.repeat(54));
  schema.forEach(r =>
    console.log(`  ${r.column_name.padEnd(24)}${r.column_type.padEnd(15)}${r.null}`)
  );

  // ── 1C. Missingness audit ──────────────────────────────────
  // Build a dynamic SQL expression that counts NULLs per column
  sub('1C. Null / blank missingness per column');
  const nullExprs = schema.map(r =>
    `COUNT(*) FILTER (WHERE "${r.column_name}" IS NULL OR TRIM(CAST("${r.column_name}" AS VARCHAR)) = '') AS "${r.column_name}_missing"`
  ).join(',\n    ');

  const missing = await q(`SELECT ${nullExprs} FROM raw`);
  const m = missing[0];
  console.log('');
  console.log('  Column                  Missing / Blank');
  console.log('  ' + '─'.repeat(40));
  Object.entries(m).forEach(([col, count]) => {
    const clean = col.replace('_missing', '');
    const flag  = count > 0 ? ' ⚠' : ' ✓';
    console.log(`  ${clean.padEnd(24)}${String(count).padStart(5)}${flag}`);
  });

  // ── 1D. Duplicate detection ────────────────────────────────
  sub('1D. Exact duplicate rows (all columns)');
  const [{ exact_dupes }] = await q(`
    SELECT COUNT(*) AS exact_dupes FROM (
      SELECT *, COUNT(*) AS n FROM raw
      GROUP BY ALL
      HAVING n > 1
    )
  `);
  console.log(`  Exact duplicate groups : ${exact_dupes}`);

  // Duplicate by business key (customer_id)
  const [{ key_dupes }] = await q(`
    SELECT COUNT(*) AS key_dupes FROM (
      SELECT customer_id, COUNT(*) AS n FROM raw
      GROUP BY customer_id HAVING n > 1
    )
  `);
  console.log(`  Duplicate customer_ids : ${key_dupes}`);

  // ── 1E. Value anomaly scan ─────────────────────────────────
  sub('1E. Value anomaly scan');

  // revenue column — string values that can't be cast to numeric
  const badRevenue = await q(`
    SELECT customer_id, revenue AS raw_revenue
    FROM raw
    WHERE TRY_CAST(TRIM(REPLACE(revenue, ',', '')) AS DOUBLE) IS NULL
      AND revenue IS NOT NULL
  `);
  console.log(`\n  Non-numeric revenue values (${badRevenue.length}):`);
  badRevenue.forEach(r =>
    console.log(`    customer_id=${r.customer_id}  revenue="${r.raw_revenue}"`)
  );

  // status — distinct raw values (shows casing inconsistency)
  const statusVals = await q(`
    SELECT status AS raw_status, COUNT(*) AS n
    FROM raw GROUP BY status ORDER BY status
  `);
  console.log(`\n  Distinct 'status' values (expect inconsistent casing):`);
  statusVals.forEach(r =>
    console.log(`    "${r.raw_status}"  →  ${r.n} rows`)
  );

  // region — distinct raw values (shows whitespace + casing issues)
  const regionVals = await q(`
    SELECT region AS raw_region, COUNT(*) AS n
    FROM raw GROUP BY region ORDER BY region
  `);
  console.log(`\n  Distinct 'region' values (expect whitespace + case issues):`);
  regionVals.forEach(r =>
    console.log(`    "${r.raw_region}"  →  ${r.n} rows`)
  );

  // ── 1F. Row count sanity ───────────────────────────────────
  sub('1F. Row count anomalies');
  const [{ distinct_rows }] = await q(`SELECT COUNT(*) AS distinct_rows FROM (SELECT DISTINCT * FROM raw)`);
  console.log(`  Total rows     : ${total_rows}`);
  console.log(`  Distinct rows  : ${distinct_rows}`);
  console.log(`  Duplicate rows : ${total_rows - distinct_rows}  (to be removed in Step 2)`);

  console.log(`\n${'─'.repeat(60)}`);
  console.log('  ✓ Audit complete — issues catalogued, no data modified');
  console.log(`${'─'.repeat(60)}\n`);

  conn.close(); db.close(() => {});
}

audit().catch(e => { console.error('✗', e.message); process.exit(1); });
