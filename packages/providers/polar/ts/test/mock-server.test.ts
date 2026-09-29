import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const port = 32_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const auth = { Authorization: 'Bearer polar_oat_test_provider' } as const;
let mock: ChildProcessWithoutNullStreams;
let blockedReason: string | null = null;

async function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

async function jsonRequest(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await request(path, init);
  expect(response.ok).toBe(true);
  return response.json() as Promise<Record<string, unknown>>;
}

beforeAll(async () => {
  const serverPath = fileURLToPath(new URL('../../../../../tools/mocks/polar/server.mjs', import.meta.url));
  mock = spawn(process.execPath, [serverPath], {
    env: { ...process.env, POLAR_MOCK_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    let stderr = '';
    mock.once('error', reject);
    mock.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('polar mock listening')) {
        ready = true;
        resolve();
      }
    });
    mock.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    mock.once('exit', (code) => {
      if (ready) return;
      if (stderr.includes('listen EPERM')) {
        blockedReason = stderr;
        resolve();
        return;
      }
      reject(new Error(`polar mock exited before ready (${code}): ${stderr}`));
    });
  });
});

afterAll(() => {
  if (mock.exitCode === null) mock.kill('SIGTERM');
});

describe('Polar mock discounts and checkout links', () => {
  it('[DC-01][AF-01] propagates a preset discount and affiliate metadata to the order and subscription', async ({ skip }) => {
    if (blockedReason) skip();
    const customer = await jsonRequest('/v1/customers/', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'discount@example.com' }),
    });
    const checkout = await jsonRequest('/v1/checkouts/', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ products: ['prod_sub_basic'], customer_id: customer.id, discount_id: 'discount_20pct', allow_discount_codes: true, metadata: { affiliateId: 'affiliate_alpha' } }),
    });
    const order = await jsonRequest(`/v1/orders/${checkout._mock_order_id as string}`, { headers: auth });
    const subscription = await jsonRequest(`/v1/subscriptions/${checkout._mock_subscription_id as string}`, { headers: auth });

    expect(order).toMatchObject({ subtotal_amount: 2900, discount_amount: 580, net_amount: 2320, total_amount: 2320, discount_id: 'discount_20pct', metadata: { affiliateId: 'affiliate_alpha' } });
    expect(subscription).toMatchObject({ discount_id: 'discount_20pct', metadata: { affiliateId: 'affiliate_alpha' } });
  });

  it('[PL-01][PL-02] copies reference_id and utm_* through link checkout metadata to its order and subscription', async ({ skip }) => {
    if (blockedReason) skip();
    const completed = await jsonRequest('/__mock/link/prod_sub_basic?reference_id=customer_42&discount_code=LESS500&utm_source=partner&utm_campaign=launch');

    expect(completed.order).toMatchObject({
      checkout_link_id: 'link_prod_sub_basic',
      subtotal_amount: 2900,
      discount_amount: 500,
      total_amount: 2400,
      metadata: { reference_id: 'customer_42', utm_source: 'partner', utm_campaign: 'launch' },
    });
    expect(completed.subscription).toMatchObject({ metadata: { reference_id: 'customer_42', utm_source: 'partner', utm_campaign: 'launch' } });
  });

  it('[DC-05] emits discounted renewals followed by the first full-price renewal', async ({ skip }) => {
    if (blockedReason) skip();
    const customer = await jsonRequest('/v1/customers/', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'renew@example.com' }),
    });
    const checkout = await jsonRequest('/v1/checkouts/', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ products: ['prod_sub_basic'], customer_id: customer.id, discount_id: 'discount_20pct' }),
    });
    const renewalAmounts: number[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const renewal = await jsonRequest('/__mock/renew', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription_id: checkout._mock_subscription_id }),
      });
      const order = await jsonRequest(`/v1/orders/${renewal.order_id as string}`, { headers: auth });
      renewalAmounts.push(order.total_amount as number);
    }

    expect(renewalAmounts).toEqual([2320, 2320, 2900]);
  });

  it('[DC-06] refuses an exhausted code without creating a checkout or order', async ({ skip }) => {
    if (blockedReason) skip();
    const before = await jsonRequest('/v1/orders/?limit=100', { headers: auth });
    const response = await request('/__mock/link/prod_onetime_pack?reference_id=customer_42&discount_code=EXHAUSTED');
    const after = await jsonRequest('/v1/orders/?limit=100', { headers: auth });

    expect(response.status).toBe(422);
    expect((after.items as unknown[]).length).toBe((before.items as unknown[]).length);
  });
});
