'use strict';

/**
 * 档案模块（持久化 + 查询）
 *
 * 以事件溯源方式保存每份眼睑气密验收，并维护：
 *  - 每个偶头的验收轮次序号（每轮一份 cycle）
 *  - 全局回执台账：requestId -> 首次回执，重复请求沿用首次回执
 *  - 全局回执号自增序号
 *
 * 读视图（列表、单头履历、放行状态）全部在同一存储上即时投影，
 * 写入与提交在同一事务函数内完成，保证“刷新后一致”。
 *
 * 存储为零外部依赖的 JSON 文件：写入采用临时文件 + rename 原子替换。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OPEN_STATUSES, CYCLE_STATUS } = require('./policy');

function defaultFile() {
  return path.join(__dirname, '..', 'data', 'eyelid-acceptance.json');
}

class EyelidArchive {
  constructor(options = {}) {
    this.file = options.file || defaultFile();
    this._state = {
      seq: { head: 0, receipt: 0 },
      heads: {}, // headId -> { seq, cycles: [cycleId...] }
      cycles: {}, // cycleId -> cycle
      receipts: {} // requestId -> receipt
    };
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.cycles && data.receipts && data.seq) {
        this._state = data;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  /** 单一写入入口：变更在 mutate 中完成，随后原子落盘。 */
  commit(mutate) {
    const result = mutate(this._state);
    this._persist();
    return result;
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this._state));
    fs.renameSync(tmp, this.file);
  }

  // ---------- 幂等：重复请求沿用首次回执 ----------

  findReceipt(requestId) {
    if (!requestId) return null;
    const stored = this._state.receipts[requestId];
    return stored ? { ...stored, replayed: true } : null;
  }

  // ---------- 查询（快照，避免外部改动档案） ----------

  getCycle(cycleId) {
    return this._state.cycles[cycleId] ? this._snapshot(this._state.cycles[cycleId]) : null;
  }

  /** 取偶头当前（最新一轮）验收。 */
  getCurrentCycle(headId) {
    const head = this._state.heads[headId];
    if (!head || !head.cycles.length) return null;
    return this.getCycle(head.cycles[head.cycles.length - 1]);
  }

  /** 每个偶头只留一份未结束验收：找到状态为待调/复测中的那一轮。 */
  getOpenCycle(headId) {
    const head = this._state.heads[headId];
    if (!head) return null;
    for (let i = head.cycles.length - 1; i >= 0; i -= 1) {
      const cycle = this._state.cycles[head.cycles[i]];
      if (OPEN_STATUSES.includes(cycle.status)) return this._snapshot(cycle);
    }
    return null;
  }

  /** 全量验收列表，最新轮次排在前。 */
  listCycles(filters = {}) {
    const out = [];
    for (const head of Object.values(this._state.heads)) {
      for (const cycleId of head.cycles) out.push(this._state.cycles[cycleId]);
    }
    let rows = out.sort((a, b) => b.startedAtMs - a.startedAtMs).map((c) => this._snapshot(c));
    if (filters.headId) rows = rows.filter((c) => c.headId === filters.headId);
    if (filters.status) rows = rows.filter((c) => c.status === filters.status);
    return rows;
  }

  /** 单头履历：该偶头历轮验收（含初测、复测、作废事件）。 */
  getHeadHistory(headId) {
    const head = this._state.heads[headId];
    if (!head) return null;
    const cycles = head.cycles.map((id) => this.getCycle(id));
    const current = cycles.length ? cycles[cycles.length - 1] : null;
    return {
      headId,
      totalCycles: head.seq,
      currentCycleId: current ? current.cycleId : null,
      currentStatus: current ? current.status : null,
      releasable: this.isReleasable(headId),
      cycles
    };
  }

  /**
   * 放行状态：仅当最新一轮验收“已放行”时可登台。
   * 作废（换眼珠/机关）后放行立即取消，须重判。
   */
  isReleasable(headId) {
    const current = this.getCurrentCycle(headId);
    return Boolean(current && current.status === CYCLE_STATUS.RELEASED);
  }

  getReleaseStatus(headId) {
    const current = this.getCurrentCycle(headId);
    if (!current) {
      return { headId, releasable: false, cycleId: null, status: '未验收', retestsNeeded: 0 };
    }
    return {
      headId,
      releasable: current.status === CYCLE_STATUS.RELEASED,
      cycleId: current.cycleId,
      status: current.status,
      retestsNeeded: current.status === CYCLE_STATUS.RELEASED
        ? 0
        : Math.max(0, 2 - (current.consecutivePasses || 0))
    };
  }

  // ---------- 命令（在 commit 事务内调用） ----------

  openCycle(state, headId, measurement, startedAtMs) {
    const head = state.heads[headId] || (state.heads[headId] = { seq: 0, cycles: [] });
    head.seq += 1;
    state.seq.head = Math.max(state.seq.head, head.seq);
    const cycleId = this._cycleId(headId, head.seq);
    const initial = { ...measurement, atMs: startedAtMs };
    const cycle = {
      cycleId,
      headId,
      cycleNo: head.seq,
      status: null, // 由判定模块在同一事务内赋值
      startedAtMs,
      openedAt: new Date(startedAtMs).toISOString(),
      initial,
      retests: [],
      consecutivePasses: 0,
      voidInfo: null,
      events: [{ type: 'initial', atMs: startedAtMs, tester: measurement.tester, measurement }]
    };
    state.cycles[cycleId] = cycle;
    head.cycles.push(cycleId);
    return cycle;
  }

  setStatus(state, cycleId, status) {
    state.cycles[cycleId].status = status;
  }

  appendRetest(state, cycleId, measurement, nextStatus, consecutivePasses, atMs) {
    const cycle = state.cycles[cycleId];
    const entry = {
      seq: cycle.retests.length + 1,
      atMs,
      at: new Date(atMs).toISOString(),
      tester: measurement.tester,
      gapMm: measurement.gapMm,
      pressureDropPa: measurement.pressureDropPa,
      openCloseCycles: measurement.openCloseCycles,
      pass: nextStatus !== CYCLE_STATUS.PENDING,
      resultStatus: nextStatus
    };
    cycle.retests.push(entry);
    cycle.consecutivePasses = consecutivePasses;
    cycle.status = nextStatus;
    cycle.events.push({ type: 'retest', atMs, ...entry });
    return entry;
  }

  /** 更换眼珠或机关：原结论作废重判（放行状态随之取消）。 */
  voidCycle(state, cycleId, part, handler, reason, atMs) {
    const cycle = state.cycles[cycleId];
    cycle.status = CYCLE_STATUS.VOID;
    cycle.voidInfo = { part, handler, reason: reason || '', atMs, at: new Date(atMs).toISOString() };
    cycle.consecutivePasses = 0;
    cycle.events.push({ type: 'void', atMs, part, handler, reason: reason || '' });
  }

  storeReceipt(state, requestId, receipt) {
    if (!requestId) return null;
    if (state.receipts[requestId]) return state.receipts[requestId];
    state.seq.receipt += 1;
    const stored = {
      ...receipt,
      receiptNo: `HS-${String(state.seq.receipt).padStart(6, '0')}`
    };
    state.receipts[requestId] = stored;
    return stored;
  }

  _cycleId(headId, seq) {
    const safe = encodeURIComponent(headId).replace(/[^a-zA-Z0-9_.~%-]/g, '_');
    return `${safe}#${String(seq).padStart(3, '0')}`;
  }

  _snapshot(cycle) {
    const copy = JSON.parse(JSON.stringify(cycle));
    const initial = {
      ...copy.initial,
      measuredAt: copy.initial.at ? copy.initial.at : new Date(copy.initial.atMs).toISOString()
    };
    delete initial.atMs;
    delete initial.at;
    copy.initial = initial;
    copy.retests = copy.retests.map((r) => {
      const { atMs, ...rest } = r;
      return { ...rest, measuredAt: new Date(atMs).toISOString() };
    });
    copy.startedAt = new Date(copy.startedAtMs).toISOString();
    delete copy.startedAtMs;
    return copy;
  }
}

module.exports = { EyelidArchive, CYCLE_STATUS };
