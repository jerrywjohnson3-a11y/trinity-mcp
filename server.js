const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'arcee-ai/arcee-blitz';

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 'trinity-mcp' });
});

// SSE endpoint for MCP
app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sessionId = uuidv4();
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  const baseUrl = `${protocol}://${host}`;
  res.write(`event: endpoint\ndata: ${baseUrl}/message?sessionId=${sessionId}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });

  if (!global.sessions) global.sessions = {};
  global.sessions[sessionId] = res;
});

// Message endpoint for MCP JSON-RPC
app.post('/message', async (req, res) => {
  const { method, params, id, jsonrpc } = req.body;
  const sessionId = req.query.sessionId;

  // Send SSE event if session exists
  const sendSSE = (data) => {
    const sseRes = global.sessions?.[sessionId];
    if (sseRes) {
      sseRes.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  if (method === 'initialize') {
    const result = {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'trinity-mcp',
          version: '1.0.0',
        },
      },
    };
    sendSSE(result);
    return res.json(result);
  }

  if (method === 'notifications/initialized') {
    const result = { jsonrpc: '2.0', id, result: {} };
    sendSSE(result);
    return res.json(result);
  }

  if (method === 'tools/list') {
    const result = {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'trinity_chat',
            description: 'Chat with Arcee Trinity via OpenRouter. A powerful AI model for analysis, coding, and reasoning.',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'The message to send to Trinity',
                },
                system_prompt: {
                  type: 'string',
                  description: 'Optional system prompt',
                },
              },
              required: ['message'],
            },
          },
        ],
      },
    };
    sendSSE(result);
    return res.json(result);
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'trinity_chat') {
      try {
        const messages = [];
        if (args.system_prompt) {
          messages.push({ role: 'system', content: args.system_prompt });
        }
        messages.push({ role: 'user', content: args.message });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://trinity-mcp.railway.app',
          },
          body: JSON.stringify({
            model: MODEL,
            messages,
          }),
        });

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || 'No response from Trinity';

        const result = {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: content }],
          },
        };
        sendSSE(result);
        return res.json(result);
      } catch (err) {
        const errResult = {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err.message },
        };
        sendSSE(errResult);
        return res.json(errResult);
      }
    }
  }

  const notFound = { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  sendSSE(notFound);
  res.json(notFound);
});

app.listen(PORT, () => {
  console.log(`Trinity MCP server running on port ${PORT}`);
});
