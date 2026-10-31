// 本地假 Webhook 服务：记录收到的企微消息体，支持“返回业务错误”模式；同时提供测试页（同源，便于 fetch）
const http = require('http');

function createHookServer() {
  const state = { hits: [] };

  const server = http.createServer((req, res) => {
    // 测试页：同源才能正常发 fetch
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>bg harness</title></head><body><h1>bg</h1></body></html>');
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
      if (req.url.startsWith('/hook-fail')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }));
        return;
      }
      if (req.url.startsWith('/hook-http500')) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
        return;
      }
      state.hits.push({ url: req.url, body: parsed, raw: body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        port,
        pageUrl: `http://127.0.0.1:${port}/`,
        url: `http://127.0.0.1:${port}/hook`,
        failUrl: `http://127.0.0.1:${port}/hook-fail`,
        http500Url: `http://127.0.0.1:${port}/hook-http500`,
        reset() { state.hits.length = 0; },
        close() { return new Promise((r) => server.close(r)); }
      });
    });
  });
}

module.exports = { createHookServer };
