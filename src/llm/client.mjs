// LLM client for background calls (consolidation, contradiction, dreaming).
// Two API formats, covers everything:
//   anthropic — Anthropic Messages API (api.anthropic.com)
//   openai    — OpenAI Chat Completions (OpenRouter, Kimi, GLM, Groq, Ollama, vLLM, etc.)
// Set CORTEX_LLM_FORMAT + URL + KEY. Models via CORTEX_WORKER_MODEL / CORTEX_JUDGE_MODEL.

const RETRIABLE = new Set([408, 429, 500, 502, 503, 529]);

export const MODEL_IDS = Object.freeze({
  worker: process.env.CORTEX_WORKER_MODEL || 'claude-haiku-4-5-20251001',
  judge: process.env.CORTEX_JUDGE_MODEL || 'claude-sonnet-4-6',
});

export const WORKER_CONTEXT_WINDOW = 200_000;

function resolveBackend() {
  const format = process.env.CORTEX_LLM_FORMAT || 'anthropic';
  const url = process.env.CORTEX_LLM_URL || (format === 'anthropic'
    ? 'https://api.anthropic.com/v1/messages'
    : 'https://openrouter.ai/api/v1/chat/completions');
  const key = process.env.CORTEX_LLM_KEY || process.env.ANTHROPIC_API_KEY || '';

  if (format === 'openai') {
    return {
      url,
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      buildBody({ model, system, user, maxTokens, prefill }) {
        const messages = [];
        if (system) messages.push({ role: 'system', content: system });
        messages.push({ role: 'user', content: user });
        if (prefill) messages.push({ role: 'assistant', content: prefill });
        return { model, temperature: 0, max_tokens: maxTokens, messages };
      },
      extractResult(data) {
        const text = data.choices?.[0]?.message?.content ?? '';
        const u = data.usage ?? {};
        return { text, usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 } };
      },
      isError(res, data) { return !res.ok || !!data?.error; },
      errorMsg(data) { return JSON.stringify(data?.error ?? data)?.slice(0, 500); },
    };
  }

  // anthropic (default)
  return {
    url,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    buildBody({ model, system, user, maxTokens, prefill }) {
      return {
        model, temperature: 0, max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [
          { role: 'user', content: user },
          ...(prefill ? [{ role: 'assistant', content: prefill }] : []),
        ],
      };
    },
    extractResult(data) {
      const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { text, usage: data.usage ?? {} };
    },
    isError(res, data) { return !res.ok || data?.type === 'error'; },
    errorMsg(data) { return JSON.stringify(data?.error ?? data)?.slice(0, 500); },
  };
}

export function createLlmClient() {
  const be = resolveBackend();
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0, by_model: {} };

  const delayFor = (status, attempt) =>
    status === 429 ? Math.min(30_000 * 2 ** attempt, 480_000) : 2000 * 2 ** attempt;

  async function call({ model, system, user, maxTokens = 2000, prefill = '', retries = 6 }) {
    const body = be.buildBody({ model, system, user, maxTokens, prefill });
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(be.url, { method: 'POST', headers: be.headers, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (be.isError(res, data)) {
        const msg = be.errorMsg(data);
        if (RETRIABLE.has(res.status) && attempt < retries) {
          await new Promise((r) => setTimeout(r, delayFor(res.status, attempt)));
          continue;
        }
        throw new Error(`LLM ${res.status} ${model}: ${msg}`);
      }
      const result = be.extractResult(data);
      const u = result.usage;
      usage.calls++;
      usage.input_tokens += u.input_tokens ?? 0;
      usage.output_tokens += u.output_tokens ?? 0;
      const bm = (usage.by_model[model] ??= { calls: 0, input_tokens: 0, output_tokens: 0 });
      bm.calls++;
      bm.input_tokens += u.input_tokens ?? 0;
      bm.output_tokens += u.output_tokens ?? 0;
      if (!result.text) throw new Error(`LLM: empty reply from ${model}`);
      return { text: prefill + result.text, usage: u };
    }
  }

  function worker(opts) { return call({ ...opts, model: opts.model ?? MODEL_IDS.worker }); }
  function judge(opts) { return call({ ...opts, model: opts.model ?? MODEL_IDS.judge, prefill: '' }); }

  return { call, worker, judge, usage, MODEL_IDS };
}
