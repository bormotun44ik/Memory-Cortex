// Loose JSON parser for LLM output.
// Handles: fenced code blocks, leading text before JSON, unterminated tails.

export function parseJsonLoose(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start === -1) throw new Error(`no JSON in model reply: ${text.slice(0, 200)}`);
  t = t.slice(start);
  const open = t[0], close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(t.slice(0, i + 1));
  }
  throw new Error(`unterminated JSON in model reply: ${text.slice(0, 200)}`);
}
