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
import re
import secrets
import time

from aiohttp import web

try:
    import folder_paths

    _folder_paths_err = None
except Exception as _exc:  # 脱离 ComfyUI 环境单独 import 时的保护（P1-C1）
    folder_paths = None
    _folder_paths_err = _exc

try:
    from app.user_manager import default_user as _default_user

    _user_manager = type("_UM", (), {"default_user": _default_user})  # 轻量载体，只取常量
except Exception as _exc:
    _user_manager = None
    _user_manager_err = _exc

try:
    from server import PromptServer

    _ROUTES = PromptServer.instance.routes
except Exception as _exc:  # 例如脱离 ComfyUI 环境单独 import 时的保护
    PromptServer = None
    _ROUTES = None
    _IMPORT_ERR = _exc
else:
    _IMPORT_ERR = None

try:
    from .history_store import commit as _history_commit
    from .history_store import save_commit as _history_save_commit
    from .history_store import list_commits as _history_list_commits
    from .history_store import read_snapshot as _history_read_snapshot
    from .history_store import attach_images as _history_attach_images
    from .history_store import migrate_history as _history_migrate
    from .history_store import set_head as _history_set_head
except Exception as _exc:  # P1-C1：history_store 纯标准库，正常不会失败；防御性保护
    _history_commit = None
    _history_save_commit = None
    _history_list_commits = None
    _history_read_snapshot = None
    _history_attach_images = None
    _history_migrate = None
    _history_set_head = None
    _HISTORY_IMPORT_ERR = _exc
else:
    _HISTORY_IMPORT_ERR = None

try:
    from .thumbs import make_thumb as _make_thumb
    from .thumbs import ThumbError as _thumb_err_cls
except Exception as _exc:  # 防御性保护；thumbs.py 仅依赖标准库 + PIL
    _make_thumb = None
    _thumb_err_cls = None
    _THUMB_IMPORT_ERR = _exc
else:
    _THUMB_IMPORT_ERR = None

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
# 2026-10-14（提交树与历史框对齐：缩略图统一 + 树补存档）：对齐新活动桥 hana-bridge-14120534。
# 2026-10-14（提交树跨泳道分叉线改非对称控制点/更早分叉）：对齐新活动桥 hana-bridge-14130045。
# 2026-10-15（提交历史框/树跟随 ComfyUI 明暗主题：中性色走 CSS 变量，深色档=原值）：对齐新活动桥 hana-bridge-15021810。
# 2026-10-15（变动符号移到节点下方，避开右上 ×N 上标；悬停气泡上移 13px 让位）：对齐新活动桥 hana-bridge-2610152337。
# 2026-10-19（提交树块并集 → 活图块名，与提交历史框同口径）：对齐新活动桥 hana-bridge-2610192344。
# 2026-10-23（后端 HEAD 持久化：.head.json + history-head-set；parent 由后端定）：对齐新活动桥 hana-bridge-23033000。
# 2026-10-24（提交身份与图同一时刻捕获：修「提交期间切画布 → 快照写进另一张画布历史」）：对齐新活动桥 hana-bridge-18133900。
# 2026-10-24（同类残留：出图产物回填 / 回跳写 HEAD 也用捕获身份）：对齐新活动桥 hana-bridge-18255100。
BRIDGE_BUILD_TAG = "2026-10-24 hana-bridge-18255100"

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
_state = {"at": None, "ts": None, "revision": None, "summary": None, "sid": None, "copilot": None}

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


def _live_pick(ss):
    """多活页时选「最近上报」者（seenAt 最新）——避免投进 TTL 内但实际已死/被节流的页。"""
    return max(ss, key=lambda s: (_frontends.get(s) or {}).get("seenAt") or 0) if ss else None


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
    prev = _frontends.get(sid) or {}
    entry = {
        "workflow": str(wf.get("name") or "").strip() or None,
        "path": wf.get("path"),
        "modified": wf.get("modified"),
        "href": str(data.get("href") or "").strip() or None,
        "at": data.get("at"),
        "seenAt": time.time(),
        "kind": kind,
    }
    # copilot（v2 续单 2026-10-08）：本次上报携带该字段才更新——/hana_bridge/state 每次上报均带；
    # hello 不带（旧上报语义）= 不冲刷已有值（向后兼容）。形状对齐桥 js 推送：
    # {enabled, pageKey?, updatedAt}（经 _copilot_brief 清洗）。
    if "copilot" in data:
        entry["copilot"] = _copilot_brief(data.get("copilot"))
    else:
        entry["copilot"] = prev.get("copilot")
    # nodeCount（T3-4 2026-10-10）：快照带 summary 时记该页最近节点数，供 canvas.pages 判「空图」；
    # hello / 旧上报不带 summary ＝ 沿用上次值（不冲刷）。取不到 = None（消费侧如实省略，不乱标）。
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else None
    if summary is not None and summary.get("nodeCount") is not None:
        try:
            entry["nodeCount"] = int(summary.get("nodeCount"))
        except (TypeError, ValueError):
            entry["nodeCount"] = prev.get("nodeCount")
    else:
        entry["nodeCount"] = prev.get("nodeCount")
    # openWorkflows（A 档 S1 2026-10-13）：本页「全量打开工作流」——随 /hana_bridge/state 上报。
    # 仅当本次上报带 list 时更新；hello / 旧上报不带（或非 list）＝ 沿用 prev（不冲刷，
    # 对齐 copilot/nodeCount 既有约定）。清洗后为 list；判不出（从未上报）＝ 保持缺省（消费侧省略）。
    if isinstance(data.get("openWorkflows"), list):
        entry["openWorkflows"] = _open_workflows_brief(data.get("openWorkflows"))
    else:
        entry["openWorkflows"] = prev.get("openWorkflows")
    _frontends[sid] = entry
    _frontend["sid"] = sid


def _pages_brief():
    """错误响应里的页面简表（诊断用；带 stale 标记）。"""
    now = time.time()
    ttl = _frontend_ttl_sec()
    rows = []
    for k, v in _frontends.items():
        row = {
            "sid": (k or "")[:8],
            "workflow": v.get("workflow"),
            "stale": _age_sec(v, now) > ttl,
        }
        # openCount（A 档 S1 2026-10-13）：该页打开的 Tab 数——定向失败/歧义报错时一眼判
        # 「是不是同页多开、名字撞车」；从未上报过 = 省略（对齐既有「判不出就省略」）。
        ow = v.get("openWorkflows")
        if isinstance(ow, list):
            row["openCount"] = len(ow)
        rows.append(row)
    return rows


# T3-4（2026-10-10）：页身份判定（读侧可辨；判不准则省略，绝不乱标）。
# · agent 生成的副本页命名＝「<原名> (AgentCopy) YYYYMMDD-HHmm」→ owner=agent。
# L4（2026-10-10）：锚到完整形态（(AgentCopy) + 空格 + YYYYMMDD-HHmm 时间戳，大小写敏感），
# 与 app 侧 agentCopyBaseName 的 `(?:\(\s*AgentCopy\)\s*\d{8}-\d{4})+$` 同源——避免用户页被误标 agent。
_AGENT_COPY_RE = re.compile(r"\(AgentCopy\)\s*\d{8}-\d{4}")


def _page_owner(name):
    """页归属：命名含「(AgentCopy)」＝agent 生成的副本页；有名字的其余＝user；无名字＝None（未知，省略）。"""
    if not isinstance(name, str):
        return None
    n = name.strip()
    if not n:
        return None
    return "agent" if _AGENT_COPY_RE.search(n) else "user"


def _page_empty(node_count):
    """该页是否空图（无节点）：节点数已知＝bool；未知（从未上报过 summary）＝None（省略，不乱标）。"""
    if isinstance(node_count, bool) or not isinstance(node_count, int):
        return None
    return node_count <= 0


def _pages_payload():
    now = time.time()
    ttl = _frontend_ttl_sec()
    pages = []
    for s, v in _frontends.items():
        age = round(_age_sec(v, now), 1)
        page = {
            "sid": (s or "")[:8],
            "sidFull": s,
            "workflow": v.get("workflow"),
            "path": v.get("path"),
            "modified": v.get("modified"),
            "ageSec": age,
            "href": v.get("href"),
            "kind": v.get("kind"),
            # copilot（v2 续单 2026-10-08）：该页最近上报的 {enabled, pageKey?, updatedAt}；
            # 从未上报过 = None（不猜、不借别页的值）。
            "copilot": v.get("copilot"),
            "stale": age > ttl,  # 过期标记：消费方取活页用 not stale（路由侧已自动跳过）
        }
        # T3-4（2026-10-10）：页身份标记——已知的给精确值，判不出的键直接省略（不塞 None）。
        owner = _page_owner(v.get("workflow"))
        if owner is not None:
            page["owner"] = owner
        empty = _page_empty(v.get("nodeCount"))
        if empty is not None:
            page["empty"] = empty
        # openWorkflows（A 档 S1 2026-10-13）：该页全量打开工作流数组；
        # 从未上报过 = 省略该键（不塞 None/[]，判不出就不猜）。
        ow = v.get("openWorkflows")
        if isinstance(ow, list):
            page["openWorkflows"] = ow
        pages.append(page)
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


def _copilot_brief(raw):
    """前端上报的 copilot 状态（共驾契约 §2：{enabled, pageKey?, updatedAt}，字段名冻结）。"""
    if not isinstance(raw, dict):
        return None
    page_key = raw.get("pageKey")
    if isinstance(page_key, str):
        page_key = page_key.strip() or None
    else:
        page_key = None
    updated = raw.get("updatedAt")
    if isinstance(updated, bool) or not isinstance(updated, (int, float)):
        updated = 0
    return {"enabled": bool(raw.get("enabled")), "pageKey": page_key, "updatedAt": updated}


def _open_workflows_brief(raw):
    """前端上报的「本页全量打开工作流」列表（A 档 S1 2026-10-13；桥 openWorkflowsInfo() 形状）。
    每项只留白名单字段：{name, path, key, active, dirty}；非 dict 项丢弃（乱数据不猜）。
    取不到名字 → name=None（消费侧如实当「未命名」）。"""
    out = []
    for it in raw:
        if not isinstance(it, dict):
            continue
        name = it.get("name")
        name = name.strip() if isinstance(name, str) and name.strip() else None
        dirty = it.get("dirty")
        out.append(
            {
                "name": name,
                "path": it.get("path"),
                "key": it.get("key"),
                "active": bool(it.get("active")),
                "dirty": dirty if isinstance(dirty, bool) else None,
            }
        )
    return out


def _norm_wf_name(val):
    """工作流名归一化（多标签寻址口径，2026-10-13）：去空白、反斜杠转正斜杠、去 .json 后缀、小写。"""
    s = str(val or "").strip().replace("\\", "/").lower()
    if s.endswith(".json"):
        s = s[:-5].rstrip()
    return s


def _match_open_workflows(entry, want_wf):
    """在单页 openWorkflows 里找命中项（多标签寻址，2026-10-13；缺口3）。
    命中口径：name / path 归一化后相等，或末端文件名相等（容忍后缀与目录差异）。
    返回 [ow, ...]；该页 openWorkflows 缺省 / 非法 → 返回 None（消费侧退回单值 workflow 逻辑）。"""
    ow = (entry or {}).get("openWorkflows")
    if not isinstance(ow, list):
        return None
    wn = _norm_wf_name(want_wf)
    if not wn:
        return []
    want_tail = wn.rsplit("/", 1)[-1]
    hits = []
    for it in ow:
        if not isinstance(it, dict):
            continue
        cands = (_norm_wf_name(it.get("name")), _norm_wf_name(it.get("path")))
        if wn in cands:
            hits.append(it)
            continue
        for c in cands:
            if c and c.rsplit("/", 1)[-1] == want_tail:
                hits.append(it)
                break
    return hits


def _state_payload():
    return {
        "at": _state["at"],
        "ageSec": _state_age_sec(),
        "revision": _state["revision"],
        "summary": _state["summary"],
        "sid": _state["sid"],
        "hasState": _state["summary"] is not None,
        "copilot": _state.get("copilot"),
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
            # 多标签寻址（缺口3，2026-10-13）：除前台标签名外，同时扫该页 openWorkflows；
            # 一页内多个命中取 active 的当「前台命中」，全非 active ＝「仅后台命中」。
            # activateWorkflow 特殊——它的目的就是切后台标签，故允许定向到仅后台命中页
            # （否则它自己会被判「仅后台命中」而拒绝，形成鸡生蛋）。
            allow_bg = op == "canvas.activateWorkflow"
            hits_live = []
            hits_stale = []
            hits_bg = []
            for s, v in _frontends.items():
                fg = v.get("workflow") or ""
                fg_hit = fg == want_wf
                ow_hits = _match_open_workflows(v, want_wf)  # None ＝ 该页从未上报（退回单值逻辑）
                active_hit = any(bool(it.get("active")) for it in (ow_hits or []))
                if not (fg_hit or ow_hits):
                    continue
                if not _is_fresh(v, now, ttl):  # 过期页仍跳过
                    hits_stale.append(s)
                    continue
                # allow_bg 真（activateWorkflow）时任一命中项都算可定向，归 live；
                # 此时 hits_bg 分支不再触发，不会同时进两处。
                if fg_hit or active_hit or allow_bg:
                    hits_live.append(s)
                    continue
                matches = []
                for it in ow_hits:
                    nm = it.get("name") or it.get("path")
                    if nm and nm not in matches:
                        matches.append(nm)
                hits_bg.append({"sid": (s or "")[:8], "foreground": fg or None, "matches": matches})
            if not hits_live:
                if hits_bg:
                    return web.json_response(
                        {
                            "ok": False,
                            "error": "target_not_foreground",
                            "detail": "「%s」在某页已打开但不在前台（前台为「%s」）；请先切到该标签（canvas.activateWorkflow）或让用户点回前台"
                            % (want_wf, hits_bg[0].get("foreground") or "未命名"),
                            "pages": _pages_brief(),
                            "candidates": hits_bg,
                        },
                        status=409,
                    )
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
            # 显式 sid 优先（2026-10-21，issue #2 P3-b）：
            # 调用方直接指定了目标页时，不要被 workflow 路由重新推断覆盖。
            # 否则「对干净页发的 openWorkflow」会因 workflow 命中多个活页而落到
            # _live_pick（取最近上报页），实际发给了脏页 → 被脏保护拦住。
            # 只有未给 sid 时才按 workflow 推断。
            routed = {"workflow": want_wf, "matched": len(hits_live)}
            if sid:
                routed["sidSource"] = "explicit"
            else:
                sid = _live_pick(hits_live)
                routed["sidSource"] = "workflow-route"
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
        # copilot（契约 §2）：仅当本次上报携带该字段时更新（旧页面不带 = 不冲刷已有值）
        if "copilot" in data:
            _state["copilot"] = _copilot_brief(data.get("copilot"))
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

    # ── P1-C1：画布提交历史（落盘与查询）─────────────────────────────────
    # 方案甲：Python 在 ComfyUI 进程内直接写盘（桥前端经 8188 同源直连，不走中继。
    # 背景：iframe 首选 direct，桥页面够不到中继的 /_relay/history/commit → 404，见
    # docs/调研-画布提交历史-落盘通道.md）。逻辑全在 history_store.py（纯模块，可单测）；
    # 此处只做鉴权/读体/取目录/拆状态码。
    # USER_DIR：folder_paths.get_user_directory()（D:\ComfyUI\ComfyUI\folder_paths.py L146-147，
    #   返回模块级 user_directory，即 <base_path>/user，L72 赋值、L149-151 可被 set_user_directory 改）；
    #   default 用户再拼一层：user_manager.default_user = "default"（app/user_manager.py L17，
    #   get_request_user_id L59-70 的缺省分支）。单用户部署实际目录 = user/default。
    #   注意：这两处 import 依赖 ComfyUI 运行环境；import 失败时落盘不可用（与 _ROUTES
    #   同一支架），由 _hana_history_deps_ready() 判定并在端点内明确报 500，不猜路径。

    def _history_user_dir():
        """解析 user/default 绝对路径；任一依赖缺失抛 RuntimeError（不猜路径拼死值）。"""
        if _ROUTES is None or _history_commit is None or folder_paths is None or _user_manager is None:
            missing = [
                name
                for name, ok in (
                    ("routes", _ROUTES is not None),
                    ("history_store", _history_commit is not None and _history_save_commit is not None),
                    ("folder_paths", folder_paths is not None),
                    ("user_manager", _user_manager is not None),
                )
                if not ok
            ]
            raise RuntimeError(
                "USER_DIR 依赖不可用（%s）：routes=%s history_store=%s folder_paths=%s user_manager=%s"
                % (
                    ", ".join(missing),
                    _IMPORT_ERR,
                    _HISTORY_IMPORT_ERR,
                    _folder_paths_err,
                    _user_manager_err,
                )
            )
        return os.path.join(folder_paths.get_user_directory(), _user_manager.default_user)

    # P1-D1（2026-10-11）：不再校验 token —— 对齐 /hello、/state 的信任模型：调用方是
    # 8188 同源页面（桥 js），只落盘/只读、不转发；本机 8188 绑 127.0.0.1。
    # 而 /call 校验 token 是因为它是中继→外部的入口，桥 js 拿不到 token（全仓无 token 引用）。
    @_ROUTES.post("/hana_bridge/history-commit")
    async def _hana_history_commit(request):
        """提交一次画布快照落盘。请求体: { workflow, workflowId?, promptId?, graph, at?, source? }"""
        try:
            user_dir = _history_user_dir()
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        body = await _json(request)
        # 2026-10-14：画布身份 id（可空）→ 历史目录主键走 id；缺失走原名键（向后兼容）。
        workflow_id = str((body or {}).get("workflowId") or "").strip() or None
        # 同日：identity 归一化入参 —— 已落地文件相对路径 / 临时画布标志（bool）。
        workflow_path = str((body or {}).get("workflowPath") or "").strip() or None
        workflow_temporary = bool((body or {}).get("workflowTemporary"))
        out = _history_commit(body, user_dir, workflow_id, path=workflow_path, temporary=workflow_temporary)
        status = out.pop("status", 200 if out.get("ok") else 500)
        return web.json_response(out, status=status)

    # P5b：存档端点 —— 请求 { workflow, graph, at?, source? }（无 promptId），永远新建 kind="save" 节点。
    # 信任模型同其它 history-* 端点（P1-D1）：8188 同源、本机-only，不校验 token。
    @_ROUTES.post("/hana_bridge/history-save")
    async def _hana_history_save(request):
        """存档当前画布（不运行）。请求体: { workflow, workflowId?, graph, at?, source? }"""
        try:
            user_dir = _history_user_dir()
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        body = await _json(request)
        # 2026-10-14：同一 id 主键口径；workflowId 缺失 → 原名键（向后兼容）。
        workflow_id = str((body or {}).get("workflowId") or "").strip() or None
        workflow_path = str((body or {}).get("workflowPath") or "").strip() or None
        workflow_temporary = bool((body or {}).get("workflowTemporary"))
        out = _history_save_commit(body, user_dir, workflow_id, path=workflow_path, temporary=workflow_temporary)
        status = out.pop("status", 200 if out.get("ok") else 500)
        return web.json_response(out, status=status)

    # 2026-10-14：改名迁移 —— 修「未保存画布保存后提交历史全丢」（见
    # docs/方案-修复历史保存后丢失-20261014.md §3.2）。逻辑全在 history_store.migrate_history。
    @_ROUTES.post("/hana_bridge/history-migrate")
    async def _hana_history_migrate(request):
        """改名迁移历史目录。请求体 { from, to }（工作流显示名）。
        信任模型同其它 history-*（P1-D1）：8188 同源、本机-only，不校验 token。"""
        try:
            user_dir = _history_user_dir()
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        body = await _json(request)
        frm = str((body or {}).get("from") or "").strip()
        to = str((body or {}).get("to") or "").strip()
        if not frm or not to:
            return web.json_response({"ok": False, "error": "missing_from_or_to"}, status=400)
        out = _history_migrate(frm, to, user_dir)
        status = out.pop("status", 200 if out.get("ok") else 500)
        return web.json_response(out, status=status)

    @_ROUTES.post("/hana_bridge/history-attach-images")
    async def _hana_history_attach_images(request):
        """P4 修：把一次出图的产物文件名持久化到 sidecar（UI 直接读磁盘，不再碰 /history）。
        请求体: { workflow, workflowId?, promptId, images:[{filename,subfolder?,type?}], at? }
        信任模型同其它 history-* 端点（P1-D1）：8188 同源、本机-only，不校验 token。"""
        try:
            user_dir = _history_user_dir()
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        body = await _json(request)
        # 2026-10-14：同一 id 主键口径；workflowId 缺失 → 原名键（向后兼容）。
        workflow_id = str((body or {}).get("workflowId") or "").strip() or None
        workflow_path = str((body or {}).get("workflowPath") or "").strip() or None
        workflow_temporary = bool((body or {}).get("workflowTemporary"))
        out = _history_attach_images(
            body.get("workflow"),
            user_dir,
            body.get("promptId"),
            body.get("images"),
            at=body.get("at"),
            workflow_id=workflow_id,
            path=workflow_path,
            temporary=workflow_temporary,
        )
        status = out.pop("status", 200 if out.get("ok") else 500)
        return web.json_response(out, status=status)

    @_ROUTES.get("/hana_bridge/history-list")
    async def _hana_history_list(request):
        """查某工作流的提交索引。query: ?workflow=<名>&workflowId=<uuid>；缺 workflow 400。
        信任模型同 history-commit（P1-D1）：8188 同源、本机-only，不校验 token。"""
        try:
            user_dir = _history_user_dir()
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        workflow = str(request.query.get("workflow") or "").strip()
        if not workflow:
            return web.json_response({"ok": False, "error": "missing_workflow"}, status=400)
        # 2026-10-14：画布身份 id（可空）→ 主键走 id；缺失走原名键（向后兼容）。
        workflow_id = str(request.query.get("workflowId") or "").strip() or None
        workflow_path = str(request.query.get("workflowPath") or "").strip() or None
        _t = str(request.query.get("workflowTemporary") or "").strip().lower()
        workflow_temporary = _t in ("1", "true")
        out = _history_list_commits(workflow, user_dir, workflow_id, path=workflow_path, temporary=workflow_temporary)
        status = out.pop("status", 200 if out.get("ok") else 500)
        return web.json_response(out, status=status)

    @_ROUTES.get("/hana_bridge/history-snapshot")
    async def _hana_history_snapshot(request):
        """P3-G1：读某条提交快照的完整 JSON（含 graph 本体，回跳用）。
        query: ?workflow=<名>&workflowId=<uuid>&seq=<n> 或 ?workflow=<名>&file=<文件名>（file 优先）。
        信任模型同 history-list / history-commit（P1-D1）：8188 同源、本机-only，不校验 token。"""
        try:
            user_dir = _history_user_dir()
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        workflow = str(request.query.get("workflow") or "").strip()
        if not workflow:
            return web.json_response({"ok": False, "error": "missing_workflow"}, status=400)
        # 2026-10-14：画布身份 id（可空）→ 主键走 id；缺失走原名键（向后兼容）。
        workflow_id = str(request.query.get("workflowId") or "").strip() or None
        workflow_path = str(request.query.get("workflowPath") or "").strip() or None
        _t = str(request.query.get("workflowTemporary") or "").strip().lower()
        workflow_temporary = _t in ("1", "true")
        seq_raw = str(request.query.get("seq") or "").strip()
        file_raw = str(request.query.get("file") or "").strip()
        if not seq_raw and not file_raw:
            return web.json_response({"ok": False, "error": "missing_seq_or_file"}, status=400)
        out = _history_read_snapshot(
            workflow,
            user_dir,
            seq=(int(seq_raw) if seq_raw.isdigit() else seq_raw),
            file_name=(file_raw or None),
            workflow_id=workflow_id,
            path=workflow_path,
            temporary=workflow_temporary,
        )
        status = out.pop("status", 200 if out.get("ok") else 500)
        return web.json_response(out, status=status)

    # 2026-10-23：HEAD 持久化写入端点（见 docs/方案-修复提交图泳道与HEAD-20261023.md §3.2）。
    # 回跳成功后由前端调用，把后端 HEAD 设为回跳目标 seq；parent 由后端据此决定。
    # 请求体: { workflow, workflowId?, workflowPath?, workflowTemporary?, seq, at? }
    # 信任模型同其它 history-* 端点（P1-D1）：8188 同源、本机-only，不校验 token。
    @_ROUTES.post("/hana_bridge/history-head-set")
    async def _hana_history_head_set(request):
        """设置当前 HEAD（回跳目标）。body: { workflow, workflowId?, seq, at? }
        200 → {"ok": true, "seq": n}；400 → missing_workflow / missing_seq / seq_not_found。"""
        try:
            user_dir = _history_user_dir()
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        body = await _json(request)
        # 2026-10-14：同一 id 主键口径 / identity 归一化入参（照拄 history-commit 的取参方式）。
        workflow_id = str((body or {}).get("workflowId") or "").strip() or None
        workflow_path = str((body or {}).get("workflowPath") or "").strip() or None
        workflow_temporary = bool((body or {}).get("workflowTemporary"))
        out = _history_set_head(body, user_dir, workflow_id, path=workflow_path, temporary=workflow_temporary)
        status = out.pop("status", 200 if out.get("ok") else 500)
        return web.json_response(out, status=status)

    # 2026-10-14：缩图 + 磁盘缓存端点（见 docs/方案-预览图降分辨率与缓存-20261014.md §2）。
    # ComfyUI 的 /view?preview= 只压格式+质量、不改分辨率（2K 原图 → webp;75 仍 213KB）
    # 且无缓存头；本端点降分辨率并按 hash 稳定缓存 → 可长缓存、二次零下载。
    # 信任模型同 history-*（P1-D1）：8188 同源、本机-only，不校验 token；只读、不改原图。
    @_ROUTES.get("/hana_bridge/thumb")
    async def _hana_thumb(request):
        """缩图 + 磁盘缓存端点。query: filename, subfolder(可空), type(默认 output), w(默认720), q(默认72)。"""
        if _make_thumb is None:
            return web.json_response(
                {"ok": False, "error": "thumbs_unavailable: %s" % _THUMB_IMPORT_ERR}, status=500
            )
        filename = str(request.query.get("filename") or "").strip()
        if not filename:
            return web.json_response({"ok": False, "error": "missing_filename"}, status=400)
        subfolder = str(request.query.get("subfolder") or "").strip()
        type_ = str(request.query.get("type") or "output").strip() or "output"
        try:
            w = int(request.query.get("w") or 720)
        except (TypeError, ValueError):
            return web.json_response({"ok": False, "error": "invalid_width"}, status=400)
        try:
            q = int(request.query.get("q") or 72)
        except (TypeError, ValueError):
            return web.json_response({"ok": False, "error": "invalid_quality"}, status=400)
        w = max(16, min(4096, w))  # clamp 到 16..4096
        q = max(1, min(100, q))  # clamp 到 1..100
        # 缓存目录复用同一 user_dir 来源（<user_dir>/.thumb-cache/）。
        try:
            user_dir = _history_user_dir()
        except RuntimeError:
            user_dir = None  # 取不到 user_dir 时退化为不缓存（仍返回缩图）
        try:
            body, content_type, _hit = _make_thumb(
                filename, subfolder, type_, width=w, quality=q, user_dir=user_dir
            )
        except _thumb_err_cls as exc:
            return web.json_response({"ok": False, "error": exc.error}, status=exc.status)
        except Exception as exc:  # 兜底：任何未预期异常都收敛成 500 JSON
            LOG.warning("hana_bridge: thumb 异常：%s", exc)
            return web.json_response({"ok": False, "error": "thumb_failed: %s" % exc}, status=500)
        return web.Response(
            body=body,
            content_type=content_type,
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    LOG.info(
        "hana_bridge: 路由已注册（call / hello / result / ping / history-commit / history-save / history-attach-images / history-list / history-snapshot / history-migrate / history-head-set / thumb），"
        "token 就绪，超时 %gs",
        CALL_TIMEOUT_SEC,
    )
else:
    LOG.warning("hana_bridge: 未取到 PromptServer.instance.routes，路由未注册（%s）", _IMPORT_ERR)
