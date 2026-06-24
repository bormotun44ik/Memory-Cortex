// Telegram notification for human-gated decisions (L3 proposals, supersession).
// Uses Hermes bot token from env. Inline keyboard for approve/reject.
// Batching: max BATCH_SIZE proposals per message, digest interval.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_HOME_CHANNEL || '';
const CORTEX_SECRET = process.env.CORTEX_SECRET || '';
const CORTEX_URL = process.env.CORTEX_URL || 'http://127.0.0.1:7100';

async function sendTelegram(text, replyMarkup = null) {
  if (!BOT_TOKEN || !CHAT_ID) return null;
  const body = { chat_id: CHAT_ID, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
  const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

export async function notifyL3Proposals(db, { log = console.log } = {}) {
  const pending = db.prepare(
    "SELECT id, text, agent, confidence FROM l3_rules WHERE pending = 1 ORDER BY created_at DESC LIMIT 10"
  ).all();
  if (pending.length === 0) return 0;

  if (pending.length <= 3) {
    for (const p of pending) {
      const msg = `📋 <b>L3 Proposal</b>\n\n<code>${escHtml(p.text.slice(0, 500))}</code>\n\nagent: ${p.agent} | conf: ${p.confidence}`;
      await sendTelegram(msg + `\n\nReply: <code>✅ ${p.id}</code> or <code>❌ ${p.id}</code>`);
    }
  } else {
    const summary = pending.map((p, i) => `${i + 1}. ${p.text.slice(0, 60)}...`).join('\n');
    await sendTelegram(`📋 <b>${pending.length} L3 Proposals</b>\n\n${escHtml(summary)}\n\nReview: GET /admin/l3/pending`);
  }
  log(`telegram: sent ${pending.length} L3 proposals`);
  return pending.length;
}

// Batched supersession digest: sends top-N by confidence, user reviews each.
// Separates NEW (since last digest) from BACKLOG (existing 1986).
export async function notifySupersessionDigest(db, { batchSize = 20, newOnly = false, log = console.log } = {}) {
  const whereClause = newOnly
    ? "AND sv.scanned_at > (CAST(strftime('%s','now') AS INTEGER) * 1000 - 86400000)"
    : '';
  // Deduplicate by unique fact_a+fact_b pair (scan may produce duplicate verdicts)
  const candidates = db.prepare(`
    SELECT min(sv.id) as vid, sv.fact_a, sv.fact_b,
      substr(old.fact_text, 1, 80) as old_text, substr(new.fact_text, 1, 80) as new_text,
      old.confidence as old_conf, new.confidence as new_conf
    FROM scan_verdicts sv
    JOIN l2_semantic old ON old.id = sv.fact_a
    JOIN l2_semantic new ON new.id = sv.fact_b
    WHERE sv.verdict = 'SUPERSESSION'
      AND old.confidence > 0 AND new.confidence > 0
      AND sv.id NOT IN (SELECT verdict_id FROM scan_verdicts_applied)
      ${whereClause}
    GROUP BY sv.fact_a, sv.fact_b
    ORDER BY new.confidence DESC LIMIT ?
  `).all(batchSize);

  const total = db.prepare(`
    SELECT count(*) c FROM scan_verdicts sv
    JOIN l2_semantic old ON old.id = sv.fact_a
    WHERE sv.verdict = 'SUPERSESSION' AND old.confidence > 0
      AND sv.id NOT IN (SELECT verdict_id FROM scan_verdicts_applied)
  `).get().c;

  if (candidates.length === 0) { log('telegram: 0 supersession to send'); return 0; }

  // Send individually with buttons (batched by batchSize)
  let sent = 0;
  for (const c of candidates) {
    const msg = `♻️ <b>Supersession</b> (${sent + 1}/${candidates.length} of ${total} total)\n\n❌ OLD: <code>${escHtml(c.old_text)}</code>\n✅ NEW: <code>${escHtml(c.new_text)}</code>\n\nReply: <code>✅ ${c.vid}</code> or <code>❌ ${c.vid}</code>`;
    await sendTelegram(msg);
    sent++;
  }
  if (total > candidates.length) {
    await sendTelegram(`📊 ${total - candidates.length} more supersession candidates remain. Send /cortex_supersession for next batch.`);
  }
  log(`telegram: sent ${sent}/${total} supersession`);
  return sent;
}

export async function notifySupersession(db, { log = console.log } = {}) {
  const candidates = db.prepare(`
    SELECT sv.id as vid, substr(old.fact_text, 1, 80) as old_text, substr(new.fact_text, 1, 80) as new_text
    FROM scan_verdicts sv
    JOIN l2_semantic old ON old.id = sv.fact_a
    JOIN l2_semantic new ON new.id = sv.fact_b
    WHERE sv.verdict = 'SUPERSESSION'
      AND old.confidence > 0 AND new.confidence > 0
      AND sv.id NOT IN (SELECT verdict_id FROM scan_verdicts_applied)
    ORDER BY sv.scanned_at DESC LIMIT 10
  `).all();
  if (candidates.length === 0) return 0;

  if (candidates.length <= 3) {
    for (const c of candidates) {
      const msg = `♻️ <b>Supersession</b>\n\n❌ OLD: <code>${escHtml(c.old_text)}</code>\n✅ NEW: <code>${escHtml(c.new_text)}</code>`;
      await sendTelegram(msg, {
        inline_keyboard: [[
          { text: '✅ Replace', callback_data: `ss_apply:${c.vid}` },
          { text: '❌ Keep both', callback_data: `ss_skip:${c.vid}` },
        ]],
      });
    }
  } else {
    await sendTelegram(`♻️ <b>${candidates.length} Supersession candidates</b>\n\nReview: manual audit needed (10% false rate).`);
  }
  log(`telegram: sent ${candidates.length} supersession candidates`);
  return candidates.length;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Poll for inline keyboard button taps (callback_query).
// Hermes gateway handles text messages; we handle ONLY callback_query.
let _lastUpdateId = 0;

export async function pollCallbacks(db, { log = console.log } = {}) {
  if (!BOT_TOKEN) return 0;
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${_lastUpdateId + 1}&timeout=1&allowed_updates=["callback_query"]`,
    );
    const data = await resp.json();
    if (!data.ok || !data.result?.length) return 0;

    let handled = 0;
    for (const update of data.result) {
      _lastUpdateId = Math.max(_lastUpdateId, update.update_id);
      const cb = update.callback_query;
      if (!cb?.data) continue;
      const result = handleCallback(db, cb.data);
      // Answer callback (removes spinner, shows toast)
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cb.id, text: result }),
      }).catch(() => {});
      log(`telegram callback: ${cb.data} → ${result}`);
      handled++;
    }
    return handled;
  } catch (e) {
    log(`telegram poll error: ${e.message}`);
    return 0;
  }
}

// Callback handler for inline keyboard buttons
export async function handleCallback(db, callbackData) {
  const [action, id] = callbackData.split(':');
  switch (action) {
    case 'l3_approve':
      db.prepare('UPDATE l3_rules SET pending = 0 WHERE id = ? AND pending = 1').run(id);
      return `✅ Rule approved: ${id}`;
    case 'l3_reject':
      db.prepare('DELETE FROM l3_rules WHERE id = ? AND pending = 1').run(id);
      return `❌ Rule rejected: ${id}`;
    case 'ss_apply': {
      const sv = db.prepare('SELECT fact_a, fact_b FROM scan_verdicts WHERE id = ?').get(id);
      if (sv) {
        db.prepare("UPDATE l2_semantic SET confidence = 0, contradicted_by = ? WHERE id = ? AND confidence > 0").run('superseded:' + sv.fact_b, sv.fact_a);
        db.prepare("INSERT OR IGNORE INTO scan_verdicts_applied (verdict_id, applied_at, action) VALUES (?, ?, ?)").run(id, Date.now(), 'telegram_approve');
      }
      return `✅ Supersession applied: ${id}`;
    }
    case 'ss_skip':
      db.prepare("INSERT OR IGNORE INTO scan_verdicts_applied (verdict_id, applied_at, action) VALUES (?, ?, ?)").run(id, Date.now(), 'telegram_skip');
      return `⏭ Supersession skipped: ${id}`;
    default:
      return 'Unknown action';
  }
}
