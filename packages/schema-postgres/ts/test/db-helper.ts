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

export async function createTestDb(label: string): Promise<TestDb> {
  const dbName = `paykit_test_${label}_${process.pid}_${randomBytes(4).toString('hex')}`;
  execFileSync('createdb', ['-h', '127.0.0.1', dbName]);
  const pool = new Pool({ host: '127.0.0.1', database: dbName });
  await migrate({ pool, modules: ALL_MODULES });
  return { dbName, pool };
}

export async function dropTestDb(db: TestDb): Promise<void> {
  await db.pool.end();
  execFileSync('dropdb', ['-h', '127.0.0.1', db.dbName]);
}
