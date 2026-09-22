'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../lib/store');
const { buildService } = require('../lib/intake');
const { createServer } = require('../server');

function fakeClock(startIso) {
  let t = new Date(startIso).getTime();
  return { date: () => new Date(t), advance: (ms) => { t += ms; } };
}

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-http-'));
  const clock = fakeClock('2026-09-22T08:00:00.000Z');
  const store = new Store(path.join(dir, 'state.json'), { clock: clock.date });
  const service = buildService(store);
  const server = createServer({ store: store.file, service });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, clock, server, stop: () => server.close() });
    });
  });
}

const GOOD = { gapMm: 0.1, pressureDropPa: 3, openCloseCycles: 12, testerId: 'T1' };

test('HTTP 全流程：登记 -> 待调 -> 复测两次（间隔30分钟、不同/同人均可）-> 登台 -> 换件作废 -> 重判', async (t) => {
  const h = await harness();
  const post = (url, body, key) => fetch(h.base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });

  await t.test('首验不达标转待调，重复请求沿用首次回执', async () => {
    const r1 = await post('/api/acceptance/initial', { headId: 'H1', ...GOOD, openCloseCycles: 2 }, 'K-INIT');
    assert.strictEqual(r1.status, 201);
    assert.strictEqual(r1.headers.get('idempotent-replay'), 'false');
    const b1 = await r1.json();
    assert.strictEqual(b1.acceptance.status, '待调');

    const r2 = await post('/api/acceptance/initial', { headId: 'H1', ...GOOD, openCloseCycles: 2 }, 'K-INIT');
    const b2 = await r2.json();
    assert.strictEqual(r2.headers.get('idempotent-replay'), 'true');
    assert.strictEqual(b2.receipt.receiptId, b1.receipt.receiptId);
  });

  await t.test('原测试员不能复测；未参与者开立，两次须隔30分钟，均达标才登台', async () => {
    const denied = await post('/api/acceptance/retests', { headId: 'H1', testerId: 'T1' });
    assert.strictEqual(denied.status, 409);
    assert.strictEqual((await denied.json()).code, 'RETESTER_PARTICIPATED');

    const opened = await (await post('/api/acceptance/retests', { headId: 'H1', testerId: 'T2' })).json();
    const rtId = opened.receipt.receiptId;

    const t1 = await (await post('/api/acceptance/retest-trials', { acceptanceId: rtId, ...GOOD, testerId: 'T2' })).json();
    assert.strictEqual(t1.receipt.awaitingSecond, true);

    h.clock.advance(20 * 60 * 1000);
    const tooSoon = await post('/api/acceptance/retest-trials', { acceptanceId: rtId, ...GOOD, testerId: 'T2' });
    assert.strictEqual(tooSoon.status, 409);
    assert.strictEqual((await tooSoon.json()).code, 'RETEST_INTERVAL_NOT_MET');

    h.clock.advance(10 * 60 * 1000 + 1);
    const t2 = await (await post('/api/acceptance/retest-trials', { acceptanceId: rtId, ...GOOD, testerId: 'T2' })).json();
    assert.strictEqual(t2.acceptance.status, '待登台');
    assert.strictEqual(t2.release.released, true);
  });

  await t.test('换眼珠后放行撤销、履历含作废；重新登记达标后再次放行', async () => {
    const repl = await (await post('/api/acceptance/replacements', { headId: 'H1', part: '眼珠', operatorId: 'O1' })).json();
    assert.ok(repl.replacement.voidedAcceptanceIds.length >= 1);

    const [status, hist, list] = await Promise.all([
      fetch(h.base + '/api/acceptance/heads/H1').then((r) => r.json()),
      fetch(h.base + '/api/acceptance/heads/H1/history').then((r) => r.json()),
      fetch(h.base + '/api/acceptance/acceptances?headId=H1').then((r) => r.json()),
    ]);
    assert.strictEqual(status.released, false);
    assert.strictEqual(status.status, '无有效结论');
    assert.strictEqual(hist.release.status, status.status); // 履历与放行口径一致
    assert.ok(hist.items.some((i) => i.type === 'replacement' && i.replacement.part === '眼珠'));
    assert.ok(list.every((a) => a.status === '已作废')); // 旧单全部作废

    const again = await (await post('/api/acceptance/initial', { headId: 'H1', ...GOOD, testerId: 'T9' })).json();
    assert.strictEqual(again.acceptance.status, '待登台');
    const heads = await fetch(h.base + '/api/acceptance/heads').then((r) => r.json());
    assert.strictEqual(heads.find((x) => x.headId === 'H1').released, true);
  });

  h.stop();
});

test('HTTP 错误码：缺字段 400 / 未知单 404 / JSON 非法 400', async () => {
  const h = await harness();
  const badField = await fetch(h.base + '/api/acceptance/initial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ headId: 'H', gapMm: 0.1 }),
  });
  assert.strictEqual(badField.status, 400);

  const notFound = await fetch(h.base + '/api/acceptance/acceptances/nope');
  assert.strictEqual(notFound.status, 404);

  const badJson = await fetch(h.base + '/api/acceptance/initial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.strictEqual(badJson.status, 400);

  h.stop();
});
