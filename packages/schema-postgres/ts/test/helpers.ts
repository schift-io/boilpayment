// Shared test-DB lifecycle helpers for Phase 6 regression tests. Not a *.test.ts file itself,
// so vitest does not pick it up as a suite.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);

export const PG_HOST = '127.0.0.1';

/** Every DB this suite creates must start with `paykit_test_` (hard constraint from the task). */
export function uniqueDbName(tag: string): string {
  const rand = randomBytes(3).toString('hex');
  return `paykit_test_${tag}_${process.pid}_${Date.now()}_${rand}`;
}

export async function createTestDb(name: string): Promise<void> {
  if (!name.startsWith('paykit_test_')) {
    throw new Error(`refusing to create db outside paykit_test_* namespace: ${name}`);
  }
  await execFileAsync('createdb', ['-h', PG_HOST, name]);
}

export async function dropTestDb(name: string): Promise<void> {
  if (!name.startsWith('paykit_test_')) {
    throw new Error(`refusing to drop db outside paykit_test_* namespace: ${name}`);
  }
  await execFileAsync('dropdb', ['-h', PG_HOST, '--if-exists', name]);
}
