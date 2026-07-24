import duckdb from 'duckdb';

const db = new duckdb.Database(':memory:');
const conn = db.connect();
const file = 'C:/Users/John Gio Arciaga/Downloads/20250331_Auunual_Collection_PSCG_2005_2024 (U).xlsx';

function query(sql) {
  return new Promise((resolve, reject) => {
    conn.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function run() {
  // Install and load spatial extension for xlsx support
  await query(`INSTALL spatial`).catch(() => {});
  await query(`LOAD spatial`);

  // Load the file
  await query(`CREATE TABLE raw AS SELECT * FROM st_read('${file}')`);

  // 1. Schema
  const schema = await query(`DESCRIBE raw`);
  console.log('\n=== SCHEMA ===');
  schema.forEach(c => console.log(`  ${c.column_name} | ${c.column_type}`));

  // 2. Row count
  const count = await query(`SELECT COUNT(*) AS total FROM raw`);
  console.log('\n=== ROW COUNT ===', count[0].total);

  // 3. Sample rows
  const sample = await query(`SELECT * FROM raw LIMIT 3`);
  console.log('\n=== SAMPLE ROWS ===');
  sample.forEach(r => console.log(JSON.stringify(r)));

  // 4. Duplicate check (all columns)
  const cols = schema.map(c => `"${c.column_name}"`).join(', ');
  const dupes = await query(`
    SELECT COUNT(*) AS dupes FROM (
      SELECT ${cols}, COUNT(*) AS n FROM raw GROUP BY ${cols} HAVING n > 1
    )
  `);
  console.log('\n=== DUPLICATES (exact rows) ===', dupes[0].dupes);

  // 5. Null counts per column
  console.log('\n=== NULL COUNTS PER COLUMN ===');
  for (const c of schema) {
    const name = c.column_name;
    const res = await query(`SELECT COUNT(*) AS nulls FROM raw WHERE "${name}" IS NULL`);
    if (res[0].nulls > 0) console.log(`  ${name}: ${res[0].nulls} nulls`);
  }

  // 6. Distinct values for low-cardinality columns (potential categoricals)
  console.log('\n=== DISTINCT VALUE COUNTS ===');
  for (const c of schema) {
    const name = c.column_name;
    const res = await query(`SELECT COUNT(DISTINCT "${name}") AS d FROM raw`);
    console.log(`  ${name}: ${res[0].d} distinct`);
  }

  conn.close();
  db.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
