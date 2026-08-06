// Notification mailer (plan §5.2 / A.5.14). Run on a schedule (e.g. every
// minute) alongside check-alerts. Reads unsent outbox rows and delivers them
// over the internal SMTP relay. Bodies contain a deep link and a reference
// ONLY — never amounts, supplier names, reasons, or attachments (A.5.14).
// EMAIL_MODE=off leaves rows queued (dev, or until Massy IT provides the
// relay) — nothing is lost, delivery resumes when the relay is configured.
import nodemailer from 'nodemailer';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

const MAX_ATTEMPTS = 5;
const BATCH = 50;

const config = loadConfig();
const db = createPool(config);

if (config.EMAIL_MODE === 'off') {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM notification_outbox WHERE sent_at IS NULL',
  );
  console.log(`send-notifications: EMAIL_MODE=off — ${rows[0]!.n} message(s) queued, none sent`);
  await db.end();
  process.exit(0);
}

const transport = nodemailer.createTransport({
  host: config.SMTP_HOST!,
  port: config.SMTP_PORT,
  secure: config.SMTP_PORT === 465,
  ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } } : {}),
});

const { rows: pending } = await db.query<{
  id: string;
  template: string;
  subject: string;
  deep_link: string;
  attempts: number;
  email: string;
  display_name: string;
  status: string;
}>(
  `SELECT n.id, n.template, n.subject, n.deep_link, n.attempts, u.email, u.display_name, u.status
   FROM notification_outbox n
   JOIN users u ON u.id = n.recipient_user_id
   WHERE n.sent_at IS NULL AND n.attempts < $1
   ORDER BY n.created_at
   LIMIT $2`,
  [MAX_ATTEMPTS, BATCH],
);

let sent = 0;
let failed = 0;
for (const row of pending) {
  if (row.status !== 'active') {
    // Disabled users get nothing; mark handled so the queue drains
    await db.query(`UPDATE notification_outbox SET sent_at = now(), last_error = 'recipient disabled' WHERE id = $1`, [
      row.id,
    ]);
    continue;
  }
  // A.5.14: deep link + subject only. No financial data in the body.
  const body = [
    `Hello ${row.display_name},`,
    '',
    row.subject,
    '',
    `Open the item here: ${config.APP_BASE_URL}${row.deep_link}`,
    '',
    'This is an automated message from Massy Purchasing. Details are only visible after signing in.',
  ].join('\n');
  try {
    await transport.sendMail({
      from: config.SMTP_FROM!,
      to: row.email,
      subject: `[Massy Purchasing] ${row.subject}`,
      text: body,
    });
    await db.query('UPDATE notification_outbox SET sent_at = now(), attempts = attempts + 1 WHERE id = $1', [row.id]);
    sent++;
  } catch (err) {
    failed++;
    await db.query('UPDATE notification_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
      row.id,
      err instanceof Error ? err.message.slice(0, 500) : String(err),
    ]);
  }
}

console.log(`send-notifications: ${sent} sent, ${failed} failed, ${pending.length} processed`);
await db.end();
process.exit(failed > 0 ? 1 : 0);
