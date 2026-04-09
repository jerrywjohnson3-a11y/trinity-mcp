const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'arcee-ai/trinity-large-preview';

app.get('/', (req, res) => {
  res.json({ status: 'ok', server: 'trinity-mcp' });
});

async function handleMcpRequest(body) {
  const { method, params, id, jsonrpc } = body;

  if (method && method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: 'trinity-mcp',
          version: '1.0.0'
        }
      }
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{
          name: 'ask_trinity',
          description: 'Ask Arcee Trinity, a frontier-class AI model, any question. Trinity excels at reasoning, analysis, coding, math, and creative tasks.',
          inputSchema: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: 'The question or prompt to send to Trinity'
              },
              system_prompt: {
                type: 'string',
                description: 'Optional system prompt to guide Trinity behavior'
              }
            },
            required: ['question']
          }
        }]
      }
    };
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const args = params && params.arguments;

    if (toolName === 'ask_trinity') {
      try {
        const messages = [];
        if (args.system_prompt) {
          messages.push({ role: 'system', content: args.system_prompt });
        }
        messages.push({ role: 'user', content: args.question });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: MODEL,
            messages: messages
          })
        });

        const data = await response.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || 'No response from model';

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: content }]
          }
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: 'Error: ' + err.message }],
            isError: true
          }
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Unknown tool: ' + toolName }
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Method not found: ' + method }
  };
}

// Streamable HTTP MCP endpoint
app.post('/mcp', async (req, res) => {
  const accept = req.headers.accept || '';
  const body = req.body;

  if (!Array.isArray(body)) {
    const result = await handleMcpRequest(body);
    if (result === null) return res.status(202).end();

    if (accept.includes('text/event-stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      });
      res.write('event: message\ndata: ' + JSON.stringify(result) + '\n\n');
      return res.end();
    }
    return res.json(result);
  }

  const results = [];
  for (const item of body) {
    const r = await handleMcpRequest(item);
    if (r !== null) results.push(r);
  }
  if (results.length === 0) return res.status(202).end();
  if (accept.includes('text/event-stream')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    });
    for (const result of results) {
      res.write('event: message\ndata: ' + JSON.stringify(result) + '\n\n');
    }
    return res.end();
  }
  res.json(results.length === 1 ? results[0] : results);
});

// Legacy SSE endpoint
app.get('/sse', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  const sessionId = uuidv4();
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;
  res.write('event: endpoint\ndata: ' + protocol + '://' + host + '/message?sessionId=' + sessionId + '\n\n');
  const keepAlive = setInterval(function() { res.write(': ping\n\n'); }, 15000);
  req.on('close', function() { clearInterval(keepAlive); });
  if (!global.sessions) global.sessions = {};
  global.sessions[sessionId] = res;
});

app.post('/message', async (req, res) => {
  const result = await handleMcpRequest(req.body);
  if (result === null) return res.status(202).end();
  const sessionId = req.query.sessionId;
  var sseRes = global.sessions && global.sessions[sessionId];
  if (sseRes) sseRes.write('event: message\ndata: ' + JSON.stringify(result) + '\n\n');
  res.json(result);
});

app.listen(PORT, function() { console.log('Trinity MCP server running on port ' + PORT); });
