# Hana-ComfyUI（v2 App，开发仓）· v0.6

把本机 ComfyUI（服务在 `127.0.0.1:8188`）接进 HanaAgent 的 v2 App。
**开发仓**：本目录（`app/`）；**宿主副本**：`<HANA_HOME>/apps/comfyui-hana/`（由 `../tools/sync-to-host.ps1` 同步）。

## 状态（M0–M2 完成，M2.5/M2.6 收尾）

- 工具 `comfyui` 全动作：status / submit / query / result / cancel / workflows / upload / service
- 任务桥：submit → `ctx.tasks.create({callToken, delivery:"next-step"})` → 2s 轮询结算（complete/fail/cancel）
  - 能力已扩容（2026-09-21 批准并生效）：`app/tasks.manage` + `app/session.start-turn`（ledger=always）
  - **子代理会话边界**：宿主可靠投递只写桌面会话；从子代理会话发起的任务不会自动回执（工具文案会如实标注；`query` 的「投递」行可查 `published/delivered`）
- 任务卡：`ui/task.html`（轮询 `GET /comfyui-hana/task?id=`；缩略图经 `_surface` 凭据路径）
- 中继 v0.3：订阅 8188 `/ws` 进度事件缓存（`/_relay/prompts`）、历史摘要（`/_relay/history`）、
  `/_relay/fs/{stat,read}` + `/_relay/upload`（controlKey 保护）、日志落盘（`app-data/comfyui-hana/logs/relay.log`，>5MiB 滚动 `.1`）
- 环境自举（v0.3 新增）：后端不可达时中继附「本机安装探测」（`/_relay/status` 的 `env` 字段；或 `node runtime/comfy-relay.mjs --probe-env` 直看）；
  壳页按「装了没跑 / 未检测到」分流引导（复制引导语→交给 Hana）；安装手册 `skills/comfyui-hana/INSTALL.md`
- 状态面板（v0.4 新增）：整页工作区左侧栏（functionPanel）带 GPU/CPU/内存实时图表（任务管理器风格曲线）
  与「释放显存」按钮（`POST /comfyui-hana/release` → 中继反代后端 `/free`）；指标经中继 `/_relay/metrics`
  （nvidia-smi 4s 缓存 + os 模块 CPU/内存采样；零新增能力）
- 安装引导（v0.5 新增）：检测到「未装 ComfyUI」时弹窗——选安装位置（中继盘位探测给候选 + 剩余空间 + 推荐）/ 自定义目录（宿主目录选择器，写回配置）；
  两个动作：直接发起安装（`session:create` + `session:send` 在默认工作区建会话投递提示词）/ 复制安装指令；
  路由 `install-targets|install-target|install-prompt|install-launch`；中继新增 `/_relay/drives`、`/_relay/custom-roots`；
  能力新增 `app/resources.read`（目录选择器用）
- 服务起停（v0.6 新增，M9）：左侧面板「启动服务 / 停止服务」+ 工具 `comfyui(action="service", op=status|start|stop)`；
  启动经 Windows 计划任务（`HanaComfyUI-Backend`）以当前用户身份拉起——中继自身跑在宿主沙箱 job 里，直接 spawn 的子进程
  会随中继退出被回收（detached 也逃不出），走计划任务才**独立于 Hana 存活**；撤下走 `taskkill /T /F`（受限令牌实测可终止）；
  中继新增 `/_relay/backend/{start,stop,proc}`，App 新增路由 `backend/start|stop|backend`；服务日志 `app-data/comfyui-hana/logs/backend.log`；
  同时把面板原「重试启动」正名为「重启中继」（它只重启受管 runtime，与 ComfyUI 服务本体是两件事）
- 已实测：中继端点 11/11；中继级 E2E（EmptyImage→SaveImage 纯 CPU）9/9 ×3；宿主段工具全动作 17/17；
  cancel 定向中断 10/10（M3）；静态校验 ok

## 关键口径

- **clientId 配对**：ComfyUI 只把执行事件发给提交方 `client_id` 的 WS 连接；中继订阅与提交共用
  同一个「每次启动随机」的 clientId（`comfyui-hana-relay-<hex>`）——不要复用固定 id（旧连接关闭时 Host 侧按 sid 清理，会误删新连接）。
- **产物定位**：ComfyUI 安装根的 `output/...`（安装根由中继环境探测自动识别，不硬编码；`/_relay/fs/stat` 校验存在）；预览 URL 走代理 `view?`。
- submit 不支持「UI 格式 → API」的完整转换：子图/环绕/静音/旁路节点会明确报错，改用「导出（API 格式）」。
- 投递诊断：`ctx.tasks.getDelivery`（`query` 已暴露）；宿主被卡记录在 `%HANA_HOME%\.ephemeral\deferred-tasks.json`。

## 本地开发

```powershell
# 静态校验（先 staging 到目录名=id；脚本在项目根 tools/ 下）
pwsh -NoProfile -File ..\tools\validate-app.ps1

# 测试（按需；脚本在项目根 tools/ 下）
node .\runtime\comfy-relay.mjs --probe-env          # 安装探测（应输出本机 ComfyUI 安装 JSON）
node ..\tools\m2-checks\test-relay-v02.mjs          # 中继新端点
node ..\tools\m2-checks\test-e2e-relay.mjs          # 中继级 E2E（前置：8188 队列为空）
node ..\tools\m2-checks\host-stage.mjs              # 宿主段工具全动作
node ..\tools\m3-checks\test-cancel.mjs             # cancel 定向取消

# 同步到宿主副本（-DryRun 预览）
pwsh -NoProfile -File ..\tools\sync-to-host.ps1 -DryRun
```

## 纪律

- 不在用户队列非空时提交测试任务；测试工作流一律极小（纯 CPU）。
- 宿主安装/重启由主脑统一安排；App 级 reload 可自行执行（本仓流程）。
- 项目全景与待办见 `..\README.md` 与 `..\docs\待办与验收清单.md`。
