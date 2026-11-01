# 接入：ComfyUI 节点的 API 调用指向 Hana（LLM 网关）

- 日期：2026-11-01
- 状态：**已真机跑通**（文本 / 流式 / 图片三条路径 + 真实节点 `PromptTranslate`）
- 版本：hui v0.21.1

---

## 1. 这套东西是什么

ComfyUI 里做「反推、翻译、LLM 对话」的节点，绝大多数都是 OpenAI 兼容客户端，只认一个 `base_url` 和一个 key。hui 现在在本机开了一个 **OpenAI 兼容端点**，这些节点把 `base_url` 指过来、key 随便填，就能直接用上 Hana 侧的模型，不必给每个插件单独配 key。

```
ComfyUI 节点 ──HTTP──▶ 127.0.0.1:8790/v1  （中继进程托管）
                              │
                              ▼  长轮询取任务
                        hui App 进程 worker
                              │  sdk.models.stream（宿主持有凭据）
                              ▼
                        Hana 模型通道（44 个模型）
```

## 2. 端点

| 路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | `{ ok, app, role, workerOnline, models }`，用来判断链路是否就绪 |
| `GET /v1/models` | Bearer | OpenAI 列表结构，`id` 形如 `provider/modelId` |
| `POST /v1/chat/completions` | Bearer | 支持 `stream: true`（SSE）与非流式；支持 `image_url`（base64 data URL） |

**token** 在 `%USERPROFILE%\.hanako\app-data\comfyui-hana\llm-gateway.json` 的 `token` 字段。key 填任意值不行，必须填这个 token。

## 3. 架构上为什么这样切（踩过的坑，别重走）

1. **App 进程不能监听端口**。AppHost 子进程不开 `--allow-net`，`listen()` 抛 `ERR_ACCESS_DENIED`，而且它在内部 microtask 里抛，`try/catch` 和 `server.on("error")` 都拦不住，会把整个 App 进程带崩。所以网关监听的活儿交给中继。
2. **中继自己不能调模型**。宿主 App 总线白名单里只有 `model:list`，没有 `model:stream`。所以模型执行必须回到 App 进程。
3. **App 到中继走 `sdk.runtime.fetch`**（项目里的 `relayFetch`），带 `x-comfy-relay-key`，支持 POST。不要用 `sdk.network.fetch` 打回环：manifest 只声明了 GET，POST 会被挡。
4. **模型调用要挂持久 task**。worker 是常驻后台循环，没有调用上下文；不传 `taskId` 会报 `App invocation expired or belongs to another App`。worker 现在持有一个 `metadata.purpose = "llm-gateway-worker"` 的 App task，失效自动重建。

## 4. 模型选择与名字映射

- 目录来自 `sdk.models.list()`，本机 44 条。
- 请求里的 `model` 按这个顺序解析：`modelMap[model]` → 目录里直配（`provider/modelId`）→ `defaultModel` → 目录第一条。
- 默认配置：`defaultModel = "deepseek/deepseek-flash"`，`modelMap` 把 `gpt-4o` / `gpt-4-turbo` / `gpt-4o-mini` / `gpt-3.5-turbo` 等常见名字全部指向 `deepseek/deepseek-flash`。
- **deepseek-flash 支持图片输入**（实测能读图），所以文本和视觉默认都用它。

## 5. 已经接入的节点：ComfyUI-Prompt-Assistant

它的配置在 `D:\ComfyUI\ComfyUI\user\default\prompt-assistant\config\config.json`（不是插件目录下那份）。

已加入服务 `hana`：

```json
{
  "id": "hana",
  "type": "openai_compatible",
  "name": "Hana",
  "base_url": "http://127.0.0.1:8790/v1",
  "api_key": "<llm-gateway.json 里的 token>",
  "llm_models": [{ "name": "deepseek/deepseek-flash", "is_default": true, ... }],
  "vlm_models": [{ "name": "deepseek/deepseek-flash", "is_default": true, ... }]
}
```

`current_services.llm` 与 `vlm` 都指向 `hana/deepseek/deepseek-flash`。改完需**重启 ComfyUI**（插件在加载时读配置）。

节点里 `translate_service` 会多出一项 `Hana/deepseek/deepseek-flash`。实测：

```
a cat sitting on a sofa under warm afternoon light
→ 一只猫坐在沙发上，沐浴在温暖的午后光线中
```

## 6. 接别的节点怎么做

大多数插件只要有这两个入口，把地址填成 `http://127.0.0.1:8790/v1`、key 填 token 即可：

- 环境变量型：`OPENAI_BASE_URL` / `OPENAI_API_BASE` / `OPENAI_API_KEY`
- 配置文件型：找插件配置里的 `base_url` 与 `api_key`
- 只认 `api.openai.com` 写死的节点、以及官方走 `api.comfy.org` 的 API 节点：**接不了**，地址不在节点手里。

## 7. 运维

- `comfyui(action="llmGateway", op="status")`：看 worker 是否在跑、中继是否可达、目录条数、token 尾号。
- `op="stop"` / `op="start"`：停/起 worker（不影响 ComfyUI 本身）。
- 中继重启后 worker 会重推目录；网关端口被占时中继只 warn，不影响主服务。
- 网关配置：`app-data\comfyui-hana\llm-gateway.json`（`enabled` / `port` / `token` / `defaultModel` / `modelMap`）。

## 8. 未做 / 已知限制

- 非流式响应的 `usage` 计数目前是 0（宿主侧未回传 token 数）。
- 一次只有 8 个并发模型请求上限（宿主限制），超了会显式报错。
- 只实现了 `chat/completions`；`/v1/completions`、`/v1/embeddings` 未做。
- 图片只收 base64 data URL；直接给远程 URL 会被忽略并记 warn。
- worker 不在线时 `POST /v1/chat/completions` 立刻 503，不会挂起等待。
