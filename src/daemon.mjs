#!/usr/bin/env node
// Memory-Cortex daemon entry point.
// Starts: SQLite + migrations → graph load → Fastify server on :7100.
// Croner: CRONER_ENABLED=true to activate (off by default — owner enables per-module).

import { loadConfig, assertServerConfig } from './config.mjs';
import { getDb } from './storage/db.mjs';
import { GraphStore } from './graph/store.mjs';
import { createLlmClient } from './llm/client.mjs';
import { createServer } from './api/server.mjs';

const cfg = assertServerConfig(loadConfig());
const db = getDb(cfg.dbPath);
const graph = new GraphStore(db);
const loaded = graph.load();
const llmClient = createLlmClient();

console.log(`cortex: db=${cfg.dbPath} graph=${loaded.nodes} nodes, ${loaded.edges} edge sources`);

const app = await createServer(db, graph, llmClient);
console.log(`cortex: listening on ${cfg.bindHost}:${cfg.port}`);

// --- Croner scheduling (per-module flags, all off by default) ---
// Enable per-module: CRON_L0L1=true, CRON_L1L2=true, etc.
// CRONER_ENABLED=true enables ALL (override). Per-module flags for staged rollout.
// CRON_TEST_MODE=true → all intervals become */1 (every minute) for quick verification.
const env = process.env;
const TEST_MODE = env.CRON_TEST_MODE === 'true';
const ALL = env.CRONER_ENABLED === 'true';
const CRON = {
  l0l1:    ALL || env.CRON_L0L1 === 'true',
  l1l2:    ALL || env.CRON_L1L2 === 'true',
  l2l3:    ALL || env.CRON_L2L3 === 'true',
  contra:  ALL || env.CRON_CONTRADICTION === 'true',
  maint:   ALL || env.CRON_MAINTENANCE === 'true',
  l0ret:   ALL || env.CRON_L0_RETENTION === 'true',
  entity:  ALL || env.CRON_ENTITY_QUEUE === 'true',
};
const activeModules = Object.entries(CRON).filter(([, v]) => v).map(([k]) => k);

if (activeModules.length > 0) {
  const { Cron } = await import('croner');
  const S = (prod) => TEST_MODE ? '*/1 * * * *' : prod;

  if (CRON.l0l1) {
    const { runL0ToL1 } = await import('./consolidation/l0-to-l1.mjs');
    new Cron(S('*/30 * * * *'), async () => {
      try { await runL0ToL1(db, llmClient, { log: (...a) => console.log('cron:l0l1', ...a) }); }
      catch (e) { console.error('cron:l0l1 error', e.message); }
    });
  }

  if (CRON.l1l2) {
    const { runL1ToL2 } = await import('./consolidation/l1-to-l2.mjs');
    new Cron(S('0 */6 * * *'), async () => {
      try { await runL1ToL2(db, llmClient, { graph, log: (...a) => console.log('cron:l1l2', ...a) }); }
      catch (e) { console.error('cron:l1l2 error', e.message); }
      // Notify owner of new L3 proposals after l1→l2 (router may have created some)
      try {
        const { notifyL3Proposals } = await import('./notifications/telegram.mjs');
        await notifyL3Proposals(db, { log: (...a) => console.log('notify:l3', ...a) });
      } catch (e) { console.error('notify:l3 error', e.message); }
    });
  }

  if (CRON.l2l3) {
    const { runL2ToL3 } = await import('./consolidation/l2-to-l3.mjs');
    new Cron(S('0 3 * * *'), async () => {
      try { await runL2ToL3(db, llmClient, { log: (...a) => console.log('cron:l2l3', ...a) }); }
      catch (e) { console.error('cron:l2l3 error', e.message); }
      // Notify owner of new L3 proposals from crystallization
      try {
        const { notifyL3Proposals } = await import('./notifications/telegram.mjs');
        await notifyL3Proposals(db, { log: (...a) => console.log('notify:l3', ...a) });
      } catch (e) { console.error('notify:l3 error', e.message); }
    });
  }

  if (CRON.contra) {
    const { runScan } = await import('./consolidation/contradiction.mjs');
    new Cron(S('30 3 * * *'), async () => {
      try { await runScan(db, llmClient, undefined, { log: (...a) => console.log('cron:contra', ...a) }); }
      catch (e) { console.error('cron:contra error', e.message); }
      // Notify owner of new supersession candidates
      try {
        const { notifySupersession } = await import('./notifications/telegram.mjs');
        await notifySupersession(db, { log: (...a) => console.log('notify:ss', ...a) });
      } catch (e) { console.error('notify:ss error', e.message); }
    });
  }

  if (CRON.maint) {
    const { runMaintenance } = await import('./graph/maintenance.mjs');
    new Cron(S('0 4 * * *'), async () => {
      try { runMaintenance(graph, { db, log: (...a) => console.log('cron:maint', ...a) }); }
      catch (e) { console.error('cron:maint error', e.message); }
    });
  }

  if (CRON.l0ret) {
    const { scanRetention } = await import('./storage/l0-retention.mjs');
    new Cron(S('30 4 * * *'), async () => {
      try { scanRetention(db, { dryRun: false, log: (...a) => console.log('cron:l0ret', ...a) }); }
      catch (e) { console.error('cron:l0ret error', e.message); }
    });
  }

  if (CRON.entity) {
    const { runEntityQueue } = await import('./graph/entity-candidates.mjs');
    new Cron(S('0 * * * *'), async () => {
      try { await runEntityQueue(db, graph, llmClient, { log: (...a) => console.log('cron:entity', ...a) }); }
      catch (e) { console.error('cron:entity error', e.message); }
    });
  }

  // Daily pending digest: remind owner via Telegram if pending proposals exist
  if (env.TELEGRAM_BOT_TOKEN) {
    const { notifyL3Proposals, notifySupersessionDigest } = await import('./notifications/telegram.mjs');
    new Cron(S('0 9 * * *'), async () => {
      try {
        const pendingCount = db.prepare('SELECT count(*) c FROM l3_rules WHERE pending = 1').get().c;
        if (pendingCount > 0) await notifyL3Proposals(db, { log: (...a) => console.log('digest:l3', ...a) });
        await notifySupersessionDigest(db, { batchSize: 5, newOnly: true, log: (...a) => console.log('digest:ss', ...a) });
      } catch (e) { console.error('digest error:', e.message); }
    });
    console.log('cortex: daily pending digest active (09:00 UTC)');
  }

  console.log(`cortex: croner active modules: [${activeModules.join(', ')}]${TEST_MODE ? ' (TEST MODE: */1 min)' : ''}`);
} else {
  console.log('cortex: croner OFF (set CRON_L0L1=true / CRONER_ENABLED=true)');
}
