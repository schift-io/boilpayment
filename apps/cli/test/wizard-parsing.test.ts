import { describe, expect, it, vi } from 'vitest';
import { runWizard } from '../src/wizard.js';
import { buildConfig } from './helpers.js';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(async () => '0'),
  isCancel: () => false,
  intro: () => undefined,
  note: () => undefined,
  outro: () => undefined,
}));

describe('wizard numeric policy parsing', () => {
  it('stores no expiry for an interactive zero-day answer just like --yes', async () => {
    // Given a saved setup with only the expiry question unanswered.
    const config = buildConfig({ models: ['topup'], goods: ['credits'] });
    const { topupExpiryDays: _removed, ...credits } = config.policy.credits;
    const existingRaw = { ...config, policy: { ...config.policy, credits } };
    // When the seller enters zero in the interactive prompt.
    const result = await runWizard({ yes: false, existingRaw });
    // Then zero means no expiration, not immediately expired.
    expect(result.policy.credits.topupExpiryDays).toBeNull();
  });
});
