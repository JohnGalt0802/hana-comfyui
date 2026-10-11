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
# 快照结构版本（字段增删时递增，供将来迁移判断）——P5 换代：1 → 2
#   v2 起索引行携带 parent/kind/sig/blocks(完整版)/delta/runs；旧条目按缺省读（normalize_entry）。
SCHEMA_VERSION = 2
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
# 产物图 sidecar 后缀（P4 修）：<快照文件名>.images.json，如 0001-bc1547d2.json.images.json
# （保留快照名里的 .json 再追加后缀，避免与快照同基名冲突）。
IMAGES_SUFFIX = ".images.json"

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
# kind 白名单（跑出来的 / 主动存档的）；非法/缺省 → "run"
_KINDS = ("run", "save")

# ── P5：归一化签名 / 画布差异 / 兼容补全 ─────────────────────────────────
# 与 JS 版 app/lib/canvas-history.mjs 的 graphSigIgnoringSeed 必须给出**同一串**：
# 哈希算法（JS / Python 逐字节一致）：
#   · offset basis = 2166136261（0x811c9dc5）
#   · prime        = 16777619（0x01000193）
#   · 输入先按 **UTF-8** 编码成字节序列，再逐字节：h ^= byte; h = (h * prime) mod 2^32
#   · 结果输出为 **8 位小写十六进制**（左补 0）
_FNV_OFFSET_BASIS = 2166136261
_FNV_PRIME = 16777619
# seed 类 widget 名（seed / noise_seed / rand_seed …）
_SEED_WIDGET_RE = re.compile("seed", re.IGNORECASE)


def _is_plain_object(v):
    return isinstance(v, dict)


def _fnv1a_hex(s):
    """FNV-1a（32 位）稳定 hex 版：UTF-8 字节 → 8 位小写 hex（见上方算法说明）。"""
    h = _FNV_OFFSET_BASIS
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * _FNV_PRIME) & 0xFFFFFFFF
    return format(h, "08x")


def _js_num_str(v):
    """数值 → 与 JS String(Number) 一致的最短形态：整数值不用小数尾巴（1 而非 1.0）。"""
    if isinstance(v, int):
        return str(v)
    if math.isfinite(v) and float(v).is_integer() and abs(v) < 1e21:
        return str(int(v))
    return repr(v)


def _canon_json(v):
    """紧凑规范化 JSON（对象键排序、无空格；对齐 JS canonJson 口径）。"""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return _js_num_str(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(_canon_json(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys())
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + _canon_json(v[k]) for k in keys) + "}"
    return "null"


def _canon_value(v):
    """规范化取值串（跨语言一致）：None → ""；对象/数组 → 排序键的紧凑 JSON；其余 → 字符串。"""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (dict, list)):
        return _canon_json(v)
    if isinstance(v, (int, float)):
        return _js_num_str(v)
    return str(v)


def _widgets_part(node):
    """节点 widget 段串：优先 widgets_values_named（可按名跳过 seed 类）；否则按位置 widgets_values。"""
    named = node.get("widgets_values_named")
    named = named if isinstance(named, dict) else None
    out = []
    if named and len(named) > 0:
        for k in named.keys():
            if _SEED_WIDGET_RE.search(k):
                continue
            out.append("%s=%s;" % (k, _canon_value(named[k])))
        return "".join(out)
    wv = node.get("widgets_values")
    if isinstance(wv, list):
        for i, val in enumerate(wv):
            out.append("widget_%d=%s;" % (i, _canon_value(val)))
    elif isinstance(wv, dict):
        for k in wv.keys():
            if _SEED_WIDGET_RE.search(k):
                continue
            out.append("%s=%s;" % (k, _canon_value(wv[k])))
    return "".join(out)


def graph_sig_ignoring_seed(graph):
    """归一化画布签名（忽略 seed 类 widget）。
    口径：按 graph.nodes 顺序，逐节点 type + "|" + widget 段，各节点段先 fnv1a，
    再以 "|" 串接整体 fnv1a，输出 8 位小写 hex。
    与桥 js graphSignature() 同族但更简化（不含 mode/title/位置/连线数；不含节点 id）。"""
    g = graph if isinstance(graph, dict) else {}
    nodes = g.get("nodes") if isinstance(g.get("nodes"), list) else []
    parts = []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        typ = "" if n.get("type") is None else str(n.get("type"))
        parts.append(_fnv1a_hex("%s|%s" % (typ, _widgets_part(n))))
    return _fnv1a_hex("|".join(parts))


def _index_nodes_by_id(graph):
    """id（字符串化）→ 节点（跳过无 id / 非对象）。"""
    out = {}
    g = graph if isinstance(graph, dict) else {}
    nodes = g.get("nodes") if isinstance(g.get("nodes"), list) else []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        if n.get("id") is None:
            continue
        out[str(n.get("id"))] = n
    return out


def _node_title(n):
    """节点显示名：title 非空则用，否则 type，否则 ""。"""
    t = n.get("title")
    if isinstance(t, str) and t:
        return t
    return "" if n.get("type") is None else str(n.get("type"))


def _widget_entries(node):
    """返回 (names|None, values)：named 优先命名，否则位置命名 widget_<i>。"""
    named = node.get("widgets_values_named")
    named = named if isinstance(named, dict) else None
    wv = node.get("widgets_values")
    if isinstance(wv, list):
        return (list(named.keys()) if named else None, list(wv))
    if isinstance(wv, dict):
        keys = list(wv.keys())
        return (keys, [wv[k] for k in keys])
    if named:
        keys = list(named.keys())
        return (keys, [named[k] for k in keys])
    return (None, [])


def _changed_widget_names(a, b):
    """同 id 两节点的 widget 变化名列表（逐项比较位置值；缺失项按 "" 参与比较）。"""
    na, va = _widget_entries(a)
    nb, vb = _widget_entries(b)
    n = max(len(va), len(vb))
    fields = []
    for i in range(n):
        x = va[i] if i < len(va) else None
        y = vb[i] if i < len(vb) else None
        if _canon_value(x) != _canon_value(y):
            fields.append((na[i] if na and i < len(na) else None) or (nb[i] if nb and i < len(nb) else None) or ("widget_%d" % i))
    return fields


def _id_sort_key(v):
    """id 排序：两数按数值，否则按字符串（对齐 JS 侧）。"""
    if isinstance(v, bool):
        return (1, str(v))
    if isinstance(v, (int, float)):
        return (0, float(v))
    return (1, str(v))


def compute_delta(prev_graph, next_graph):
    """对比两画布（UI 格式），相对 prev 算三类变化。
    prev_graph 为 None/非法 → 返回 None。
    返回 {"changed":[{id,title,fields}], "added":[{id,title}], "removed":[{id,title}]}。"""
    if not isinstance(prev_graph, dict):
        return None
    prev = _index_nodes_by_id(prev_graph)
    nxt = _index_nodes_by_id(next_graph)
    added = []
    removed = []
    changed = []
    for k, n in nxt.items():
        if k not in prev:
            added.append({"id": n.get("id"), "title": _node_title(n)})
    for k, n in prev.items():
        if k not in nxt:
            removed.append({"id": n.get("id"), "title": _node_title(n)})
    for k, a in prev.items():
        b = nxt.get(k)
        if b is None:
            continue
        fields = []
        ta = "" if a.get("type") is None else str(a.get("type"))
        tb = "" if b.get("type") is None else str(b.get("type"))
        if ta != tb:
            fields.append("type")
        fields.extend(_changed_widget_names(a, b))
        if fields:
            changed.append({"id": b.get("id"), "title": _node_title(b), "fields": fields})
    added.sort(key=lambda x: _id_sort_key(x["id"]))
    removed.sort(key=lambda x: _id_sort_key(x["id"]))
    changed.sort(key=lambda x: _id_sort_key(x["id"]))
    return {"changed": changed, "added": added, "removed": removed}


def should_merge_with_head(new_sig, head_sig):
    """合并判定辅助（纯比较）：两侧签名串相等即 True（供桥侧调用）。非字符串一律 False。"""
    return isinstance(new_sig, str) and isinstance(head_sig, str) and new_sig == head_sig


def _norm_kind(k):
    """归一化 kind：白名单 run/save，非法/缺省 → "run"。"""
    return k if k in _KINDS else "run"


def _norm_parent(v):
    """归一化 parent：有限数 → 整数；其余（含 None/""）→ None。"""
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n):
        return None
    return int(n)


def _norm_images(imgs):
    """归一化 images：[{filename,subfolder,type}]（缺省空串；非对象项剔除）。"""
    if not isinstance(imgs, list):
        return []
    out = []
    for im in imgs:
        if not isinstance(im, dict):
            continue
        out.append(
            {
                "filename": "" if im.get("filename") is None else str(im.get("filename")),
                "subfolder": "" if im.get("subfolder") is None else str(im.get("subfolder")),
                "type": "" if im.get("type") is None else str(im.get("type")),
            }
        )
    return out


def _norm_runs(runs):
    """归一化 runs：[{promptId, at, images}]（非对象项剔除）。"""
    if not isinstance(runs, list):
        return []
    out = []
    for r in runs:
        if not isinstance(r, dict):
            continue
        out.append(
            {
                "promptId": None if r.get("promptId") is None else str(r.get("promptId")),
                "at": None if r.get("at") is None else str(r.get("at")),
                "images": _norm_images(r.get("images")),
            }
        )
    return out


def _norm_block(blk):
    """归一化 block（完整版）：{name, source, nodeIds}；source 缺省 "group"，nodeIds 缺省 []。"""
    b = blk if isinstance(blk, dict) else {}
    src = b.get("source")
    src = src if isinstance(src, str) and src else "group"
    ids = b.get("nodeIds")
    return {
        "name": "" if b.get("name") is None else str(b.get("name")),
        "source": src,
        "nodeIds": list(ids) if isinstance(ids, list) else [],
    }


def _norm_blocks(blocks):
    """归一化 blocks：非数组 → []；逐块补全 name/source/nodeIds（非对象块剔除）。"""
    if not isinstance(blocks, list):
        return []
    out = []
    for blk in blocks:
        if not isinstance(blk, dict):
            continue
        out.append(_norm_block(blk))
    return out


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
    字段（P5 v2）：seq / parent / file / promptId / at / source / kind /
      nodeCount / linkCount / sig / blocks(完整版) / delta / runs。
    缺省：parent→None；kind→"run"；sig→""；blocks→[]；delta→None；runs→[]。
    入参兼容别名：file ← file | fileName | name。
    """
    m = meta if isinstance(meta, dict) else {}
    if m.get("file") is not None:
        raw_file = m.get("file")
    elif m.get("fileName") is not None:
        raw_file = m.get("fileName")
    else:
        raw_file = m.get("name")
    sig = m.get("sig")
    obj = {
        "seq": _to_int(m.get("seq"), 0),
        "parent": _norm_parent(m.get("parent")),
        "file": "" if raw_file is None else str(raw_file),
        "promptId": None if m.get("promptId") is None else str(m.get("promptId")),
        "at": None if m.get("at") is None else str(m.get("at")),
        "source": normalize_source(m.get("source")),
        "kind": _norm_kind(m.get("kind")),
        "nodeCount": _to_int(m.get("nodeCount"), 0),
        "linkCount": _to_int(m.get("linkCount"), 0),
        "sig": sig if isinstance(sig, str) else "",
        "blocks": _norm_blocks(m.get("blocks")),
        "delta": m.get("delta") if isinstance(m.get("delta"), dict) else None,
        "runs": _norm_runs(m.get("runs")),
    }
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def normalize_entry(entry):
    """兼容补全：把旧条目（缺新字段）读成新形态，**不改写磁盘**、不改入参。
    缺省：parent→None；kind→"run"；sig→""；delta→None；blocks→[]；
      runs → 缺则用顶层 promptId/at 造单元素 runs（promptId 为 None 时 → []）。
    """
    e = entry if isinstance(entry, dict) else {}
    out = dict(e)
    out["parent"] = _norm_parent(e.get("parent"))
    out["kind"] = _norm_kind(e.get("kind"))
    sig = e.get("sig")
    out["sig"] = sig if isinstance(sig, str) else ""
    out["delta"] = e.get("delta") if isinstance(e.get("delta"), dict) else None
    out["blocks"] = _norm_blocks(e.get("blocks"))
    if isinstance(e.get("runs"), list):
        out["runs"] = _norm_runs(e.get("runs"))
    elif e.get("promptId") is None:
        out["runs"] = []
    else:
        out["runs"] = [
            {
                "promptId": str(e.get("promptId")),
                "at": None if e.get("at") is None else str(e.get("at")),
                "images": [],
            }
        ]
    return out


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
    """读某工作流的索引。目录不存在 → 空 entries（ok=True）；索引坏行只计数不抛异常。

    P4 修：每条 entry **新增**两个只读合并字段（不写回索引磁盘）：
      · runs   —— 有 sidecar 图 → 单元素 [{promptId, at, images}]；无 → []
      · images —— runs 里所有 images 的扁平合并；无 → []
    """
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
    out_entries = []
    for e in parsed["entries"]:
        if not isinstance(e, dict):
            out_entries.append(e)
            continue
        raw_file = e.get("file")
        imgs = _read_sidecar_images(dir_path, raw_file.strip()) if isinstance(raw_file, str) and raw_file.strip() else []
        merged = dict(e)
        if imgs:
            merged["runs"] = [
                {"promptId": e.get("promptId"), "at": e.get("at"), "images": imgs}
            ]
        else:
            merged["runs"] = []
        merged["images"] = _merge_images([], [im for r in merged["runs"] for im in r["images"]])
        out_entries.append(merged)
    return {"ok": True, "status": 200, "entries": out_entries, "badLines": parsed["badLines"]}


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


# ── 13. 产物图 sidecar（P4 修）──────────────────────────────────────────
# 为什么用 sidecar：索引是 JSONL 追加写（天然无竞态），回填要改已写行会破坏追加语义。
# sidecar 是 per-commit 独立小文件，可独立更新、无并发竞态。
def _sidecar_file_name(snapshot_file):
    """sidecar 名：<快照文件名>.images.json（保留 .json 再追加后缀，避与快照同基名冲突）。"""
    return "%s%s" % (snapshot_file, IMAGES_SUFFIX) if isinstance(snapshot_file, str) else ""


def _norm_image_item(im):
    """规范化单个图项：**只保留** filename/subfolder/type，其余字段丢弃。
    filename 非空字符串才有效（否则 None，调用方按 400/剔除处理）；
    subfolder 非字符串/缺省 → ""；type 非字符串/缺省 → "output"。
    """
    if not isinstance(im, dict):
        return None
    fn = im.get("filename")
    fn = fn if isinstance(fn, str) else ("" if fn is None else str(fn))
    if not fn:
        return None
    sub = im.get("subfolder")
    sub = sub if isinstance(sub, str) else ("" if sub is None else str(sub))
    typ = im.get("type")
    typ = typ if isinstance(typ, str) else ("" if typ is None else str(typ))
    if not typ:
        typ = "output"
    return {"filename": fn, "subfolder": sub, "type": typ}


def _image_key(im):
    """去重键：filename+subfolder+type（NUL 分隔，避免字段拼接歧义）。"""
    return "%s\x00%s\x00%s" % (im["filename"], im["subfolder"], im["type"])


def _merge_images(existing, incoming):
    """按 filename+subfolder+type 去重合并（先 existing 后 incoming，保持首次出现顺序）。
    非法项（无 filename）剔除；入参可为任意（非列表 → 空）。
    """
    out = []
    seen = set()
    for src in (existing, incoming):
        if not isinstance(src, list):
            continue
        for im in src:
            norm = _norm_image_item(im)
            if norm is None:
                continue
            k = _image_key(norm)
            if k in seen:
                continue
            seen.add(k)
            out.append(norm)
    return out


def _find_entry_by_prompt_id(entries, prompt_id):
    """按 promptId 在索引里找 entry（首个匹配）；找不到 → None。"""
    pid = None if prompt_id is None else str(prompt_id)
    for e in entries if isinstance(entries, list) else []:
        if isinstance(e, dict) and e.get("promptId") is not None and str(e.get("promptId")) == pid:
            return e
    return None


def _read_sidecar_images(dir_path, snapshot_file):
    """读 <dir>/<snapshot_file>.images.json 的 images；无/坏/非对象 → []。"""
    name = _sidecar_file_name(snapshot_file)
    if not name:
        return []
    path = os.path.join(dir_path, name)
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            obj = json.loads(fh.read())
    except (OSError, ValueError):
        return []
    if not isinstance(obj, dict):
        return []
    return _merge_images([], obj.get("images"))


def read_images_for(workflow, user_dir, prompt_id):
    """内部用：读某工作流某 promptId 的产物图 list；无 sidecar / 无该 promptId → []。"""
    if not isinstance(workflow, str) or not workflow.strip():
        return []
    if not isinstance(user_dir, str) or not user_dir.strip():
        return []
    if prompt_id is None or not str(prompt_id):
        return []
    dir_path = history_dir(user_dir, workflow)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)
    if not os.path.isfile(index_path):
        return []
    try:
        with open(index_path, "r", encoding="utf-8") as fh:
            entries = parse_index(fh.read())["entries"]
    except OSError:
        return []
    entry = _find_entry_by_prompt_id(entries, prompt_id)
    if entry is None:
        return []
    raw_file = entry.get("file")
    if not isinstance(raw_file, str) or not raw_file.strip():
        return []
    snapshot_file = raw_file.strip()
    if snapshot_file != os.path.basename(snapshot_file) or snapshot_file in (".", ".."):
        return []
    return _read_sidecar_images(dir_path, snapshot_file)


def attach_images(workflow, user_dir, prompt_id, images, at=None):
    """把一次出图的产物文件名持久化到 sidecar（P4 修）。

    校验 workflow / promptId / images（非空数组，每项含 filename）→ 非法 400；
    读索引按 promptId 找 entry → 找不到 404；
    取其 file 基名 → sidecar = <基名>.images.json；
    读旧 sidecar → 按 filename+subfolder+type 去重合并 → 原子写回（.tmp → os.replace）。
    返回 {ok, status, file, count}；file = sidecar 文件名，count = 累计张数。
    """
    wf = workflow.strip() if isinstance(workflow, str) else ""
    if not wf:
        return {"ok": False, "status": 400, "error": "需要 workflow（工作流名）"}
    pid = None if prompt_id is None else str(prompt_id)
    if not pid:
        return {"ok": False, "status": 400, "error": "需要 promptId"}
    if not isinstance(images, list) or not images:
        return {"ok": False, "status": 400, "error": "需要 images（非空数组）"}
    norm_in = []
    for im in images:
        norm = _norm_image_item(im)
        if norm is None:
            return {"ok": False, "status": 400, "error": "images 每项必须含 filename"}
        norm_in.append(norm)
    if not isinstance(user_dir, str) or not user_dir.strip():
        return {"ok": False, "status": 500, "error": "无法解析 ComfyUI 用户目录（user_dir 未就绪）"}

    dir_path = history_dir(user_dir, wf)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)
    entries = []
    try:
        if os.path.isfile(index_path):
            with open(index_path, "r", encoding="utf-8") as fh:
                entries = parse_index(fh.read())["entries"]
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}
    entry = _find_entry_by_prompt_id(entries, pid)
    if entry is None:
        return {"ok": False, "status": 404, "error": "索引里没有 promptId=%s 这条提交" % pid}
    raw_file = entry.get("file")
    if not isinstance(raw_file, str) or not raw_file.strip():
        return {"ok": False, "status": 500, "error": "索引条目缺少 file 字段"}
    snapshot_file = raw_file.strip()
    if snapshot_file != os.path.basename(snapshot_file) or snapshot_file in (".", ".."):
        return {"ok": False, "status": 500, "error": "索引条目 file 字段非法（含路径）"}

    sidecar_name = _sidecar_file_name(snapshot_file)
    sidecar_path = os.path.join(dir_path, sidecar_name)
    merged = _merge_images(_read_sidecar_images(dir_path, snapshot_file), norm_in)
    obj = {"promptId": pid, "images": merged, "updatedAt": _to_iso(at)}
    try:
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        return {"ok": False, "status": 500, "error": "sidecar 序列化失败：%s" % exc}

    tmp_path = sidecar_path + ".tmp"
    try:
        os.makedirs(dir_path, exist_ok=True)
        with open(tmp_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        os.replace(tmp_path, sidecar_path)
    except OSError as exc:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
        return {"ok": False, "status": 500, "error": "写入 sidecar 失败：%s" % exc}
    return {"ok": True, "status": 200, "file": sidecar_name, "count": len(merged)}
