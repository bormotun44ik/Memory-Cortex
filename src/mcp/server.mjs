#!/usr/bin/env node
// Memory-Cortex MCP server — thin bridge exposing Cortex daemon HTTP API as MCP tools.
// Speaks stdio MCP protocol. Any MCP-compatible client (Claude Code, Hermes, OpenClaw)
// connects to this process and gets a universal memory layer.
//
// Usage:
//   node src/mcp/server.mjs
//
// Claude Code settings.json:
//   { "mcpServers": { "memory-cortex": {
//       "command": "node", "args": ["src/mcp/server.mjs"],
//       "env": { "CORTEX_URL": "http://127.0.0.1:7100", "CORTEX_SECRET": "..." }
//   }}}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const CORTEX_URL = process.env.CORTEX_URL || 'http://127.0.0.1:7100';
const CORTEX_SECRET = process.env.CORTEX_SECRET || '';
const DEFAULT_AGENT = process.env.CORTEX_DEFAULT_AGENT || 'default';

const log = (...args) => process.stderr.write(`[cortex-mcp] ${args.join(' ')}\n`);

// --- HTTP helpers ---

async function post(path, body) {
  try {
    const res = await fetch(`${CORTEX_URL}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CORTEX_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { _error: true, status: res.status, message: text || res.statusText };
    }
    return res.json();
  } catch (e) {
    return { _error: true, status: 0, message: `Cortex daemon unreachable at ${CORTEX_URL}: ${e.message}` };
  }
}

async function get(path) {
  try {
    const res = await fetch(`${CORTEX_URL}${path}`, {
      headers: { 'Authorization': `Bearer ${CORTEX_SECRET}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { _error: true, status: res.status, message: text || res.statusText };
    }
    return res.json();
  } catch (e) {
    return { _error: true, status: 0, message: `Cortex daemon unreachable at ${CORTEX_URL}: ${e.message}` };
  }
}

function textResult(data) {
  if (data?._error) {
    return {
      content: [{ type: 'text', text: `Error: ${data.message} (status ${data.status})` }],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'memory_search',
    description:
      'Search memory for facts relevant to a query. Uses graph spreading-activation + BM25 to find semantically related L2 facts. Returns ranked results with confidence scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results to return (default 20)' },
        agent: { type: 'string', description: 'Agent identity for scope filtering' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_remember',
    description:
      'Store a new fact in long-term memory. The fact is inserted directly as an L2 semantic fact with graph linking. Use for explicit "remember this" requests.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact to remember' },
        source_type: {
          type: 'string',
          enum: ['user_authored', 'tool_result', 'agent_internal'],
          description: 'Trust level of the source (default: user_authored)',
        },
        agent: { type: 'string', description: 'Agent identity' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_observe',
    description:
      'Record a raw observation as an L0 event. Lower level than memory_remember — use for logging exchanges, tool results, or system events that will be consolidated into facts later by the background pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Raw observation content' },
        type: {
          type: 'string',
          enum: ['exchange', 'tool_call', 'tool_result', 'system_event'],
          description: 'Event type (default: exchange)',
        },
        session: { type: 'string', description: 'Session identifier (groups related events)' },
        agent: { type: 'string', description: 'Agent identity' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_prefetch',
    description:
      'Get a pre-formatted memory context block for injection into a prompt. Returns HOT facts (full text) and WARM facts (short stubs with recall IDs). Designed for system-prompt prepending.',
    inputSchema: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recent conversation messages (last 3-5 turns as strings) for context extraction',
        },
        agent: { type: 'string', description: 'Agent identity' },
        budget_tokens: { type: 'number', description: 'Max tokens for the memory block (default 500)' },
      },
      required: ['messages'],
    },
  },
  {
    name: 'memory_timeline',
    description:
      'Get a chronological timeline of facts mentioning a specific entity or topic. Useful for understanding how knowledge evolved over time.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity or topic to filter by' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        from: { type: 'number', description: 'Start timestamp (ms since epoch)' },
        to: { type: 'number', description: 'End timestamp (ms since epoch)' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'memory_status',
    description:
      'Get memory system status — total records at each level (L0/L1/L2), graph node count, and daemon uptime.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// --- Tool handlers ---

async function handleTool(name, args) {
  switch (name) {
    case 'memory_search': {
      const data = await post('/mcp/query', {
        query: args.query,
        limit: args.limit ?? 20,
        agent: args.agent ?? DEFAULT_AGENT,
      });
      return textResult(data);
    }

    case 'memory_remember': {
      const data = await post('/mcp/remember', {
        fact_text: args.content,
        source_type: args.source_type ?? 'user_authored',
        entities: [],
      });
      return textResult(data);
    }

    case 'memory_observe': {
      const data = await post('/mcp/observe', {
        agent: args.agent ?? DEFAULT_AGENT,
        session: args.session ?? `mcp_${Date.now()}`,
        type: args.type ?? 'exchange',
        source_type: 'agent_internal',
        content: args.content,
        entities: [],
      });
      return textResult(data);
    }

    case 'memory_prefetch': {
      const data = await post('/provider/prefetch', {
        agent: args.agent ?? DEFAULT_AGENT,
        messages: args.messages ?? [],
        context_remaining: args.budget_tokens ?? 500,
      });
      return textResult(data);
    }

    case 'memory_timeline': {
      const params = new URLSearchParams();
      params.set('entity', args.entity);
      if (args.limit) params.set('limit', String(args.limit));
      if (args.from) params.set('from', String(args.from));
      if (args.to) params.set('to', String(args.to));
      const data = await get(`/mcp/timeline?${params}`);
      return textResult(data);
    }

    case 'memory_status': {
      const [health, stats] = await Promise.all([get('/health'), get('/stats')]);
      if (health?._error && stats?._error) return textResult(health);
      const merged = { ...health, ...stats };
      delete merged._error;
      return textResult(merged);
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// --- MCP server setup ---

const server = new Server(
  { name: 'memory-cortex', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  log(`tool call: ${name}`);
  return handleTool(name, args ?? {});
});

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`connected (daemon: ${CORTEX_URL}, agent: ${DEFAULT_AGENT})`);
}

main().catch((e) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
