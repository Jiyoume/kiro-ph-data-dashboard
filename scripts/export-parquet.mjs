/**
 * scripts/export-parquet.mjs
 *
 * Exports every transformed table from data/pscg.db as a Parquet file
 * into the data/exports/ directory.
 *
 * Files written:
 *   data/exports/collections_clean.parquet    — canonical enriched dataset
 *   data/exports/agg_national_trend.parquet
 *   data/exports/agg_region_year.parquet
 *   data/exports/agg_province_rank.parquet
 *   data/exports/agg_decade.parquet
 *   data/exports/agg_covid_impact.parquet
 *   data/exports/agg_cagr.parquet
 *   data/exports/agg_kpi_by_year.parquet
 *   data/exports/agg_yoy_heatmap.parquet
 *
 * Also copies collections_clean.parquet → public/pscg_clean.parquet
 * so the browser dashboard picks it up without a separate ingest run.
 *
 * Usage:
 *   node scripts/export-parquet.mjs
 *   node scripts/export-parquet.mjs --table collections_clean   # single table
 *   node scripts/export-parquet.mjs --no-public                 # skip public/ copy
 */

import duckdb from 'duckdb';
import { existsSync, mkdirSync, copyFileSync, statSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, '..');
const DB_PATH    = resolve(ROOT, 'data', 'pscg.db');
const EXPORT_DIR = resolve(ROOT, 'data', 'exports');
const PUBLIC_DIR = resolve(ROOT, 'public');

// CLI flags
const args          = process.argv.slice(2);
const SINGLE_TABLE  = args.includes('--table') ? args[args.indexOf('--table') + 1] : null;
const SKIP_PUBLIC   = args.includes('--no-public');

// Tables to export (order: canonical first, then aggregations)
const ALL_TABLES = [
  'collections_clean',
  'agg_national_trend',
  'agg_region_year',
  'agg_province_rank',
  'agg_decade',
  'agg_covid_impact',
  'agg_cagr',
  'agg_kpi_by_year',
  'agg_yoy_heatmap',
];

const TABLES_TO_EXPORT = SINGLE_TABLE ? [SINGLE_TABLE] : ALL_TABLES;

// ── Helpers ───────────────────────────────────────────────────
const ok   = (msg) => console.log(`  ✓  ${msg}`);
const warn = (msg) => console.warn(`  ⚠  ${msg}`);
const fail = (msg) => { console.error(`  ✗  ${msg}`); process.exit(1); };
const step = (msg) => console.log(`\n[•] ${msg}`);

function fmtBytes(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1_024)     return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function makeConn(dbPath) {
  const db   = new duckdb.Database(dbPath);
  const conn = db.connect();
  const run = (sql) =>
    new Promise((res, rej) => conn.run(sql, (e) => e ? rej(e) : res()));
  const query = (sql) =>
    new Promise((res, rej) =>
      conn.all(sql, (e, rows) => e ? rej(e) :
        res(rows.map(r => Object.fromEntries(
          Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
        )))
      )
    );
  const close = () => new Promise((res) => { conn.close(); db.close(res); });
  return { run, query, close };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n━━━ PSCG Parquet Export ━━━');
  console.log(`  Source DB : ${DB_PATH}`);
  console.log(`  Export dir: ${EXPORT_DIR}`);
  console.log(`  Tables    : ${TABLES_TO_EXPORT.join(', ')}`);

  if (!existsSync(DB_PATH)) fail(`DB not found: ${DB_PATH} — run 'npm run ingest:db && npm run transform' first`);

  // Create export directory
  if (!existsSync(EXPORT_DIR)) {
    mkdirSync(EXPORT_DIR, { recursive: true });
    ok(`Created ${EXPORT_DIR}`);
  }

  const { run, query, close } = makeConn(DB_PATH);

  // Verify requested tables exist in DB
  const existing = await query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'main'
  `);
  const existingNames = new Set(existing.map(r => r.table_name));

  for (const t of TABLES_TO_EXPORT) {
    if (!existingNames.has(t)) fail(`Table '${t}' not found in DB — run 'npm run transform' first`);
  }

  // ── Export each table ───────────────────────────────────────
  step('Exporting tables to Parquet (ZSTD compression)…');

  const summary = [];

  for (const table of TABLES_TO_EXPORT) {
    const outPath  = resolve(EXPORT_DIR, `${table}.parquet`);
    const tmpPath  = resolve(tmpdir(), `${table}.tmp.parquet`);
    const safeTmp  = tmpPath.replace(/\\/g, '/');
    const safeOut  = outPath.replace(/\\/g, '/');

    // Get row count before export
    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM ${table}`);

    // Write to OS temp first (avoids Vite watcher lock issues)
    await run(`
      COPY (SELECT * FROM ${table})
      TO '${safeTmp}'
      (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000)
    `);

    // Move from temp → final destination
    if (existsSync(outPath)) {
      try { require('fs').unlinkSync(outPath); } catch (_) {}
    }
    copyFileSync(tmpPath, outPath);

    const size = statSync(outPath).size;
    ok(`${table.padEnd(26)} — ${n.toLocaleString().padStart(6)} rows  ${fmtBytes(size).padStart(10)}  → ${basename(outPath)}`);
    summary.push({ table, rows: n, size, path: outPath });
  }

  // ── Copy canonical file to public/ for browser dashboard ───
  if (!SKIP_PUBLIC) {
    const canonicalOut = resolve(EXPORT_DIR, 'collections_clean.parquet');
    const publicDest   = resolve(PUBLIC_DIR, 'pscg_clean.parquet');

    if (existsSync(canonicalOut)) {
      step('Updating public/pscg_clean.parquet for browser dashboard…');
      copyFileSync(canonicalOut, publicDest);
      const size = statSync(publicDest).size;
      ok(`public/pscg_clean.parquet updated (${fmtBytes(size)})`);
    }
  }

  // ── Verify exported files are readable by DuckDB ───────────
  step('Verifying exported Parquet files…');

  for (const { table, rows, path } of summary) {
    const safePath = path.replace(/\\/g, '/');
    const [{ vn }] = await query(
      `SELECT COUNT(*) AS vn FROM read_parquet('${safePath}')`
    );
    if (vn !== rows) {
      warn(`${table}: wrote ${rows} rows but read back ${vn} — mismatch!`);
    } else {
      ok(`${table.padEnd(26)} — readback verified (${vn.toLocaleString()} rows)`);
    }
  }

  // ── Print schema of collections_clean for reference ────────
  step('Schema of collections_clean.parquet:');
  const cleanPath = resolve(EXPORT_DIR, 'collections_clean.parquet').replace(/\\/g, '/');
  const schema = await query(`DESCRIBE SELECT * FROM read_parquet('${cleanPath}')`);
  schema.forEach(r =>
    console.log(`    ${r.column_name.padEnd(26)} ${r.column_type}`)
  );

  await close();

  // ── Final summary ───────────────────────────────────────────
  const totalRows  = summary.reduce((s, r) => s + r.rows, 0);
  const totalBytes = summary.reduce((s, r) => s + r.size, 0);

  console.log('\n━━━ Export complete ━━━');
  console.log(`  Files   : ${summary.length}`);
  console.log(`  Dir     : ${EXPORT_DIR}`);
  console.log(`  Total   : ${totalRows.toLocaleString()} rows across all files`);
  console.log(`  Size    : ${fmtBytes(totalBytes)} on disk`);
  if (!SKIP_PUBLIC) {
    console.log(`  Browser : public/pscg_clean.parquet updated`);
  }
  console.log();
}

main().catch(err => {
  console.error('\n✗ Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
