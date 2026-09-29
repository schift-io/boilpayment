import { describe, it, expect } from 'vitest';
import { toPaykitConfig } from '../src/wizard-state.js';
import { emptyConfig, readConfig, writeConfig } from '../src/config.js';
import type { WizardConfig } from '../src/wizard-state.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('toPaykitConfig', () => {
  it('strips csApiKey (secret — never written to paykit.config.json)', () => {
    const wc: WizardConfig = { ...emptyConfig(), csApiKey: 'pk_live_super_secret' };
    const out = toPaykitConfig(wc);
    expect(out).not.toHaveProperty('csApiKey');
    expect(JSON.stringify(out)).not.toContain('pk_live_super_secret');
  });

  it('strips the other transient wizard-only flags (trialEnabled, refundAdvanced)', () => {
    const wc: WizardConfig = { ...emptyConfig(), trialEnabled: true, refundAdvanced: true, csApiKey: 'x' };
    const out = toPaykitConfig(wc);
    expect(out).not.toHaveProperty('trialEnabled');
    expect(out).not.toHaveProperty('refundAdvanced');
  });

  it('keeps every real PaykitConfig field intact', () => {
    const wc: WizardConfig = { ...emptyConfig(), csApiKey: 'x', providers: ['stripe'], models: ['subscription'] };
    const out = toPaykitConfig(wc);
    expect(out.providers).toEqual(['stripe']);
    expect(out.models).toEqual(['subscription']);
    expect(out.version).toBe(1);
    expect(out.policy).toBeDefined();
  });
});

describe('0.3.0 config defaults', () => {
  it('adds checkout hold and affiliate defaults to new configs', () => {
    // Given / When
    const config = emptyConfig();

    // Then
    expect(config.checkout.registrationHoldHours).toBe(24);
    expect(config.affiliate).toEqual({
      commission: { type: 'rate', rate: 0 },
      renewals: 'first_only',
    });
  });

  it('fills the defaults when reading a pre-0.3.0 config', async () => {
    // Given
    const dir = await mkdtemp(path.join(os.tmpdir(), 'boilpayment-config-'));
    const legacy = emptyConfig();
    const serialized = { ...legacy, checkout: undefined, affiliate: undefined };
    await writeConfig(dir, serialized as typeof legacy);

    try {
      // When
      const config = await readConfig(dir);

      // Then
      expect(config?.checkout.registrationHoldHours).toBe(24);
      expect(config?.affiliate.commission).toEqual({ type: 'rate', rate: 0 });
      expect(config?.affiliate.renewals).toBe('first_only');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
