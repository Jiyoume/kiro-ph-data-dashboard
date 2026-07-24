/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WORKSHOP — STEP 2: CLEANING & INTEGRITY ENFORCEMENT
 * ─────────────────────────────────────────────────────────────────────────────
 * Applies ALL fixes identified in Step 1 as a single, reproducible SQL
 * transformation. The raw table is never mutated — we produce a new
 * 'collections_clean' table, preserving auditability.
 *
 * Fixes applied (in order):
 *   1. Deduplication         — keep first occurrence per customer_id
 *   2. Whitespace stripping  — TRIM() on all VARCHAR columns
 *   3. Case standardisation  — INITCAP(region), LOWER(status), UPPER(segment)
 *   4. Type coercion         — revenue / order_count → strict numeric types
 *   5. Null imputation       — domain-appropriate defaults for missing values
 *   6. Date normalisation    — signup_date cast to DATE type
 *
 * 📌 DE INSIGHT — Why do all transforms in one SQL CTAS pass?
 *    A single CREATE TABLE AS SELECT reads the source columnar data once and
 *    writes the output once — no intermediate copies, no row-by-row Python
 *    loops. DuckDB's query optimiser pushes filters, projections, and
 *    type casts into a single vectorised scan that is orders of magnitude
 *    faster and cheaper on memory than iterative dataframe mutation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import duckdb from 'duckdb';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW       = resolve(__dirname, 'raw_dataset.csv').replace(/\\/g, '/');

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

const step = (n, t) => console.log(`\n[${n}] ${t}`);
const ok   = (t)    => console.log(`  ✓  ${t}`);
const info = (t)    => console.log(`  ·  ${t}`);

// ─────────────────────────────────────────────────────────────
async function clean() {
  console.log('\n' + '═'.repeat(60));
  console.log('  STEP 2 · CLEANING & INTEGRITY ENFORCEMENT');
  console.log('═'.repeat(60));

  // ── Load raw ───────────────────────────────────────────────
  await run(`CREATE OR REPLACE TABLE raw AS SELECT * FROM read_csv_auto('${RAW}', header=true)`);
  const [{ raw_n }] = await q(`SELECT COUNT(*) AS raw_n FROM raw`);
  info(`Raw rows ingested: ${raw_n}`);

  // ─────────────────────────────────────────────────────────
  // STEP 2A — DEDUPLICATION
  // Strategy: QUALIFY ROW_NUMBER() keeps only the FIRST occurrence
  // per business key (customer_id), ordered by most data present.
  // This is safer than DISTINCT * which would keep near-duplicates.
  // ─────────────────────────────────────────────────────────
  step('2A', 'Deduplication via QUALIFY ROW_NUMBER()');

  await run(`
    CREATE OR REPLACE TABLE deduped AS
    SELECT * FROM raw
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY customer_id
      -- Prefer rows with the most non-null fields (more complete records)
      ORDER BY (
        (email        IS NOT NULL)::INT +
        (full_name    IS NOT NULL)::INT +
        (signup_date  IS NOT NULL)::INT +
        (order_count  IS NOT NULL)::INT +
        (revenue      IS NOT NULL)::INT
      ) DESC
    ) = 1
  `);

  const [{ dedup_n }] = await q(`SELECT COUNT(*) AS dedup_n FROM deduped`);
  ok(`Rows after dedup: ${dedup_n}  (removed ${raw_n - dedup_n} duplicate(s))`);

  // ─────────────────────────────────────────────────────────
  // STEP 2B — FULL CLEANING CTAS
  // All transforms in one pass for columnar efficiency.
  // ─────────────────────────────────────────────────────────
  step('2B', 'Single-pass cleaning CTAS — type casting, trim, standardisation, imputation');

  await run(`
    CREATE OR REPLACE TABLE cleaned AS
    SELECT
      -- ── Identifiers ──────────────────────────────────────
      TRIM(customer_id)                                   AS customer_id,

      -- Title-case: uppercase first letter of each word using string split
      -- Works in all DuckDB versions without INITCAP or regex back-references
      ARRAY_TO_STRING(
        LIST_TRANSFORM(
          STRING_SPLIT(LOWER(TRIM(full_name)), ' '),
          w -> UPPER(LEFT(w,1)) || SUBSTR(w,2)
        ), ' '
      )                                                   AS full_name,

      -- Lowercase email; NULL for missing (cannot impute contact info)
      CASE
        WHEN TRIM(email) = '' OR email IS NULL THEN NULL
        ELSE LOWER(TRIM(email))
      END                                                 AS email,

      -- ── Geography ────────────────────────────────────────
      CASE UPPER(TRIM(region))
        WHEN 'NCR'        THEN 'NCR'
        WHEN 'CAR'        THEN 'CAR'
        WHEN 'BARMM'      THEN 'BARMM'
        ELSE ARRAY_TO_STRING(
               LIST_TRANSFORM(
                 STRING_SPLIT(LOWER(TRIM(region)), ' '),
                 w -> UPPER(LEFT(w,1)) || SUBSTR(w,2)
               ), ' '
             )
      END                                                 AS region,

      -- ── Categoricals ─────────────────────────────────────
      UPPER(TRIM(segment))                                AS segment,
      LOWER(TRIM(status))                                 AS status,

      -- ── Numeric / Monetary ───────────────────────────────
      CAST(
        TRY_CAST(
          TRIM(REPLACE(REPLACE(COALESCE(revenue, ''), ',', ''), ' ', ''))
          AS DOUBLE
        ) AS DECIMAL(15, 2)
      )                                                   AS revenue,

      TRY_CAST(TRIM(CAST(order_count AS VARCHAR)) AS INTEGER)
                                                          AS order_count,

      -- ── Dates ─────────────────────────────────────────────
      TRY_CAST(TRIM(CAST(signup_date AS VARCHAR)) AS DATE)
                                                          AS signup_date

    FROM deduped
  `);

  const [{ clean_n }] = await q(`SELECT COUNT(*) AS clean_n FROM cleaned`);
  ok(`Rows in cleaned table: ${clean_n}`);

  // ─────────────────────────────────────────────────────────
  // STEP 2C — NULL IMPUTATION for remaining NULLs
  // After type coercion, apply domain-appropriate defaults:
  //   revenue = 0.00    → no revenue recorded, but row is valid
  //   order_count = 0   → same logic
  //   signup_date = today → placeholder for unknown onboarding date
  //   full_name = 'Unknown' → required for downstream display
  // Email is intentionally left NULL (cannot fabricate contact data)
  // ─────────────────────────────────────────────────────────
  step('2C', 'Null imputation — domain-appropriate defaults');

  await run(`
    CREATE OR REPLACE TABLE cleaned_final AS
    SELECT
      customer_id,
      COALESCE(full_name,   'Unknown')                       AS full_name,
      email,                                                 -- NULL allowed: cannot impute
      region,
      segment,
      COALESCE(revenue,     0.00)                            AS revenue,
      COALESCE(order_count, 0)                               AS order_count,
      COALESCE(signup_date, CURRENT_DATE)                    AS signup_date,
      status
    FROM cleaned
  `);

  ok('Null imputation applied');

  // ─────────────────────────────────────────────────────────
  // STEP 2D — POST-CLEAN SUMMARY
  // ─────────────────────────────────────────────────────────
  step('2D', 'Post-clean snapshot');

  const sample = await q(`
    SELECT customer_id, full_name, region, segment, revenue, order_count, signup_date, status
    FROM cleaned_final
    ORDER BY customer_id
    LIMIT 8
  `);

  console.log('');
  console.log('  customer_id  full_name         region       segment  revenue     orders  signup_date  status');
  console.log('  ' + '─'.repeat(96));
  sample.forEach(r =>
    console.log(
      `  ${String(r.customer_id).padEnd(12)} ${String(r.full_name).padEnd(18)}` +
      `${String(r.region).padEnd(13)}${String(r.segment).padEnd(9)}` +
      `${String(r.revenue).padStart(10)}  ${String(r.order_count).padStart(5)}` +
      `  ${r.signup_date}  ${r.status}`
    )
  );

  // Null counts post-clean
  const nullCheck = await q(`
    SELECT
      COUNT(*) FILTER (WHERE customer_id  IS NULL) AS id_null,
      COUNT(*) FILTER (WHERE full_name    IS NULL) AS name_null,
      COUNT(*) FILTER (WHERE region       IS NULL) AS region_null,
      COUNT(*) FILTER (WHERE segment      IS NULL) AS segment_null,
      COUNT(*) FILTER (WHERE revenue      IS NULL) AS revenue_null,
      COUNT(*) FILTER (WHERE order_count  IS NULL) AS orders_null,
      COUNT(*) FILTER (WHERE signup_date  IS NULL) AS date_null,
      COUNT(*) FILTER (WHERE status       IS NULL) AS status_null
    FROM cleaned_final
  `);
  const nc = nullCheck[0];
  const nullTotal = Object.values(nc).reduce((s, v) => s + v, 0);

  console.log('');
  console.log('  Core column null counts after cleaning:');
  Object.entries(nc).forEach(([col, n]) =>
    console.log(`    ${col.replace('_null','').padEnd(14)} ${n === 0 ? '✓ 0' : '✗ ' + n}`)
  );
  console.log(`\n  Total nulls remaining in core fields: ${nullTotal === 0 ? '✓ 0 — ZERO NULLS ACHIEVED' : '✗ ' + nullTotal}`);

  // Expose cleaned_final to Step 3
  // Return db handle so Step 3 can reuse it
  return { db, conn };
}

export { clean };

// ── Run standalone ────────────────────────────────────────────
const { db: _db, conn: _conn } = await clean().catch(e => {
  console.error('✗', e.message);
  process.exit(1);
});
_conn.close(); _db.close(() => {});
