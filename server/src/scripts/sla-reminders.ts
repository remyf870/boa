// SLA reminders and escalation (plan §5.2). Run daily (with check-alerts).
// A step pending longer than sla_reminder_days re-notifies its approver once;
// longer than sla_escalation_days flags it escalated and notifies again.
// Escalation NOTIFIES — it never auto-approves anything (plan §5.2).
// Thresholds are app_settings data, not code constants (plan §0.3).
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { readSetting } from '../settings.js';
import { AuditAction, writeAudit } from '../audit/audit.js';
import { NotificationTemplate, queueNotification } from '../notify/notifier.js';

const config = loadConfig();
const db = createPool(config);

const reminderDays = await readSetting(db, 'sla_reminder_days');
const escalationDays = await readSetting(db, 'sla_escalation_days');

interface OverdueStep {
  id: string;
  assigned_user_id: string;
  purpose: string;
  requisition_id: string;
  reference: string;
  opened_at: Date;
  reminder_sent_at: Date | null;
  escalated_at: Date | null;
}

/** finance_review steps are role-addressed (any active accounting holder may
 * decide them — see approvals.ts), so their reminders/escalations go to every
 * accounting holder, not only the nominal assignee: re-notifying one absent
 * person forever was exactly the freeze the role-addressing fix removed. */
async function recipientsFor(step: OverdueStep): Promise<string[]> {
  if (step.purpose !== 'finance_review') return [step.assigned_user_id];
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT DISTINCT ra.user_id FROM roles_assignments ra
     JOIN users u ON u.id = ra.user_id AND u.status = 'active'
     WHERE ra.role = 'accounting' AND ra.revoked_at IS NULL`,
  );
  return rows.length > 0 ? rows.map((r) => r.user_id) : [step.assigned_user_id];
}

// A step is "open" when it is pending, its requisition is submitted, and every
// earlier step approved. It "opened" when the previous step decided (step 1:
// at submission). finance_review steps (the Accounts final hurdle, migration
// 0014) sit after every DOA step and get the same reminders — a stalled
// accounting review blocks approval exactly like a stalled approver.
const { rows: overdue } = await db.query<OverdueStep>(
  `SELECT st.id, st.assigned_user_id, st.purpose, st.requisition_id, r.reference,
          coalesce(prev.decided_at, r.submitted_at) AS opened_at,
          st.reminder_sent_at, st.escalated_at
   FROM approval_steps st
   JOIN requisitions r ON r.id = st.requisition_id AND r.status = 'submitted'
   LEFT JOIN LATERAL (
     SELECT max(p.decided_at) AS decided_at
     FROM approval_steps p
     WHERE p.requisition_id = st.requisition_id AND p.purpose IN ('doa', 'finance_review')
       AND p.step_no < st.step_no
   ) prev ON true
   WHERE st.decision = 'pending' AND st.purpose IN ('doa', 'finance_review')
     AND NOT EXISTS (SELECT 1 FROM approval_steps b
                     WHERE b.requisition_id = st.requisition_id
                       AND b.purpose IN ('doa', 'finance_review')
                       AND b.step_no < st.step_no AND b.decision <> 'approved')
     AND coalesce(prev.decided_at, r.submitted_at) < now() - make_interval(days => $1)`,
  [reminderDays],
);

let reminders = 0;
let escalations = 0;
for (const step of overdue) {
  const ageDays = (Date.now() - step.opened_at.getTime()) / 86_400_000;

  if (ageDays >= escalationDays && step.escalated_at === null) {
    await db.query('UPDATE approval_steps SET escalated_at = now() WHERE id = $1', [step.id]);
    for (const recipient of await recipientsFor(step)) {
      await queueNotification(db, {
        recipientUserId: recipient,
        template: NotificationTemplate.ApprovalEscalation,
        reference: step.reference,
        deepLink: '/approvals',
      });
    }
    await writeAudit(db, {
      actorUserId: null,
      action: AuditAction.SlaEscalated,
      entityType: 'approval_step',
      entityId: step.id,
      after: { reference: step.reference, ageDays: Math.floor(ageDays), escalationDays },
    });
    escalations++;
  } else if (step.reminder_sent_at === null) {
    await db.query('UPDATE approval_steps SET reminder_sent_at = now() WHERE id = $1', [step.id]);
    for (const recipient of await recipientsFor(step)) {
      await queueNotification(db, {
        recipientUserId: recipient,
        template: NotificationTemplate.ApprovalReminder,
        reference: step.reference,
        deepLink: '/approvals',
      });
    }
    await writeAudit(db, {
      actorUserId: null,
      action: AuditAction.SlaReminderSent,
      entityType: 'approval_step',
      entityId: step.id,
      after: { reference: step.reference, ageDays: Math.floor(ageDays), reminderDays },
    });
    reminders++;
  }
}

console.log(
  `sla-reminders: ${overdue.length} overdue step(s), ${reminders} reminder(s), ${escalations} escalation(s)`,
);
await db.end();
