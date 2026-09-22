# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 偶头眼睑气密验收台

入口、判定、档案三个业务模块位于 `acceptance/`：

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 入口 | `acceptance/intake.js` | HTTP 校验、命令编排、签发/复用回执 |
| 判定 | `acceptance/policy.js` | 阈值与状态机（纯规则，无 I/O） |
| 档案 | `acceptance/archive.js` | 事件溯源档案、未结束验收唯一性、幂等台账、原子持久化 |

验收规则：

- 每次登记四要素：眼睑间隙、气室压降、开合次数、测试员。
- 间隙 **超过 0.2mm**、压降 **超过 5Pa** 或开合 **少于 8 次**：只转「待调」（0.2、5、8 边界值达标）。
- 每个偶头同时只留一份未结束验收（待调/复测中）。
- 复测须由**未参与初测者**执行，每次测量间隔不少于 **30 分钟**，**连续两次均达标**才放行；一次不达标回待调并清零。
- 更换**眼珠或机关**后原结论立即作废（放行取消），须重新登记初测。
- 命令带 `requestId`（或 `Idempotency-Key` 头），重复请求沿用首次回执（回执号 `HS-xxxxxx`）。

接口（前缀 `/api/eyelidAcceptance`）：

- `POST /tests` 登记初测；`POST /retests` 登记复测；`POST /replacements` 登记更换眼珠/机关（作废重判）
- `GET /cycles` 验收列表（可按 `headId`、`status` 过滤）
- `GET /heads/:headId/history` 单头履历
- `GET /heads/:headId/release` 放行状态

档案持久化在 `data/eyelid-acceptance.json`（零外部依赖，临时文件 + rename 原子写入）。
通用接口需要 sqlite3 CLI；若环境缺少 sqlite3，不影响本验收台启动。

```bash
npm test     # 21 项验收规则测试
```

