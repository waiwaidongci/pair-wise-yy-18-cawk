'use strict';

const {
  measureFailures,
  retestVerdict,
  validateMeasure,
} = require('./rules');
const { errors } = require('./errors');
const { addHistory } = require('./archive');

// —— 判定模块 ——
// 职责：对一次测量给出达标/不达标（只认 rules.js 的阈值），
// 以及把“验收中”的首验单、“复测中”的复测单结判为 待登台 / 待调。
// 本模块不做权限与排队，那些属于入口模块；这里只负责“怎么判”。

function evaluateMeasure(rawMeasure) {
  const { value: measure, error } = validateMeasure(rawMeasure);
  if (error) throw errors.validation(error);
  const reasons = measureFailures(measure);
  return { measure, pass: reasons.length === 0, reasons };
}

// 首验单结判：任一指标不达标（间隙超 0.2 / 压降超 5 / 开合少于 8）只转待调
function judgeInitial(state, store, acceptance, { by }) {
  if (acceptance.status !== '验收中') {
    throw errors.conflict(`验收单 ${acceptance.id} 当前状态为「${acceptance.status}」，不可首验判定`);
  }
  const at = store.now();
  acceptance.status = acceptance.initial.pass ? '待登台' : '待调';
  acceptance.closedAt = at;
  addHistory(acceptance, {
    action: '首验判定',
    at,
    by: by || acceptance.initial.measure.testerId,
    note: acceptance.initial.pass
      ? '四项登记齐全且均达标，准予登台（待登台）'
      : '存在不达标项，只转待调：' + acceptance.initial.reasons.join('；'),
  });
  return acceptance;
}

// 复测单结判：两次复测均达标才可登台，否则只转待调
function judgeRetest(state, store, acceptance, { by }) {
  if (acceptance.status !== '复测中') {
    throw errors.conflict(`验收单 ${acceptance.id} 当前状态为「${acceptance.status}」，不可复测判定`);
  }
  const trials = acceptance.retest.trials;
  if (trials.length < 2) {
    throw errors.conflict('复测须完成两次测量后方可判定', 'RETEST_INCOMPLETE');
  }
  const verdict = retestVerdict(trials);
  const at = store.now();
  acceptance.status = verdict.pass ? '待登台' : '待调';
  acceptance.closedAt = at;
  addHistory(acceptance, {
    action: '复测判定',
    at,
    by: by || '',
    note: verdict.pass
      ? '两次复测均达标，准予登台（待登台）'
      : '复测未全部达标，只转待调：' + verdict.reasons.join('；'),
  });
  return acceptance;
}

function judgeAny(state, store, acceptance, { by }) {
  if (acceptance.status === '验收中') return judgeInitial(state, store, acceptance, { by });
  if (acceptance.status === '复测中') return judgeRetest(state, store, acceptance, { by });
  throw errors.conflict(`验收单 ${acceptance.id} 已结束（${acceptance.status}），不能重判`);
}

module.exports = {
  evaluateMeasure,
  judgeInitial,
  judgeRetest,
  judgeAny,
};
