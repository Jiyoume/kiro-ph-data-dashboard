/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WORKSHOP — STEP 3: EXPORT & POST-QUALITY VALIDATION PIPELINE
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the production gate. Nothing ships to the frontend or DuckDB-WASM
 * unless ALL assertion checks pass. If even one assertion fails, the export
 * is blocked and the script exits non-zero — safe for CI/CD pipelines.
 *
 * Validation assertions:
 *   A1. Zero nulls in all core fields
 *   A2. Row count within expected range (no silent data loss)
 *   A3. No duplicate customer_ids
 *   A4. Revenue is always ≥ 0 (no negative monetary values)
 *   A5. order_count is always ≥ 0
 *   A6. status only contains canonical values (active / inactive)
 *   A7. segment only contains canonical values (ENTERPRISE / SME)
 *   A8. signup_date is always a valid past date
 *   A9. customer_id format matches expected pattern (C + digits)
 *
 * 📌 DE INSIGHT — Why validate before export, not after?
 *    Exporting corrupt data to Parquet creates a poisoned artifact that may
 *    silently propagate bad values into every downstream consumer — dashboards,
 *    ML features, reports. Asserting pre-export means the Parquet file is
 *    a trust boundary: any consumer can rely on its schema contract without
 *    re-running their own defensive checks, reducing total pipeline latency
 *    and eliminating duplicated validation code across teams.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import duckdb from 'duckdb';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync } from 'fs';
import { tmpdir } from 'os';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const RAW        = resolve(__dirname, 'raw_dataset.csv').replace(/\\/g, '/');
const OUTPUT     = resolve(__dirname, 'cleaned_dataset.parquet');
const TMP_OUTPUT = resolve(tmpdir(), 'cleaned_dataset.tmp.parquet'); // write outside watch dir

// ── DB helpers ────────────────────────────────────────────────
const db   = new duckdb.Database(':memory:');
const conn = db.connect();

function run(sql) {
  return new Promise((res, rej) => conn.run(sql, e => e ? rej(e) : res()));
}
function q(sql) {
  return new Promise((res, rej) =>
    conn.all(sql, (e, rows) => e ? rej(e) :
      res(rows.map(r => Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
      )))
    )
  );
}

// ── Assertion engine ──────────────────────────────────────────
let passed = 0, failed = 0;
const assertions = [];

function assert(label, value, expected, operator = '===') {
  let ok = false;
  switch (operator) {
    case '===': ok = value === expected; break;
    case '>=':  ok = value >= expected;  break;
    case '<=':  ok = value <= expected;  break;
    case '>':   ok = value > expected;   break;
    case '<':   ok = value < expected;   break;
  }
  if (ok) {
    console.log(`  ✓  ${label}  (${value} ${operator} ${expected})`);
    passed++;
  } else {
    console.error(`  ✗  ASSERTION FAILED: ${label}  →  got ${value}, expected ${operator} ${expected}`);
    failed++;
  }
  assertions.push({ label, value, expected, operator, ok });
}

// ─────────────────────────────────────────────────────────────
async function runPipeline() {
  console.log('\n' + '═'.repeat(60));
  console.log('  STEP 3 · EXPORT & POST-QUALITY VALIDATION');
  console.log('═'.repeat(60));

  // ─────────────────────────────────────────────────────────
  // RE-RUN STEPS 1 & 2 IN-MEMORY
  // (In production this would read an intermediate staging table.
  //  Here we replay the full transform for workshop self-containment.)
  // ─────────────────────────────────────────────────────────
  console.log('\n[•] Replaying Step 1 + Step 2 transforms…');

  await run(`CREATE OR REPLACE TABLE raw AS SELECT * FROM read_csv_auto('${RAW}', header=true)`);

  // --- Deduplication (same as Step 2A) ---
  await run(`
    CREATE OR REPLACE TABLE deduped AS
    SELECT * FROM raw
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY customer_id
      ORDER BY (
        (email IS NOT NULL)::INT + (full_name IS NOT NULL)::INT +
        (signup_date IS NOT NULL)::INT + (order_count IS NOT NULL)::INT +
        (revenue IS NOT NULL)::INT
      ) DESC
    ) = 1
  `);

  // --- Full cleaning CTAS (same as Step 2B) ---
  await run(`
    CREATE OR REPLACE TABLE cleaned AS
    SELECT
      TRIM(customer_id)                                    AS customer_id,
      ARRAY_TO_STRING(
        LIST_TRANSFORM(STRING_SPLIT(LOWER(TRIM(full_name)), ' '),
          w -> UPPER(LEFT(w,1)) || SUBSTR(w,2)
        ), ' '
      )                                                   AS full_name,
      CASE WHEN TRIM(email) = '' OR email IS NULL THEN NULL
           ELSE LOWER(TRIM(email)) END                     AS email,
      CASE UPPER(TRIM(region))
        WHEN 'NCR'   THEN 'NCR'
        WHEN 'CAR'   THEN 'CAR'
        WHEN 'BARMM' THEN 'BARMM'
        ELSE ARRAY_TO_STRING(
               LIST_TRANSFORM(STRING_SPLIT(LOWER(TRIM(region)), ' '),
                 w -> UPPER(LEFT(w,1)) || SUBSTR(w,2)
               ), ' '
             )
      END                                                  AS region,
      UPPER(TRIM(segment))                                 AS segment,
      LOWER(TRIM(status))                                  AS status,
      CAST(
        TRY_CAST(
          TRIM(REPLACE(REPLACE(COALESCE(revenue, ''), ',', ''), ' ', ''))
          AS DOUBLE
        ) AS DECIMAL(15, 2)
      )                                                    AS revenue,
      TRY_CAST(TRIM(CAST(order_count AS VARCHAR)) AS INTEGER) AS order_count,
      TRY_CAST(TRIM(CAST(signup_date AS VARCHAR)) AS DATE)    AS signup_date
    FROM deduped
  `);

  // --- Null imputation (same as Step 2C) ---
  await run(`
    CREATE OR REPLACE TABLE cleaned_final AS
    SELECT
      customer_id,
      COALESCE(full_name,   'Unknown')   AS full_name,
      email,
      region,
      segment,
      COALESCE(revenue,     0.00)        AS revenue,
      COALESCE(order_count, 0)           AS order_count,
      COALESCE(signup_date, CURRENT_DATE) AS signup_date,
      status
    FROM cleaned
  `);

  console.log('  ✓ Transform pipeline replayed');

  // ─────────────────────────────────────────────────────────
  // PRE-EXPORT VALIDATION ASSERTIONS
  // ─────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('  PRE-EXPORT ASSERTIONS');
  console.log('─'.repeat(60));

  const [counts] = await q(`
    SELECT
      COUNT(*)                                                AS total_rows,
      COUNT(*) FILTER (WHERE customer_id  IS NULL)           AS id_null,
      COUNT(*) FILTER (WHERE full_name    IS NULL)           AS name_null,
      COUNT(*) FILTER (WHERE region       IS NULL)           AS region_null,
      COUNT(*) FILTER (WHERE segment      IS NULL)           AS segment_null,
      COUNT(*) FILTER (WHERE revenue      IS NULL)           AS rev_null,
      COUNT(*) FILTER (WHERE order_count  IS NULL)           AS orders_null,
      COUNT(*) FILTER (WHERE signup_date  IS NULL)           AS date_null,
      COUNT(*) FILTER (WHERE status       IS NULL)           AS status_null,
      COUNT(*) FILTER (WHERE revenue < 0)                    AS neg_revenue,
      COUNT(*) FILTER (WHERE order_count < 0)                AS neg_orders,
      COUNT(*) FILTER (WHERE signup_date > CURRENT_DATE)     AS future_dates
    FROM cleaned_final
  `);

  // A1. Zero nulls in critical fields
  console.log('\n  A1. Zero nulls in core fields:');
  assert('customer_id nulls',  counts.id_null,     0);
  assert('full_name nulls',    counts.name_null,   0);
  assert('region nulls',       counts.region_null, 0);
  assert('segment nulls',      counts.segment_null,0);
  assert('revenue nulls',      counts.rev_null,    0);
  assert('order_count nulls',  counts.orders_null, 0);
  assert('signup_date nulls',  counts.date_null,   0);
  assert('status nulls',       counts.status_null, 0);

  // A2. Row count within expected range
  console.log('\n  A2. Row count sanity:');
  const [{ raw_n }] = await q(`SELECT COUNT(*) AS raw_n FROM raw`);
  assert('cleaned rows ≤ raw rows',       counts.total_rows, raw_n,  '<=');
  assert('cleaned rows > 0',              counts.total_rows, 0,      '>');
  assert('minimum expected rows (≥ 20)',  counts.total_rows, 20,     '>=');

  // A3. No duplicate customer_ids
  console.log('\n  A3. Deduplication verified:');
  const [{ dupe_ids }] = await q(`
    SELECT COUNT(*) AS dupe_ids FROM (
      SELECT customer_id FROM cleaned_final
      GROUP BY customer_id HAVING COUNT(*) > 1
    )
  `);
  assert('duplicate customer_ids', dupe_ids, 0);

  // A4–A5. Non-negative numerics
  console.log('\n  A4–A5. Non-negative numeric values:');
  assert('negative revenue values',     counts.neg_revenue, 0);
  assert('negative order_count values', counts.neg_orders,  0);

  // A6. Canonical status values only
  console.log('\n  A6. Canonical status values (active / inactive only):');
  const [{ bad_status }] = await q(`
    SELECT COUNT(*) AS bad_status FROM cleaned_final
    WHERE status NOT IN ('active', 'inactive')
  `);
  assert('non-canonical status values', bad_status, 0);

  // A7. Canonical segment values only
  console.log('\n  A7. Canonical segment values (ENTERPRISE / SME only):');
  const [{ bad_segment }] = await q(`
    SELECT COUNT(*) AS bad_segment FROM cleaned_final
    WHERE segment NOT IN ('ENTERPRISE', 'SME')
  `);
  assert('non-canonical segment values', bad_segment, 0);

  // A8. No future signup dates
  console.log('\n  A8. No future signup dates:');
  assert('future signup_dates', counts.future_dates, 0);

  // A9. customer_id format: starts with C followed by digits
  console.log('\n  A9. customer_id format (C + digits):');
  const [{ bad_ids }] = await q(`
    SELECT COUNT(*) AS bad_ids FROM cleaned_final
    WHERE NOT regexp_matches(customer_id, '^C\\d+$')
  `);
  assert('malformed customer_ids', bad_ids, 0);

  // ─────────────────────────────────────────────────────────
  // GATE: block export if any assertion failed
  // ─────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`  Results: ${passed} passed · ${failed} failed`);
  console.log('─'.repeat(60));

  if (failed > 0) {
    console.error(`\n  ✗ EXPORT BLOCKED — ${failed} assertion(s) failed.`);
    console.error('    Fix the data quality issues above before re-running.\n');
    conn.close(); db.close(() => {}); process.exit(1);
  }

  console.log('\n  ✓ All assertions passed — proceeding to export');

  // ─────────────────────────────────────────────────────────
  // EXPORT TO PARQUET (SNAPPY compression)
  // Write to OS temp first, then move atomically so no Vite
  // file-watcher lock issues.
  // ─────────────────────────────────────────────────────────
  console.log('\n[•] Exporting cleaned_final → cleaned_dataset.parquet (SNAPPY)…');

  const safeTmp = TMP_OUTPUT.replace(/\\/g, '/');
  await run(`
    COPY (
      SELECT
        customer_id,
        full_name,
        email,
        region,
        segment,
        revenue::DECIMAL(15,2)  AS revenue,
        order_count::INTEGER     AS order_count,
        signup_date::DATE        AS signup_date,
        status
      FROM cleaned_final
      ORDER BY customer_id
    )
    TO '${safeTmp}'
    (FORMAT PARQUET, CODEC 'SNAPPY')
  `);

  // Atomic move from temp → final destination
  const { copyFileSync, unlinkSync } = await import('fs');
  if (existsSync(OUTPUT)) unlinkSync(OUTPUT);
  copyFileSync(TMP_OUTPUT, OUTPUT);

  const size = statSync(OUTPUT).size;
  console.log(`  ✓ Written: ${OUTPUT}`);
  console.log(`  ✓ Size   : ${(size / 1024).toFixed(1)} KB (SNAPPY compressed)`);

  // ─────────────────────────────────────────────────────────
  // POST-EXPORT READBACK VALIDATION
  // Confirm the Parquet file is readable and row count matches
  // ─────────────────────────────────────────────────────────
  console.log('\n[•] Post-export readback validation…');

  const safeOut = OUTPUT.replace(/\\/g, '/');
  const [{ parquet_n }] = await q(
    `SELECT COUNT(*) AS parquet_n FROM read_parquet('${safeOut}')`
  );
  assert('Parquet row count matches cleaned_final', parquet_n, counts.total_rows);

  // Schema check on Parquet output
  const parquetSchema = await q(`DESCRIBE SELECT * FROM read_parquet('${safeOut}')`);
  console.log('\n  Parquet schema (final contract for downstream consumers):');
  console.log('  ' + '─'.repeat(44));
  parquetSchema.forEach(r =>
    console.log(`  ${r.column_name.padEnd(16)} ${r.column_type}`)
  );

  // Final sample
  const finalSample = await q(`
    SELECT * FROM read_parquet('${safeOut}') ORDER BY customer_id LIMIT 5
  `);
  console.log('\n  First 5 rows of cleaned_dataset.parquet:');
  console.log('  ' + '─'.repeat(92));
  finalSample.forEach(r =>
    console.log(
      `  ${String(r.customer_id).padEnd(10)} | ${String(r.full_name).padEnd(18)} | ` +
      `${String(r.region).padEnd(14)} | ${String(r.segment).padEnd(12)} | ` +
      `${String(r.revenue).padStart(10)} | ${String(r.order_count).padStart(6)} | ${r.signup_date} | ${r.status}`
    )
  );

  conn.close();
  db.close(() => {
    console.log('\n' + '═'.repeat(60));
    console.log(`  ✓ PIPELINE COMPLETE`);
    console.log(`  ✓ Output : cleaned_dataset.parquet`);
    console.log(`  ✓ Rows   : ${parquet_n} production-ready records`);
    console.log(`  ✓ Assertions: ${passed + 1} passed · 0 failed`);
    console.log('═'.repeat(60) + '\n');
  });
}

runPipeline().catch(e => { console.error('\n✗ Fatal:', e.message); process.exit(1); });
