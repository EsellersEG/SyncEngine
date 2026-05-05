#!/usr/bin/env node
/**
 * Database initialization script
 * Run: node scripts/initDb.js
 * 
 * This runs the schema.sql file against your DATABASE_URL
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function init() {
  const client = await pool.connect();
  console.log('✅ Connected to database');

  try {
    const schemaPath = path.join(__dirname, '../prisma/schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    
    await client.query(sql);
    console.log('✅ Schema created successfully');
  } catch (err) {
    console.error('❌ Schema error:', err.message);
    // Tables may already exist — that's OK
    if (err.message.includes('already exists')) {
      console.log('ℹ️  Tables already exist, skipping creation');
    } else {
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

init().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
