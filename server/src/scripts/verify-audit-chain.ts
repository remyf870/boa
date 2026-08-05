// Audit chain verification job (A.8.15 / A.8.16). Schedule at least daily
// (Task Scheduler / cron); non-zero exit or a `critical` alert row means the
// log has been tampered with — treat as a security incident
// (docs/runbooks/incident-response.md).
//
// The printed ANCHOR line (max seq + tip hash + row count) must be captured by
// the SIEM/job log: comparing successive anchors detects tail-truncation or
// wholesale hash recomputation that in-database verification alone cannot see
// (docs/CRYPTO.md section 3).
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { raiseAlert, verifyAuditChain, writeAudit } from '../audit/audit.js';

const config = loadConfig();
const db = createPool(config);

const result = await verifyAuditChain(db);

if (result.ok && result.totalRows > 0) {
  await writeAudit(db, {
    action: 'audit.chain.verified',
    entityType: 'audit_log',
    after: { totalRows: result.totalRows, maxSeq: result.maxSeq, tipHash: result.tipHash, job: 'verify-audit-chain' },
  });
  console.log(`audit chain OK — ${result.totalRows} rows verified`);
  console.log(`ANCHOR ${JSON.stringify({ maxSeq: result.maxSeq, tipHash: result.tipHash, totalRows: result.totalRows, at: new Date().toISOString() })}`);
  await db.end();
  process.exit(0);
} else {
  // A zero-row "success" is a failure: after first use the log is never empty,
  // so an empty result means truncation or broken visibility.
  const reason = result.totalRows === 0 ? 'zero rows visible to verification' : `${result.defects.length} defect(s)`;
  await raiseAlert(db, 'audit_chain_verification_failed', 'critical', {
    defects: result.defects.slice(0, 50),
    totalRows: result.totalRows,
    reason,
    job: 'verify-audit-chain',
  });
  await writeAudit(db, {
    action: 'audit.chain.verification_failed',
    entityType: 'audit_log',
    after: { defectCount: result.defects.length, totalRows: result.totalRows, reason },
  }).catch(() => undefined);
  console.error(`AUDIT CHAIN VERIFICATION FAILED — ${reason}`);
  for (const d of result.defects.slice(0, 50)) console.error(`  seq ${d.seq}: ${d.problem}`);
  await db.end();
  process.exit(1);
}
