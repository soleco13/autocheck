import fs from 'fs';
import path from 'path';
import { db } from './index';
import dotenv from 'dotenv';

dotenv.config();

async function migrate() {
  console.log('Running migrations...');

  const migrationsDir = path.join(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // Postgres "already exists" error classes — safe to skip on re-run since this
  // runner has no per-migration tracking table and re-applies every file each time.
  const ALREADY_EXISTS = new Set([
    '42P07', // duplicate_table
    '42710', // duplicate_object (constraint, index)
    '42701', // duplicate_column
    '42723', // duplicate_function
    '42P06', // duplicate_schema
  ]);

  for (const file of files) {
    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      await db.query(sql);
      console.log(`✅ ${file} done`);
    } catch (err: any) {
      if (ALREADY_EXISTS.has(err?.code)) {
        console.log(`↪︎ ${file} already applied (${err.code}), skipping`);
        continue;
      }
      console.error(`❌ ${file} failed:`, err);
      throw err;
    }
  }

  console.log('All migrations complete');
  await db.end();
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
