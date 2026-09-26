"""Hana-ComfyUI 桥 · ComfyUI 侧（P1 只读阶段）。

职责只有两件：
  1. 让 ComfyUI 前端加载 js/hana-bridge.js（通过 WEB_DIRECTORY）；
  2. 提供本机路由，把「外部调用」转成「前端扩展执行」。

链路（见 docs/画布共驾方案-20260926.md §2.2）：
  Hana 工具 → App → 中继 → POST /api/hana_bridge/call
    → send_sync 经 ComfyUI 自带 /ws 推给前端扩展 → 扩展读画布
    → POST /api/hana_bridge/result → 路由回原路返回

为什么必须由 ComfyUI 自己加载这份 JS：
  工作区 iframe 直连 8188 属跨源，壳页与中继都够不着 window.app；且 ComfyUI 自己的 CSP
  （connect-src 'self' data:，见 server.py）禁止前端连外部端口。只有跑在 8188 源下的
  扩展既能读写画布，又能同源回传。

安全：
  · /call 校验 X-Hana-Token；token 首次加载时随机生成、落在同目录 .token，中继读同一文件比对。
  · 8188 绑 127.0.0.1，本机之外不可达。
  · /hello 与 /result 只接受同源前端请求（不额外校验），且只读阶段无写能力。

零依赖：只用 ComfyUI 自带的 aiohttp / server 模块，不新增任何 pip 包。
"""

import asyncio
import logging
import os
import secrets

from aiohttp import web

try:
    from server import PromptServer

    _ROUTES = PromptServer.instance.routes
except Exception as _exc:  # 例如脱离 ComfyUI 环境单独 import 时的保护
    PromptServer = None
    _ROUTES = None
    _IMPORT_ERR = _exc
else:
    _IMPORT_ERR = None

WEB_DIRECTORY = "./js"

# 本包只提供前端扩展与路由，不含节点类。但 ComfyUI 的自定义节点加载器要求模块提供
# NODE_CLASS_MAPPINGS 或 comfy_entrypoint，否则会在启动日志里打一条 warning、并把本包记成
# 「IMPORT FAILED」（功能不受影响：WEB_DIRECTORY 的注册先于该检查，见 nodes.py 里
# 对 WEB_DIRECTORY 与 NODE_CLASS_MAPPINGS 的处理顺序）。给两个空映射即可让启动日志干净，
# 语义上也准确：本包确实不注册任何节点。
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY"]

LOG = logging.getLogger("hana_bridge")
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(_PKG_DIR, ".token")

try:
    CALL_TIMEOUT_SEC = max(1.0, float(os.environ.get("HANA_BRIDGE_TIMEOUT", "") or 6))
except ValueError:
    CALL_TIMEOUT_SEC = 6.0

# 前端扩展上报的 clientId（即 /ws 的 sid）。多标签时保留最近一个。
_frontend = {"sid": None}
# 进行中的调用：reqId → asyncio.Future
_pending = {}


def _load_token():
    """读同目录 .token；没有就生成一个并写回（两侧读同一文件，天然一致）。"""
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as fh:
            tok = (fh.read() or "").strip()
        if tok:
            return tok
    except FileNotFoundError:
        pass
    except OSError as exc:
        LOG.warning("hana_bridge: 读取 token 失败：%s", exc)

    tok = secrets.token_urlsafe(32)
    try:
        with open(TOKEN_FILE, "w", encoding="utf-8") as fh:
            fh.write(tok)
    except OSError as exc:
        LOG.warning("hana_bridge: 写入 token 失败（本次仅内存有效）：%s", exc)
    return tok


TOKEN = _load_token()


async def _json(request):
    try:
        data = await request.json()
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _token_ok(request):
    got = request.headers.get("X-Hana-Token") or ""
    return bool(got) and secrets.compare_digest(got, TOKEN)


if _ROUTES is not None:

    @_ROUTES.post("/hana_bridge/hello")
    async def _hana_hello(request):
        data = await _json(request)
        sid = str(data.get("clientId") or "").strip()
        if sid:
            if _frontend["sid"] != sid:
                LOG.info("hana_bridge: 前端已上报（sid=%s）", sid)
            _frontend["sid"] = sid
        return web.json_response({"ok": True})

    @_ROUTES.post("/hana_bridge/result")
    async def _hana_result(request):
        data = await _json(request)
        rid = str(data.get("id") or "")
        fut = _pending.pop(rid, None)
        if fut is not None and not fut.done():
            fut.set_result(data)
        return web.json_response({"ok": True})

    @_ROUTES.post("/hana_bridge/call")
    async def _hana_call(request):
        if not _token_ok(request):
            return web.json_response({"ok": False, "error": "token_invalid"}, status=403)

        body = await _json(request)
        op = str(body.get("op") or "").strip()
        if not op:
            return web.json_response({"ok": False, "error": "missing_op"}, status=400)

        # 分发一律走广播（sid=None）：页面刷新 / 重连不会重跑 setup，hello 上报的 sid 可能已失效，
        # 而 server.py 实测 send_json(sid=None) 会发给当前所有连接——只要有一个前端在就能收到。
        # 多标签时都会收到并回传，这里只取最先到的那份（_pending.pop 幂等）。
        sid = str(body.get("sid") or "").strip() or None

        rid = secrets.token_hex(8)
        fut = asyncio.get_running_loop().create_future()
        _pending[rid] = fut
        try:
            # 注意签名顺序：send_sync(event, data, sid)
            PromptServer.instance.send_sync(
                "hana_bridge.call", {"id": rid, "op": op, "args": body.get("args") or {}}, sid
            )
            res = await asyncio.wait_for(fut, timeout=CALL_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            _pending.pop(rid, None)
            return web.json_response(
                {
                    "ok": False,
                    "error": "timeout",
                    "detail": "前端 %gs 内未回传：可能没有打开的 ComfyUI 页面（或前端扩展未加载 / 正在执行阻塞）"
                    % CALL_TIMEOUT_SEC,
                },
                status=504,
            )
        except Exception as exc:  # noqa: BLE001
            _pending.pop(rid, None)
            return web.json_response({"ok": False, "error": "internal", "detail": str(exc)}, status=500)

        payload = {"ok": bool(res.get("ok"))}
        if "data" in res:
            payload["data"] = res["data"]
        if res.get("error"):
            payload["error"] = res["error"]
        return web.json_response(payload)

    @_ROUTES.get("/hana_bridge/ping")
    async def _hana_ping(request):
        return web.json_response(
            {
                "ok": True,
                "frontend": _frontend["sid"],
                "pending": len(_pending),
                "timeoutSec": CALL_TIMEOUT_SEC,
            }
        )

    LOG.info(
        "hana_bridge: 路由已注册（call / hello / result / ping），token 就绪，超时 %gs",
        CALL_TIMEOUT_SEC,
    )
else:
    LOG.warning("hana_bridge: 未取到 PromptServer.instance.routes，路由未注册（%s）", _IMPORT_ERR)
