"""history_store.py — 画布提交历史 P1-C1：落盘与索引（纯 Python，零 ComfyUI 依赖）。

干什么：接收一次「提交上报」→ 把画布快照写成一个文件 + 追加一行 JSONL 索引。
  commit(body, user_dir) 请求体: { workflow, promptId?, graph, at?, source? }
  成功: {"ok":True, "seq":…, "file":…, "dir":…}；失败: {"ok":False, "status":…, "error":…}

语义口径：逐段照搬已通过单测验证的 JS 版（app/lib/canvas-history.mjs + app/runtime/
  history-commit.mjs），字段名与返回值形态一一对应。唯一已知偏差见
  snapshot_file_name 注释（文件名段允许字符），已在 docs/记录-画布提交历史-P1-C1.md 声明。

为什么抽成独立模块：__init__.py 由 ComfyUI 的 load_custom_node 加载，脱离 ComfyUI
  环境无法 import；本模块只用标准库（os/re/json/math/datetime），可用系统 Python +
  unittest 单测，全部落盘在 tempfile 临时目录。

磁盘布局（目录由调用方传入 user_dir，本模块负责拼接）：
  <user_dir>/workflows/.history/<净化工作流名>/
    ├── index.jsonl             # 每行一条元数据（build_index_line，追加写，绝不读全文重写）
    ├── 0001-a3f9c2e1.json      # 第 1 次提交的画布快照，UI 格式 JSON
    └── ...

体积防护：序列化后 > MAX_SNAPSHOT_BYTES（14 MiB，写上限 16 MiB 留裕量）→ 不写盘、
  不建目录，返回 413 语义。
原子写：同目录 .tmp → os.replace（同卷 rename，Windows 上亦原子）。
"""

from __future__ import annotations

import datetime
import json
import math
import os
import re

# ── 常量（对齐 canvas-history.mjs 的导出口径）──────────────────────────────
# 快照结构版本（字段增删时递增，供将来迁移判断）
SCHEMA_VERSION = 1
# 目录/文件名段长度上限（含中文按字符数计）
MAX_NAME_LEN = 80
# 净化后为空时的回退名
UNTITLED = "untitled"
# 剥离 base64 内嵌图时替换成的占位（保持结构、清空体积；此处取空串）
STRIPPED_IMAGE_PLACEHOLDER = ""
# 单份快照序列化后上限（写上限 16 MiB 留 ~2 MiB 裕量）
MAX_SNAPSHOT_BYTES = 14 * 1024 * 1024
# 索引文件名（JSONL，一行一条；追加写，绝不读全文重写）
INDEX_FILE_NAME = "index.jsonl"

# data:image/...;base64, 开头的字符串
_BASE64_IMAGE_RE = re.compile(r"^data:image/[a-z0-9.+-]*;base64,", re.IGNORECASE)
# 控制字符（C0 + DEL + C1）
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# 路径分隔符 + Windows 非法字符
_ILLEGAL_RE = re.compile(r'[/\\:*?"<>|]')
# 首尾空白与点
_EDGE_RE = re.compile(r"^[\s.]+|[\s.]+$")
# 文件名段（promptId 头）允许字符。⚠️ 与 JS 版有已知偏差：JS 用 [^a-zA-Z0-9]（连字符
# 也被剔除），本模块按本批规格保留连字符（[A-Za-z0-9-]）。promptId 是 UUID 时前 8 位
# 均为十六进制，两种口径实际结果一致。
_ID_ILLEGAL_RE = re.compile(r"[^A-Za-z0-9-]")

_SOURCES = ("user", "agent", "unknown")


def _to_int(v, fallback=0):
    """数值安全取整（非有限值 → fallback）。对齐 JS 的 Number() + Math.trunc。"""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n):
        return fallback
    return int(n)  # int() 向零截断，与 Math.trunc 一致


def normalize_source(source):
    """归一化 source：非 user/agent/unknown 一律 unknown。"""
    return source if source in _SOURCES else "unknown"


# ── 1. 命名 ─────────────────────────────────────────────────────────────────
def sanitize_workflow_name(name):
    """把工作流名净化成安全的目录/文件名段：
      · 保留中文与常见字符；
      · 剔除路径分隔符（/ \\ :）、Windows 非法字符（* ? " < > |）、控制字符；
      · 去首尾空白与点（Windows 不允许名以点/空格结尾）；
      · 超长截断到 MAX_NAME_LEN（80，截断后再次去尾，对齐 JS 的两次 EDGE 清洗）；
      · 空名/纯空白/净化后为空 → "untitled"。
    """
    s = "" if name is None else str(name)
    s = _CTRL_RE.sub("", s)
    s = _ILLEGAL_RE.sub("", s)
    s = _EDGE_RE.sub("", s)
    if len(s) > MAX_NAME_LEN:
        s = s[:MAX_NAME_LEN]
    s = _EDGE_RE.sub("", s)
    return s or UNTITLED


# ── 2. 目录 ─────────────────────────────────────────────────────────────────
def history_dir(user_dir, workflow_name):
    """历史目录绝对路径：<user_dir>/workflows/.history/<净化后的名字>。"""
    return os.path.abspath(
        os.path.join(
            "" if user_dir is None else str(user_dir),
            "workflows",
            ".history",
            sanitize_workflow_name(workflow_name),
        )
    )


# ── 3. 文件名 ───────────────────────────────────────────────────────────────
def snapshot_file_name(seq, prompt_id):
    """快照文件名：<seq 补零到 4 位>-<promptId 前 8 位净化>.json
      · seq 非有限值按 0；超过 4 位不截断（自然增长）；
      · promptId 只取前 8 位，再剔除非 [A-Za-z0-9-]；净化后为空 → "noid"。
    """
    head = str(_to_int(seq, 0)).zfill(4)
    pid = "" if prompt_id is None else str(prompt_id)
    ident = _ID_ILLEGAL_RE.sub("", pid[:8])
    if not ident:
        ident = "noid"
    return "%s-%s.json" % (head, ident)


# ── 4. 快照构造 ─────────────────────────────────────────────────────────────
def _iso_utc(dt):
    """UTC datetime → ISO 8601 毫秒精度 + Z 后缀（对齐 JS toISOString 的形态）。"""
    return dt.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _to_iso(at):
    """at：缺省/空 → 当前 UTC 时间 ISO；datetime → 转 UTC 后 ISO；其余原样转字符串。"""
    if at is None:
        return _iso_utc(datetime.datetime.now(datetime.timezone.utc))
    if isinstance(at, datetime.datetime):
        if at.tzinfo is None:
            at = at.replace(tzinfo=datetime.timezone.utc)
        return _iso_utc(at)
    return str(at)


def build_snapshot(graph, prompt_id=None, seq=1, at=None, source="unknown", blocks=None):
    """构造一份快照对象（graph 原样嵌入，不做拷贝）。
    P2-F2：blocks（块归属，[{name, source, nodeIds:[…]}]，由桥前端计算）原样透传；
    None / 非列表 → 不写该字段（旧快照兼容：无 blocks 的条目读回 null，schemaVersion 不 bump）。
    """
    g = graph if isinstance(graph, dict) else {}
    nodes = g.get("nodes") if isinstance(g.get("nodes"), list) else []
    links = g.get("links") if isinstance(g.get("links"), list) else []
    snap = {
        "schemaVersion": SCHEMA_VERSION,
        "seq": _to_int(seq, 0),
        "promptId": None if prompt_id is None else str(prompt_id),
        "at": _to_iso(at),
        "source": normalize_source(source),
        "nodeCount": len(nodes),
        "linkCount": len(links),
        "graph": graph,
    }
    if isinstance(blocks, list):
        snap["blocks"] = blocks  # 原样透传（不校验/不拷贝，语义归桥前端）
    return snap


# ── 5. 剥离 base64 内嵌图 ────────────────────────────────────────────────────
def _walk_strip(node, trail, stripped):
    """深拷贝 + 命中 base64 内嵌图则替换为占位；沿路记录命中路径。返回新值。"""
    if isinstance(node, str):
        if _BASE64_IMAGE_RE.match(node):
            stripped.append(trail)
            return STRIPPED_IMAGE_PLACEHOLDER
        return node
    if isinstance(node, list):
        out = []
        for i, item in enumerate(node):
            out.append(_walk_strip(item, "%s[%d]" % (trail, i), stripped))
        return out
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            out[k] = _walk_strip(v, "%s.%s" % (trail, k) if trail else str(k), stripped)
        return out
    return node  # number / bool / None 等标量原样


def strip_heavy_fields(graph):
    """防御性深拷贝 graph，并剥离 base64 内嵌图（data:image/...;base64,... 字符串）。
      · **不修改入参对象**（深拷贝）；
      · 命中位置的值替换为 STRIPPED_IMAGE_PLACEHOLDER（空串），保持结构不变；
      · stripped 记录命中路径，形如 "nodes[3].widgets_values[0]"（相对 graph 根）。
    """
    stripped = []
    src = graph if isinstance(graph, dict) else {}
    copy = _walk_strip(src, "", stripped)
    return {"graph": copy, "stripped": stripped}


# ── 6. 索引行 ───────────────────────────────────────────────────────────────
def build_index_line(meta):
    """构造一行索引元数据（JSON 字符串，**不含 graph**）。
    字段：seq / file（文件名）/ promptId / at / source / nodeCount / linkCount。
    P2-F2：meta 带 blocks（列表）时索引行写**摘要** blocks:[{name, nodeCount}]（不写 nodeIds
    全量——索引行要瘦身）；非列表 / 缺失 → 不写该字段（旧条目读回 null）。
    入参兼容别名：file ← file | fileName | name。
    """
    m = meta if isinstance(meta, dict) else {}
    if m.get("file") is not None:
        raw_file = m.get("file")
    elif m.get("fileName") is not None:
        raw_file = m.get("fileName")
    else:
        raw_file = m.get("name")
    obj = {
        "seq": _to_int(m.get("seq"), 0),
        "file": "" if raw_file is None else str(raw_file),
        "promptId": None if m.get("promptId") is None else str(m.get("promptId")),
        "at": None if m.get("at") is None else str(m.get("at")),
        "source": normalize_source(m.get("source")),
        "nodeCount": _to_int(m.get("nodeCount"), 0),
        "linkCount": _to_int(m.get("linkCount"), 0),
    }
    if isinstance(m.get("blocks"), list):
        summary = []
        for blk in m["blocks"]:
            if not isinstance(blk, dict):
                continue
            # 摘要只留 name + nodeCount；nodeCount 缺省时由 nodeIds 推导（桥上报的是 nodeIds 全量）
            nc = blk.get("nodeCount")
            if nc is None:
                ids = blk.get("nodeIds")
                nc = len(ids) if isinstance(ids, list) else 0
            summary.append({"name": "" if blk.get("name") is None else str(blk.get("name")), "nodeCount": _to_int(nc, 0)})
        obj["blocks"] = summary
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


# ── 7. 索引解析 ─────────────────────────────────────────────────────────────
def parse_index(text):
    """容错解析 JSONL 索引：
      · 空行（含纯空白）跳过，不计入 badLines；
      · 坏行（JSON 解析失败，或解析出来不是对象）计入 badLines 计数，不抛异常；
      · 缺字段的行照样进 entries（本模块不校验字段完整性）。
    返回 {"entries": [dict, ...], "badLines": 坏行数 int}。
    """
    entries = []
    bad = 0
    lines = re.split(r"\r?\n", "" if text is None else str(text))
    for line in lines:
        if line.strip() == "":
            continue
        try:
            v = json.loads(line)
        except ValueError:
            bad += 1
            continue
        if isinstance(v, dict):
            entries.append(v)
        else:
            bad += 1
    return {"entries": entries, "badLines": bad}


# ── 8. 序号 ─────────────────────────────────────────────────────────────────
def next_seq(entries):
    """下一个序号：entries 为空（或无有效 seq）→ 1；否则 max(seq)+1。
    只统计有限数值 seq，坏行的非法 seq 忽略。
    """
    best = None
    for e in entries if isinstance(entries, list) else []:
        if not isinstance(e, dict):
            continue
        try:
            n = float(e.get("seq"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(n):
            n = int(n)
            if best is None or n > best:
                best = n
    return 1 if best is None else best + 1


# ── 9. 最新一条 ─────────────────────────────────────────────────────────────
def latest_entry(entries):
    """最后一条 entry（按索引顺序，即最新）；空 → None。"""
    lst = entries if isinstance(entries, list) else []
    return lst[-1] if lst else None


# ── 10. 提交落盘 ────────────────────────────────────────────────────────────
def commit(body, user_dir):
    """处理一次提交上报：写快照 + 追加索引行。返回带 status 的结果对象，由路由拆出 HTTP 码。

    流程对齐 JS handleHistoryCommit（含顺序）：缺字段 400 → 读索引 → next_seq →
    构造/序列化快照 → 体积防护（超限不写盘、**不建目录**）→ mkdir → 原子写快照 →
    追加一行索引。

    P2-F2 可选入参：blocks —— 块归属（[{name, source, nodeIds:[…]}]，桥前端算好随请求体带上）。
    非列表 → 视为未提供，快照/索引均不写该字段；schemaVersion 不 bump（新增可选字段向后兼容）。
    """
    b = body if isinstance(body, dict) else {}
    workflow = b.get("workflow") if isinstance(b.get("workflow"), str) else ""
    workflow = workflow.strip()
    if not workflow:
        return {"ok": False, "status": 400, "error": "需要 workflow（工作流名）"}
    if not isinstance(b.get("graph"), dict):
        return {"ok": False, "status": 400, "error": "需要 graph（画布快照对象）"}
    if not isinstance(user_dir, str) or not user_dir.strip():
        return {"ok": False, "status": 500, "error": "无法解析 ComfyUI 用户目录（user_dir 未就绪）"}

    prompt_id = b.get("promptId")
    prompt_id = None if prompt_id is None else str(prompt_id)
    dir_path = history_dir(user_dir, workflow)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)

    # 读已有索引（不存在当空处理；容错解析交给 parse_index）
    entries = []
    try:
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as fh:
                entries = parse_index(fh.read())["entries"]
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}

    seq = next_seq(entries)
    file_name = snapshot_file_name(seq, prompt_id)
    abs_file = os.path.join(dir_path, file_name)

    snapshot = build_snapshot(b.get("graph"), prompt_id, seq, b.get("at"), b.get("source"), b.get("blocks"))
    try:
        text = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        return {"ok": False, "status": 400, "error": "快照序列化失败：%s" % exc}
    size = len(text.encode("utf-8"))
    if size > MAX_SNAPSHOT_BYTES:
        return {
            "ok": False,
            "status": 413,
            "error": "快照超过 %d MiB 上限（%d 字节）" % (MAX_SNAPSHOT_BYTES // (1024 * 1024), size),
            "size": size,
        }

    # 索引行（不含 graph；字段取自 snapshot，保证与落盘快照一致）
    line = build_index_line(
        {
            "seq": seq,
            "file": file_name,
            "promptId": snapshot["promptId"],
            "at": snapshot["at"],
            "source": snapshot["source"],
            "nodeCount": snapshot["nodeCount"],
            "linkCount": snapshot["linkCount"],
            "blocks": snapshot.get("blocks"),  # P2-F2：块归属 → 索引行写摘要
        }
    )

    # 目录不存在就递归创建（在体积防护之后，超限不落任何盘上痕迹）
    try:
        os.makedirs(dir_path, exist_ok=True)
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "创建历史目录失败：%s" % exc}

    # 快照落盘（原子写：同目录 .tmp → os.replace，同卷 rename）
    tmp_path = abs_file + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        os.replace(tmp_path, abs_file)
    except OSError as exc:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        return {"ok": False, "status": 500, "error": "写入快照失败：%s" % exc}

    # 追加一行索引（追加写；禁止读全文重写整份索引）
    try:
        with open(index_path, "a", encoding="utf-8", newline="") as fh:
            fh.write(line + "\n")
    except OSError as exc:
        return {
            "ok": False,
            "status": 500,
            "error": "追加索引失败：%s" % exc,
            "seq": seq,
            "file": file_name,
            "dir": dir_path,
        }

    return {"ok": True, "status": 200, "seq": seq, "file": file_name, "dir": dir_path}


# ── 11. 查询 ────────────────────────────────────────────────────────────────
def list_commits(workflow, user_dir):
    """读某工作流的索引。目录不存在 → 空 entries（ok=True）；索引坏行只计数不抛异常。"""
    if not isinstance(user_dir, str) or not user_dir.strip():
        return {"ok": False, "status": 500, "error": "无法解析 ComfyUI 用户目录（user_dir 未就绪）"}
    dir_path = history_dir(user_dir, workflow)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)
    if not os.path.isdir(dir_path):
        return {"ok": True, "status": 200, "entries": [], "badLines": 0}
    try:
        with open(index_path, "r", encoding="utf-8") as fh:
            parsed = parse_index(fh.read())
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}
    return {"ok": True, "status": 200, "entries": parsed["entries"], "badLines": parsed["badLines"]}


# ── 12. 快照全文读取（P3-G1：回跳用）───────────────────────────────────────
def read_snapshot(workflow, user_dir, seq=None, file_name=None):
    """读一份提交快照的完整 JSON（含 graph 本体）。返回带 status 的结果对象，由路由拆出 HTTP 码。

    定位：file 优先（直接点名，回跳前端走这条）；否则用 seq 从索引解析出 file（history-list
    只有摘要、无 graph 本体，本函数是回跳拿完整快照的入口）。
    file 只接受纯文件名（拒绝任何含路径分隔的值，防穿越）；索引缺失/无该条 → 404。
    失败码：400 参数缺失/非法；404 快照不存在；500 读取/解析失败（含坏 JSON）。
    """
    if not isinstance(user_dir, str) or not user_dir.strip():
        return {"ok": False, "status": 500, "error": "无法解析 ComfyUI 用户目录（user_dir 未就绪）"}
    if not isinstance(workflow, str) or not workflow.strip():
        return {"ok": False, "status": 400, "error": "需要 workflow（工作流名）"}
    dir_path = history_dir(user_dir, workflow)
    fname = None
    if file_name is not None and str(file_name).strip():
        fname = str(file_name).strip()
        if fname != os.path.basename(fname) or fname in (".", ".."):
            return {"ok": False, "status": 400, "error": "file 只能是文件名（不含路径）"}
    elif seq is not None:
        n = _to_int(seq, None)
        if n is None:
            return {"ok": False, "status": 400, "error": "seq 必须是整数"}
        index_path = os.path.join(dir_path, INDEX_FILE_NAME)
        if not os.path.isdir(dir_path) or not os.path.isfile(index_path):
            return {"ok": False, "status": 404, "error": "该工作流没有提交历史", "seq": n}
        try:
            with open(index_path, "r", encoding="utf-8") as fh:
                entries = parse_index(fh.read())["entries"]
        except OSError as exc:
            return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}
        entry = next(
            (e for e in entries if isinstance(e, dict) and _to_int(e.get("seq"), None) == n),
            None,
        )
        if entry is None:
            return {"ok": False, "status": 404, "error": "索引里没有 #%d 这条提交" % n, "seq": n}
        raw = entry.get("file")
        if not isinstance(raw, str) or not raw.strip():
            return {"ok": False, "status": 404, "error": "索引条目缺少 file 字段", "seq": n}
        fname = raw.strip()
        if fname != os.path.basename(fname) or fname in (".", ".."):
            return {"ok": False, "status": 500, "error": "索引条目 file 字段非法（含路径）"}
    else:
        return {"ok": False, "status": 400, "error": "需要 seq 或 file 之一"}
    abs_file = os.path.join(dir_path, fname)
    if not os.path.isfile(abs_file):
        return {"ok": False, "status": 404, "error": "快照文件不存在：%s" % fname}
    try:
        with open(abs_file, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取快照失败：%s" % exc}
    try:
        snap = json.loads(text)
    except ValueError as exc:
        return {"ok": False, "status": 500, "error": "快照不是合法 JSON：%s" % exc}
    if not isinstance(snap, dict):
        return {"ok": False, "status": 500, "error": "快照内容不是 JSON 对象"}
    return {"ok": True, "status": 200, "file": fname, "seq": _to_int(snap.get("seq"), 0), "snapshot": snap}
