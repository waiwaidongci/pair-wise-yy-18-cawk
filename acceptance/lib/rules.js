'use strict';

// 偶头眼睑气密验收 —— 判定规则（阈值唯一出处）
// 判定模块只能引用本文件的常量与函数，不得在别处硬编码阈值。
const RULES = Object.freeze({
  // 眼睑间隙上限（毫米）：超过 0.2 毫米即不达标（0.2 本身达标）
  GAP_MAX_MM: 0.2,
  // 气室压降上限（帕）：超过 5 帕即不达标（5 本身达标）
  PRESSURE_DROP_MAX_PA: 5,
  // 开合次数下限：少于 8 次即不达标（8 本身达标）
  OPEN_CLOSE_MIN: 8,
  // 复测两次测量之间的最小间隔（毫秒）：隔三十分钟做两次
  RETEST_INTERVAL_MS: 30 * 60 * 1000,
  // 每次登记必须记录的四项：间隙、压降、开合次数、测试员
  REQUIRED_FIELDS: ['gapMm', 'pressureDropPa', 'openCloseCycles', 'testerId'],
  // 允许登记的换件部位
  REPLACEABLE_PARTS: ['眼珠', '机关'],
});

// 未结束（开放）的验收单状态：每个偶头同时只允许存在一份
const OPEN_STATUSES = Object.freeze(['验收中', '复测中']);

function isOpenStatus(status) {
  return OPEN_STATUSES.includes(status);
}

// 校验并归一化一次测量登记
function validateMeasure(raw) {
  const out = {};
  for (const field of ['gapMm', 'pressureDropPa']) {
    const v = raw[field];
    if (v === undefined || v === null || Number.isNaN(Number(v))) {
      return { error: `字段 ${field} 必须为数字` };
    }
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) {
      return { error: `字段 ${field} 必须为不小于 0 的有限数字` };
    }
    out[field] = num;
  }
  const cycles = raw.openCloseCycles;
  if (cycles === undefined || cycles === null || Number.isNaN(Number(cycles))) {
    return { error: '字段 openCloseCycles 必须为整数' };
  }
  if (!Number.isInteger(Number(cycles)) || Number(cycles) < 0) {
    return { error: '字段 openCloseCycles 必须为不小于 0 的整数' };
  }
  out.openCloseCycles = Number(cycles);
  if (typeof raw.testerId !== 'string' || !raw.testerId.trim()) {
    return { error: '字段 testerId 必须为非空字符串（测试员）' };
  }
  out.testerId = raw.testerId.trim();
  return { value: out };
}

// 单项达标判定，返回不达标原因列表（空列表表示达标）
function measureFailures(m) {
  const reasons = [];
  if (m.gapMm > RULES.GAP_MAX_MM) {
    reasons.push(`眼睑间隙 ${m.gapMm} 毫米超过 ${RULES.GAP_MAX_MM} 毫米`);
  }
  if (m.pressureDropPa > RULES.PRESSURE_DROP_MAX_PA) {
    reasons.push(`气室压降 ${m.pressureDropPa} 帕超过 ${RULES.PRESSURE_DROP_MAX_PA} 帕`);
  }
  if (m.openCloseCycles < RULES.OPEN_CLOSE_MIN) {
    reasons.push(`开合次数 ${m.openCloseCycles} 少于 ${RULES.OPEN_CLOSE_MIN} 次`);
  }
  return reasons;
}

function measurePass(m) {
  return measureFailures(m).length === 0;
}

// 两次复测均达标才判达标；任一次不达标即待调
function retestVerdict(trials) {
  const failures = [];
  trials.forEach((trial) => {
    for (const reason of measureFailures(trial.measure)) {
      failures.push(`第${trial.seq}次复测：${reason}`);
    }
  });
  return { pass: failures.length === 0, reasons: failures };
}

module.exports = {
  RULES,
  OPEN_STATUSES,
  isOpenStatus,
  validateMeasure,
  measureFailures,
  measurePass,
  retestVerdict,
};
