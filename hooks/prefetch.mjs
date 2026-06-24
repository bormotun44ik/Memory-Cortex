#!/usr/bin/env node
// Claude Code hook: UserPromptSubmit
// Calls Cortex prefetch with the user's message, returns memory context
// that gets injected into the conversation via additionalContext.
//
// Hook flow:
//   User types message → this hook fires → Cortex returns relevant facts
//   → additionalContext injected → Claude sees memory before responding.

const CORTEX_URL = process.env.CORTEX_URL || 'http://127.0.0.1:7100';
const CORTEX_SECRET = process.env.CORTEX_SECRET || '';
const CORTEX_AGENT = process.env.CORTEX_DEFAULT_AGENT || 'default';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  try {
    let userMessage = '';
    try {
      const data = JSON.parse(input);
      userMessage = data.prompt || data.message || data.content || '';
      if (typeof userMessage !== 'string') userMessage = JSON.stringify(userMessage);
    } catch {
      userMessage = input.trim();
    }

    if (!userMessage || userMessage.length < 3) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const res = await fetch(`${CORTEX_URL}/provider/prefetch`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CORTEX_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent: CORTEX_AGENT,
        messages: [userMessage],
      }),
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    const result = await res.json();
    const block = result.block || result.context || '';

    if (!block || block.length < 10) {
      process.stdout.write(JSON.stringify({ continue: true }));
      return;
    }

    process.stdout.write(JSON.stringify({
      continue: true,
      additionalContext: `<memory-cortex>\n${block}\n</memory-cortex>`,
    }));
  } catch {
    process.stdout.write(JSON.stringify({ continue: true }));
  }
});
