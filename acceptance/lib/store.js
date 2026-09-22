'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// 零依赖持久化：
//  - 内存中保持单一权威状态；落盘用“写临时文件 + rename”原子替换。
//  - 所有变更经串行队列执行，保证并发请求按序生效；
//    列表 / 单头履历 / 放行状态全部读取同一份已提交状态，刷新后一致。
const EMPTY_STATE = Object.freeze({
  seq: 0,
  acceptances: [], // 验收单（首验单与复测单）
  replacements: [], // 换件登记（换眼珠 / 换机关）
  receipts: {}, // 幂等键 -> 首次回执快照
});

class Store {
  constructor(file, { clock = () => new Date() } = {}) {
    this.file = file;
    this.clock = clock;
    this._state = null;
    this._tail = Promise.resolve();
  }

  now() {
    return this.clock().toISOString();
  }

  newId(prefix) {
    return `${prefix}_${randomUUID()}`;
  }

  load() {
    if (this._state) return this._state;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this._state = {
        seq: Number(parsed.seq) || 0,
        acceptances: Array.isArray(parsed.acceptances) ? parsed.acceptances : [],
        replacements: Array.isArray(parsed.replacements) ? parsed.replacements : [],
        receipts: parsed.receipts && typeof parsed.receipts === 'object' ? parsed.receipts : {},
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this._state = JSON.parse(JSON.stringify(EMPTY_STATE));
    }
    return this._state;
  }

  _persist() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  // 变更事务：排队执行，先改内存状态，原子落盘成功后才提交结果。
  mutate(fn) {
    const run = this._tail.then(() => {
      const state = this.load();
      const result = fn(state);
      this._persist();
      return result;
    });
    // 队列不因单次失败而断裂
    this._tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  // 只读快照：与变更共用同一内存状态，保证三种读取口径一致。
  read(fn) {
    const state = this.load();
    return fn(state);
  }
}

module.exports = { Store };
