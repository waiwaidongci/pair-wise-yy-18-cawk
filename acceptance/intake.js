'use strict';

/**
 * 入口模块（HTTP 接口 + 命令编排）
 *
 * 对外暴露眼睑气密验收台的全部入口，负责请求校验、调用判定模块、
 * 在档案模块的同一事务内落盘，并签发/复用回执。
 *
 * 命令：
 *  POST /api/eyelidAcceptance/tests          登记初测（达标放行 / 否则只转待调）
 *  POST /api/eyelidAcceptance/retests        登记复测（换人、间隔 30 分钟、两次均达标）
 *  POST /api/eyelidAcceptance/replacements   更换眼珠或机关，原结论作废重判
 *
 * 查询（同一存储即时投影，刷新后一致）：
 *  GET  /api/eyelidAcceptance/cycles         验收列表
 *  GET  /api/eyelidAcceptance/heads/:id/history   单头履历
 *  GET  /api/eyelidAcceptance/heads/:id/release   放行状态
 *
 * 幂等：命令请求带 requestId（或 Idempotency-Key 头），重复请求沿用首次回执。
 */

const express = require('express');
const path = require('path');
const { EyelidArchive } = require('./archive');
const {
  CYCLE_STATUS,
  HttpError,
  evaluateMeasurement,
  parseMeasurementPayload,
  requireHeadId,
  assertInitialAllowed,
  assertRetestAllowed,
  nextRetestState
} = require('./policy');

function createIntakeApp(options = {}) {
  const archive = options.archive || new EyelidArchive(
    options.file ? { file: options.file } : {}
  );
  const clock = options.clock || (() => Date.now());
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  function requestIdOf(req) {
    return (
      (typeof req.body.requestId === 'string' && req.body.requestId.trim()) ||
      req.get('Idempotency-Key') ||
      (typeof req.body.requestId === 'number' ? String(req.body.requestId) : '') ||
      ''
    );
  }

  function measureTimeOf(value) {
    return typeof value.measuredAtMs === 'number' ? value.measuredAtMs : clock();
  }

  function badRequest(errors) {
    return new HttpError(400, 'VALIDATION_FAILED', '登记信息不完整或不合法', { errors });
  }

  function receiptBody({ kind, action, cycle, result, atMs, replayed, part }) {
    const body = {
      kind,
      action,
      headId: cycle.headId,
      cycleId: cycle.cycleId,
      status: cycle.status,
      result,
      servedAt: new Date(atMs).toISOString(),
      cycleSnapshot: archive.getCycle(cycle.cycleId)
    };
    if (part) body.part = part;
    if (replayed) body.replayed = true;
    return body;
  }

  // ---------- 登记初测 ----------

  app.post('/api/eyelidAcceptance/tests', (req, res, next) => {
    try {
      const requestId = requestIdOf(req);
      const cached = archive.findReceipt(requestId);
      if (cached) return res.status(200).json(cached);

      const headId = requireHeadId(req.body);
      const { value, errors } = parseMeasurementPayload(req.body);
      if (errors.length) throw badRequest(errors);

      const measuredAtMs = measureTimeOf(value);
      const measurement = {
        gapMm: value.gapMm,
        pressureDropPa: value.pressureDropPa,
        openCloseCycles: value.openCloseCycles,
        tester: value.tester
      };
      const judge = evaluateMeasurement(measurement);

      const receipt = archive.commit((state) => {
        const open = archive.getOpenCycle(headId);
        assertInitialAllowed(open);
        const cycle = archive.openCycle(state, headId, measurement, measuredAtMs);
        const status = judge.pass ? CYCLE_STATUS.RELEASED : CYCLE_STATUS.PENDING;
        archive.setStatus(state, cycle.cycleId, status);

        const result = judge.pass
          ? { pass: true, failures: [], decision: '放行登台' }
          : { pass: false, failures: judge.failures, decision: '只转待调' };

        const body = receiptBody({ kind: 'test', action: '初测登记', cycle: { ...cycle, status }, result, atMs: measuredAtMs, part: null });
        return archive.storeReceipt(state, requestId, body);
      });

      return res.status(201).json(receipt);
    } catch (error) {
      return next(error);
    }
  });

  // ---------- 登记复测 ----------

  app.post('/api/eyelidAcceptance/retests', (req, res, next) => {
    try {
      const requestId = requestIdOf(req);
      const cached = archive.findReceipt(requestId);
      if (cached) return res.status(200).json(cached);

      const headId = requireHeadId(req.body);
      const { value, errors } = parseMeasurementPayload(req.body);
      if (errors.length) throw badRequest(errors);

      const measuredAtMs = measureTimeOf(value);
      const measurement = {
        gapMm: value.gapMm,
        pressureDropPa: value.pressureDropPa,
        openCloseCycles: value.openCloseCycles,
        tester: value.tester
      };

      const receipt = archive.commit((state) => {
        const current = archive.getCurrentCycle(headId);
        assertRetestAllowed(current, { tester: measurement.tester, measuredAtMs });
        const judge = evaluateMeasurement(measurement);
        const move = nextRetestState(current, judge.pass);
        archive.appendRetest(state, current.cycleId, measurement, move.status, move.consecutivePasses, measuredAtMs);

        const decision = move.status === CYCLE_STATUS.RELEASED
          ? '两次复测均达标，放行登台'
          : move.status === CYCLE_STATUS.PENDING
            ? '复测不达标，回到待调，连续达标计数清零'
            : '复测达标，还须再由未参与初测者间隔 30 分钟复测一次';
        const result = {
          pass: judge.pass,
          failures: judge.failures,
          consecutivePasses: move.consecutivePasses,
          decision
        };
        const cycle = archive.getCycle(current.cycleId);
        const body = receiptBody({ kind: 'retest', action: '复测登记', cycle, result, atMs: measuredAtMs, part: null });
        return archive.storeReceipt(state, requestId, body);
      });

      return res.status(201).json(receipt);
    } catch (error) {
      return next(error);
    }
  });

  // ---------- 更换眼珠/机关：作废重判 ----------

  const REPLACEABLE_PARTS = ['眼珠', '机关'];

  app.post('/api/eyelidAcceptance/replacements', (req, res, next) => {
    try {
      const requestId = requestIdOf(req);
      const cached = archive.findReceipt(requestId);
      if (cached) return res.status(200).json(cached);

      const headId = requireHeadId(req.body);
      const part = typeof req.body.part === 'string' ? req.body.part.trim() : '';
      if (!REPLACEABLE_PARTS.includes(part)) {
        throw new HttpError(400, 'PART_INVALID', 'part 必须是“眼珠”或“机关”');
      }
      const handler = typeof req.body.handler === 'string' ? req.body.handler.trim() : '';
      if (!handler) throw new HttpError(400, 'HANDLER_REQUIRED', '更换经手人必须登记');
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
      const atMs = clock();

      const receipt = archive.commit((state) => {
        const current = archive.getCurrentCycle(headId);
        if (!current) throw new HttpError(404, 'CYCLE_NOT_FOUND', '该偶头尚无验收记录，无可作废的结论');
        if (current.status === CYCLE_STATUS.VOID) {
          throw new HttpError(409, 'CYCLE_VOIDED', '上一轮验收已作废，请直接重新登记初测');
        }
        archive.voidCycle(state, current.cycleId, part, handler, reason, atMs);
        const cycle = archive.getCycle(current.cycleId);
        const result = {
          pass: false,
          decision: `已更换${part}，原结论（${current.cycleId}）作废，须重新验收达标后方可登台`
        };
        const body = receiptBody({ kind: 'replacement', action: `更换${part}·作废重判`, cycle, result, atMs, part });
        return archive.storeReceipt(state, requestId, body);
      });

      return res.status(201).json(receipt);
    } catch (error) {
      return next(error);
    }
  });

  // ---------- 查询 ----------

  app.get('/api/eyelidAcceptance/cycles', (req, res, next) => {
    try {
      const filters = {};
      if (req.query.headId) filters.headId = String(req.query.headId);
      if (req.query.status) filters.status = String(req.query.status);
      const cycles = archive.listCycles(filters);
      res.json({ count: cycles.length, cycles });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/eyelidAcceptance/heads/:headId/history', (req, res, next) => {
    try {
      const history = archive.getHeadHistory(req.params.headId);
      if (!history) return res.status(404).json({ error: '偶头无验收履历', code: 'HEAD_NOT_FOUND' });
      res.json(history);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/eyelidAcceptance/heads/:headId/release', (req, res, next) => {
    try {
      res.json(archive.getReleaseStatus(req.params.headId));
    } catch (error) {
      next(error);
    }
  });

  // ---------- 错误处理 ----------

  app.use((error, req, res, next) => {
    if (error instanceof SyntaxError) {
      return res.status(400).json({ code: 'BAD_JSON', error: '请求体不是合法 JSON' });
    }
    if (error instanceof HttpError) {
      return res.status(error.status).json({
        code: error.code,
        error: error.message,
        ...(error.details ? { details: error.details } : {})
      });
    }
    return res.status(500).json({ code: 'INTERNAL', error: error.message || 'server error' });
  });

  app.archive = archive;
  return app;
}

module.exports = { createIntakeApp, REPLACEABLE_PARTS: ['眼珠', '机关'] };
