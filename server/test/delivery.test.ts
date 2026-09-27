import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config';
import { createOtpSender, parseSender } from '../src/lib/delivery';

const log = { warn: () => undefined, error: () => undefined, info: () => undefined } as never;
const cfg = (otpDelivery: Config['otpDelivery']) =>
  ({ otpDelivery, emailApiKey: 'key-123', smtpUrl: undefined, smtpFrom: 'Attendly <atul@gmail.com>', smsDelivery: 'disabled', twilio: undefined }) as unknown as Config;
const msg = { channel: 'email' as const, to: 'prof@college.edu', code: '482913', institution: 'Green Valley <College>' };

afterEach(() => vi.unstubAllGlobals());

describe('sign-in emails over HTTPS', () => {
  it('Brevo: sender split into name + email, text and HTML with the code and the credit', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('{}', { status: 201 })));
    await createOtpSender(cfg('brevo'), log).send(msg);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((calls[0]!.init.headers as Record<string, string>)['api-key']).toBe('key-123');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.sender).toEqual({ name: 'Attendly', email: 'atul@gmail.com' });
    expect(body.to).toEqual([{ email: 'prof@college.edu' }]);
    expect(body.subject).toBe('482913 is your Attendly sign-in code');
    expect(body.textContent).toContain('Attendly · Created by Atul Kumar Jena');
    expect(body.htmlContent).toContain('Green Valley &lt;College&gt;'); // escaped
  });

  it('Resend: bearer key; retries a server error, then succeeds', async () => {
    let n = 0;
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      return new Response('busy', { status: ++n === 1 ? 503 : 200 });
    });
    await createOtpSender(cfg('resend'), log).send(msg);
    expect(seen).toEqual(['https://api.resend.com/emails Bearer key-123', 'https://api.resend.com/emails Bearer key-123']);
  });

  it('a wrong key fails at once with the provider’s message (no pointless retries)', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => (n++, new Response('{"message":"Key not found"}', { status: 401 })));
    await expect(createOtpSender(cfg('brevo'), log).send(msg)).rejects.toThrow('brevo HTTP 401: {"message":"Key not found"}');
    expect(n).toBe(1);
  });

  it('parses senders', () => {
    expect(parseSender('Attendly <a@b.co>')).toEqual({ name: 'Attendly', email: 'a@b.co' });
    expect(parseSender('"Green Valley" <a@b.co>')).toEqual({ name: 'Green Valley', email: 'a@b.co' });
    expect(parseSender('a@b.co')).toEqual({ email: 'a@b.co' });
  });
});

describe('email settings are checked at start-up', async () => {
  const { loadConfig } = await import('../src/config');
  const key = Buffer.alloc(32, 1).toString('base64');
  const key2 = Buffer.alloc(32, 2).toString('base64');
  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x@y/z', SERVER_SIGNING_KEY: key, TOKEN_PEPPER: key2 };
  it('brevo needs a key and a real sender', () => {
    expect(() => loadConfig({ ...base, OTP_DELIVERY: 'brevo' })).toThrow(/EMAIL_API_KEY/);
    expect(() => loadConfig({ ...base, OTP_DELIVERY: 'brevo', EMAIL_API_KEY: 'k', SMTP_FROM: 'Attendly' })).toThrow(/SMTP_FROM/);
    const c = loadConfig({ ...base, OTP_DELIVERY: 'brevo', EMAIL_API_KEY: 'k', SMTP_FROM: 'Attendly <atul@gmail.com>' });
    expect(c.otpDelivery).toBe('brevo');
    expect(c.demoInstantLogin).toBe(false); // real email → no demo sign-in
    expect(c.seedDemo).toBe(false);
  });
});
