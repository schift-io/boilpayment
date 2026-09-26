// Phase 6 regression tests — slack/resend/smtp adapters, with a fake transport injected so no
// real network call is ever attempted. slack() and resend() take an explicit `fetchImpl`
// override in their config (the DI seam the source already exposes — see ts/src/slack.ts and
// ts/src/resend.ts). smtp() has no such seam: it calls `nodemailer.createTransport(...)`
// directly in ts/src/smtp.ts, so this file mocks the `nodemailer` module itself via vi.mock for
// the duration of the smtp describe block.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from 'boilpayment-core';
import { resend, slack } from '../src/index.js';

const notification: Notification = { type: 'usage.soft_cap', customerId: 'cust_1', payload: { meter: 'api_call', overage: 2, included: 5 } };

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({}), { status });
}

describe('notify: slack adapter', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('notify: slack adapter builds POST to webhookUrl with *subject*\\ntext body, no real network call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = slack({ webhookUrl: 'https://hooks.slack.test/services/abc', locale: 'en', fetchImpl });

    await notifier.send(notification);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.test/services/abc');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ text: '*Usage limit reached*\nYou have used 2 units beyond your included 5 for api_call.' });
  });

  it('notify: slack adapter renders the ko locale into the webhook payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = slack({ webhookUrl: 'https://hooks.slack.test/services/abc', locale: 'ko', fetchImpl });

    await notifier.send(notification);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ text: '*이용량 한도 도달*\napi_call 사용량이 포함 한도 5 을 2 만큼 초과했습니다.' });
  });

  it('notify: slack adapter — non-2xx response does not throw, is logged and swallowed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500));
    const notifier = slack({ webhookUrl: 'https://hooks.slack.test/services/abc', fetchImpl });

    await expect(notifier.send(notification)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('notify.slack non-2xx', 500);
  });

  it('notify: slack adapter — a rejected fetch (unreachable host) does not throw, is logged and swallowed', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const notifier = slack({ webhookUrl: 'https://hooks.slack.test/services/abc', fetchImpl });

    await expect(notifier.send(notification)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('notify.slack failed', expect.any(Error));
  });
});

describe('notify: resend adapter', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('notify: resend adapter builds POST to api.resend.com/emails with Bearer auth and from/to/subject/text body, no real network call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = resend({ apiKey: 'sk_fake_123', from: 'billing@example.com', to: 'default@example.com', locale: 'en', fetchImpl });

    await notifier.send(notification);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_fake_123');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'billing@example.com',
      to: 'default@example.com',
      subject: 'Usage limit reached',
      text: 'You have used 2 units beyond your included 5 for api_call.',
    });
  });

  it('notify: resend adapter — n.payload.email overrides the configured default `to`', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));
    const notifier = resend({ apiKey: 'sk_fake_123', from: 'billing@example.com', to: 'default@example.com', fetchImpl });
    const withEmail: Notification = { ...notification, payload: { ...notification.payload, email: 'override@example.com' } };

    await notifier.send(withEmail);

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).to).toBe('override@example.com');
  });

  it('notify: resend adapter — non-2xx response does not throw, is logged and swallowed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(422));
    const notifier = resend({ apiKey: 'sk_fake_123', from: 'a@example.com', to: 'b@example.com', fetchImpl });

    await expect(notifier.send(notification)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('notify.resend non-2xx', 422);
  });

  it('notify: resend adapter — a rejected fetch (network down) does not throw, is logged and swallowed', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const notifier = resend({ apiKey: 'sk_fake_123', from: 'a@example.com', to: 'b@example.com', fetchImpl });

    await expect(notifier.send(notification)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('notify.resend failed', expect.any(Error));
  });
});

describe('notify: smtp adapter', () => {
  const mocks = vi.hoisted(() => ({
    sendMail: vi.fn(),
    createTransport: vi.fn(),
  }));

  vi.mock('nodemailer', () => ({
    default: { createTransport: mocks.createTransport },
  }));

  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.sendMail.mockReset().mockResolvedValue({ messageId: 'fake-id' });
    mocks.createTransport.mockReset().mockReturnValue({ sendMail: mocks.sendMail });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('notify: smtp adapter — createTransport is called with host/port/secure/auth, sendMail with from/to/subject/text, no real network call', async () => {
    const { smtp } = await import('../src/smtp.js');
    const notifier = smtp({ host: 'smtp.example.com', port: 587, secure: true, auth: { user: 'u', pass: 'p' }, from: 'billing@example.com', to: 'default@example.com', locale: 'en' });

    expect(mocks.createTransport).toHaveBeenCalledWith({ host: 'smtp.example.com', port: 587, secure: true, auth: { user: 'u', pass: 'p' } });

    await notifier.send(notification);

    expect(mocks.sendMail).toHaveBeenCalledWith({
      from: 'billing@example.com',
      to: 'default@example.com',
      subject: 'Usage limit reached',
      text: 'You have used 2 units beyond your included 5 for api_call.',
    });
  });

  it('notify: smtp adapter — n.payload.email overrides the configured default `to`', async () => {
    const { smtp } = await import('../src/smtp.js');
    const notifier = smtp({ host: 'smtp.example.com', port: 587, from: 'billing@example.com', to: 'default@example.com' });
    const withEmail: Notification = { ...notification, payload: { ...notification.payload, email: 'override@example.com' } };

    await notifier.send(withEmail);

    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'override@example.com' }));
  });

  it('notify: smtp adapter — sendMail rejecting (e.g. unreachable host) does not throw, is logged and swallowed', async () => {
    mocks.sendMail.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:1'));
    const { smtp } = await import('../src/smtp.js');
    const notifier = smtp({ host: '127.0.0.1', port: 1, from: 'a@example.com', to: 'b@example.com' });

    await expect(notifier.send(notification)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('notify.smtp failed', expect.any(Error));
  });
});
