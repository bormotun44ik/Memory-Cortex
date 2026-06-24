#!/usr/bin/env node
// Claude Code hook: PreCompact
// Fires BEFORE context compaction. Saves the conversation to Cortex L0
// so that details lost to compression are preserved in long-term memory.
//
// This is the critical hook for long sessions: without it, compacted
// context is gone forever. With it, Cortex distills important facts
// into L2 before they disappear from the agent's working memory.

import { readFileSync } from 'node:fs';

const CORTEX_URL = process.env.CORTEX_URL || 'http://127.0.0.1:7100';
const CORTEX_SECRET = process.env.CORTEX_SECRET || '';
const CORTEX_AGENT = process.env.CORTEX_DEFAULT_AGENT || 'default';
const SESSION_ID = process.env.CLAUDE_SESSION_ID || `cc_${Date.now()}`;
const TRANSCRIPT = process.env.CLAUDE_TRANSCRIPT || '';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  try {
    // Strategy: read the transcript file if available,
    // extract messages that haven't been synced yet, batch-send to L0.
    let messages = [];

    if (TRANSCRIPT) {
      try {
        const raw = readFileSync(TRANSCRIPT, 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean);
        for (const line of lines.slice(-200)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' || entry.type === 'assistant') {
              const text = typeof entry.message === 'string'
                ? entry.message
                : entry.message?.content || JSON.stringify(entry.message);
              if (text && text.length > 5) {
                messages.push({ role: entry.type, content: text.slice(0, 8000) });
              }
            }
          } catch { /* skip malformed lines */ }
        }
      } catch { /* transcript unreadable — fall through to stdin */ }
    }

    // Fallback: use stdin data if transcript unavailable
    if (messages.length === 0 && input.trim()) {
      try {
        const data = JSON.parse(input);
        if (Array.isArray(data.messages)) messages = data.messages;
        else if (data.context) messages = [{ role: 'system', content: data.context.slice(0, 32000) }];
      } catch { /* stdin not parseable */ }
    }

    if (messages.length === 0) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    // Batch send: group messages into chunks and send as L0 events
    const CHUNK_SIZE = 10;
    let saved = 0;
    for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
      const chunk = messages.slice(i, i + CHUNK_SIZE);
      const content = chunk.map((m) => `[${m.role}] ${m.content}`).join('\n---\n');

      await fetch(`${CORTEX_URL}/provider/sync`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CORTEX_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent: CORTEX_AGENT,
          session: SESSION_ID,
          content: content.slice(0, 32000),
          type: 'exchange',
          source_type: 'user_authored',
        }),
        signal: AbortSignal.timeout(5000),
      });
      saved += chunk.length;
    }

    process.stderr.write(`cortex: saved ${saved} messages before compaction\n`);
    process.stdout.write(JSON.stringify({ continue: true }));
  } catch (e) {
    process.stderr.write(`cortex precompact error: ${e.message}\n`);
    process.stdout.write(JSON.stringify({ continue: true }));
  }
});
