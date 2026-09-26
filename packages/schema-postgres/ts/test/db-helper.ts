// Shared test-only helper: creates/drops a throwaway `paykit_test_*` database per test file and
// applies the full migration set. Never touches any database outside that naming pattern.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../dist/index.js';

export interface TestDb {
  dbName: string;
  pool: Pool;
}

const ALL_MODULES = ['core', 'credits', 'usage', 'webhook', 'refund', 'cs'];

export async function createTestDb(label: string, modules: string[] = ALL_MODULES): Promise<TestDb> {
  const dbName = `paykit_test_${label}_${process.pid}_${randomBytes(4).toString('hex')}`;
  execFileSync('createdb', ['-h', '127.0.0.1', dbName]);
  const pool = new Pool({ host: '127.0.0.1', database: dbName });
  try {
    await migrate({ pool, modules });
  } catch (err) {
    // A failed setup must not leave the database behind (afterAll never sees it).
    await dropTestDb({ dbName, pool });
    throw err;
  }
  return { dbName, pool };
}

export async function dropTestDb(db: TestDb): Promise<void> {
  try {
    await db.pool.end();
  } finally {
    execFileSync('dropdb', ['-h', '127.0.0.1', '--if-exists', db.dbName]);
  }
}
