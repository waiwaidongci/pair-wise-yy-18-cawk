'use strict';

/**
 * 偶头眼睑气密验收台 —— 模块总装
 *
 * 入口模块：./intake  （HTTP 入口、校验、命令编排、回执）
 * 判定模块：./policy  （阈值、结论、复测资格与状态机，纯规则）
 * 档案模块：./archive （事件溯源档案、唯一性、幂等台账、原子持久化）
 */

const { createIntakeApp } = require('./intake');
const policy = require('./policy');
const { EyelidArchive } = require('./archive');

module.exports = {
  createIntakeApp,
  createEyelidApp: createIntakeApp,
  EyelidArchive,
  policy
};
