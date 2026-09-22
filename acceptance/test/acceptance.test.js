'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../lib/store');
const { buildService } = require('../lib/intake');
const { RULES } = require('../lib/rules');
const { DomainError } = require('../lib/errors');

// 可控时钟：便于验证“隔三十分钟做两次”
function fakeClock(startIso) {
  let t = new Date(startIso).getTime();
  return {
    date: () => new Date(t),
    advance(ms) {
      t += ms;
    },
  };
}

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-'));
  const file = path.join(dir, 'state.json');
  const clock = fakeClock('2026-09-22T08:00:00.000Z');
  const store = new Store(file, { clock: clock.date });
  return { svc: buildService(store), clock, store, file };
}

const GOOD = { gapMm: 0.18, pressureDropPa: 4.2, openCloseCycles: 10, testerId: 'T1' };

test('四项登记齐全且达标：判待登台并放行', async () => {
  const { svc } = makeService();
  const res = await svc.submitInitial({ headId: 'H1', ...GOOD });
  assert.strictEqual(res.acceptance.status, '待登台');
  assert.strictEqual(res.release.released, true);
  const st = await svc.headStatus('H1');
  assert.strictEqual(st.status, '待登台');
});

test('缺任一项登记即拒绝（间隙/压降/开合次数/测试员）', async () => {
  const { svc } = makeService();
  for (const missing of ['gapMm', 'pressureDropPa', 'openCloseCycles', 'testerId']) {
    const body = { headId: 'H', ...GOOD };
    delete body[missing];
    await assert.rejects(() => svc.submitInitial(body), (e) => {
      assert.ok(e instanceof DomainError);
      assert.strictEqual(e.status, 400);
      return true;
    });
  }
});

test('间隙超0.2 / 压降超5 / 开合少于8：只转待调，不放行', async () => {
  const { svc } = makeService();
  const cases = [
    { gapMm: 0.21 },
    { pressureDropPa: 5.01 },
    { openCloseCycles: 7 },
  ];
  let i = 0;
  for (const override of cases) {
    const headId = `HB${i++}`;
    const res = await svc.submitInitial({ headId, ...GOOD, ...override });
    assert.strictEqual(res.acceptance.status, '待调', JSON.stringify(override));
    assert.strictEqual(res.release.released, false);
  }
});

test('边界值：0.2毫米、5帕、8次均判达标', async () => {
  const { svc } = makeService();
  const res = await svc.submitInitial({
    headId: 'HE',
    gapMm: 0.2,
    pressureDropPa: 5,
    openCloseCycles: 8,
    testerId: 'T1',
  });
  assert.strictEqual(res.acceptance.status, '待登台');
});

test('每个偶头只留一份未结束验收：待调后复测期间不能再首验', async () => {
  const { svc } = makeService();
  await svc.submitInitial({ headId: 'H', ...GOOD, openCloseCycles: 1 }); // 待调
  await svc.openRetest({ headId: 'H', testerId: 'T2' }); // 复测中（未结束）
  await assert.rejects(() => svc.submitInitial({ headId: 'H', ...GOOD }), (e) => {
    assert.strictEqual(e.code, 'OPEN_ACCEPTANCE_EXISTS');
    return true;
  });
});

test('复测必须由未参与测试者承担：原测试员被拒', async () => {
  const { svc } = makeService();
  await svc.submitInitial({ headId: 'H', ...GOOD, openCloseCycles: 1 });
  await assert.rejects(() => svc.openRetest({ headId: 'H', testerId: 'T1' }), (e) => {
    assert.strictEqual(e.code, 'RETESTER_PARTICIPATED');
    return true;
  });
  // 原测试员也不能在复测单里做测量
  await svc.openRetest({ headId: 'H', testerId: 'T2' });
  const rt = await svc.listAcceptances({ headId: 'H', status: '复测中' });
  await assert.rejects(
    () => svc.addRetestTrial({ acceptanceId: rt[0].id, ...GOOD, testerId: 'T1' }),
    (e) => {
      assert.strictEqual(e.code, 'RETESTER_PARTICIPATED');
      return true;
    }
  );
});

test('待登台无须复测，无可复测单时拒绝', async () => {
  const { svc } = makeService();
  await svc.submitInitial({ headId: 'H', ...GOOD });
  await assert.rejects(() => svc.openRetest({ headId: 'H', testerId: 'T2' }), (e) => {
    assert.strictEqual(e.code, 'RETEST_NOT_ELIGIBLE');
    return true;
  });
  await assert.rejects(() => svc.openRetest({ headId: 'NEW', testerId: 'T2' }), (e) => {
    assert.strictEqual(e.code, 'RETEST_NOT_ELIGIBLE');
    return true;
  });
});

test('复测两次须隔三十分钟：不足拒绝，满三十分钟且均达标才登台', async () => {
  const ctx = makeService();
  const { svc, clock } = ctx;
  await svc.submitInitial({ headId: 'H', ...GOOD, openCloseCycles: 1 });
  await svc.openRetest({ headId: 'H', testerId: 'T2' });
  let rt = await svc.listAcceptances({ headId: 'H', status: '复测中' });
  const rtId = rt[0].id;

  // 第一次复测（T3，达标）
  const first = await svc.addRetestTrial({ acceptanceId: rtId, ...GOOD, testerId: 'T3' });
  assert.strictEqual(first.receipt.awaitingSecond, true);
  assert.strictEqual(first.acceptance.status, '复测中');

  // 不足 30 分钟的第二次被拒
  clock.advance(29 * 60 * 1000 + 59 * 1000);
  await assert.rejects(
    () => svc.addRetestTrial({ acceptanceId: rtId, ...GOOD, testerId: 'T4' }),
    (e) => {
      assert.strictEqual(e.code, 'RETEST_INTERVAL_NOT_MET');
      return true;
    }
  );

  // 满 30 分钟，第二次达标 -> 待登台、放行
  clock.advance(1000);
  const second = await svc.addRetestTrial({ acceptanceId: rtId, ...GOOD, testerId: 'T4' });
  assert.strictEqual(second.acceptance.status, '待登台');
  assert.strictEqual(second.release.released, true);
  assert.strictEqual(RULES.RETEST_INTERVAL_MS, 30 * 60 * 1000);
});

test('复测两次中任一次不达标：即使完成也只转待调', async () => {
  const ctx = makeService();
  const { svc, clock } = ctx;
  await svc.submitInitial({ headId: 'H', ...GOOD, gapMm: 0.5 });
  await svc.openRetest({ headId: 'H', testerId: 'T2' });
  const rt = await svc.listAcceptances({ headId: 'H', status: '复测中' });
  const id = rt[0].id;
  await svc.addRetestTrial({ acceptanceId: id, ...GOOD, testerId: 'T3' });
  clock.advance(31 * 60 * 1000);
  const done = await svc.addRetestTrial({
    acceptanceId: id,
    ...GOOD,
    pressureDropPa: 6,
    testerId: 'T4',
  });
  assert.strictEqual(done.acceptance.status, '待调');
  assert.strictEqual(done.release.released, false);
});

test('更换眼珠或机关后原结论作废重判、停止放行', async () => {
  const { svc } = makeService();
  await svc.submitInitial({ headId: 'H', ...GOOD });
  assert.strictEqual((await svc.headStatus('H')).released, true);

  const repl = await svc.registerReplacement({
    headId: 'H',
    part: '眼珠',
    operatorId: 'O1',
  });
  assert.ok(repl.replacement.voidedAcceptanceIds.length >= 1);
  const st = await svc.headStatus('H');
  assert.strictEqual(st.released, false);
  assert.strictEqual(st.voidedByReplacement, true);
  assert.strictEqual(st.status, '无有效结论');

  // 非眼珠/机关部位被拒
  await assert.rejects(
    () => svc.registerReplacement({ headId: 'H', part: '发髻', operatorId: 'O1' }),
    (e) => {
      assert.strictEqual(e.status, 400);
      return true;
    }
  );

  // 换件后可重新首验，重新达标后再次放行；且换机关同样作废
  await svc.submitInitial({ headId: 'H', ...GOOD });
  assert.strictEqual((await svc.headStatus('H')).released, true);
  await svc.registerReplacement({ headId: 'H', part: '机关', operatorId: 'O2' });
  assert.strictEqual((await svc.headStatus('H')).released, false);
});

test('复测期间换件：未结束复测单也被作废，每头只剩零份未结束', async () => {
  const { svc } = makeService();
  await svc.submitInitial({ headId: 'H', ...GOOD, openCloseCycles: 1 });
  await svc.openRetest({ headId: 'H', testerId: 'T2' });
  await svc.registerReplacement({ headId: 'H', part: '眼珠', operatorId: 'O1' });
  const open = await svc.listAcceptances({ headId: 'H', status: '复测中' });
  assert.strictEqual(open.length, 0);
  // 作废后允许重开首验
  const again = await svc.submitInitial({ headId: 'H', ...GOOD });
  assert.strictEqual(again.acceptance.status, '待登台');
});

test('重复请求沿用首次回执（含首次的验收单编号），载荷不同则冲突', async () => {
  const { svc } = makeService();
  const first = await svc.submitInitial({
    headId: 'H',
    ...GOOD,
    openCloseCycles: 1,
    idempotencyKey: 'K-1',
  });
  const replay = await svc.submitInitial({
    headId: 'H',
    ...GOOD,
    openCloseCycles: 1,
    idempotencyKey: 'K-1',
  });
  assert.strictEqual(replay.receipt.receiptId, first.receipt.receiptId);
  // 不会因重复提交再建一张单
  const list = await svc.listAcceptances({ headId: 'H' });
  assert.strictEqual(list.length, 1);

  await assert.rejects(
    () => svc.submitInitial({ headId: 'H', ...GOOD, idempotencyKey: 'K-1' }),
    (e) => {
      assert.strictEqual(e.code, 'IDEMPOTENCY_MISMATCH');
      assert.strictEqual(e.status, 409);
      return true;
    }
  );
});

test('列表、单头履历、放行状态刷新后一致（同一事实来源）', async () => {
  const { svc } = makeService();
  const r = await svc.submitInitial({ headId: 'H', ...GOOD });
  const fromList = (await svc.listAcceptances({ headId: 'H' }))[0];
  const hist = await svc.headHistory('H');
  const status = await svc.headStatus('H');
  assert.strictEqual(fromList.id, r.receipt.receiptId);
  assert.strictEqual(hist.release.status, status.status);
  assert.strictEqual(hist.items.length, 1);
  assert.strictEqual(hist.items[0].type, 'acceptance');
});

test('多偶头互不干扰，列表可按状态过滤；待调链可反复复测直到通过', async () => {
  const ctx = makeService();
  const { svc, clock } = ctx;
  await svc.submitInitial({ headId: 'A', ...GOOD }); // 待登台
  await svc.submitInitial({ headId: 'B', ...GOOD, openCloseCycles: 1 }); // 待调
  assert.strictEqual((await svc.listAcceptances({ status: '待登台' })).length, 1);
  assert.strictEqual((await svc.listAcceptances({ status: '待调' })).length, 1);

  // B 复测失败 -> 仍待调；再开一轮复测，通过 -> 放行
  await svc.openRetest({ headId: 'B', testerId: 'T2' });
  let rt = await svc.listAcceptances({ headId: 'B', status: '复测中' });
  await svc.addRetestTrial({ acceptanceId: rt[0].id, ...GOOD, testerId: 'T3' });
  clock.advance(31 * 60 * 1000);
  await svc.addRetestTrial({ acceptanceId: rt[0].id, ...GOOD, testerId: 'T3', gapMm: 0.9 });
  assert.strictEqual((await svc.headStatus('B')).released, false);

  await svc.openRetest({ headId: 'B', testerId: 'T5' });
  rt = await svc.listAcceptances({ headId: 'B', status: '复测中' });
  await svc.addRetestTrial({ acceptanceId: rt[0].id, ...GOOD, testerId: 'T6' });
  clock.advance(30 * 60 * 1000);
  await svc.addRetestTrial({ acceptanceId: rt[0].id, ...GOOD, testerId: 'T6' });
  assert.strictEqual((await svc.headStatus('B')).released, true);
  // 通过后该头为待登台，不再允许复测（参与者禁入规则在待调链上已生效）
  await assert.rejects(() => svc.openRetest({ headId: 'B', testerId: 'T6' }), (e) => {
    assert.strictEqual(e.code, 'RETEST_NOT_ELIGIBLE');
    return true;
  });
  // 若再换件则结论作废，此时任何旧参与者（含 T3/T6）都不能为“待调单”开复测以外的影响——
  // 直接验证参与者禁入：换件后首验再做差，旧链参与者 T6 开复测仍被拒（新单被判定为对新首验的复测）
  await svc.registerReplacement({ headId: 'B', part: '机关', operatorId: 'O9' });
  await svc.submitInitial({ headId: 'B', ...GOOD, openCloseCycles: 1 });
  await assert.rejects(() => svc.openRetest({ headId: 'B', testerId: 'T1' }), (e) => {
    assert.strictEqual(e.code, 'RETESTER_PARTICIPATED');
    return true;
  });
});

test('数据落盘后重启，档案与放行状态保持一致', async () => {
  const ctx = makeService();
  const { svc, store, file } = ctx;
  await svc.submitInitial({ headId: 'H', ...GOOD });
  const reopened = new Store(file, { clock: () => new Date('2026-09-22T09:00:00.000Z') });
  const svc2 = buildService(reopened);
  assert.strictEqual((await svc2.headStatus('H')).released, true);
  assert.strictEqual((await svc2.listAcceptances({ headId: 'H' })).length, 1);
  assert.ok(fs.existsSync(store.file));
});
