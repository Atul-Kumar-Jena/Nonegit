import nodemailer from 'nodemailer';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';

export interface OtpMessage {
  channel: 'email' | 'phone';
  to: string;
  code: string;
  institution: string;
}

export interface OtpSender {
  send(msg: OtpMessage): Promise<void>;
  /** True when the channel can actually deliver (used to refuse phone OTP when SMS is disabled). */
  supports(channel: 'email' | 'phone'): boolean;
  /** Console mode only: the last few codes, so the testing console can show them. */
  recentCodes?(): { to: string; code: string; at: string }[];
}

const RECENT_LIMIT = 10;

const subjectOf = (m: OtpMessage) => `${m.code} is your Attendly sign-in code`;
const textOf = (m: OtpMessage) =>
  `Your Attendly sign-in code for ${m.institution} is ${m.code}.\n\n` +
  `It expires in 5 minutes. If you did not try to sign in, ignore this email — nobody can use the code without your phone.\n\nAttendly · Created by Atul Kumar Jena`;
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const htmlOf = (m: OtpMessage) =>
  `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#111">` +
  `<div style="font-weight:700;font-size:16px">Attendly</div>` +
  `<p style="color:#444">Your sign-in code for <b>${esc(m.institution)}</b>:</p>` +
  `<div style="font:700 34px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:8px;padding:18px 0">${esc(m.code)}</div>` +
  `<p style="color:#666;font-size:13px">It expires in 5 minutes. If you did not try to sign in, ignore this email — nobody can use the code without your phone.</p>` +
  `<p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:12px">Attendly · Created by Atul Kumar Jena</p></div>`;

/** "Attendly <you@gmail.com>" → { name, email } (Brevo wants them apart). */
export function parseSender(from: string): { name?: string; email: string } {
  const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(from);
  return m ? { ...(m[1] ? { name: m[1].replace(/^"|"$/g, '') } : {}), email: m[2]! } : { email: from.trim() };
}

export function createOtpSender(config: Config, log: FastifyBaseLogger): OtpSender {
  const recent: { to: string; code: string; at: string }[] = [];
  const remember = (to: string, code: string) => {
    recent.unshift({ to, code, at: new Date().toISOString() });
    recent.length = Math.min(recent.length, RECENT_LIMIT);
  };
  const transport =
    config.otpDelivery === 'smtp' && config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

  async function sendEmail(msg: OtpMessage) {
    if (config.otpDelivery === 'brevo' || config.otpDelivery === 'resend') return sendViaApi(msg);
    if (config.otpDelivery === 'console' || !transport) {
      log.warn({ to: msg.to, code: msg.code }, `[otp:console] Attendly sign-in code for ${msg.to}: ${msg.code}`);
      remember(msg.to, msg.code);
      return;
    }
    await transport.sendMail({ from: config.smtpFrom, to: msg.to, subject: subjectOf(msg), text: textOf(msg), html: htmlOf(msg) });
  }

  /** Email over HTTPS (Brevo / Resend): no mail ports needed. */
  async function sendViaApi(msg: OtpMessage) {
    const from = parseSender(config.smtpFrom);
    const req: { url: string; headers: Record<string, string>; body: unknown } =
      config.otpDelivery === 'brevo'
        ? {
            url: 'https://api.brevo.com/v3/smtp/email',
            headers: { 'api-key': config.emailApiKey ?? '', 'content-type': 'application/json', accept: 'application/json' },
            body: { sender: from, to: [{ email: msg.to }], subject: subjectOf(msg), textContent: textOf(msg), htmlContent: htmlOf(msg) },
          }
        : {
            url: 'https://api.resend.com/emails',
            headers: { authorization: `Bearer ${config.emailApiKey ?? ''}`, 'content-type': 'application/json' },
            body: { from: config.smtpFrom, to: [msg.to], subject: subjectOf(msg), text: textOf(msg), html: htmlOf(msg) },
          };
    let lastError = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(10_000) });
        if (res.ok) return;
        lastError = `${config.otpDelivery} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
        if (res.status < 500 && res.status !== 429) break; // a bad key or sender won't fix itself
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
    throw new Error(lastError || 'email delivery failed');
  }

  async function sendSms(msg: OtpMessage) {
    if (config.smsDelivery === 'console') {
      log.warn({ to: msg.to, code: msg.code }, `[otp:console] Attendly SMS code for ${msg.to}: ${msg.code}`);
      remember(msg.to, msg.code);
      return;
    }
    if (config.smsDelivery !== 'twilio' || !config.twilio) throw new Error('SMS delivery is disabled');
    const { accountSid, authToken, from } = config.twilio;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: msg.to, From: from, Body: `${msg.code} is your Attendly code. Expires in 5 min.` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`twilio responded ${res.status}`);
  }

  return {
    recentCodes: () => recent.map((r) => ({ ...r })),
    supports: (channel) => channel === 'email' || config.smsDelivery !== 'disabled',
    async send(msg) {
      if (msg.channel === 'email') await sendEmail(msg);
      else await sendSms(msg);
    },
  };
}
