import { describe, it, expect } from 'vitest';
import { toPaykitConfig } from '../src/wizard-state.js';
import { emptyConfig } from '../src/config.js';
import type { WizardConfig } from '../src/wizard-state.js';

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
