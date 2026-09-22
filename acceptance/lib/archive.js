'use strict';

const { RULES, isOpenStatus } = require('./rules');
const { errors } = require('./errors');

// —— 档案模块 ——
// 职责：验收单 / 换件登记的归档、列表、单头履历、放行状态。
// 所有读取口径都由本模块定义；入口与判定模块也复用这里的查询，
// 保证“列表、单头履历与放行状态刷新后一致”。

function addHistory(acc, { action, at, by, note, detail }) {
  acc.history.push({
    id: acc.history.length + 1,
    action,
    at,
    by: by || '',
    note: note || '',
    detail: detail || null,
  });
}

// 该偶头最近一次“换眼珠 / 换机关”的时间（无则 null）
function latestReplacementAt(state, headId) {
  let latest = null;
  for (const r of state.replacements) {
    if (r.headId === headId && (latest === null || r.seq > latest.seq)) latest = r;
  }
  return latest;
}

// 该偶头当前未结束的验收单（验收中 / 复测中）；每个偶头至多一份
function findOpenAcceptance(state, headId) {
  return (
    state.acceptances.find((a) => a.headId === headId && isOpenStatus(a.status)) ||
    null
  );
}

// 该偶头当前“有效结论”：已判结论（待登台 / 待调）且未被作废、
// 且发生在最近一次换件之后。换件后旧结论作废，故此处自然排除。
function findEffectiveAcceptance(state, headId) {
  const lastRepl = latestReplacementAt(state, headId);
  const replSeq = lastRepl ? lastRepl.seq : -1;
  let found = null;
  for (const a of state.acceptances) {
    if (a.headId !== headId) continue;
    if (isOpenStatus(a.status) || a.status === '已作废') continue;
    if (a.seq <= replSeq) continue;
    if (found === null || a.seq > found.seq) found = a;
  }
  return found;
}

function acceptanceById(state, id) {
  return state.acceptances.find((a) => a.id === id) || null;
}

// 放行状态：有效结论为“待登台”才放行；待调 / 无结论 / 已作废均不放行。
function releaseStatusFor(state, headId) {
  const eff = findEffectiveAcceptance(state, headId);
  const lastRepl = latestReplacementAt(state, headId);
  return {
    headId,
    released: !!eff && eff.status === '待登台',
    status: eff ? eff.status : '无有效结论',
    acceptanceId: eff ? eff.id : null,
    voidedByReplacement: !eff && !!lastRepl,
    lastReplacement: lastRepl
      ? { part: lastRepl.part, at: lastRepl.at, operatorId: lastRepl.operatorId }
      : null,
  };
}

function summaryOf(state, a) {
  return {
    id: a.id,
    headId: a.headId,
    kind: a.kind,
    status: a.status,
    seq: a.seq,
    createdAt: a.createdAt,
    closedAt: a.closedAt || null,
    initial: a.initial
      ? {
          measure: a.initial.measure,
          pass: a.initial.pass,
          reasons: a.initial.reasons,
        }
      : null,
    retest: a.retest
      ? {
          openedAt: a.retest.openedAt,
          openedBy: a.retest.openedBy,
          trials: a.retest.trials.map((t) => ({
            seq: t.seq,
            at: t.at,
            testerId: t.testerId,
            measure: t.measure,
            pass: t.pass,
            reasons: t.reasons,
          })),
        }
      : null,
    voided: a.status === '已作废'
      ? { at: a.closedAt, reason: a.voidReason, by: a.voidBy }
      : null,
  };
}

function listAcceptances(state, { headId, status } = {}) {
  return state.acceptances
    .filter((a) => {
      if (headId && a.headId !== headId) return false;
      if (status && a.status !== status) return false;
      return true;
    })
    .sort((x, y) => y.seq - x.seq)
    .map((a) => summaryOf(state, a));
}

function listHeads(state) {
  const ids = new Set();
  state.acceptances.forEach((a) => ids.add(a.headId));
  state.replacements.forEach((r) => ids.add(r.headId));
  return [...ids].sort().map((headId) => releaseStatusFor(state, headId));
}

// 单头履历：该头全部验收单（含复测链）与换件登记，按时间顺序合并。
function headHistory(state, headId) {
  const items = [];
  for (const a of state.acceptances.filter((x) => x.headId === headId)) {
    items.push({
      type: 'acceptance',
      seq: a.seq,
      at: a.createdAt,
      acceptance: summaryOf(state, a),
      timeline: a.history,
    });
  }
  for (const r of state.replacements.filter((x) => x.headId === headId)) {
    items.push({
      type: 'replacement',
      seq: r.seq,
      at: r.at,
      replacement: {
        id: r.id,
        part: r.part,
        operatorId: r.operatorId,
        note: r.note,
        at: r.at,
      },
    });
  }
  items.sort((x, y) => x.seq - y.seq || (x.at < y.at ? -1 : 1));
  return { headId, release: releaseStatusFor(state, headId), items };
}

// —— 换件登记：更换眼珠或机关后，原结论作废重判 ——
function registerReplacement(state, store, input) {
  const headId = typeof input.headId === 'string' ? input.headId.trim() : '';
  const part = input.part;
  const operatorId =
    typeof input.operatorId === 'string' ? input.operatorId.trim() : '';
  if (!headId) throw errors.validation('字段 headId 必须为非空字符串（偶头编号）');
  if (!RULES.REPLACEABLE_PARTS.includes(part)) {
    throw errors.validation(`字段 part 必须是 ${RULES.REPLACEABLE_PARTS.join(' / ')} 之一`);
  }
  if (!operatorId) throw errors.validation('字段 operatorId 必须为非空字符串（操作员）');

  state.seq += 1;
  const at = store.now();
  const replacement = {
    id: store.newId('repl'),
    seq: state.seq,
    headId,
    part,
    operatorId,
    note: typeof input.note === 'string' ? input.note : '',
    at,
  };
  state.replacements.push(replacement);

  // 作废该头所有“仍有效”的验收单：未结束的直接作废；已判结论的也作废。
  const voided = [];
  for (const acc of state.acceptances) {
    if (acc.headId !== headId || acc.status === '已作废') continue;
    acc.status = '已作废';
    acc.closedAt = at;
    acc.voidReason = `更换${part}，原结论作废重判`;
    acc.voidBy = operatorId;
    addHistory(acc, {
      action: '作废',
      at,
      by: operatorId,
      note: acc.voidReason,
    });
    voided.push(acc.id);
  }

  return { replacement: { ...replacement, voidedAcceptanceIds: voided } };
}

module.exports = {
  addHistory,
  acceptanceById,
  findOpenAcceptance,
  findEffectiveAcceptance,
  latestReplacementAt,
  releaseStatusFor,
  listAcceptances,
  listHeads,
  headHistory,
  registerReplacement,
  summaryOf,
};
