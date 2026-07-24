import duckdb from 'duckdb';
const db   = new duckdb.Database('data/pscg.db');
const conn = db.connect();
const q    = (sql) => new Promise((res, rej) => conn.all(sql, (e, r) => e ? rej(e) : res(r)));

const s  = await q('DESCRIBE collections');
console.log('=== SCHEMA ===');
s.forEach(r => console.log(r.column_name.padEnd(26), r.column_type.padEnd(12), 'nullable:', r.null));

const rows = await q('SELECT * FROM collections ORDER BY year, particulars LIMIT 5');
console.log('\n=== SAMPLE ROWS ===');
rows.forEach(r => console.log(JSON.stringify(r)));

const rc = await q('SELECT row_type, COUNT(DISTINCT particulars) entities, COUNT(*) records FROM collections GROUP BY row_type ORDER BY row_type');
console.log('\n=== ROW TYPE COUNTS ===');
rc.forEach(r => console.log(JSON.stringify(r)));

const nc = await q(`
  SELECT
    COUNT(*) FILTER(WHERE particulars IS NULL)           AS particulars_null,
    COUNT(*) FILTER(WHERE region IS NULL)                AS region_null,
    COUNT(*) FILTER(WHERE amount_millions IS NULL)       AS amount_null,
    COUNT(*) FILTER(WHERE yoy_pct IS NULL)               AS yoy_null,
    COUNT(*) FILTER(WHERE national_total IS NULL)        AS national_total_null,
    COUNT(*) FILTER(WHERE share_of_national_pct IS NULL) AS share_null,
    COUNT(*) FILTER(WHERE is_covid_year IS NULL)         AS covid_null,
    COUNT(*) FILTER(WHERE is_ncr IS NULL)                AS ncr_null
  FROM collections
`);
console.log('\n=== NULL COUNTS ===');
console.log(JSON.stringify(nc[0], null, 2));

const yr = await q('SELECT MIN(year) y1, MAX(year) y2, COUNT(DISTINCT year) yrs FROM collections');
console.log('\n=== YEAR RANGE ===', JSON.stringify(yr[0]));

const dupes = await q(`
  SELECT particulars, year, COUNT(*) n
  FROM collections
  GROUP BY particulars, year
  HAVING n > 1
  LIMIT 10
`);
console.log('\n=== DUPLICATES (particulars+year) ===', dupes.length ? JSON.stringify(dupes) : 'none');

const zeroAmt = await q(`SELECT COUNT(*) n FROM collections WHERE amount_millions = 0`);
console.log('\n=== ZERO AMOUNTS ===', zeroAmt[0].n);

const views = await q(`SELECT table_name FROM information_schema.tables WHERE table_type='VIEW' ORDER BY table_name`);
console.log('\n=== VIEWS ===', views.map(r => r.table_name).join(', '));

conn.close(); db.close(() => {});
