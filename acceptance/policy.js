'use strict';

/**
 * 判定模块（纯业务规则，无任何 I/O 依赖）
 *
 * 负责：
 *  - 单次测量达标判定（眼睑间隙、气室压降、开合次数）
 *  - 初测结论：全部达标 -> 已放行；任一项不达标 -> 只转待调
 *  - 复测资格：复测者必须未参与初测，每次测量间隔不少于 30 分钟
 *  - 复测状态机：连续两次复测均达标才放行，任一不达标回到待调
 */

const GAP_LIMIT_MM = 0.2;                 // 眼睑间隙上限（毫米），超过即不合格
const PRESSURE_DROP_LIMIT_PA = 5;         // 气室压降上限（帕），超过即不合格
const MIN_OPEN_CLOSE_CYCLES = 8;          // 开合次数下限，少于即不合格
const RETEST_INTERVAL_MS = 30 * 60 * 1000; // 复测间隔：30 分钟
const REQUIRED_RETEST_PASSES = 2;         // 连续复测达标次数：两次

const CYCLE_STATUS = Object.freeze({
  PENDING: '待调', // 初测/复测不达标，只可转待调
  RETESTING: '复测中', // 已有一次复测达标，等待第二次
  RELEASED: '已放行', // 准予登台
  VOID: '已作废' // 更换眼珠或机关，原结论作废
});

const OPEN_STATUSES = Object.freeze([CYCLE_STATUS.PENDING, CYCLE_STATUS.RETESTING]);

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * 单次测量达标判定。
 * 边界按“超 / 少于”严格解释：0.2mm、5Pa、8 次本身均判达标。
 */
function evaluateMeasurement(m) {
  const failures = [];
  if (m.gapMm > GAP_LIMIT_MM) {
    failures.push({
      code: 'GAP_EXCEEDED',
      field: 'gapMm',
      actual: m.gapMm,
      limit: GAP_LIMIT_MM,
      message: `眼睑间隙 ${m.gapMm}mm 超过 ${GAP_LIMIT_MM}mm`
    });
  }
  if (m.pressureDropPa > PRESSURE_DROP_LIMIT_PA) {
    failures.push({
      code: 'PRESSURE_DROP_EXCEEDED',
      field: 'pressureDropPa',
      actual: m.pressureDropPa,
      limit: PRESSURE_DROP_LIMIT_PA,
      message: `气室压降 ${m.pressureDropPa}Pa 超过 ${PRESSURE_DROP_LIMIT_PA}Pa`
    });
  }
  if (m.openCloseCycles < MIN_OPEN_CLOSE_CYCLES) {
    failures.push({
      code: 'OPEN_CYCLE_INSUFFICIENT',
      field: 'openCloseCycles',
      actual: m.openCloseCycles,
      limit: MIN_OPEN_CLOSE_CYCLES,
      message: `开合次数 ${m.openCloseCycles} 次少于 ${MIN_OPEN_CLOSE_CYCLES} 次`
    });
  }
  return { pass: failures.length === 0, failures };
}

/**
 * 登记载荷校验：眼睑间隙、气室压降、开合次数、测试员均须登记。
 * 返回 { value, errors }。
 */
function parseMeasurementPayload(body) {
  const errors = [];
  const value = {};

  const num = (field, label) => {
    const raw = body[field];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      errors.push({ field, message: `${label}必须登记` });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      errors.push({ field, message: `${label}必须是数字` });
      return;
    }
    if (n < 0) {
      errors.push({ field, message: `${label}不能为负` });
      return;
    }
    value[field] = n;
  };

  num('gapMm', '眼睑间隙');
  num('pressureDropPa', '气室压降');

  const cyclesRaw = body.openCloseCycles;
  if (cyclesRaw === undefined || cyclesRaw === null || String(cyclesRaw).trim() === '') {
    errors.push({ field: 'openCloseCycles', message: '开合次数必须登记' });
  } else {
    const n = Number(cyclesRaw);
    if (!Number.isInteger(n) || n < 0) {
      errors.push({ field: 'openCloseCycles', message: '开合次数必须是非负整数' });
    } else {
      value.openCloseCycles = n;
    }
  }

  const tester = typeof body.tester === 'string' ? body.tester.trim() : '';
  if (!tester) errors.push({ field: 'tester', message: '测试员必须登记' });
  value.tester = tester;

  if (body.measuredAt !== undefined && body.measuredAt !== null && body.measuredAt !== '') {
    const t = Date.parse(body.measuredAt);
    if (Number.isNaN(t)) {
      errors.push({ field: 'measuredAt', message: '测量时间不是合法时间' });
    } else {
      value.measuredAtMs = t;
    }
  }

  return { value, errors };
}

function requireHeadId(body) {
  const headId = typeof body.headId === 'string' ? body.headId.trim() : '';
  if (!headId) throw new HttpError(400, 'HEAD_ID_REQUIRED', '偶头标识必须登记');
  return headId;
}

/** 初测入口校验：每个偶头只留一份未结束验收。 */
function assertInitialAllowed(openCycle) {
  if (openCycle) {
    throw new HttpError(
      409,
      'OPEN_CYCLE_EXISTS',
      `偶头已有一份未结束验收（${openCycle.cycleId}，状态：${openCycle.status}），不能重复登记初测`
    );
  }
}

/**
 * 复测资格判定：
 *  1. 验收必须处于待调/复测中；
 *  2. 复测者必须是未参与初测的人；
 *  3. 距该轮验收上一次测量至少 30 分钟（初测与复测之间、两次复测之间均如此）。
 *
 * cycle 为档案快照（时间字段为 measuredAt ISO 字符串）。
 */
function assertRetestAllowed(cycle, input) {
  if (!cycle) {
    throw new HttpError(404, 'CYCLE_NOT_FOUND', '该偶头尚无验收记录，不能登记复测');
  }
  if (cycle.status === CYCLE_STATUS.VOID) {
    throw new HttpError(409, 'CYCLE_VOIDED', '原验收结论已作废，请重新登记初测');
  }
  if (cycle.status === CYCLE_STATUS.RELEASED) {
    throw new HttpError(409, 'CYCLE_CLOSED', '该验收已放行，复测登记关闭；请重新登记初测或登记更换后重判');
  }
  if (input.tester === cycle.initial.tester) {
    throw new HttpError(403, 'RETESTER_SAME_AS_INITIAL', '复测须由未参与初测的测试员执行');
  }
  const last = cycle.retests.length ? cycle.retests[cycle.retests.length - 1] : cycle.initial;
  const lastMeasuredAtMs = typeof last.atMs === 'number' ? last.atMs : Date.parse(last.measuredAt);
  const elapsedMs = input.measuredAtMs - lastMeasuredAtMs;
  if (elapsedMs < RETEST_INTERVAL_MS) {
    const waitMin = Math.ceil((RETEST_INTERVAL_MS - elapsedMs) / 60000);
    throw new HttpError(
      409,
      'RETEST_INTERVAL_TOO_SHORT',
      `距上一次测量不足 30 分钟，请至少再等 ${waitMin} 分钟`
    );
  }
}

/** 复测结论状态机：连续两次达标才放行；一次不达标即清零回待调。 */
function nextRetestState(cycle, pass) {
  if (!pass) {
    return { status: CYCLE_STATUS.PENDING, consecutivePasses: 0 };
  }
  const consecutivePasses = cycle.consecutivePasses + 1;
  return {
    status: consecutivePasses >= REQUIRED_RETEST_PASSES ? CYCLE_STATUS.RELEASED : CYCLE_STATUS.RETESTING,
    consecutivePasses
  };
}

function lastMeasurement(cycle) {
  return cycle.retests.length ? cycle.retests[cycle.retests.length - 1] : cycle.initial;
}

module.exports = {
  GAP_LIMIT_MM,
  PRESSURE_DROP_LIMIT_PA,
  MIN_OPEN_CLOSE_CYCLES,
  RETEST_INTERVAL_MS,
  REQUIRED_RETEST_PASSES,
  CYCLE_STATUS,
  OPEN_STATUSES,
  HttpError,
  evaluateMeasurement,
  parseMeasurementPayload,
  requireHeadId,
  assertInitialAllowed,
  assertRetestAllowed,
  nextRetestState,
  lastMeasurement
};
