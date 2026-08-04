// Audit chain verification job (A.8.15 / A.8.16). Schedule this at least
// daily (Task Scheduler / cron); a non-zero exit or a `critical` alert row
// means the log has been tampered with — treat as a security incident
// (docs/runbooks/incident-response.md).
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { raiseAlert, verifyAuditChain, writeAudit } from '../audit/audit.js';

const config = loadConfig();
const db = createPool(config);

const result = await verifyAuditChain(db);

if (result.ok) {
  await writeAudit(db, {
    action: 'audit.chain.verified',
    entityType: 'audit_log',
    after: { totalRows: result.totalRows, job: 'verify-audit-chain' },
  });
  console.log(`audit chain OK — ${result.totalRows} rows verified`);
  await db.end();
  process.exit(0);
} else {
  await raiseAlert(db, 'audit_chain_verification_failed', 'critical', {
    defects: result.defects.slice(0, 50),
    totalRows: result.totalRows,
    job: 'verify-audit-chain',
  });
  // Best effort: the append may itself fail if the DB is compromised
  await writeAudit(db, {
    action: 'audit.chain.verification_failed',
    entityType: 'audit_log',
    after: { defectCount: result.defects.length },
  }).catch(() => undefined);
  console.error(`AUDIT CHAIN BROKEN — ${result.defects.length} defect(s):`);
  for (const d of result.defects.slice(0, 50)) console.error(`  seq ${d.seq}: ${d.problem}`);
  await db.end();
  process.exit(1);
}
