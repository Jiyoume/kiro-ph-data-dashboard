/**
 * scripts/ingest.mjs
 *
 * Node.js ingestion script for the BIR PSCG Annual Collection dataset.
 * Reads the raw xlsx, applies all PRD transform rules, and writes:
 *
 *   public/pscg_clean.parquet   — long-format cleaned dataset (used by dashboard)
 *   public/pscg_clean.json      — same data as JSON (fallback / inspection)
 *   scripts/ingest_summary.json — data quality report
 *
 * Usage:
 *   node scripts/ingest.mjs [path/to/file.xlsx]
 *
 * If no path is supplied, defaults to the copy in public/pscg.xlsx.
 */

import duckdb from 'duckdb';
import { writeFileSync, existsSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Config ────────────────────────────────────────────────────
const DEFAULT_SOURCE = resolve(ROOT, 'public', 'pscg.xlsx');
const PARQUET_OUT    = resolve(ROOT, 'public', 'pscg_clean.parquet');
const PARQUET_TMP    = resolve(tmpdir(), 'pscg_clean.tmp.parquet'); // OS temp — outside Vite watch
const JSON_OUT       = resolve(ROOT, 'public', 'pscg_clean.json');
const SUMMARY_OUT    = resolve(__dirname, 'ingest_summary.json');

const YEARS = Array.from({ length: 20 }, (_, i) => 2005 + i); // 2005–2024

// ── Transform rules (mirrored from src/loader.js) ─────────────

const FOOTNOTE_RE = /\s+\d{1,2}\/\s*$/;

const REGION_NAMES = new Set([
  'National Capital Region (NCR)',
  'Cordillera Administrative Region (CAR)',
  'Region I (Ilocos Region)',
  'Region II (Cagayan Valley)',
  'Region III (Central Luzon)',
  'Region IV-A (CALABARZON)',
  'Region IV-B (MIMAROPA)',
  'Region V (Bicol Region)',
  'Region VI (Western Visayas)',
  'Region VII (Central Visayas)',
  'Region VIII (Eastern Visayas)',
  'Region IX (Zamboanga Peninsula)',
  'Region X (Northern Mindanao)',
  'Region XI (Davao Region)',
  'Region XII (SOCCSKSARGEN)',
  'Region XIII (Caraga)',
  'Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)',
  'Large Taxpayers Service',
]);

const SUMMARY_NAMES = new Set([
  'Total BIR Operations',
  'Total Non-BIR Operations',
  'Total Gross Collection',
  'Tax Refund',
  'Total Collection - Net of Tax Refund',
  'Others',
]);

function cleanName(raw) {
  if (raw === null || raw === undefined) return null;
  return String(raw)
    .replace(FOOTNOTE_RE, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function classifyRow(name) {
  if (!name) return 'blank';
  if (SUMMARY_NAMES.has(name)) return 'summary';
  if (REGION_NAMES.has(name)) return 'region';
  if (/^(Region\s+(I|V|X)|Cordillera|National Capital|Bangsamoro|Large Taxpayer)/i.test(name)) return 'region';
  return 'province_city';
}

function toNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// ── DuckDB promise wrapper ────────────────────────────────────
function makeDB(path = ':memory:') {
  const db = new duckdb.Database(path);
  const conn = db.connect();
  const query = (sql) =>
    new Promise((resolve, reject) =>
      conn.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)))
    );
  const run = (sql) =>
    new Promise((resolve, reject) =>
      conn.run(sql, (err) => (err ? reject(err) : resolve()))
    );
  const close = () =>
    new Promise((res) => { conn.close(); db.close(res); });
  return { query, run, close, conn, db };
}

// ── Logging ───────────────────────────────────────────────────
const log  = (msg) => console.log(`  ${msg}`);
const ok   = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.warn(`  ⚠  ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exit(1); };

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  const sourcePath = process.argv[2]
    ? resolve(process.argv[2])
    : DEFAULT_SOURCE;

  console.log('\n━━━ BIR PSCG Ingestion Script ━━━');
  log(`Source : ${sourcePath}`);
  log(`Parquet: ${PARQUET_OUT}`);
  log(`JSON   : ${JSON_OUT}`);

  if (!existsSync(sourcePath)) {
    fail(`Source file not found: ${sourcePath}`);
  }

  const { query, run, close } = makeDB();
  const report = {
    source: sourcePath,
    runAt: new Date().toISOString(),
    rawRowCount: 0,
    droppedRows: { blank: 0, footnote: 0, noData: 0, duplicate: 0 },
    cleanedRowCount: 0,
    longFormatRowCount: 0,
    rowTypeCounts: {},
    regionCount: 0,
    yearRange: [2005, 2024],
    nullAmounts: 0,
    zeroAmounts: 0,
    warnings: [],
  };

  // ── Step 1: Load raw xlsx ──────────────────────────────────
  console.log('\n[1/6] Loading raw xlsx via DuckDB spatial…');
  await query(`INSTALL spatial`).catch(() => {});
  await query(`LOAD spatial`);

  // Escape backslashes for DuckDB SQL string
  const safeSource = sourcePath.replace(/\\/g, '/');
  await run(`CREATE TABLE raw AS SELECT * FROM st_read('${safeSource}')`);

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM raw`);
  report.rawRowCount = Number(total);
  ok(`${report.rawRowCount} raw rows loaded`);

  // ── Step 2: Detect exact duplicates ───────────────────────
  console.log('\n[2/6] Checking for duplicates…');
  const schema = await query(`DESCRIBE raw`);
  const cols = schema.map(c => `"${c.column_name}"`).join(', ');
  const [{ dupes }] = await query(`
    SELECT COUNT(*) AS dupes FROM (
      SELECT ${cols}, COUNT(*) AS n FROM raw GROUP BY ${cols} HAVING n > 1
    )
  `);
  report.droppedRows.duplicate = Number(dupes);
  if (Number(dupes) > 0) {
    warn(`${dupes} exact duplicate row(s) found — will be dropped`);
    report.warnings.push(`${dupes} exact duplicate rows removed`);
  } else {
    ok('No exact duplicates');
  }

  // ── Step 3: Pull rows into JS for structural cleaning ──────
  console.log('\n[3/6] Applying transform rules…');
  // Add a stable row number BEFORE deduplication so source order is preserved
  await run(`CREATE TABLE raw_rn AS SELECT ROW_NUMBER() OVER () AS _rn, * FROM raw`);
  // Deduplicate: keep the first occurrence of each duplicate by keeping min(_rn) per group
  await run(`
    CREATE TABLE raw_deduped AS
    SELECT r.* FROM raw_rn r
    INNER JOIN (
      SELECT ${cols}, MIN(_rn) AS keep_rn FROM raw_rn GROUP BY ${cols}
    ) d ON r._rn = d.keep_rn
    ORDER BY r._rn
  `);
  const rawRows = await query(`SELECT * FROM raw_deduped ORDER BY _rn`);
  const yearFieldMap = YEARS.map((yr, i) => ({ year: yr, field: `Field${i + 2}` }));

  // Find header row
  const headerIdx = rawRows.findIndex(
    r => r.Field1 && String(r.Field1).trim().toUpperCase() === 'PARTICULARS'
  );
  if (headerIdx === -1) fail('Could not locate PARTICULARS header row — file structure may have changed');
  ok(`Header row found at index ${headerIdx}`);

  const dataRows = rawRows.slice(headerIdx + 1);
  const cleaned  = [];
  let currentRegion = null;
  let dropBlank = 0, dropFootnote = 0, dropNoData = 0;

  for (const row of dataRows) {
    const name = cleanName(row.Field1);

    // Rule: drop blanks
    if (!name) { dropBlank++; continue; }

    // Rule: drop footnote / source / notes lines
    if (/^(\*|Source|Notes:|\d{1,2}\/)/.test(name)) { dropFootnote++; continue; }

    // Rule: drop rows with no numeric data in any year column
    const hasNumbers = yearFieldMap.some(({ field }) => toNumber(row[field]) !== null);
    if (!hasNumbers) { dropNoData++; continue; }

    const rowType = classifyRow(name);
    if (rowType === 'region') currentRegion = name;

    // Warn about province rows that appear before any region row
    if (rowType === 'province_city' && !currentRegion) {
      warn(`Province row "${name}" has no parent region — region will be null`);
      report.warnings.push(`Province "${name}" appeared before any region row`);
    }

    // Unpivot: one record per year
    for (const { year, field } of yearFieldMap) {
      const amount = toNumber(row[field]);
      cleaned.push({
        particulars:    name,
        region:         rowType === 'region'   ? name
                      : rowType === 'summary'  ? 'SUMMARY'
                      : currentRegion,
        row_type:       rowType,
        year,
        amount_millions: amount,
      });
    }
  }

  report.droppedRows.blank    = dropBlank;
  report.droppedRows.footnote = dropFootnote;
  report.droppedRows.noData   = dropNoData;
  report.cleanedRowCount      = cleaned.length / YEARS.length; // wide rows
  report.longFormatRowCount   = cleaned.length;
  report.nullAmounts          = cleaned.filter(r => r.amount_millions === null).length;
  report.zeroAmounts          = cleaned.filter(r => r.amount_millions === 0).length;

  ok(`${report.cleanedRowCount} wide rows → ${report.longFormatRowCount} long-format records`);
  ok(`Dropped: ${dropBlank} blank, ${dropFootnote} footnote, ${dropNoData} no-data rows`);
  if (report.nullAmounts) warn(`${report.nullAmounts} NULL amount values`);
  if (report.zeroAmounts) warn(`${report.zeroAmounts} zero amount values (reported zeros, not missing)`);

  // ── Step 4: Load cleaned data into DuckDB ─────────────────
  console.log('\n[4/6] Loading cleaned data into DuckDB…');
  await run(`
    CREATE TABLE collections (
      particulars     VARCHAR,
      region          VARCHAR,
      row_type        VARCHAR,
      year            INTEGER,
      amount_millions DOUBLE
    )
  `);

  const BATCH = 500;
  for (let i = 0; i < cleaned.length; i += BATCH) {
    const batch = cleaned.slice(i, i + BATCH);
    const values = batch.map(r =>
      `('${r.particulars.replace(/'/g, "''")}', ` +
      `${r.region ? `'${r.region.replace(/'/g, "''")}'` : 'NULL'}, ` +
      `'${r.row_type}', ` +
      `${r.year}, ` +
      `${r.amount_millions === null ? 'NULL' : r.amount_millions})`
    ).join(', ');
    await run(`INSERT INTO collections VALUES ${values}`);
  }
  ok(`Inserted ${cleaned.length} rows into collections table`);

  // ── Step 5: Build enriched view + validate ─────────────────
  console.log('\n[5/6] Building enriched view & validating…');
  await run(`
    CREATE VIEW collections_enriched AS
    WITH national AS (
      SELECT year, amount_millions AS national_total
      FROM collections
      WHERE particulars = 'Total Collection - Net of Tax Refund'
    ),
    with_prev AS (
      SELECT
        c.*,
        LAG(c.amount_millions) OVER (
          PARTITION BY c.particulars ORDER BY c.year
        ) AS prev_amount
      FROM collections c
    )
    SELECT
      w.*,
      n.national_total,
      CASE
        WHEN w.prev_amount IS NULL OR w.prev_amount = 0 THEN NULL
        ELSE ROUND(((w.amount_millions - w.prev_amount) / w.prev_amount) * 100, 2)
      END AS yoy_pct,
      CASE
        WHEN n.national_total IS NULL OR n.national_total = 0 THEN NULL
        ELSE ROUND((w.amount_millions / n.national_total) * 100, 4)
      END AS share_of_national_pct,
      (w.year IN (2020, 2021)) AS is_covid_year,
      (w.region = 'National Capital Region (NCR)') AS is_ncr
    FROM with_prev w
    LEFT JOIN national n ON w.year = n.year
  `);

  // Row type summary
  const typeCounts = await query(`
    SELECT row_type, COUNT(DISTINCT particulars) AS entities, COUNT(*) AS records
    FROM collections GROUP BY row_type ORDER BY row_type
  `);
  for (const row of typeCounts) {
    report.rowTypeCounts[row.row_type] = { entities: Number(row.entities), records: Number(row.records) };
    ok(`  ${row.row_type.padEnd(14)} — ${row.entities} entities × ${YEARS.length} years = ${row.records} records`);
  }

  // Region count
  const [{ regionCount }] = await query(`
    SELECT COUNT(DISTINCT region) AS regionCount
    FROM collections WHERE row_type = 'province_city'
  `);
  report.regionCount = Number(regionCount);
  ok(`${regionCount} distinct regions assigned to province/city rows`);

  // Spot-check: 2024 national net collection
  const [spot] = await query(`
    SELECT amount_millions FROM collections
    WHERE particulars = 'Total Collection - Net of Tax Refund' AND year = 2024
  `);
  if (spot) ok(`2024 Net Collection = ₱${Number(spot.amount_millions).toLocaleString()}M (spot check)`);
  else { warn('2024 Net Collection row not found — check transform rules'); report.warnings.push('2024 Net Collection missing'); }

  // ── Step 6: Write outputs ──────────────────────────────────
  console.log('\n[6/6] Writing outputs…');

  // Parquet — write to scripts/ first, then move to public/ atomically
  // (avoids crashing Vite's file watcher with a partial write inside public/)
  await run(`COPY (SELECT * FROM collections_enriched ORDER BY row_type, particulars, year)
             TO '${PARQUET_TMP.replace(/\\/g, '/')}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  if (existsSync(PARQUET_OUT)) unlinkSync(PARQUET_OUT);
  renameSync(PARQUET_TMP, PARQUET_OUT);
  ok(`Parquet written: ${PARQUET_OUT}`);

  // JSON — same data (for fallback / browser use without DuckDB)
  const allRows = await query(`SELECT * FROM collections_enriched ORDER BY row_type, particulars, year`);
  writeFileSync(JSON_OUT, JSON.stringify(allRows, null, 2), 'utf8');
  ok(`JSON written: ${JSON_OUT} (${allRows.length} records)`);

  // Summary report
  writeFileSync(SUMMARY_OUT, JSON.stringify(report, null, 2), 'utf8');
  ok(`Summary written: ${SUMMARY_OUT}`);

  await close();

  console.log('\n━━━ Ingestion complete ━━━\n');
  console.log(`  Records written : ${report.longFormatRowCount}`);
  console.log(`  Warnings        : ${report.warnings.length}`);
  if (report.warnings.length) report.warnings.forEach(w => console.log(`    • ${w}`));
  console.log();
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
