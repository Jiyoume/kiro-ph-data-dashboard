import * as duckdb from '@duckdb/duckdb-wasm';

// The browser fetches pscg_clean.json produced by the ingest pipeline.
// This file already contains all enriched columns (yoy_pct, rolling_3yr_avg,
// national_rank, etc.) — no spatial extension needed in the browser.
const DATA_URL = '/pscg_clean.json';

// ── DuckDB WASM init ──────────────────────────────────────────
export async function initDB() {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(worker_url);
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(worker_url);
  return db;
}

// ── Load JSON → DuckDB in-memory ─────────────────────────────
export async function loadAndClean(db, onProgress) {
  const conn = await db.connect();

  // 1. Fetch
  onProgress?.('Fetching dataset…');
  const resp = await fetch(DATA_URL);
  if (!resp.ok) throw new Error(`Failed to fetch ${DATA_URL}: ${resp.status}`);
  const records = await resp.json();
  if (!records.length) throw new Error('Dataset empty — run npm run ingest first');

  // 2. Register the JSON bytes so DuckDB WASM can read it with read_json_auto
  //    which infers all columns automatically — no manual schema needed.
  onProgress?.('Loading into DuckDB…');
  const jsonBytes = new TextEncoder().encode(JSON.stringify(records));
  await db.registerFileBuffer('pscg_clean.json', jsonBytes);

  // read_json_auto infers every column from the file — handles all pipeline-added
  // columns (rolling_3yr_avg, national_rank, decade_bucket, etc.) automatically.
  await conn.query(`
    CREATE OR REPLACE TABLE collections AS
    SELECT * FROM read_json_auto('pscg_clean.json')
  `);

  // 3. Verify
  onProgress?.('Verifying…');
  const check = await conn.query(`SELECT COUNT(*) AS n FROM collections`);
  const n = Number(check.toArray().map(r => Object.fromEntries(r))[0].n);
  if (n === 0) throw new Error('No rows loaded — check pscg_clean.json');

  // 4. Enriched view — direct alias (all enrichment already in the JSON)
  await conn.query(`
    CREATE OR REPLACE VIEW collections_enriched AS
    SELECT * FROM collections
  `);

  return conn;
}

// ── Query helpers ─────────────────────────────────────────────
export async function queryRows(conn, sql) {
  const result = await conn.query(sql);
  return result.toArray().map(r => Object.fromEntries(r));
}

export async function getRegions(conn) {
  const rows = await queryRows(conn, `
    SELECT DISTINCT region
    FROM collections_enriched
    WHERE row_type = 'region'
    ORDER BY region
  `);
  return rows.map(r => r.region);
}

export async function getNationalTrend(conn) {
  return queryRows(conn, `
    SELECT year, amount_millions, yoy_pct
    FROM collections_enriched
    WHERE particulars = 'Total Collection - Net of Tax Refund'
    ORDER BY year
  `);
}

export async function getRegionBreakdown(conn, year) {
  return queryRows(conn, `
    SELECT particulars AS region, amount_millions, share_of_national_pct
    FROM collections_enriched
    WHERE row_type = 'region'
      AND year = ${year}
      AND particulars != 'Large Taxpayers Service'
    ORDER BY amount_millions DESC
  `);
}

export async function getProvinceDetail(conn, region, year) {
  return queryRows(conn, `
    SELECT particulars, amount_millions, yoy_pct
    FROM collections_enriched
    WHERE row_type = 'province_city'
      AND region = '${region.replace(/'/g, "''")}'
      AND year = ${year}
    ORDER BY amount_millions DESC
    LIMIT 15
  `);
}

export async function getYoyHeatmap(conn) {
  return queryRows(conn, `
    SELECT particulars AS region, year, yoy_pct
    FROM collections_enriched
    WHERE row_type = 'region'
      AND year > 2005
    ORDER BY region, year
  `);
}

export async function getKpis(conn, year) {
  const rows = await queryRows(conn, `
    SELECT
      (SELECT amount_millions FROM collections_enriched
       WHERE particulars = 'Total Collection - Net of Tax Refund' AND year = ${year}) AS total_net,
      (SELECT amount_millions FROM collections_enriched
       WHERE particulars = 'Total Collection - Net of Tax Refund' AND year = ${year - 1}) AS prev_total,
      (SELECT amount_millions FROM collections_enriched
       WHERE particulars = 'Tax Refund' AND year = ${year}) AS tax_refund,
      (SELECT amount_millions FROM collections_enriched
       WHERE particulars = 'Total Gross Collection' AND year = ${year}) AS gross_total,
      (SELECT particulars FROM collections_enriched
       WHERE row_type = 'region' AND year = ${year}
         AND particulars != 'Large Taxpayers Service'
       ORDER BY amount_millions DESC LIMIT 1) AS top_region,
      (SELECT particulars FROM collections_enriched
       WHERE row_type = 'province_city' AND year = ${year}
       ORDER BY amount_millions DESC LIMIT 1) AS top_province
  `);
  return rows[0];
}
