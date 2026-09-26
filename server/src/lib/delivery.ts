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

export function createOtpSender(config: Config, log: FastifyBaseLogger): OtpSender {
  const recent: { to: string; code: string; at: string }[] = [];
  const remember = (to: string, code: string) => {
    recent.unshift({ to, code, at: new Date().toISOString() });
    recent.length = Math.min(recent.length, RECENT_LIMIT);
  };
  const transport =
    config.otpDelivery === 'smtp' && config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

  async function sendEmail(msg: OtpMessage) {
    if (config.otpDelivery === 'console' || !transport) {
      log.warn({ to: msg.to, code: msg.code }, `[otp:console] Attendly sign-in code for ${msg.to}: ${msg.code}`);
      remember(msg.to, msg.code);
      return;
    }
    await transport.sendMail({
      from: config.smtpFrom,
      to: msg.to,
      subject: `${msg.code} is your Attendly sign-in code`,
      text:
        `Your Attendly sign-in code for ${msg.institution} is ${msg.code}.\n\n` +
        `It expires in 5 minutes. If you did not try to sign in, ignore this email — nobody can use the code without your phone.`,
    });
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
