// R1 — Page-fault recall (three-class injection).
// HOT: 5-8 full facts (~300 tok). WARM: 15-20 one-line stubs (~150 tok).
// COLD: 0 tokens (entity in graph only, retrievable via cortex_query).
// Stub format: [RECALL ref_N] one-line summary (ref_N = session-scoped opaque alias).
// Kill-gate: stub dereference rate < 10% after 2 weeks → demote warm to keywords-only.

const HOT_SLOTS = 8;
const WARM_SLOTS = 20;

// Session-scoped ref aliases (opaque, no ULID leak)
let _refCounter = 0;
const _refMap = new Map(); // ref_N → fact_id

export function resetRefMap() {
  _refCounter = 0;
  _refMap.clear();
}

export function resolveRef(refN) {
  return _refMap.get(refN) ?? null;
}

// Partition facts into HOT/WARM/COLD tiers.
// Hot/warm boundary = median activation score (fallback until C1 provides derived).
export function partitionFacts(rankedFacts) {
  if (rankedFacts.length === 0) return { hot: [], warm: [], cold: [] };

  const hot = rankedFacts.slice(0, HOT_SLOTS);
  const warm = rankedFacts.slice(HOT_SLOTS, HOT_SLOTS + WARM_SLOTS);
  const cold = rankedFacts.slice(HOT_SLOTS + WARM_SLOTS);
  return { hot, warm, cold };
}

// Format WARM stubs with opaque ref_N aliases
export function formatWarmStubs(warmFacts) {
  const stubs = [];
  for (const f of warmFacts) {
    _refCounter++;
    const refN = `ref_${_refCounter}`;
    _refMap.set(refN, f.id);
    const oneLine = (f.fact_text || f.text || '').slice(0, 80).replace(/\n/g, ' ');
    stubs.push({ refN, text: `[RECALL ${refN}] ${oneLine}`, factId: f.id });
  }
  return stubs;
}

// Assemble the three-class injection block
// Superseded: prefetch calls partitionFacts+formatWarmStubs directly.
function assembleR1Block(rankedFacts, { tokenBudget = 500 } = {}) {
  const { hot, warm, cold } = partitionFacts(rankedFacts);

  // HOT: full text
  const hotLines = hot.map((f) => {
    const annotation = f.injectionStatus === 'annotate' ? ' [low confidence]' : '';
    return (f.fact_text || f.text || '') + annotation;
  });

  // WARM: stubs
  const warmStubs = formatWarmStubs(warm);
  const warmLines = warmStubs.map((s) => s.text);

  const delimiter = warm.length > 0 ? '--- retrievable stubs below ---' : '';

  return {
    hotFacts: hot,
    warmStubs,
    coldCount: cold.length,
    block: [
      ...hotLines,
      ...(delimiter ? [delimiter] : []),
      ...warmLines,
    ].join('\n'),
  };
}
