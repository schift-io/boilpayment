import { describe, expect, it } from 'vitest';
import { mapTossWebhook } from '../src/index.js';

describe('Toss webhook instants', () => {
  it.each([
    ['2022-05-12T00:00:00.000', '2022-05-11T15:00:00.000Z'],
    ['2022-05-12T00:00:00+09:00', '2022-05-11T15:00:00.000Z'],
    ['2022-05-12T00:00:00Z', '2022-05-12T00:00:00.000Z'],
    ['2022-05-12T00:00:00-04:00', '2022-05-12T04:00:00.000Z'],
  ])('preserves a deterministic instant for %s', (createdAt, expected) => {
    // Given provider time with either an explicit offset or the legacy local format.
    const body = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt, data: { paymentKey: 'payment', status: 'DONE' } };
    // When the webhook is normalized.
    const event = mapTossWebhook(body);
    // Then UTC time is independent of the server timezone and event identity is unchanged.
    expect(event.occurredAt.toISOString()).toBe(expected);
    expect(event.id).toBe(`PAYMENT_STATUS_CHANGED:payment:DONE:${createdAt}`);
  });
});
