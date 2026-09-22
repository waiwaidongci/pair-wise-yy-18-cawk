'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createIntakeApp } = require('../acceptance');
const { EyelidArchive } = require('../acceptance/archive');
const policy = require('../acceptance/policy');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-09-22T08:00:00.000Z');

let currentTime = T0;

function makeApp() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eyelid-')), 'archive.json');
  return createIntakeApp({ file, clock: () => currentTime });
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function api(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: (url, body) => fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
    get: (url) => fetch(base + url).then(async (r) => ({ status: r.status, body: await r.json() }))
  };
}

const good = (over = {}) => ({
  gapMm: 0.1,
  pressureDropPa: 3,
  openCloseCycles: 12,
  tester: '张三',
  ...over
});

const bad = (over = {}) => good({ gapMm: 0.3, tester: '张三', ...over });

describe('判定模块（纯规则）', () => {
  test('间隙/压降“超过”、开合“少于”取严格不等号，边界值达标', () => {
    assert.equal(policy.evaluateMeasurement({ gapMm: 0.2, pressureDropPa: 5, openCloseCycles: 8 }).pass, true);
    assert.equal(policy.evaluateMeasurement({ gapMm: 0.21, pressureDropPa: 5, openCloseCycles: 8 }).pass, false);
    assert.equal(policy.evaluateMeasurement({ gapMm: 0.2, pressureDropPa: 5.01, openCloseCycles: 8 }).pass, false);
    assert.equal(policy.evaluateMeasurement({ gapMm: 0.2, pressureDropPa: 5, openCloseCycles: 7 }).pass, false);
  });

  test('四项登记缺一不可', () => {
    assert.equal(policy.parseMeasurementPayload({ gapMm: 0.1, pressureDropPa: 3, openCloseCycles: 10 }).errors.some((e) => e.field === 'tester'), true);
    assert.equal(policy.parseMeasurementPayload(good()).errors.length, 0);
  });
});

describe('初测登记', () => {
  let server, http;
  beforeEach(async () => {
    currentTime = T0;
    const app = makeApp();
    server = await listen(app);
    http = api(server);
  });
  test.afterEach(() => server.close());

  test('全部达标即放行登台', async () => {
    const r = await http.post('/api/eyelidAcceptance/tests', { headId: 'h1', requestId: 'req-1', ...good() });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, '已放行');
    assert.equal(r.body.result.decision, '放行登台');
    assert.match(r.body.receiptNo, /^HS-\d{6}$/);
  });

  test('任一指标不达标只转待调，不得放行', async () => {
    const r = await http.post('/api/eyelidAcceptance/tests', { headId: 'h2', requestId: 'req-2', ...bad() });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, '待调');
    assert.equal(r.body.result.pass, false);
    assert.equal(r.body.result.failures[0].code, 'GAP_EXCEEDED');
    const rel = await http.get('/api/eyelidAcceptance/heads/h2/release');
    assert.equal(rel.body.releasable, false);
    assert.equal(rel.body.status, '待调');
  });

  test('缺少登记项返回 400', async () => {
    const r = await http.post('/api/eyelidAcceptance/tests', { headId: 'h3', gapMm: 0.1 });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDATION_FAILED');
    assert.ok(r.body.details.errors.length >= 3);
  });

  test('每个偶头只留一份未结束验收', async () => {
    await http.post('/api/eyelidAcceptance/tests', { headId: 'h4', requestId: 'a', ...bad() });
    const again = await http.post('/api/eyelidAcceptance/tests', { headId: 'h4', requestId: 'b', ...good() });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'OPEN_CYCLE_EXISTS');
  });

  test('已放行轮次属于已结束验收：可另开新一轮，但同一时间仍只留一份未结束验收', async () => {
    await http.post('/api/eyelidAcceptance/tests', { headId: 'h5', requestId: 'c', ...good() });
    const again = await http.post('/api/eyelidAcceptance/tests', { headId: 'h5', requestId: 'd', ...bad() });
    assert.equal(again.status, 201);
    assert.equal(again.body.cycleId.endsWith('#002'), true);
    assert.equal(again.body.status, '待调');
    // 新一轮未结束前，不能再开第三轮
    const third = await http.post('/api/eyelidAcceptance/tests', { headId: 'h5', requestId: 'e', ...good() });
    assert.equal(third.status, 409);
  });
});

describe('复测：换人、隔 30 分钟、两次均达标', () => {
  let server, http;
  beforeEach(async () => {
    currentTime = T0;
    const app = makeApp();
    server = await listen(app);
    http = api(server);
    await http.post('/api/eyelidAcceptance/tests', { headId: 'h1', requestId: 'init', ...bad() });
  });
  test.afterEach(() => server.close());

  test('原测试员不能复测', async () => {
    currentTime = T0 + 31 * MIN;
    const r = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r1', ...bad({ gapMm: 0.1, tester: '张三' }) });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'RETESTER_SAME_AS_INITIAL');
  });

  test('间隔不足 30 分钟被拒', async () => {
    currentTime = T0 + 29 * MIN;
    const r = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r2', ...good({ tester: '李四' }) });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'RETEST_INTERVAL_TOO_SHORT');
  });

  test('恰满 30 分钟允许；首次复测达标进复测中', async () => {
    currentTime = T0 + 30 * MIN;
    const r = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r3', ...good({ tester: '李四' }) });
    assert.equal(r.status, 201);
    assert.equal(r.body.status, '复测中');
    assert.equal(r.body.result.consecutivePasses, 1);
  });

  test('第二次复测达标且再隔 30 分钟才放行', async () => {
    currentTime = T0 + 30 * MIN;
    await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r3', ...good({ tester: '李四' }) });

    currentTime = T0 + 59 * MIN;
    const soon = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r4', ...good({ tester: '王五' }) });
    assert.equal(soon.status, 409);

    currentTime = T0 + 60 * MIN;
    const pass = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r5', ...good({ tester: '王五' }) });
    assert.equal(pass.status, 201);
    assert.equal(pass.body.status, '已放行');
    const rel = await http.get('/api/eyelidAcceptance/heads/h1/release');
    assert.equal(rel.body.releasable, true);
  });

  test('第二次复测不达标：回待调，计数清零，须重新累计两次', async () => {
    currentTime = T0 + 30 * MIN;
    await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r3', ...good({ tester: '李四' }) });
    currentTime = T0 + 60 * MIN;
    const fail = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r6', ...bad({ tester: '王五', gapMm: 0.25 }) });
    assert.equal(fail.body.status, '待调');
    assert.equal(fail.body.result.consecutivePasses, 0);

    currentTime = T0 + 90 * MIN;
    const one = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r7', ...good({ tester: '李四' }) });
    assert.equal(one.body.status, '复测中');
  });

  test('两次复测均须由未参与初测者执行（第二次若为原测试员被拒）', async () => {
    currentTime = T0 + 30 * MIN;
    await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r3', ...good({ tester: '李四' }) });
    currentTime = T0 + 60 * MIN;
    const r = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r8', ...good({ tester: '张三' }) });
    assert.equal(r.status, 403);
  });

  test('待调轮次中首次复测就不达标，仍停留待调', async () => {
    currentTime = T0 + 30 * MIN;
    const r = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'r9', ...bad({ tester: '李四', pressureDropPa: 9 }) });
    assert.equal(r.body.status, '待调');
    assert.deepEqual(r.body.result.failures.map((f) => f.code), ['GAP_EXCEEDED', 'PRESSURE_DROP_EXCEEDED']);
  });
});

describe('更换眼珠或机关：原结论作废重判', () => {
  let server, http;
  beforeEach(async () => {
    currentTime = T0;
    const app = makeApp();
    server = await listen(app);
    http = api(server);
  });
  test.afterEach(() => server.close());

  test('放行后换眼珠立即取消放行，须重新初测', async () => {
    await http.post('/api/eyelidAcceptance/tests', { headId: 'h1', requestId: 'init', ...good() });
    const rep = await http.post('/api/eyelidAcceptance/replacements', { headId: 'h1', part: '眼珠', handler: '赵六', reason: '眼珠褪色', requestId: 'rep-1' });
    assert.equal(rep.status, 201);
    assert.equal(rep.body.status, '已作废');
    const rel = await http.get('/api/eyelidAcceptance/heads/h1/release');
    assert.equal(rel.body.releasable, false);
    assert.equal(rel.body.status, '已作废');

    const retestOnVoid = await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'x', ...good({ tester: '李四' }) });
    assert.equal(retestOnVoid.status, 409);

    currentTime = T0 + 10 * MIN;
    const redo = await http.post('/api/eyelidAcceptance/tests', { headId: 'h1', requestId: 'init-2', ...good() });
    assert.equal(redo.status, 201);
    assert.equal(redo.body.cycleId.endsWith('#002'), true);
    assert.equal((await http.get('/api/eyelidAcceptance/heads/h1/release')).body.releasable, true);
  });

  test('换机关同样作废；part 非法或无经手人返回 400', async () => {
    await http.post('/api/eyelidAcceptance/tests', { headId: 'h2', requestId: 'init', ...bad() });
    const rep = await http.post('/api/eyelidAcceptance/replacements', { headId: 'h2', part: '机关', handler: '赵六', requestId: 'rep-2' });
    assert.equal(rep.body.status, '已作废');

    const badPart = await http.post('/api/eyelidAcceptance/replacements', { headId: 'h2', part: '胡须', handler: '赵六', requestId: 'rep-3' });
    assert.equal(badPart.status, 400);
    const noHandler = await http.post('/api/eyelidAcceptance/replacements', { headId: 'h2', part: '眼珠', requestId: 'rep-4' });
    assert.equal(noHandler.status, 400);
  });
});

describe('幂等回执', () => {
  let server, http;
  beforeEach(async () => {
    currentTime = T0;
    const app = makeApp();
    server = await listen(app);
    http = api(server);
  });
  test.afterEach(() => server.close());

  test('重复请求沿用首次回执（同号、同内容，标记 replayed）', async () => {
    const payload = { headId: 'h1', requestId: 'dup-1', ...bad() };
    const first = await http.post('/api/eyelidAcceptance/tests', payload);
    const second = await http.post('/api/eyelidAcceptance/tests', payload);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.receiptNo, first.body.receiptNo);
    assert.equal(second.body.cycleId, first.body.cycleId);

    const list = await http.get('/api/eyelidAcceptance/cycles?headId=h1');
    assert.equal(list.body.count, 1);
  });

  test('Idempotency-Key 头同样生效', async () => {
    const payload = { headId: 'h2', ...good() };
    const doPost = () => fetch(`${http.base}/api/eyelidAcceptance/tests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'key-9' },
      body: JSON.stringify(payload)
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const a = await doPost();
    const b = await doPost();
    assert.equal(a.body.receiptNo, b.body.receiptNo);
    assert.equal(b.body.replayed, true);
  });

  test('首次请求被拒（如 409）不签发回执，改正后可重提', async () => {
    await http.post('/api/eyelidAcceptance/tests', { headId: 'h3', requestId: 'ok', ...bad() });
    const rejected = await http.post('/api/eyelidAcceptance/tests', { headId: 'h3', requestId: 'dup-2', ...good() });
    assert.equal(rejected.status, 409);
    currentTime = T0 + 30 * MIN;
    const retest = await http.post('/api/eyelidAcceptance/retests', { headId: 'h3', requestId: 'dup-2', ...good({ tester: '李四' }) });
    assert.equal(retest.status, 201);
  });
});

describe('列表 / 履历 / 放行状态一致', () => {
  test('同一存储即时投影，刷新后结论一致；重启档案后仍一致', async () => {
    currentTime = T0;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eyelid-')), 'archive.json');
    const mk = () => createIntakeApp({ file, clock: () => currentTime });

    let server = await listen(mk());
    let http = api(server);
    await http.post('/api/eyelidAcceptance/tests', { headId: 'h1', requestId: 'i1', ...bad() });
    await http.post('/api/eyelidAcceptance/tests', { headId: 'h2', requestId: 'i2', ...good() });
    currentTime = T0 + 30 * MIN;
    await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'i3', ...good({ tester: '李四' }) });
    currentTime = T0 + 60 * MIN;
    await http.post('/api/eyelidAcceptance/retests', { headId: 'h1', requestId: 'i4', ...good({ tester: '王五' }) });
    server.close();

    // 重新打开档案（模拟重启/刷新）
    server = await listen(mk());
    http = api(server);

    const list = await http.get('/api/eyelidAcceptance/cycles');
    assert.equal(list.body.count, 2);
    const h1inList = list.body.cycles.find((c) => c.headId === 'h1');
    const history = await http.get('/api/eyelidAcceptance/heads/h1/history');
    const release = await http.get('/api/eyelidAcceptance/heads/h1/release');

    assert.equal(h1inList.status, '已放行');
    assert.equal(history.body.currentStatus, '已放行');
    assert.equal(history.body.releasable, true);
    assert.equal(history.body.cycles[0].retests.length, 2);
    assert.equal(release.body.releasable, true);
    assert.equal(h1inList.status, history.body.currentStatus);
    assert.equal(h1inList.status, release.body.status);

    const releasedOnly = await http.get('/api/eyelidAcceptance/cycles?status=已放行');
    assert.equal(releasedOnly.body.count, 2);
    const pendingOnly = await http.get('/api/eyelidAcceptance/cycles?status=待调');
    assert.equal(pendingOnly.body.count, 0);
    server.close();
  });

  test('未验收偶头的放行状态', async () => {
    const app = makeApp();
    const server = await listen(app);
    const http = api(server);
    const r = await http.get('/api/eyelidAcceptance/heads/nobody/release');
    assert.equal(r.body.status, '未验收');
    assert.equal(r.body.releasable, false);
    const h = await http.get('/api/eyelidAcceptance/heads/nobody/history');
    assert.equal(h.status, 404);
    server.close();
  });
});
