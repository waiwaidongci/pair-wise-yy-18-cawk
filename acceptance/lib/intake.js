'use strict';

const crypto = require('crypto');
const { RULES } = require('./rules');
const { errors } = require('./errors');
const archive = require('./archive');
const decision = require('./decision');

// —— 入口模块 ——
// 职责：受理与编排（不拥有阈值规则，也不直接对外暴露读取口径）。
//   1. 首验登记：每偶头只留一份未结束验收；四项（间隙/压降/开合次数/测试员）必须登记。
//   2. 复测：由未参与（被复测单）测试者，隔三十分钟做两次，两次都达标才能登台。
//   3. 换件：换眼珠/机关后原结论作废重判（登记实现归档模块，入口仅编排）。
//   4. 幂等：同一业务键的重复请求沿用首次回执；载荷不同则冲突拒绝。

function fingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// 幂等包装：首次执行并缓存回执（含 HTTP 状态），重复请求原样沿用。
function withIdempotency(state, store, key, payload, fn) {
  if (key) {
    const cached = state.receipts[key];
    if (cached) {
      if (cached.fingerprint !== fingerprint(payload)) {
        throw errors.conflict('同一回执键已用于不同请求，拒绝重复提交', 'IDEMPOTENCY_MISMATCH');
      }
      return { ...cached.receipt, _replay: true, _status: cached.status };
    }
  }
  const result = fn();
  if (key) {
    state.receipts[key] = {
      fingerprint: fingerprint(payload),
      status: result._status || 200,
      receipt: { ...result, _replay: undefined, _status: undefined },
    };
  }
  return result;
}

function requireHeadId(input) {
  const headId = typeof input.headId === 'string' ? input.headId.trim() : '';
  if (!headId) throw errors.validation('字段 headId 必须为非空字符串（偶头编号）');
  return headId;
}

// 沿复测链收集参与者（首验员 + 历次复测员）。
// includeSelf=false 时跳过当前复测单自身——复测负责人本人即可完成两次测量，
// 只要 TA 未参与过此前（被复测的）测试。
function upstreamTesters(state, acc, includeSelf = true) {
  const set = new Set();
  const guard = new Set();
  let cur = includeSelf ? acc : acc.retest
    ? archive.acceptanceById(state, acc.retest.ofAcceptanceId)
    : null;
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    if (cur.initial) set.add(cur.initial.measure.testerId);
    if (cur.retest) {
      cur.retest.trials.forEach((t) => set.add(t.testerId));
      if (cur.retest.openedBy) set.add(cur.retest.openedBy);
      cur = cur.retest.ofAcceptanceId ? archive.acceptanceById(state, cur.retest.ofAcceptanceId) : null;
    } else {
      cur = null;
    }
  }
  return set;
}

function buildService(store) {
  // 内部：解析当前有效结论链的末端（若末端是待登台，则无复测资格）
  function latestClosed(state, headId) {
    let found = null;
    for (const a of state.acceptances) {
      if (a.headId !== headId) continue;
      if (['待登台', '待调'].includes(a.status) && (found === null || a.seq > found.seq)) {
        found = a;
      }
    }
    return found;
  }

  const service = {
    rules: () => JSON.parse(JSON.stringify(RULES)),

    // 首验登记（四项登记齐全 + 当场判定）
    submitInitial(input = {}) {
      const headId = requireHeadId(input);
      return store.mutate((state) =>
        withIdempotency(state, store, input.idempotencyKey, { op: 'submitInitial', input }, () => {
          if (archive.findOpenAcceptance(state, headId)) {
            throw errors.conflict(`偶头 ${headId} 已存在一份未结束验收，须先结判或作废`, 'OPEN_ACCEPTANCE_EXISTS');
          }
          const { measure, pass, reasons } = decision.evaluateMeasure(input);
          const at = store.now();
          state.seq += 1;
          const acc = {
            id: store.newId('acc'),
            seq: state.seq,
            headId,
            kind: 'initial',
            status: '验收中',
            createdAt: at,
            closedAt: null,
            initial: { measure, pass, reasons, at },
            retest: null,
            voidReason: null,
            voidBy: null,
            history: [],
          };
          archive.addHistory(acc, {
            action: '首验登记',
            at,
            by: measure.testerId,
            note: '登记间隙/压降/开合次数/测试员',
            detail: measure,
          });
          state.acceptances.push(acc);
          decision.judgeInitial(state, store, acc, { by: measure.testerId });
          return {
            _status: 201,
            receipt: { receiptId: acc.id, headId, status: acc.status, pass },
            acceptance: archive.summaryOf(state, acc),
            release: archive.releaseStatusFor(state, headId),
          };
        })
      );
    },

    // 开立复测单（前提：当前有效结论为待调；开单人未参与该链测试）
    openRetest(input = {}) {
      const headId = requireHeadId(input);
      const openerId = typeof input.testerId === 'string' ? input.testerId.trim() : '';
      if (!openerId) throw errors.validation('字段 testerId 必须为非空字符串（复测负责人）');
      return store.mutate((state) =>
        withIdempotency(state, store, input.idempotencyKey, { op: 'openRetest', input }, () => {
          if (archive.findOpenAcceptance(state, headId)) {
            throw errors.conflict(`偶头 ${headId} 已有未结束验收，不能再开复测`, 'OPEN_ACCEPTANCE_EXISTS');
          }
          const target = latestClosed(state, headId);
          if (!target) {
            throw errors.conflict(`偶头 ${headId} 无可复测的已结判验收`, 'RETEST_NOT_ELIGIBLE');
          }
          if (target.status === '待登台') {
            throw errors.conflict(`偶头 ${headId} 当前为待登台，无须复测`, 'RETEST_NOT_ELIGIBLE');
          }
          const forbidden = upstreamTesters(state, target);
          if (forbidden.has(openerId)) {
            throw errors.conflict('复测须由未参与测试者承担，开单人已参与此前测试', 'RETESTER_PARTICIPATED');
          }
          const at = store.now();
          state.seq += 1;
          const acc = {
            id: store.newId('rt'),
            seq: state.seq,
            headId,
            kind: 'retest',
            status: '复测中',
            createdAt: at,
            closedAt: null,
            initial: null,
            retest: { openedAt: at, openedBy: openerId, ofAcceptanceId: target.id, trials: [] },
            voidReason: null,
            voidBy: null,
            history: [],
          };
          archive.addHistory(acc, {
            action: '开立复测',
            at,
            by: openerId,
            note: `针对待调验收 ${target.id} 开立；复测人未参与此前测试`,
          });
          state.acceptances.push(acc);
          return {
            _status: 201,
            receipt: { receiptId: acc.id, headId, status: acc.status },
            acceptance: archive.summaryOf(state, acc),
            release: archive.releaseStatusFor(state, headId),
          };
        })
      );
    },

    // 复测测量登记（隔三十分钟做两次，复测人须未参与此前测试，两次后自动结判）
    addRetestTrial(input = {}) {
      const acceptanceId = typeof input.acceptanceId === 'string' ? input.acceptanceId.trim() : '';
      if (!acceptanceId) throw errors.validation('字段 acceptanceId 必须为非空字符串（复测单编号）');
      return store.mutate((state) =>
        withIdempotency(state, store, input.idempotencyKey, { op: 'addRetestTrial', input }, () => {
          const acc = archive.acceptanceById(state, acceptanceId);
          if (!acc) throw errors.notFound(`复测单 ${acceptanceId} 不存在`);
          if (acc.status !== '复测中') {
            throw errors.conflict(`复测单 ${acceptanceId} 当前为「${acc.status}」，不能再登记测量`);
          }
          const { measure, pass, reasons } = decision.evaluateMeasure(input);
          const forbidden = upstreamTesters(state, acc, false);
          if (forbidden.has(measure.testerId)) {
            throw errors.conflict('复测须由未参与测试者执行，该测试员已参与此前测试', 'RETESTER_PARTICIPATED');
          }
          const trials = acc.retest.trials;
          if (trials.length >= 2) {
            throw errors.conflict('复测已完成两次测量', 'RETEST_COMPLETE');
          }
          const atMs = store.clock().getTime();
          if (trials.length === 1) {
            const elapsed = atMs - new Date(trials[0].at).getTime();
            if (elapsed < RULES.RETEST_INTERVAL_MS) {
              const waitMin = Math.ceil((RULES.RETEST_INTERVAL_MS - elapsed) / 60000);
              throw errors.interval(
                `两次复测须间隔至少 30 分钟，距首次测量尚需等待约 ${waitMin} 分钟`
              );
            }
          }
          const trial = {
            seq: trials.length + 1,
            at: store.now(),
            testerId: measure.testerId,
            measure,
            pass,
            reasons,
          };
          trials.push(trial);
          archive.addHistory(acc, {
            action: `复测第${trial.seq}次测量`,
            at: trial.at,
            by: measure.testerId,
            note: pass ? '本次测量达标' : '本次测量不达标：' + reasons.join('；'),
            detail: measure,
          });

          if (trials.length === 2) {
            decision.judgeRetest(state, store, acc, { by: measure.testerId });
          }
          return {
            _status: 201,
            receipt: {
              receiptId: acc.id,
              headId: acc.headId,
              status: acc.status,
              trialSeq: trial.seq,
              pass,
              awaitingSecond: trials.length === 1,
            },
            acceptance: archive.summaryOf(state, acc),
            release: archive.releaseStatusFor(state, acc.headId),
          };
        })
      );
    },

    // 换眼珠 / 换机关：原结论作废重判（实现归档模块）
    registerReplacement(input = {}) {
      return store.mutate((state) =>
        withIdempotency(state, store, input.idempotencyKey, { op: 'registerReplacement', input }, () => {
          const out = archive.registerReplacement(state, store, input);
          return {
            _status: 201,
            receipt: { receiptId: out.replacement.id, headId: out.replacement.headId, part: out.replacement.part },
            ...out,
            release: archive.releaseStatusFor(state, out.replacement.headId),
          };
        })
      );
    },

    // —— 只读：统一走档案模块 ——
    listAcceptances(query) {
      return store.read((state) => archive.listAcceptances(state, query));
    },
    listHeads() {
      return store.read((state) => archive.listHeads(state));
    },
    headStatus(headId) {
      return store.read((state) => archive.releaseStatusFor(state, headId));
    },
    headHistory(headId) {
      return store.read((state) => archive.headHistory(state, headId));
    },
    getAcceptance(id) {
      return store.read((state) => {
        const acc = archive.acceptanceById(state, id);
        if (!acc) throw errors.notFound(`验收单 ${id} 不存在`);
        return {
          acceptance: archive.summaryOf(state, acc),
          release: archive.releaseStatusFor(state, acc.headId),
          timeline: acc.history,
        };
      });
    },
  };

  return service;
}

module.exports = { buildService, fingerprint };
