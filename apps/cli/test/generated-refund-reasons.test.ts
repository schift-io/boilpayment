// EC:D16 — generated support.requestRefund takes a refund reason only when a reason rule is set,
// and the generated kit accepts it at runtime in both languages.
import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from '../src/generate/index.js';
import { kitchenSinkConfig } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function env(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim(); const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Z0-9_]+$/.test(key)) out[key] = line.slice(eq + 1).split(' #')[0].trim();
  }
  return out;
}

async function generate(withRules: boolean) {
  const config = kitchenSinkConfig();
  if (withRules) config.policy.refund.reasons = { technicalFailure: 'full', dissatisfied: 'evidence_required', userError: 'deny' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'paykit-reasons-')); dirs.push(dir);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await generateAll(config, dir, { csApiKey: 'pk_live_test' });
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(path.join(ROOT, 'packages/sdk/ts'), path.join(dir, 'node_modules/boilpayment-sdk'), 'dir');
  return { dir, env: env(await fs.readFile(path.join(dir, '.env.example'), 'utf8')) };
}

describe('EC:D16 generated refund reasons', () => {
  it('default rules: the generated support signature and INTEGRATION.md are unchanged', async () => {
    const { dir } = await generate(false);
    expect(await fs.readFile(path.join(dir, 'paykit/index.ts'), 'utf8')).not.toContain("| 'reason'");
    expect(await fs.readFile(path.join(dir, 'paykit/index.py'), 'utf8')).not.toContain('RefundReasonInput');
    expect(await fs.readFile(path.join(dir, 'INTEGRATION.md'), 'utf8')).not.toContain('EC:D16');
  }, 60_000);

  it('rules on: TS and Python kits accept a reason on support.requestRefund', async () => {
    const { dir, env: e } = await generate(true);
    expect(await fs.readFile(path.join(dir, 'INTEGRATION.md'), 'utf8')).toContain('EC:D16');
    await fs.writeFile(path.join(dir, 'harness.ts'), `
import { createPaymentKit } from './paykit/index.js';
import { InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger } from 'boilpayment-sdk/core';
import config from './paykit.config.json' with { type: 'json' };
const clock = new FixedClock(new Date('2026-03-01T00:00:00Z')); const ids = new SequentialIdGen('t');
const kit = createPaymentKit(config, { clock, ids, repo: new InMemoryRepo(), ledger: new InMemoryLedger(ids, clock), logger: new NoopLogger(), env: ${JSON.stringify(e)} });
const c = await kit.support.requestRefund({ customerId: 'cus_x', paymentId: 'nope', requestId: 'r1', reason: { category: 'user_error' } });
console.log(c.status);
`);
    const ts = spawnSync(path.join(ROOT, 'apps/cli/node_modules/.bin/tsx'), ['harness.ts'], { cwd: dir, encoding: 'utf8' });
    expect(ts.status, `${ts.stdout}\n${ts.stderr}`).toBe(0);
    expect(ts.stdout.trim().split('\n').pop()).toBe('rejected');

    await fs.writeFile(path.join(dir, 'harness.py'), `
import asyncio, importlib.util, json
from datetime import datetime, timezone
from boilpayment_core import Deps, InMemoryRepo, InMemoryLedger, FixedClock, SequentialIdGen, NoopLogger
from boilpayment.refund import RefundReasonInput
spec = importlib.util.spec_from_file_location('g', ${JSON.stringify(path.join(dir, 'paykit/index.py'))})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
async def main():
    clock = FixedClock(datetime(2026, 3, 1, tzinfo=timezone.utc)); ids = SequentialIdGen('t')
    config = json.load(open(${JSON.stringify(path.join(dir, 'paykit.config.json'))}))
    kit = mod.create_payment_kit(config, Deps(clock=clock, ids=ids, repo=InMemoryRepo(), ledger=InMemoryLedger(ids, clock), logger=NoopLogger(), notifier=None, providers={}, policy=None), json.loads(${JSON.stringify(JSON.stringify(e))}))
    c = await kit['support']['request_refund'](customer_id='cus_x', payment_id='nope', request_id='r1', reason=RefundReasonInput(category='user_error'))
    print(c.status)
asyncio.run(main())
`);
    const py = spawnSync(path.join(ROOT, '.venv/bin/python'), [path.join(dir, 'harness.py')], { encoding: 'utf8' });
    expect(py.status, `${py.stdout}\n${py.stderr}`).toBe(0);
    expect(py.stdout.trim().split('\n').pop()).toBe('rejected');
  }, 120_000);
});
