import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(PACKAGE_ROOT, 'dist');
const SUBPATHS = [
  'core', 'credits', 'lifecycle', 'refund', 'usage', 'webhook', 'notify',
  'cs', 'postgres', 'stripe', 'toss', 'portone', 'polar',
] as const;
const INTERNAL_SPECIFIER = /(?:boilpayment-(?:core|credits|lifecycle|refund|usage|webhook|notify|cs|schema-postgres|stripe|toss|portone|polar))(?:\/[^'"\s]*)?/;

async function filesBelow(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(file) : Promise.resolve([file]);
  }));
  return nested.flat();
}

describe('published SDK bundle', () => {
  it('contains each public entry point without bare internal specifiers', async () => {
    // Given: the SDK has been built for publication.
    const entrypoints = ['index', ...SUBPATHS].flatMap((name) => [
      path.join(DIST, `${name}.js`),
      path.join(DIST, `${name}.d.ts`),
    ]);

    // When: every shipped JavaScript and declaration file is inspected.
    const shipped = (await filesBelow(DIST)).filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'));
    const missing = await Promise.all(entrypoints.map(async (file) => fs.access(file).then(() => null, () => file)));
    const offenders = await Promise.all(shipped.map(async (file) => (
      INTERNAL_SPECIFIER.test(await fs.readFile(file, 'utf8')) ? file : null
    )));

    // Then: all entry points exist and every internal edge stays inside this tarball.
    expect(missing.filter((file) => file !== null)).toEqual([]);
    expect(offenders.filter((file) => file !== null)).toEqual([]);
  });

  it('ships the Postgres migrations beside the bundled loader', async () => {
    // Given: schema-postgres owns the runtime SQL source of truth.
    const source = await fs.readdir(path.resolve(PACKAGE_ROOT, '../../schema-postgres/sql'));

    // When: the bundled Postgres assets are listed.
    const bundled = await fs.readdir(path.join(DIST, 'internal/postgres/sql'));

    // Then: every SQL migration is present in the SDK.
    expect(bundled.filter((file) => file.endsWith('.sql')).sort()).toEqual(
      source.filter((file) => file.endsWith('.sql')).sort(),
    );
  });
});
