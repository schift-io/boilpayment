import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderName } from 'boilpayment-sdk/core';
import { runLive, stripeCliArgs } from '../src/commands/live.js';
import { writeConfig } from '../src/config.js';
import * as envFile from '../src/util/env-file.js';
import { buildConfig } from './helpers.js';

let directory: string;
const originalExitCode = process.exitCode;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'paykit-live-'));
  process.exitCode = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(envFile, 'loadEnvFile').mockResolvedValue({ found: true, fileVars: {}, merged: {} });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = originalExitCode;
  await rm(directory, { recursive: true, force: true });
});

describe('live verification evidence', () => {
  it('binds Stripe CLI listener and trigger to the selected key', () => {
    const selectedKey = 'sk_test_selected_for_this_run';
    expect(stripeCliArgs(selectedKey, 'listen', '--events', 'payment_intent.succeeded')).toEqual([
      '--api-key', selectedKey, 'listen', '--events', 'payment_intent.succeeded',
    ]);
    expect(stripeCliArgs(selectedKey, 'trigger', 'payment_intent.succeeded')).toEqual([
      '--api-key', selectedKey, 'trigger', 'payment_intent.succeeded',
    ]);
  });

  it.each([[], ['toss'], ['portone'], ['stripe'], ['polar']] satisfies ProviderName[][])(
    'fails when no configured provider runs: %j', async (...providers) => {
      // Given a generated config without provider credentials.
      await writeConfig(directory, buildConfig({ providers }));
      // When verification runs without dry-run.
      await runLive(directory, { positional: [], flags: {} });
      // Then missing evidence is not success.
      expect(process.exitCode).toBe(1);
    },
  );

  it('allows an explicit dry-run with no credentials', async () => {
    // Given a configured provider without keys.
    await writeConfig(directory, buildConfig({ providers: ['toss'] }));
    // When the operator explicitly requests a preview.
    await runLive(directory, { positional: [], flags: { 'dry-run': true } });
    // Then no network evidence is required.
    expect(process.exitCode).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  const probes = [
    { provider: 'toss', step: 'getPayment(unknown key)', code: 'NOT_FOUND_PAYMENT' },
    { provider: 'toss', step: 'billing/authorizations/issue(bogus authKey)', code: 'NOT_FOUND_BILLING' },
    { provider: 'portone', step: 'getPayment(unknown id)', code: 'PAYMENT_NOT_FOUND' },
    { provider: 'portone', step: 'billing-keys(no real method)', code: 'INVALID_REQUEST' },
  ] as const;
  for (const probe of probes) {
    it.each(['expected', 'unauthorized', 'transport', 'runtime', 'unexpected-success'] as const)(
      `${probe.provider} ${probe.step} classifies %s correctly`, async (response) => {
        // Given HTTP responses from the narrow network boundary, using the real adapter.
        await writeConfig(directory, buildConfig({ providers: [probe.provider] }));
        vi.mocked(envFile.loadEnvFile).mockResolvedValue({ found: true, fileVars: {}, merged: {
          TOSS_SECRET_KEY: 'test_sk_fixture', PORTONE_API_SECRET: 'fixture',
          PORTONE_STORE_ID: 'fixture', PORTONE_WEBHOOK_SECRET: 'fixture',
        } });
        const fetchStub = vi.fn<typeof fetch>();
        if (response === 'transport') fetchStub.mockRejectedValue(new TypeError('connection refused'));
        else if (response === 'runtime') fetchStub.mockRejectedValue(new RangeError('unexpected runtime error'));
        else if (response === 'unexpected-success') fetchStub.mockImplementation(async () => new Response('{}', { status: 200 }));
        else {
          const code = response === 'expected' ? probe.code : 'UNAUTHORIZED';
          fetchStub.mockImplementation(async () => new Response(JSON.stringify({ code, type: code, message: code }), { status: 400 }));
        }
        vi.stubGlobal('fetch', fetchStub);
        // When the live command exercises its negative probes.
        await runLive(directory, { positional: [], flags: {} });
        // Then only the expected provider rejection counts as a passed probe.
        const output = vi.mocked(console.log).mock.calls.flat().map(String).find((line) => line.includes(probe.step));
        expect(output).toBeDefined();
        expect(output).toMatch(response === 'expected' ? /PASS/ : /FAIL/);
      },
    );
  }
});
