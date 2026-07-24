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
  await query(`LOAD spatial`);
  await query(`CREATE TABLE raw AS SELECT * FROM st_read('${file}')`);

  // Print ALL rows to understand the actual layout
  const all = await query(`SELECT * FROM raw`);
  console.log(`\nTotal rows: ${all.length}`);
  console.log('\n=== ALL ROWS ===');
  all.forEach((r, i) => {
    // Only print rows that have non-null values (skip fully empty rows)
    const vals = Object.values(r).filter(v => v !== null && v !== '');
    if (vals.length > 0) {
      console.log(`\nRow ${i + 1}:`);
      Object.entries(r).forEach(([k, v]) => {
        if (v !== null && v !== '') console.log(`  ${k}: ${v}`);
      });
    }
  });

  conn.close();
  db.close();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
