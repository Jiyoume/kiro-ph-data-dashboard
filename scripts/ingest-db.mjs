/**
 * scripts/ingest-db.mjs
 *
 * Ingests the pre-cleaned PSCG dataset (JSON or Parquet) into a persistent
 * DuckDB database file at data/pscg.db.
 *
 * Run:
 *   node scripts/ingest-db.mjs              # uses public/pscg_clean.parquet (fastest)
 *   node scripts/ingest-db.mjs --json       # uses public/pscg_clean.json instead
 *   node scripts/ingest-db.mjs --force      # drops existing tables before loading
 *
 * Output:
 *   data/pscg.db   — persistent DuckDB database with collections + enriched views
 */

import duckdb from 'duckdb';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

const PARQUET_SRC = resolve(ROOT, 'public', 'pscg_clean.parquet');
const JSON_SRC    = resolve(ROOT, 'public', 'pscg_clean.json');
const DB_DIR      = resolve(ROOT, 'data');
const DB_PATH     = resolve(DB_DIR, 'pscg.db');

const USE_JSON    = process.argv.includes('--json');
const FORCE       = process.argv.includes('--force');
const SOURCE      = USE_JSON ? JSON_SRC : PARQUET_SRC;
const SOURCE_TYPE = USE_JSON ? 'JSON' : 'Parquet';

// ── Helpers ───────────────────────────────────────────────────
function makeConn(dbPath) {
  const db   = new duckdb.Database(dbPath);
  const conn = db.connect();
  const query = (sql) =>
    new Promise((res, rej) => conn.all(sql, (err, rows) => err ? rej(err) : res(rows)));
  const run = (sql) =>
    new Promise((res, rej) => conn.run(sql, (err) => err ? rej(err) : res()));
  const close = () =>
    new Promise((res) => { conn.close(); db.close(res); });
  return { query, run, close };
}

const ok   = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.warn(`  ⚠  ${m}`);
const step = (m) => console.log(`\n[•] ${m}`);
const fail = (m) => { console.error(`\n✗ ${m}`); process.exit(1); };

// ─────────────────────────────────────────────────────────────
async function main() {
  console.log('\n━━━ PSCG → DuckDB Ingest ━━━');
  console.log(`  Source : ${SOURCE_SRC_LABEL()} (${SOURCE_TYPE})`);
  console.log(`  Target : ${DB_PATH}`);
  console.log(`  Force  : ${FORCE ? 'yes — existing tables will be dropped' : 'no'}`);

  // ── Pre-flight checks ──────────────────────────────────────
  if (!existsSync(SOURCE)) {
    fail(
      `Source file not found: ${SOURCE}\n` +
      `  Run 'npm run ingest' first to generate the cleaned dataset.`
    );
  }

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
    ok(`Created directory: ${DB_DIR}`);
  }

  const dbExists = existsSync(DB_PATH);
  if (dbExists && !FORCE) {
    // Check if collections table already exists in the DB
    const check = makeConn(DB_PATH);
    const tables = await check.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`
    ).catch(() => []);
    await check.close();
    const hasCollections = tables.some(r => r.table_name === 'collections');
    if (hasCollections) {
      console.log(`\n  DB already contains a 'collections' table.`);
      console.log(`  Use --force to drop and reload. Exiting.\n`);
      process.exit(0);
    }
  }

  const { query, run, close } = makeConn(DB_PATH);

  // ── Drop existing if --force ───────────────────────────────
  if (FORCE) {
    step('Dropping existing tables/views…');
    await run(`DROP VIEW  IF EXISTS collections_enriched`);
    await run(`DROP VIEW  IF EXISTS v_region_year`);
    await run(`DROP VIEW  IF EXISTS v_national_trend`);
    await run(`DROP TABLE IF EXISTS collections`);
    ok('Cleared existing schema');
  }

  // ── Create base table ──────────────────────────────────────
  step('Creating collections table…');
  await run(`
    CREATE TABLE IF NOT EXISTS collections (
      particulars           VARCHAR   NOT NULL,
      region                VARCHAR,
      row_type              VARCHAR   NOT NULL,  -- region | province_city | summary
      year                  INTEGER   NOT NULL,
      amount_millions       DOUBLE,
      prev_amount           DOUBLE,
      national_total        DOUBLE,
      yoy_pct               DOUBLE,
      share_of_national_pct DOUBLE,
      is_covid_year         BOOLEAN,
      is_ncr                BOOLEAN,
      PRIMARY KEY (particulars, year)
    )
  `);
  ok('Table created');

  // ── Load from source ───────────────────────────────────────
  step(`Loading from ${SOURCE_TYPE}: ${SOURCE}…`);
  const safeSrc = SOURCE.replace(/\\/g, '/');

  const readExpr = USE_JSON
    ? `read_json_auto('${safeSrc}')`
    : `read_parquet('${safeSrc}')`;

  await run(`
    INSERT OR REPLACE INTO collections
    SELECT
      particulars,
      region,
      row_type,
      year::INTEGER,
      amount_millions::DOUBLE,
      prev_amount::DOUBLE,
      national_total::DOUBLE,
      yoy_pct::DOUBLE,
      share_of_national_pct::DOUBLE,
      is_covid_year::BOOLEAN,
      is_ncr::BOOLEAN
    FROM ${readExpr}
  `);

  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM collections`);
  ok(`Loaded ${Number(n).toLocaleString()} rows into collections`);

  // ── Create views ───────────────────────────────────────────
  step('Creating analytical views…');

  // 1. Flat enriched alias (already enriched, kept for API consistency)
  await run(`
    CREATE OR REPLACE VIEW collections_enriched AS
    SELECT * FROM collections
  `);
  ok('View: collections_enriched');

  // 2. National trend view
  await run(`
    CREATE OR REPLACE VIEW v_national_trend AS
    SELECT
      year,
      amount_millions  AS net_collection,
      yoy_pct,
      national_total   AS gross_national
    FROM collections
    WHERE particulars = 'Total Collection - Net of Tax Refund'
    ORDER BY year
  `);
  ok('View: v_national_trend');

  // 3. Region × year summary
  await run(`
    CREATE OR REPLACE VIEW v_region_year AS
    SELECT
      region,
      year,
      SUM(amount_millions)       AS total_amount,
      COUNT(DISTINCT particulars) AS province_count
    FROM collections
    WHERE row_type = 'province_city'
    GROUP BY region, year
    ORDER BY year, total_amount DESC
  `);
  ok('View: v_region_year');

  // 4. Province rankings per year
  await run(`
    CREATE OR REPLACE VIEW v_province_rank AS
    SELECT
      year,
      region,
      particulars,
      amount_millions,
      yoy_pct,
      RANK() OVER (PARTITION BY year ORDER BY amount_millions DESC) AS national_rank,
      RANK() OVER (PARTITION BY year, region ORDER BY amount_millions DESC) AS regional_rank
    FROM collections
    WHERE row_type = 'province_city'
  `);
  ok('View: v_province_rank');

  // 5. COVID impact view
  await run(`
    CREATE OR REPLACE VIEW v_covid_impact AS
    SELECT
      particulars,
      region,
      row_type,
      MAX(CASE WHEN year = 2019 THEN amount_millions END) AS pre_covid_2019,
      MAX(CASE WHEN year = 2020 THEN amount_millions END) AS covid_2020,
      MAX(CASE WHEN year = 2021 THEN amount_millions END) AS covid_2021,
      MAX(CASE WHEN year = 2022 THEN amount_millions END) AS recovery_2022,
      ROUND(
        (MAX(CASE WHEN year = 2020 THEN amount_millions END) -
         MAX(CASE WHEN year = 2019 THEN amount_millions END)) /
        NULLIF(MAX(CASE WHEN year = 2019 THEN amount_millions END), 0) * 100,
        2
      ) AS pct_drop_2020,
      ROUND(
        (MAX(CASE WHEN year = 2022 THEN amount_millions END) -
         MAX(CASE WHEN year = 2019 THEN amount_millions END)) /
        NULLIF(MAX(CASE WHEN year = 2019 THEN amount_millions END), 0) * 100,
        2
      ) AS pct_recovery_vs_2019
    FROM collections
    WHERE row_type IN ('region', 'province_city')
    GROUP BY particulars, region, row_type
    ORDER BY pct_drop_2020 ASC
  `);
  ok('View: v_covid_impact');

  // ── Validation queries ─────────────────────────────────────
  step('Running validation checks…');

  // Row type counts
  const typeCounts = await query(`
    SELECT row_type,
           COUNT(DISTINCT particulars) AS entities,
           COUNT(*)                    AS records
    FROM collections
    GROUP BY row_type
    ORDER BY row_type
  `);
  typeCounts.forEach(r =>
    ok(`  ${r.row_type.padEnd(14)} — ${r.entities} entities, ${Number(r.records).toLocaleString()} records`)
  );

  // Year range
  const [range] = await query(`SELECT MIN(year) AS y1, MAX(year) AS y2 FROM collections`);
  ok(`Year range: ${range.y1} – ${range.y2}`);

  // 2024 net collection spot-check
  const [spot] = await query(`
    SELECT amount_millions FROM collections
    WHERE particulars = 'Total Collection - Net of Tax Refund' AND year = 2024
  `);
  if (spot) {
    ok(`2024 Net Collection: ₱${Number(spot.amount_millions).toLocaleString('en-PH', { maximumFractionDigits: 0 })}M`);
  } else {
    warn('2024 Net Collection row not found — check source data');
  }

  // Top 5 provinces in 2024
  const top5 = await query(`
    SELECT particulars, region, amount_millions
    FROM collections
    WHERE row_type = 'province_city' AND year = 2024
    ORDER BY amount_millions DESC
    LIMIT 5
  `);
  ok('Top 5 provinces/cities (2024):');
  top5.forEach((r, i) =>
    console.log(`       ${i + 1}. ${r.particulars} (${r.region?.replace(/Region .+ \((.+)\)/, '$1') ?? ''}) — ₱${Number(r.amount_millions).toLocaleString('en-PH', { maximumFractionDigits: 0 })}M`)
  );

  // Null check
  const [nulls] = await query(`SELECT COUNT(*) AS n FROM collections WHERE amount_millions IS NULL`);
  if (Number(nulls.n) > 0) warn(`${nulls.n} NULL amount_millions values`);
  else ok('No NULL amount values');

  // COVID impact sample
  const covidTop = await query(`
    SELECT particulars, pct_drop_2020, pct_recovery_vs_2019
    FROM v_covid_impact
    WHERE row_type = 'region'
    ORDER BY pct_drop_2020 ASC
    LIMIT 3
  `);
  ok('Hardest-hit regions (2020 drop %):');
  covidTop.forEach(r =>
    console.log(`       ${r.particulars?.substring(0, 40).padEnd(40)} drop: ${r.pct_drop_2020}%  recovery vs 2019: ${r.pct_recovery_vs_2019}%`)
  );

  await close();

  console.log('\n━━━ Ingest complete ━━━');
  console.log(`  Database : ${DB_PATH}`);
  console.log(`  Tables   : collections`);
  console.log(`  Views    : collections_enriched, v_national_trend, v_region_year, v_province_rank, v_covid_impact`);
  console.log();
}

function SOURCE_SRC_LABEL() {
  return SOURCE;
}

main().catch(err => {
  console.error('\n✗ Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
