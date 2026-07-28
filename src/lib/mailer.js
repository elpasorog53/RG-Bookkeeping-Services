import nodemailer from 'nodemailer';

function isConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_HOST !== 'your-smtp-host' &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // nodemailer's own defaults run into minutes; a slow/unreachable mail
      // host must fail fast rather than hang the request that triggered it.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
  }
  return transporter;
}

let lastSimulated;

// Test-only introspection hook: lets integration tests recover a token that
// was only ever "sent" to the console fallback below, without ever exposing
// this in a production code path (production always has real SMTP_* values).
export function getLastSimulatedMail() {
  return lastSimulated;
}

// Falls back to a console log in any environment without real SMTP creds
// (local dev, this sandbox, CI) so the auth flow stays fully exercisable
// without a mail account. Nothing here silently drops a send in production,
// since production always has real SMTP_* values configured per BLOCKERS.md.
export async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) {
    console.log(`[mailer] (no SMTP configured) would send to ${to}: ${subject}\n${text}`);
    lastSimulated = { to, subject, text, html };
    return { simulated: true };
  }

  const from = process.env.MAIL_FROM || 'RG Bookkeeping <no-reply@example.com>';
  return getTransporter().sendMail({ from, to, subject, text, html });
}
