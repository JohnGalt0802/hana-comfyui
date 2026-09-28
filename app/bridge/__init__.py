"""Hana-ComfyUI 桥 · ComfyUI 侧（P1 只读阶段）。

职责只有两件：
  1. 让 ComfyUI 前端加载 js/hana-bridge-<构建>.js（通过 WEB_DIRECTORY）；
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
import time

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

# 桥构建标识（与 js 侧 BUILD_TAG 同源口径；2026-09-28 起取代此前的陈旧占位标签）。
# 信息口：/hana_bridge/diag 的 file.hasBuildTag / file.buildTag。
BRIDGE_BUILD_TAG = "2026-09-28 hana-bridge-28105930"

# 前端扩展上报的 clientId（即 /ws 的 sid）。多标签时保留最近一个。
_frontend = {"sid": None}
# 进行中的调用：reqId → asyncio.Future
_pending = {}
# 在线前端账本：sid → {workflow, path, href, at, seenAt}。
# 多页面路由靠它：一个页面对应一个工作流名（对应一个 json），定向时按工作流名找 sid。
_frontends = {}
# 最近一次画布状态快照：由前端扩展在画布变化后主动推来。
# 为何缓在服务端：人与 agent 的对话不是持续态，agent 多半在「宿主聊天页」对话、
# ComfyUI 页面并不开着；缓一份在服务端，agent 就随时拿得到「手边快照」，
# 不依赖「此刻页面在线」。
_state = {"at": None, "ts": None, "revision": None, "summary": None, "sid": None}

# ── 前端账本过期判定（TTL，2026-09-28 补缺）─────────────────────────────
# 背景：页面关闭/冻结后不再上报，_frontends 条目不清理（无 TTL）；按 workflow 名
# 定向时死条目（hits[0] 取最早插入）会截胡活页 → 活页收不到、误报 no_page/超时。
# 语义：seenAt 超过 TTL 视作过期（死条目）。消费点——
#   · canvas.pages 输出带 stale 标记（保留可观测性，不删条目）；
#   · 按名/前缀定向只在未过期集合里取；只剩过期时明确报 no_live_page（不静默退回死条目）；
#   · 收到定向回传 = 存活证明，顺带刷新 seenAt。
# 默认 15 分钟（页面冻结实测 4–5 分钟失联，取裕量）。调测口：环境变量
# HANA_BRIDGE_FRONTEND_TTL_SEC 或同目录 frontend_ttl_sec.txt（整数秒）；调用时读取。
_FRONTEND_TTL_DEFAULT = 15 * 60.0


def _frontend_ttl_sec():
    raw = os.environ.get("HANA_BRIDGE_FRONTEND_TTL_SEC", "").strip()
    if not raw:
        try:
            with open(os.path.join(_PKG_DIR, "frontend_ttl_sec.txt"), "r", encoding="utf-8") as fh:
                raw = (fh.read() or "").strip()
        except OSError:
            raw = ""
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return _FRONTEND_TTL_DEFAULT
    return val if val > 0 else _FRONTEND_TTL_DEFAULT


def _age_sec(entry, now):
    try:
        seen = float((entry or {}).get("seenAt") or 0)
    except (TypeError, ValueError):
        seen = 0.0
    return now - seen


def _is_fresh(entry, now, ttl):
    return _age_sec(entry, now) <= ttl


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


def _note_frontend(sid, data, kind):
    """记录/更新一个前端的身份（它开着哪个工作流）。"""
    if not sid:
        return
    wf = data.get("workflow") if isinstance(data.get("workflow"), dict) else {}
    _frontends[sid] = {
        "workflow": str(wf.get("name") or "").strip() or None,
        "path": wf.get("path"),
        "modified": wf.get("modified"),
        "href": str(data.get("href") or "").strip() or None,
        "at": data.get("at"),
        "seenAt": time.time(),
        "kind": kind,
    }
    _frontend["sid"] = sid


def _pages_brief():
    """错误响应里的页面简表（诊断用；带 stale 标记）。"""
    now = time.time()
    ttl = _frontend_ttl_sec()
    return [
        {
            "sid": (k or "")[:8],
            "workflow": v.get("workflow"),
            "stale": _age_sec(v, now) > ttl,
        }
        for k, v in _frontends.items()
    ]


def _pages_payload():
    now = time.time()
    ttl = _frontend_ttl_sec()
    pages = []
    for s, v in _frontends.items():
        age = round(_age_sec(v, now), 1)
        pages.append(
            {
                "sid": (s or "")[:8],
                "sidFull": s,
                "workflow": v.get("workflow"),
                "path": v.get("path"),
                "modified": v.get("modified"),
                "ageSec": age,
                "href": v.get("href"),
                "kind": v.get("kind"),
                "stale": age > ttl,  # 过期标记：消费方取活页用 not stale（路由侧已自动跳过）
            }
        )
    pages.sort(key=lambda p: p["ageSec"])
    return {
        "pages": pages,
        "count": len(pages),
        "liveCount": sum(1 for p in pages if not p["stale"]),
        "ttlSec": round(ttl, 1),
    }


def _state_age_sec():
    """快照年龄（秒）；无快照返回 None。"""
    ts = _state.get("ts")
    if not ts:
        return None
    try:
        return round(time.time() - (float(ts) / 1000.0), 1)
    except (TypeError, ValueError):
        return None


def _state_payload():
    return {
        "at": _state["at"],
        "ageSec": _state_age_sec(),
        "revision": _state["revision"],
        "summary": _state["summary"],
        "sid": _state["sid"],
        "hasState": _state["summary"] is not None,
    }


if _ROUTES is not None:

    @_ROUTES.post("/hana_bridge/hello")
    async def _hana_hello(request):
        data = await _json(request)
        sid = str(data.get("clientId") or "").strip()
        if sid:
            if _frontend["sid"] != sid:
                LOG.info("hana_bridge: 前端已上报（sid=%s）", sid)
            _note_frontend(sid, data, "hello")
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

        # 状态快照不走前端：直接回服务端缓存（这正是「提前做」的意义——
        # ComfyUI 页面没开着也能拿到上次的快照）
        if op == "canvas.state":
            return web.json_response({"ok": True, "data": _state_payload()})

        # 页面清单（多页面路由的「眼睛」）：现在有谁在线、各自开着哪个工作流
        if op == "canvas.pages":
            return web.json_response({"ok": True, "data": _pages_payload()})

        # 定向策略（2026-09-27，多页面；2026-09-28 加 TTL）：
        # ① 给了 workflow → 找同名页面定向；找不到就明确报错，**不退回广播**（避免误伤别的页面）
        #    TTL：只在未过期集合里取；只剩过期条目时明确报 no_live_page（不静默退回死条目）
        # ② 没给 → 广播（向后兼容；单页面时行为不变。页面刷新/重连不会重跑 setup，
        #    而 server.py 实测 send_json(sid=None) 会发给当前所有连接，只要有一个前端在就能收到）
        now = time.time()
        ttl = _frontend_ttl_sec()
        want_wf = str(body.get("workflow") or "").strip()
        sid = str(body.get("sid") or "").strip() or None
        # 页面清单里给的是 8 位短 sid（便于人读），定向时允许前缀匹配；
        # 只有唯一命中才认，多个命中视为歧义、不猜。
        # 2026-09-28（TTL）：精确 sid 保持原语义（可直指任意条目，含探死条目做诊断）；
        # 前缀解析只认活条目；只剩过期命中时明确报 no_live_page，不静默退回死条目。
        if sid and sid not in _frontends:
            pref = [k for k in _frontends if (k or "").startswith(sid)]
            pref_live = [k for k in pref if _is_fresh(_frontends.get(k) or {}, now, ttl)]
            if len(pref_live) == 1:
                sid = pref_live[0]
            elif pref and not pref_live:
                return web.json_response(
                    {
                        "ok": False,
                        "error": "no_live_page",
                        "detail": "sid 前缀「%s」只剩过期页面（%d 条，已跳过）" % (sid, len(pref)),
                        "pages": _pages_brief(),
                    },
                    status=409,
                )
            else:
                sid = None  # 无命中/歧义（多个活命中）→ 维持「不猜」语义
        routed = None
        if want_wf:
            hits_live = [
                s
                for s, v in _frontends.items()
                if (v.get("workflow") or "") == want_wf and _is_fresh(v, now, ttl)
            ]
            hits_stale = [
                s
                for s, v in _frontends.items()
                if (v.get("workflow") or "") == want_wf and not _is_fresh(v, now, ttl)
            ]
            if not hits_live:
                if hits_stale:
                    return web.json_response(
                        {
                            "ok": False,
                            "error": "no_live_page",
                            "detail": "「%s」的匹配页面均已过期（stale %d 条，已跳过）" % (want_wf, len(hits_stale)),
                            "pages": _pages_brief(),
                        },
                        status=409,
                    )
                return web.json_response(
                    {
                        "ok": False,
                        "error": "no_page",
                        "detail": "没有页面正打开「%s」" % want_wf,
                        "pages": _pages_brief(),
                    },
                    status=409,
                )
            sid = hits_live[0]
            routed = {"workflow": want_wf, "matched": len(hits_live)}
            if hits_stale:
                routed["staleSkipped"] = len(hits_stale)
                LOG.info(
                    "hana_bridge: 定向「%s」命中 %d 活页、跳过 %d 条过期条目",
                    want_wf,
                    len(hits_live),
                    len(hits_stale),
                )

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

        # 收到回传 = 该页存活证明：定向命中时顺带刷新 seenAt（广播无法归属，不刷）。
        if sid and sid in _frontends:
            _frontends[sid]["seenAt"] = time.time()

        payload = {"ok": bool(res.get("ok"))}
        if "data" in res:
            payload["data"] = res["data"]
        if res.get("error"):
            payload["error"] = res["error"]
        if routed:
            payload["routed"] = routed
        return web.json_response(payload)

    @_ROUTES.post("/hana_bridge/state")
    async def _hana_state_push(request):
        """前端扩展在画布变化后推来的快照（同源，不校验 token，只存摘要）。"""
        data = await _json(request)
        summary = data.get("summary")
        if not isinstance(summary, dict):
            return web.json_response({"ok": False, "error": "missing_summary"}, status=400)
        _state.update(
            {
                "at": data.get("at"),
                "ts": data.get("ts"),
                "revision": data.get("revision"),
                "summary": summary,
                "sid": str(data.get("sid") or "").strip() or None,
            }
        )
        _frontend["sid"] = _state["sid"] or _frontend["sid"]
        _note_frontend(_state["sid"], data, "state")
        return web.json_response({"ok": True, "revision": _state["revision"]})

    @_ROUTES.get("/hana_bridge/diag")
    async def _hana_diag(request):
        """自检：把扩展挂载的真实状况报出来（只读）。
        目的：弄清前端到底从哪里加载桥 js（hana-bridge-<构建>.js）。"""
        try:
            import nodes as _nodes
            dirs = dict(getattr(_nodes, "EXTENSION_WEB_DIRS", {}) or {})
        except Exception as exc:  # noqa: BLE001
            dirs = {"__err__": str(exc)}
        here = os.path.dirname(os.path.abspath(__file__))
        js_dir = os.path.join(here, "js")
        # 2026-09-28：桥 js 为具名构建文件（hana-bridge-<ddHHmmss>.js，部署时清空重建）。
        # 动态扫出当前活动文件；同目录 .bak-* 备份不参与。
        info = {}
        try:
            candidates = sorted(
                f
                for f in os.listdir(js_dir)
                if f.startswith("hana-bridge-") and f.endswith(".js") and ".bak" not in f
            )
            info["jsCandidates"] = candidates
            if not candidates:
                info["jsErr"] = "未找到桥 js（hana-bridge-*.js）"
            else:
                js_file = os.path.join(js_dir, candidates[-1])
                with open(js_file, "r", encoding="utf-8") as fh:
                    txt = fh.read()
                info.update(
                    {
                        "jsPath": js_file,
                        "jsBytes": len(txt.encode("utf-8")),
                        "hasDiag": "api.diag" in txt,
                        "hasBuildTag": BRIDGE_BUILD_TAG in txt,
                        "buildTag": BRIDGE_BUILD_TAG,
                    }
                )
        except Exception as exc:  # noqa: BLE001
            info = {"jsErr": str(exc)}
        return web.json_response(
            {
                "ok": True,
                "extensionWebDirs": {k: str(v) for k, v in dirs.items()},
                "pkgDir": here,
                "webDirectory": WEB_DIRECTORY,
                "file": info,
            }
        )

    @_ROUTES.get("/hana_bridge/ping")
    async def _hana_ping(request):
        return web.json_response(
            {
                "ok": True,
                "frontend": _frontend["sid"],
                "pending": len(_pending),
                "timeoutSec": CALL_TIMEOUT_SEC,
                "stateAgeSec": _state_age_sec(),
                "stateRevision": _state["revision"],
                "pages": [{"sid": (k or "")[:8], "workflow": v.get("workflow")} for k, v in _frontends.items()],
            }
        )

    LOG.info(
        "hana_bridge: 路由已注册（call / hello / result / ping），token 就绪，超时 %gs",
        CALL_TIMEOUT_SEC,
    )
else:
    LOG.warning("hana_bridge: 未取到 PromptServer.instance.routes，路由未注册（%s）", _IMPORT_ERR)
