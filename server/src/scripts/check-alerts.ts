// A.8.16 monitoring job. Detection logic lives in src/audit/alert-rules.ts
// (shared with the test suite); this wrapper is the schedulable entry point.
// Schedule every 15 minutes (Task Scheduler / cron). Alert rows are forwarded
// to the SIEM / notification channel by ops (delivery wiring: Phase 4).
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { runAlertScan } from '../audit/alert-rules.js';

const config = loadConfig();
const db = createPool(config);

const { raised, chainOk } = await runAlertScan(db);
for (const alert of raised) {
  console.log(`ALERT [${alert.severity}] ${alert.rule}: ${JSON.stringify(alert.details)}`);
}
console.log(`check-alerts: done — ${raised.length} new alert(s) raised`);
await db.end();
process.exit(chainOk ? 0 : 1);
