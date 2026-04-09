const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'arcee-ai/arcee-blitz';

app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 'trinity-mcp' });
});

async function handleMcpRequest(body) {
  const { method, params, id, jsonrpc } = body;

  // Notifications have no id - return null to signal no response needed
  if (method && method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'trinity-mcp', version: '1.0.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{
          name: 'trinity_chat',
          description: 'Chat with Arcee Trinity via OpenRouter. A powerful AI model for analysis, coding, and reasoning.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The message to send to Trinity' },
              system_prompt: { type: 'string', description: 'Optional system prompt' },
            },
            required: ['message'],
          },
        }],
      },
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    if (name === 'trinity_chat') {
      try {
        const messages = [];
        if (args.system_prompt) messages.push({ role: 'system', content: args.system_prompt });
        messages.push({ role: 'user', content: args.message });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://trinity-mcp.railway.app',
          },
          body: JSON.stringify({ model: MODEL, messages }),
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || 'No response from Trinity';

        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: content }] },
        };
      } catch (err) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } };
      }
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

// Streamable HTTP MCP endpoint
app.post('/mcp', async (req, res) => {
  const accept = req.headers.accept || '';
  const body = req.body;

  // Handle single request
  if (!Array.isArray(body)) {
    const result = await handleMcpRequest(body);

    // Notification - no response needed, return 202
    if (result === null) {
      return res.status(202).end();
    }

    if (accept.includes('text/event-stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      return res.end();
    }

    return res.json(result);
  }

  // Batch
  const results = [];
  for (const item of body) {
    const r = await handleMcpRequest(item);
    if (r !== null) results.push(r);
  }

  if (results.length === 0) return res.status(202).end();

  if (accept.includes('text/event-stream')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    for (const result of results) {
      res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
    }
    return res.end();
  }

  res.json(results.length === 1 ? results[0] : results);
});

// SSE endpoint
app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const sessionId = uuidv4();
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  res.write(`event: endpoint\ndata: ${protocol}://${host}/message?sessionId=${sessionId}\n\n`);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => clearInterval(keepAlive));
  if (!global.sessions) global.sessions = {};
  global.sessions[sessionId] = res;
});

app.post('/message', async (req, res) => {
  const result = await handleMcpRequest(req.body);
  if (result === null) return res.status(202).end();
  const sessionId = req.query.sessionId;
  const sseRes = global.sessions?.[sessionId];
  if (sseRes) sseRes.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
  res.json(result);
});

app.listen(PORT, () => console.log(`Trinity MCP server running on port ${PORT}`));
