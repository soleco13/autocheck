import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 40,                   // was 20; raised to handle 5 workers × 5 AI concurrent + overhead
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 3_000,
});

db.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

export async function testConnection(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected');
  } finally {
    client.release();
  }
}
