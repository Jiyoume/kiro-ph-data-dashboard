import duckdb from 'duckdb';
const db = new duckdb.Database(':memory:');
const conn = db.connect();
const q = (sql) => new Promise((res,rej) => conn.all(sql,(e,r)=>e?rej(e):res(r)));
const file = 'C:/Users/John Gio Arciaga/Desktop/kirow6/workshop/cleaned_dataset.parquet';

const schema = await q(`DESCRIBE SELECT * FROM read_parquet('${file}')`);
console.log('=== SCHEMA ===');
schema.forEach(r => console.log(r.column_name.padEnd(20), r.column_type));

const stats = await q(`
  SELECT
    COUNT(*) AS rows,
    COUNT(DISTINCT customer_id) AS unique_customers,
    COUNT(DISTINCT region) AS regions,
    COUNT(DISTINCT segment) AS segments,
    COUNT(DISTINCT status) AS statuses,
    SUM(revenue::DOUBLE) AS total_revenue,
    AVG(revenue::DOUBLE) AS avg_revenue,
    SUM(order_count) AS total_orders,
    MIN(signup_date) AS earliest,
    MAX(signup_date) AS latest
  FROM read_parquet('${file}')
`);
console.log('\n=== STATS ===');
const s = stats[0];
Object.entries(s).forEach(([k,v]) => console.log(`  ${k.padEnd(20)} ${typeof v === 'bigint' ? Number(v) : v}`));

const regions = await q(`
  SELECT region, COUNT(*) n, SUM(revenue::DOUBLE)::DECIMAL(15,2) rev
  FROM read_parquet('${file}') GROUP BY region ORDER BY rev DESC
`);
console.log('\n=== REVENUE BY REGION ===');
regions.forEach(r => console.log(`  ${(r.region||'NULL').padEnd(16)} n=${r.n}  rev=₱${Number(r.rev).toLocaleString()}`));

const segments = await q(`
  SELECT segment, COUNT(*) n, SUM(revenue::DOUBLE)::DECIMAL(15,2) rev
  FROM read_parquet('${file}') GROUP BY segment ORDER BY rev DESC
`);
console.log('\n=== REVENUE BY SEGMENT ===');
segments.forEach(r => console.log(`  ${(r.segment||'NULL').padEnd(12)} n=${r.n}  rev=₱${Number(r.rev).toLocaleString()}`));

const top5 = await q(`
  SELECT customer_id, full_name, region, segment, revenue, order_count
  FROM read_parquet('${file}') ORDER BY revenue DESC LIMIT 5
`);
console.log('\n=== TOP 5 CUSTOMERS BY REVENUE ===');
top5.forEach(r => console.log(`  ${r.customer_id} ${r.full_name?.padEnd(18)} ${r.region?.padEnd(14)} ₱${Number(r.revenue).toLocaleString()}`));

conn.close(); db.close(()=>{});
