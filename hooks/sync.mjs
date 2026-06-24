#!/usr/bin/env node
// Claude Code hook: Stop
// After each Claude response, syncs the exchange (user message + assistant response)
// to Cortex L0 so the memory pipeline can process it.
//
// Runs async — doesn't block the UI.

const CORTEX_URL = process.env.CORTEX_URL || 'http://127.0.0.1:7100';
const CORTEX_SECRET = process.env.CORTEX_SECRET || '';
const CORTEX_AGENT = process.env.CORTEX_DEFAULT_AGENT || 'default';
const SESSION_ID = process.env.CLAUDE_SESSION_ID || `cc_${Date.now()}`;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  try {
    let data;
    try { data = JSON.parse(input); } catch { return; }

    const content = data.response || data.stopResponse || '';
    if (!content || (typeof content === 'string' && content.length < 10)) return;

    const text = typeof content === 'string' ? content : JSON.stringify(content);

    await fetch(`${CORTEX_URL}/provider/sync`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CORTEX_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent: CORTEX_AGENT,
        session: SESSION_ID,
        content: text.slice(0, 32000),
        type: 'exchange',
        source_type: 'agent_internal',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* async hook — silent fail, don't block UI */ }
});
