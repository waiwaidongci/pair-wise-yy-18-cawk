'use strict';

const http = require('http');
const path = require('path');
const { URL } = require('url');
const { Store } = require('./lib/store');
const { DomainError } = require('./lib/errors');
const { buildService } = require('./lib/intake');
const { RULES } = require('./lib/rules');

// 偶头眼睑气密验收台 HTTP 服务（仅 Node 标准库）
function createServer({ store, service } = {}) {
  const persistence = store instanceof Store ? store : new Store(store || path.join(__dirname, '..', 'data', 'acceptance.json'));
  const svc = service || buildService(persistence);

  function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 1_000_000) reject(new DomainError('请求体过大', 'PAYLOAD_TOO_LARGE', 413));
      });
      req.on('end', () => {
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new DomainError('请求体不是合法 JSON', 'INVALID_JSON', 400));
        }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const q = Object.fromEntries(url.searchParams.entries());

      if (req.method === 'GET' && (p === '/' || p === '/health')) {
        return send(res, 200, { ok: true, service: '偶头眼睑气密验收台' });
      }
      if (req.method === 'GET' && p === '/api/acceptance/meta') {
        return send(res, 200, {
          title: '偶头眼睑气密验收台',
          modules: ['入口（intake）', '判定（decision）', '档案（archive）'],
          rules: RULES,
        });
      }

      // —— 档案只读口径 ——
      if (req.method === 'GET' && p === '/api/acceptance/acceptances') {
        return send(res, 200, svc.listAcceptances(q));
      }
      if (req.method === 'GET' && p === '/api/acceptance/heads') {
        return send(res, 200, svc.listHeads());
      }
      const headMatch = p.match(/^\/api\/acceptance\/heads\/([^/]+)$/);
      if (req.method === 'GET' && headMatch) {
        return send(res, 200, svc.headStatus(decodeURIComponent(headMatch[1])));
      }
      const histMatch = p.match(/^\/api\/acceptance\/heads\/([^/]+)\/history$/);
      if (req.method === 'GET' && histMatch) {
        return send(res, 200, svc.headHistory(decodeURIComponent(histMatch[1])));
      }
      const accMatch = p.match(/^\/api\/acceptance\/acceptances\/([^/]+)$/);
      if (req.method === 'GET' && accMatch) {
        return send(res, 200, svc.getAcceptance(decodeURIComponent(accMatch[1])));
      }

      // —— 入口写操作 ——
      if (req.method === 'POST') {
        const body = await readBody(req);
        // 幂等键优先取请求头，其次请求体
        const key = req.headers['idempotency-key'] || body.idempotencyKey;
        const payload = { ...body, idempotencyKey: key || undefined };
        let out;
        switch (p) {
          case '/api/acceptance/initial':
            out = await svc.submitInitial(payload);
            break;
          case '/api/acceptance/retests':
            out = await svc.openRetest(payload);
            break;
          case '/api/acceptance/retest-trials':
            out = await svc.addRetestTrial(payload);
            break;
          case '/api/acceptance/replacements':
            out = await svc.registerReplacement(payload);
            break;
          default:
            return send(res, 404, { error: 'not found' });
        }
        const status = out._status || 200;
        const replay = !!out._replay;
        delete out._status;
        delete out._replay;
        res.setHeader('Idempotent-Replay', replay ? 'true' : 'false');
        return send(res, status, out);
      }

      return send(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof DomainError) {
        return send(res, error.status, { error: error.message, code: error.code });
      }
      return send(res, 500, { error: error.message || 'server error' });
    }
  });

  return server;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3915;
  createServer().listen(PORT, () => {
    console.log(`偶头眼睑气密验收台 running at http://localhost:${PORT}`);
  });
}

module.exports = { createServer };
