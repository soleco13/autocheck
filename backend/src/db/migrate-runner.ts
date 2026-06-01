import fs from 'fs';
import path from 'path';
import { db } from './index';

const ALREADY_EXISTS = new Set(['42P07','42710','42701','42723','42P06']);

export async function runMigrations(): Promise<void> {
  const dir = path.join(__dirname, '../../migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      await db.query(sql);
    } catch (err: any) {
      if (!ALREADY_EXISTS.has(err?.code)) throw err;
    }
  }
}
