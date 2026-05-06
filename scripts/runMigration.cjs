const { Pool } = require('pg');
const fs = require('fs');

const url = process.argv[2] || process.env.DATABASE_URL;
if (!url) { console.error('Usage: node runMigration.cjs <DATABASE_URL>'); process.exit(1); }

const pool = new Pool({ connectionString: url });

async function run() {
  // Check existing tables
  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  console.log('Existing tables:', tables.rows.map(r => r.table_name));

  // Run full schema (creates tables IF NOT EXISTS style — uses CREATE TABLE which will skip if exists)
  const schema = fs.readFileSync('./prisma/schema.sql', 'utf8');
  // Split by semicolons and run each statement, skip failures for already-existing objects
  const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
  
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log('  (skipped - already exists)');
      } else {
        console.log('  Statement error:', e.message.substring(0, 100));
      }
    }
  }
  console.log('Schema applied!');

  // Verify
  const after = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  console.log('Tables after:', after.rows.map(r => r.table_name));

  // Check feeds columns
  const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='feeds' ORDER BY ordinal_position");
  console.log('Feeds columns:', cols.rows.map(r => r.column_name));

  await pool.end();
}

run().catch(e => { console.error('Error:', e.message); pool.end(); process.exit(1); });
