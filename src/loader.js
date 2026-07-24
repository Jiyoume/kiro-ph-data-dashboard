import * as duckdb from '@duckdb/duckdb-wasm';

const DATA_URL = '/pscg_clean.json';

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

export async function loadData(db, onProgress) {
  const conn = await db.connect();

  onProgress?.('Fetching dataset…');
  const resp = await fetch(DATA_URL);
  if (!resp.ok) throw new Error(`Failed to fetch ${DATA_URL}: ${resp.status}`);
  const records = await resp.json();
  if (!records.length) throw new Error('Dataset empty — run npm run ingest first');

  onProgress?.('Loading into DuckDB…');
  const jsonBytes = new TextEncoder().encode(JSON.stringify(records));
  await db.registerFileBuffer('pscg_clean.json', jsonBytes);

  await conn.query(`
    CREATE OR REPLACE TABLE collections AS
    SELECT * FROM read_json_auto('pscg_clean.json')
  `);

  const check = await conn.query(`SELECT COUNT(*) AS n FROM collections`);
  const n = Number(check.toArray().map(r => Object.fromEntries(r))[0].n);
  if (n === 0) throw new Error('No rows loaded');

  return conn;
}

// ── Query helper ──────────────────────────────────────────────
export async function queryRows(conn, sql) {
  const result = await conn.query(sql);
  return result.toArray().map(r => Object.fromEntries(r));
}

// ── Filtered queries ──────────────────────────────────────────
function buildWhere(filters) {
  const clauses = [];
  if (filters.yearMin) clauses.push(`year >= ${filters.yearMin}`);
  if (filters.yearMax) clauses.push(`year <= ${filters.yearMax}`);
  if (filters.region) clauses.push(`region = '${filters.region.replace(/'/g, "''")}'`);
  if (filters.rowTypes && filters.rowTypes.length) {
    clauses.push(`row_type IN (${filters.rowTypes.map(t => `'${t}'`).join(',')})`);
  }
  return clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
}

export async function getRegions(conn) {
  const rows = await queryRows(conn, `
    SELECT DISTINCT region FROM collections WHERE row_type = 'region' ORDER BY region
  `);
  return rows.map(r => r.region);
}

export async function getFilteredTrend(conn, filters) {
  const where = buildWhere({ ...filters, rowTypes: undefined });
  return queryRows(conn, `
    SELECT year, SUM(amount_millions) AS amount, AVG(yoy_pct) AS avg_yoy
    FROM collections
    ${where ? where + ' AND' : 'WHERE'} particulars = 'Total Collection - Net of Tax Refund'
    GROUP BY year ORDER BY year
  `);
}

export async function getFilteredRegions(conn, filters) {
  const where = buildWhere(filters);
  return queryRows(conn, `
    SELECT region, SUM(amount_millions) AS total
    FROM collections
    ${where ? where + ' AND' : 'WHERE'} row_type = 'region'
      AND particulars != 'Large Taxpayers Service'
    GROUP BY region ORDER BY total DESC
  `);
}

export async function getFilteredProvinces(conn, filters) {
  const where = buildWhere(filters);
  return queryRows(conn, `
    SELECT particulars, SUM(amount_millions) AS total
    FROM collections
    ${where ? where + ' AND' : 'WHERE'} row_type = 'province_city'
    GROUP BY particulars ORDER BY total DESC LIMIT 15
  `);
}

export async function getHeatmapData(conn, filters, metric = 'amount_millions') {
  const where = buildWhere({ ...filters, rowTypes: ['region'] });
  const agg = metric === 'amount_millions' ? 'SUM' : 'AVG';
  return queryRows(conn, `
    SELECT particulars AS region, year, ${agg}(${metric}) AS value
    FROM collections
    ${where ? where + ' AND' : 'WHERE'} row_type = 'region'
      AND particulars != 'Large Taxpayers Service'
    GROUP BY particulars, year
    ORDER BY particulars, year
  `);
}

export async function getYoyByRegion(conn, filters) {
  const where = buildWhere({ ...filters, rowTypes: ['region'] });
  return queryRows(conn, `
    SELECT particulars AS region, year, yoy_pct
    FROM collections
    ${where ? where + ' AND' : 'WHERE'} row_type = 'region'
      AND year > ${filters.yearMin || 2005}
      AND particulars != 'Large Taxpayers Service'
    ORDER BY particulars, year
  `);
}

export async function getRankings(conn, filters) {
  const where = buildWhere(filters);
  return queryRows(conn, `
    SELECT particulars, region, SUM(amount_millions) AS total, AVG(yoy_pct) AS avg_yoy
    FROM collections
    ${where ? where + ' AND' : 'WHERE'} row_type = 'province_city'
    GROUP BY particulars, region
    ORDER BY total DESC
    LIMIT 25
  `);
}

export async function getKpis(conn, filters) {
  const yr = filters.yearMax || 2024;
  const rows = await queryRows(conn, `
    SELECT
      (SELECT SUM(amount_millions) FROM collections WHERE particulars = 'Total Collection - Net of Tax Refund' AND year = ${yr}) AS total_net,
      (SELECT SUM(amount_millions) FROM collections WHERE particulars = 'Total Collection - Net of Tax Refund' AND year = ${yr - 1}) AS prev_total,
      (SELECT SUM(amount_millions) FROM collections WHERE particulars = 'Tax Refund' AND year = ${yr}) AS tax_refund,
      (SELECT SUM(amount_millions) FROM collections WHERE particulars = 'Total Gross Collection' AND year = ${yr}) AS gross_total,
      (SELECT particulars FROM collections WHERE row_type = 'region' AND year = ${yr} AND particulars != 'Large Taxpayers Service' ORDER BY amount_millions DESC LIMIT 1) AS top_region
  `);
  return rows[0];
}

export async function getFilteredCount(conn, filters) {
  const where = buildWhere(filters);
  const [{ n }] = await queryRows(conn, `SELECT COUNT(*) AS n FROM collections ${where}`);
  return Number(n);
}

export async function getFilteredCSV(conn, filters) {
  const where = buildWhere(filters);
  return queryRows(conn, `
    SELECT particulars, region, row_type, year, amount_millions, yoy_pct, share_of_national_pct
    FROM collections ${where}
    ORDER BY year, region, particulars
  `);
}
