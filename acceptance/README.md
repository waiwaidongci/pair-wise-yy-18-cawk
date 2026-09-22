# 偶头眼睑气密验收台

为木偶戏班建立的偶头眼睑气密验收子系统。入口、判定、档案各由一个业务模块承担，
**零第三方依赖**（仅用 Node.js 标准库），数据持久化到 `data/acceptance.json`。

## 启动与测试

```bash
npm run acceptance     # 启动验收台，默认 http://localhost:3915（PORT 可覆盖）
npm test               # 运行全部测试（node:test，共 20 个）
```

## 三模块边界

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 入口（intake） | `lib/intake.js` | 受理与编排：首验登记、开立复测、复测测量、换件登记入口；四项校验、唯一未结束单、复测人资格、三十分钟两次、幂等回执 |
| 判定（decision） | `lib/decision.js` | 怎么判：首验判定、复测判定（达标/不达标只引用 `lib/rules.js` 的阈值） |
| 档案（archive） | `lib/archive.js` | 归档与唯一只读口径：列表、单头履历、放行状态、换件作废登记 |

阈值在 `lib/rules.js` 集中定义（判定模块不得在别处硬编码）：

- 眼睑间隙 **> 0.2 毫米** 不达标（0.2 本身达标）
- 气室压降 **> 5 帕** 不达标（5 本身达标）
- 开合次数 **< 8 次** 不达标（8 本身达标）
- 复测间隔 `RETEST_INTERVAL_MS = 30 分钟`

## 业务规则

1. **四项必须登记**：眼睑间隙 `gapMm`、气室压降 `pressureDropPa`、开合次数 `openCloseCycles`、测试员 `testerId`，缺一拒收（400）。
2. **每偶头只留一份未结束验收**：存在「验收中/复测中」单据时，不能再首验或再开复测（409）。
3. **判定结果只有两种**：
   - 四项均达标 → **待登台**（放行）；
   - 间隙超 0.2 / 压降超 5 / 开合少于 8，任一不达标 → **只转待调**（不放行）。
4. **复测**（针对「待调」单据）：
   - 由**未参与被复测链测试**的人承担（首验员及历次复测员均被系统沿链识别并拒绝，409）；
   - **隔三十分钟做两次**：第 2 次与第 1 次登记时间不足 30 分钟拒收（`RETEST_INTERVAL_NOT_MET`）；
   - **两次均达标才可登台**；任一次不达标，完成后仍只转待调，可再次开复测。
   - 口径说明：规则实现为“**两次复测测量之间至少相隔 30 分钟**”；复测负责人本人即可完成两次，前提是 TA 未参与此前测试。如需改成“距首验 30 分钟后才能复测”，仅需调整 `lib/rules.js` 与 `lib/intake.js` 的计时点。
5. **更换眼珠或机关**：`POST /api/acceptance/replacements`（`part` 仅接受 `眼珠`/`机关`）。登记后该偶头**所有**未结束单与有效结论一律置为「已作废」，放行撤销，需重新首验判定；履历保留作废原因。
6. **重复请求沿用首次回执**：写接口支持 `Idempotency-Key` 请求头或请求体 `idempotencyKey`。同键同载荷返回首次回执（响应头 `Idempotent-Replay: true`，单据编号不变）；同键不同载荷冲突拒收（409 `IDEMPOTENCY_MISMATCH`）。
7. **读取一致**：列表、单头履历、放行状态都由档案模块从同一份已提交状态派生，刷新后口径一致；状态经串行写队列 + 临时文件原子改名落盘。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/acceptance/meta` | 阈值与模块说明 |
| GET | `/api/acceptance/acceptances?headId=&status=` | 验收单列表 |
| GET | `/api/acceptance/acceptances/:id` | 单据详情 + 时间线 |
| GET | `/api/acceptance/heads` | 全部偶头放行状态 |
| GET | `/api/acceptance/heads/:headId` | 单头放行状态 |
| GET | `/api/acceptance/heads/:headId/history` | 单头履历（验收链 + 换件） |
| POST | `/api/acceptance/initial` | 首验登记（当场判定） |
| POST | `/api/acceptance/retests` | 开立复测单 |
| POST | `/api/acceptance/retest-trials` | 复测第 1/2 次测量（第 2 次自动结判） |
| POST | `/api/acceptance/replacements` | 换眼珠/机关（原结论作废重判） |

### 典型流程

```bash
# 1) 首验（开合只有 2 次 -> 待调）
curl -s -X POST localhost:3915/api/acceptance/initial \
  -H 'Content-Type: application/json' \
  -d '{"headId":"头-001","gapMm":0.18,"pressureDropPa":4.2,"openCloseCycles":2,"testerId":"张三"}'

# 2) 未参与者（李四）开复测
curl -s -X POST localhost:3915/api/acceptance/retests \
  -H 'Content-Type: application/json' -d '{"headId":"头-001","testerId":"李四"}'

# 3) 第一次复测（李四，达标）
curl -s -X POST localhost:3915/api/acceptance/retest-trials \
  -H 'Content-Type: application/json' \
  -d '{"acceptanceId":"rt_...","gapMm":0.15,"pressureDropPa":4.0,"openCloseCycles":12,"testerId":"李四"}'

# 4) 隔 30 分钟后第二次复测（仍由李四，达标）-> 待登台、放行
# 5) 若之后换眼珠/机关：
curl -s -X POST localhost:3915/api/acceptance/replacements \
  -H 'Content-Type: application/json' -d '{"headId":"头-001","part":"眼珠","operatorId":"王五"}'
```

## 状态机

```
首验登记 ──达标──> 待登台（放行）
        └─不达标─> 待调 ──开立复测(未参与者)──> 复测中
                                   第1次测量 ─30分钟后─> 第2次测量
                          两次均达标 -> 待登台；任一不达标 -> 待调（可再复测）
换眼珠/机关 ──> 该头所有单据「已作废」，放行撤销，须重新首验
```
