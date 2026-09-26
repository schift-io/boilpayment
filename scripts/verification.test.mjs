import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

for (const status of [0, 1, 5]) {
  test(`pytest wrapper preserves exit ${status}`, () => {
    // Given an isolated pytest executable with a known exit status.
    const root = mkdtempSync(join(tmpdir(), 'paykit-gate-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, '.venv/bin'), { recursive: true });
      copyFileSync('scripts/ci-pytest.sh', join(root, 'scripts/ci-pytest.sh'));
      writeFileSync(join(root, '.venv/bin/pytest'), `#!/bin/sh\nexit ${status}\n`, { mode: 0o755 });
      // When the CI wrapper runs, then no-tests/failure must remain nonzero.
      const result = spawnSync('bash', [join(root, 'scripts/ci-pytest.sh')]);
      assert.equal(result.status, status);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [left, right] of [
  ['currency:USD', 'currency:usd'],
  ['amount:100', 'amount:101'],
  ['at:2026-09-10T12:00:00Z', 'at:2026-09-11T12:00:00Z'],
  ['id:customerA', 'id:customer_a'],
  ['{"id":"customerA:DONE"}', '{"id":"customer_a:done"}'],
  ['{"at":"2026-09-10T12:00:00.000001Z"}', '{"at":"2026-09-10T12:00:00.000002Z"}'],
  ['{"refundRef":"refund_1","amount":100}', '{"amount":100,"refund_ref":"refund_2"}'],
]) {
  test(`parity preserves different values: ${left}`, () => {
    // Given distinct business values, when normalizing, then they remain distinct.
    const normalize = (input) => spawnSync('node', ['scripts/parity-normalize.mjs'], { input, encoding: 'utf8' });
    const a = normalize(left);
    const b = normalize(right);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.notEqual(a.stdout, b.stdout);
  });
}

test('parity compares JSON values regardless of object property order', () => {
  // Given equivalent event data serialized by TS and Python in different key order.
  const normalize = (input) => spawnSync('node', ['scripts/parity-normalize.mjs'], { input, encoding: 'utf8' });
  // When normalized, then key aliases/order alone have no business meaning.
  const left = normalize('{"refundRef":"refund_1","amount":{"amountMinor":100,"currency":"KRW"}}');
  const right = normalize('{"amount":{"currency":"KRW","amount_minor":100},"refund_ref":"refund_1"}');
  assert.equal(left.status, 0);
  assert.equal(right.status, 0);
  assert.equal(left.stdout, right.stdout);
});

for (const [providers, dryRun, expected] of [
  [[], false, 1],
  [[], true, 0],
  [['unknown'], false, 1],
  [['stripe'], false, 1],
  [['stripe'], true, 0],
]) {
  test(`Python live: providers ${providers}, dry-run ${dryRun}`, () => {
    // Given a temp config and no inherited credentials, no provider call is possible.
    const root = mkdtempSync(join(tmpdir(), 'paykit-live-gate-'));
    try {
      writeFileSync(join(root, 'paykit.config.json'), JSON.stringify({ providers }));
      // When invoked, then absent coverage fails unless explicitly previewing a dry-run.
      const result = spawnSync(resolve('.venv/bin/python'), [
        'examples/live/real_round_trip.py', '--out', root, ...(dryRun ? ['--dry-run'] : []),
      ], { env: {}, encoding: 'utf8' });
      assert.equal(result.status, expected, result.stdout + result.stderr);
      assert.match(result.stdout, /paykit live/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [output, status, expected] of [
  ['MOCK ROUND TRIP OK', 0, 0],
  ['MOCK ROUND TRIP OK', 2, 1],
  ['not a success', 0, 1],
  ['NOT ROUND TRIP OKAY', 0, 1],
]) {
  test(`round-trip gate: ${JSON.stringify(output)}, exit ${status}`, () => {
    // Given a child command with independent output and exit status.
    const command = 'source scripts/live.sh; run fixture bash -c \'printf "%s\\n" "$1"; exit "$2"\' -- "$1" "$2"; exit "$fail"';
    // When checking its result, then both the marker and successful exit are required.
    const result = spawnSync('bash', ['-c', command, '--', output, String(status)]);
    assert.equal(result.status, expected, result.stdout.toString() + result.stderr.toString());
  });
}
