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
import uuid

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


# ── 连线端点归一化（v2 签名 / delta 共用）──────────────────────────────────
# 快照 links 真实格式（2026-10-15 实测 394 份历史快照：**全部为数组数组**）：
#   [[id, origin_id, origin_slot, target_id, target_slot, type], ...]
# 对象数组格式（[{id, origin_id, origin_slot, target_id, target_slot, type}]）一并兼容。
def _link_endpoint(link):
    """单条 link → (origin_id, origin_slot, target_id, target_slot) 原始 4 元组；无法解析 → None。"""
    if isinstance(link, dict):
        o, os_ = link.get("origin_id"), link.get("origin_slot")
        t, ts = link.get("target_id"), link.get("target_slot")
    elif isinstance(link, (list, tuple)) and len(link) >= 5:
        o, os_, t, ts = link[1], link[2], link[3], link[4]
    else:
        return None
    if o is None or t is None:
        return None
    return (o, os_, t, ts)


def _endpoint_str(ep):
    """端点 4 元组 → 规范化端点串 `originId:originSlot>targetId:targetSlot`（跨语言一致）。"""
    return "%s:%s>%s:%s" % (_canon_value(ep[0]), _canon_value(ep[1]), _canon_value(ep[2]), _canon_value(ep[3]))


def _links_part(graph):
    """签名的连线部分：全部端点串**排序**后以 "," 拼接（不用连线条数，端点对集合敏感）。"""
    g = graph if isinstance(graph, dict) else {}
    links = g.get("links") if isinstance(g.get("links"), list) else []
    parts = []
    for l in links:
        ep = _link_endpoint(l)
        if ep is None:
            continue
        parts.append(_endpoint_str(ep))
    parts.sort()
    return ",".join(parts)


def _norm_slot(v):
    """槽位号归一化：None → None；整数值 → int；其余数值原样；非数值 → 字符串。"""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return int(v) if float(v).is_integer() else v
    return str(v)


def _links_index(graph):
    """links → {端点串: 端点 4 元组}（首个同串为准）。"""
    g = graph if isinstance(graph, dict) else {}
    links = g.get("links") if isinstance(g.get("links"), list) else []
    out = {}
    for l in links:
        ep = _link_endpoint(l)
        if ep is None:
            continue
        key = _endpoint_str(ep)
        if key not in out:
            out[key] = ep
    return out


def _link_end(node_id, slot, by_id):
    """delta 的单侧端点：{type, slot}；type = 节点 type 名，取不到则用 id 兜底。"""
    n = by_id.get(_canon_value(node_id))
    typ = None
    if isinstance(n, dict) and n.get("type") is not None:
        typ = str(n.get("type"))
    if typ is None or typ == "":
        typ = _canon_value(node_id)
    return {"type": typ, "slot": _norm_slot(slot)}


def _link_desc(ep, by_id):
    """端点 4 元组 → {from:{type,slot}, to:{type,slot}}。"""
    return {"from": _link_end(ep[0], ep[1], by_id), "to": _link_end(ep[2], ep[3], by_id)}


def graph_sig_ignoring_seed(graph):
    """归一化画布签名（忽略 seed 类 widget；v2 起纳入连线端点对）。
    口径（v2）：节点部分 = 按 graph.nodes 顺序，逐节点 type + "|" + widget 段，各节点段先
    fnv1a，再以 "|" 串接；连线部分 = 全部端点串（`originId:originSlot>targetId:targetSlot`）
    排序后以 "," 拼接；最终 `"v2:" + fnv1a(节点部分 + "#L#" + 连线部分)`，输出 8 位小写 hex。
    与桥 js graphSignature() 同族但更简化（不含 mode/title/位置；不含节点 id）。
    口径版本前缀：旧数据无 `v2:` 前缀 → 判为不可比 → 不合并（一次性代价）。"""
    g = graph if isinstance(graph, dict) else {}
    nodes = g.get("nodes") if isinstance(g.get("nodes"), list) else []
    parts = []
    for n in nodes:
        if not isinstance(n, dict):
            continue
        typ = "" if n.get("type") is None else str(n.get("type"))
        parts.append(_fnv1a_hex("%s|%s" % (typ, _widgets_part(n))))
    return "v2:" + _fnv1a_hex("|".join(parts) + "#L#" + _links_part(g))


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
    """对比两画布（UI 格式），相对 prev 算四类变化（节点三类 + 连线一类）。
    prev_graph 为 None/非法 → 返回 None。
    返回 {"changed":[{id,title,fields}], "added":[{id,title}], "removed":[{id,title}],
          "links":{"added":[{from:{type,slot},to:{type,slot}}], "removed":[...]}}。
    连线身份 = 端点串 `originId:originSlot>targetId:targetSlot`；改接自然表达为 removed+added。"""
    if not isinstance(prev_graph, dict):
        return None
    prev = _index_nodes_by_id(prev_graph)
    nxt = _index_nodes_by_id(next_graph)
    link_prev = _links_index(prev_graph)
    link_next = _links_index(next_graph)
    links_added = []
    links_removed = []
    for k in link_next:
        if k not in link_prev:
            links_added.append(k)
    for k in link_prev:
        if k not in link_next:
            links_removed.append(k)
    links_added.sort()
    links_removed.sort()
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
    return {
        "changed": changed,
        "added": added,
        "removed": removed,
        "links": {
            "added": [_link_desc(link_next[k], nxt) for k in links_added],
            "removed": [_link_desc(link_prev[k], prev) for k in links_removed],
        },
    }


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
    """归一化 block（完整版）：{name, source, nodeIds, color}。

    color（2026-10-20 新增）：提交时画布框的颜色快照。
    为何必须存：内条颜色原来回头查「活图框色」，一旦提交之后改框色/删框/改名，
    旧提交的内条就跟着变错位——历史应当只读历史。
    旧条目无此字段 → 缺省 None（读侧退回活图/中性灰，不报错）。
    """
    b = blk if isinstance(blk, dict) else {}
    src = b.get("source")
    src = src if isinstance(src, str) and src else "group"
    ids = b.get("nodeIds")
    c = b.get("color")
    return {
        "name": "" if b.get("name") is None else str(b.get("name")),
        "source": src,
        "nodeIds": list(ids) if isinstance(ids, list) else [],
        "color": c if isinstance(c, str) and c else None,
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
    """历史目录绝对路径：<user_dir>/workflows/.history/<净化后的键>。

    2026-10-14 起参数含义由「工作流名」扩为「历史键」：既可是画布身份 id（uuid），
    也可是净化后的工作流名（老行为）。本函数语义不变（净化 + 拼接）。
    """
    return os.path.abspath(
        os.path.join(
            "" if user_dir is None else str(user_dir),
            "workflows",
            ".history",
            sanitize_workflow_name(workflow_name),
        )
    )


# ── 2.1 画布身份 id 主键（2026-10-14：历史主键改画布身份）────────────────────
# 背景：历史目录原按工作流**显示名**为键 → 改名/另存致键漂移（曾致数据丢失）。
# 现改为按画布身份 id（前端 JSON 顶层 uuid）为键：rename 保 id → 历史自动跟随。
# 共享 id 的多张画布（文件级同源派生）用 claims 登记表 mint sideId「各算各的」。
# 全部状态限定在 <user_dir>/workflows/.history/ 内：.claims.json + <键目录>/.meta.json。

# 合法 uuid（8-4-4-4-12 十六进制）；非 uuid（老 legacyId / 名）一律走名键。
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
# claims 登记表 / 目录元数据文件名
CLAIMS_FILE_NAME = ".claims.json"
META_FILE_NAME = ".meta.json"
# 2026-10-23：HEAD（当前所在提交节点）持久化文件，与 index.jsonl 同级。
# 内容 {"seq": 12, "at": "<ISO>"}；HEAD 是**图的状态**，不再依赖前端 localStorage。
# 见 docs/方案-修复提交图泳道与HEAD-20261023.md §3.2。
HEAD_FILE_NAME = ".head.json"


def is_valid_uuid(v):
    """是否合法 uuid 字符串（去首尾空白后整串匹配 8-4-4-4-12 十六进制）。"""
    return isinstance(v, str) and bool(_UUID_RE.match(v.strip()))


def _claims_path(user_dir):
    """claims 登记表绝对路径：<user_dir>/workflows/.history/.claims.json。"""
    return os.path.abspath(
        os.path.join(
            "" if user_dir is None else str(user_dir),
            "workflows",
            ".history",
            CLAIMS_FILE_NAME,
        )
    )


def _read_claims(user_dir):
    """读 claims 登记表。返回 (claims, ok)：
      · 文件缺失 → ({}, True)（首次写会新建）；
      · 内容损坏（坏 JSON / 非对象）→ ({}, False)（调用方回退纯 id 键，**不覆盖原文件**）。
    """
    path = _claims_path(user_dir)
    if not os.path.isfile(path):
        return {}, True
    try:
        with open(path, "r", encoding="utf-8") as fh:
            obj = json.loads(fh.read())
    except (OSError, ValueError):
        return {}, False
    if not isinstance(obj, dict):
        return {}, False
    return obj, True


def _write_claims(user_dir, claims):
    """原子写 claims（同目录 .tmp → os.replace）。目录不存在则递归创建；失败静默（best-effort）。"""
    path = _claims_path(user_dir)
    text = json.dumps(claims, ensure_ascii=False, separators=(",", ":"))
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except OSError:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


# 临时画布（未落盘）的哨兵身份：不受其显示名变化影响（2026-10-14 致命修正）。
TEMP_IDENTITY = "__temp__"


def _identity_of(name, path, temporary):
    """identity 归一化（mint 判据，**不用显示名当身份**）：
      · temporary（未落盘画布）→ 哨兵 TEMP_IDENTITY（改名不影响）；
      · 已落地文件有相对路径 → path（strip 后）；
      · 兜底 → name（无 path 的老调用，属已知边界）。
    """
    if temporary:
        return TEMP_IDENTITY
    if isinstance(path, str) and path.strip():
        return path.strip()
    return name if isinstance(name, str) else ""


def _identity_is_path_like(identity):
    """identity 是否「像文件路径」（含 / \\ 或以 .json 结尾）——只有这类才参与 missing 判定。"""
    if not isinstance(identity, str) or not identity:
        return False
    return ("/" in identity) or ("\\" in identity) or identity.lower().endswith(".json")


def _identity_file_exists(user_dir, identity):
    """identity 对应的画布文件是否**真实存在**（判据基于文件系统事实，而非会变的值）。

      · identity 像路径（含 / \\ 或 .json 结尾）→ os.path.isfile(os.path.join(user_dir, identity))；
      · 否则（TEMP 哨兵 / 名兜底）→ True（名不参与 missing，避免误判）。
    读文件失败（异常）→ True（保守：宁可不判「消失」，也不误 mint）。
    """
    if not _identity_is_path_like(identity):
        return True
    try:
        return os.path.isfile(os.path.join(user_dir, identity))
    except OSError:
        return True


def _resolve_val(wid, val):
    """claims 值 → 实际历史键："primary" → id 本身；合法 uuid → 该 uuid（sideId）；其余 → id。"""
    if val == "primary":
        return wid
    if isinstance(val, str) and is_valid_uuid(val):
        return val.strip()
    return wid


def history_key(name, workflow_id=None, user_dir=None, path=None, temporary=None):
    """解析历史目录**键**：有效 uuid → id 键（查 claims 决定，含 mint）；无 id → 名键（老行为）。

    参数：
      name        —— 工作流显示名（无 id 时净化后作键；有 id 时仅作 identity 兜底）。
      workflow_id —— 画布身份 id（前端 JSON 顶层 uuid）；非法/缺失 → 走名键。
      user_dir    —— ComfyUI 用户目录（claims 落盘处；缺失 → 纯 id 键）。
      path        —— 可选：画布文件相对路径（identity 优先用它）。
      temporary   —— 可选 bool：画布未落盘（临时画布）→ identity 归入 TEMP 哨兵。

    claims 结构（<user_dir>/workflows/.history/.claims.json）：
      { "<id>": { "<identity>": "primary" | "<sideId>" } }
      identity = TEMP_IDENTITY（临时）/ 相对 path（正式）/ name（兜底）；
      值 "primary" → 键 = id 本身；值 sideId → 键 = 该 sideId。

    判据基于**文件系统事实**（旧文件还在不在），不用「会变的值」（name/path）判断变没变：
      ① 命中 identity → 幂等返回其键；
      ② 临时(TEMP) → 正式(path)：升级（键不变，只把 TEMP 的键挪给新 identity）；
      ③ 恰一个正式 path 消失（旧文件被 move 走）→ 单张改名 → 跟随（键不变）；
      ④ 首次认领 → 登记 primary，键 = id；
      ⑤ 两张独立（各自文件都在）→ mint sideId，键 = sideId（各算各的）。
    旧 claims 结构（{owner,paths}）兼容：claims 实际从未生成过，读到即重置为空表（不炸）。
    claims 损坏/缺失 → 回退纯 id 键（不覆盖损坏文件）。
    """
    if not is_valid_uuid(workflow_id):
        return sanitize_workflow_name(name)
    wid = workflow_id.strip()
    if not isinstance(user_dir, str) or not user_dir.strip():
        return wid  # 无 user_dir 无从查 claims → 纯 id 键
    identity = _identity_of(name, path, temporary)
    claims, ok = _read_claims(user_dir)
    if not ok:
        return wid  # claims 损坏 → 回退纯 id 键（不覆盖原文件）
    rec = claims.get(wid)
    rec = dict(rec) if isinstance(rec, dict) else {}
    # 旧结构兼容（{owner,paths}）：直接重置为最简空表（claims 实际从未生成过）
    if "owner" in rec or "paths" in rec:
        rec = {}

    # ① 命中（幂等）：该 identity 已登记 → 返回其键
    if identity in rec:
        return _resolve_val(wid, rec[identity])

    # ② 临时 → 正式：升级（键不变，把 TEMP 的键挪给正式 identity）
    if TEMP_IDENTITY in rec and identity != TEMP_IDENTITY:
        key = rec.pop(TEMP_IDENTITY)
        rec[identity] = key
        claims[wid] = rec
        _write_claims(user_dir, claims)
        return _resolve_val(wid, key)

    # ③ 恰一个正式 path 消失 → 单张改名 → 跟随（键不变）
    # 2026-10-24 护栏：仅当该 id 只登记过一条身份时才判「改名跟随」。
    # 为什么：多个工作流文件可共享同一 id（同源派生，例如 5 个 minimax_h3_* 共用 e3f2b845）。
    # 其中某个旧文件被删除/移走后，打开另一个文件会被误判成「改名」，把两段不同历史并进同一目录。
    # 取舍：宁可多拆一个目录（mint sideId），也不要误并两段历史。
    missing = [k for k in rec if k != TEMP_IDENTITY and not _identity_file_exists(user_dir, k)]
    if len(rec) <= 1 and len(missing) == 1:
        key = rec.pop(missing[0])
        rec[identity] = key
        claims[wid] = rec
        _write_claims(user_dir, claims)
        return _resolve_val(wid, key)

    # ④ 首次认领：登记 primary，键 = id
    if not rec:
        rec[identity] = "primary"
        claims[wid] = rec
        _write_claims(user_dir, claims)
        return wid

    # ⑤ 两张独立（各自文件都在）→ mint：为该 identity 分配 sideId
    side = str(uuid.uuid4())
    rec[identity] = side
    claims[wid] = rec
    _write_claims(user_dir, claims)
    return side


def resolve_history_dir(user_dir, name, workflow_id=None, path=None, temporary=None):
    """解析某工作流历史目录的**实际路径**（先 id 键后名键回退，兼容重排前/后）。

      · 有有效 id：id 键目录存在 → 用它；否则名键目录存在 → 回退用它；
        都不存在 → 返回 id 键目录（新建/写入按 id 落盘）。
      · 无 id：返回名键目录（老行为，一字不改）。
    2026-10-14：path/temporary → identity 归一化入参（见 history_key / _identity_of）。
    """
    name_dir = history_dir(user_dir, name)
    if not is_valid_uuid(workflow_id):
        return name_dir
    id_dir = history_dir(user_dir, history_key(name, workflow_id, user_dir, path, temporary))
    if os.path.isdir(id_dir):
        return id_dir
    if os.path.isdir(name_dir):
        return name_dir
    return id_dir


def _write_meta_file(dir_path, workflow_id, name, path=None):
    """在 id 键目录写人可读的 .meta.json：{id, name, path?, updatedAt}（原子写）。
    仅当 workflow_id 是合法 uuid 时写（名键老目录不写）；失败静默。
    """
    if not is_valid_uuid(workflow_id):
        return
    obj = {
        "id": workflow_id.strip(),
        "name": "" if name is None else str(name),
        "updatedAt": _to_iso(None),
    }
    if isinstance(path, str) and path.strip():
        obj["path"] = path.strip()
    meta_path = os.path.join(dir_path, META_FILE_NAME)
    tmp = meta_path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        os.replace(tmp, meta_path)
    except OSError:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass


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
    N3（2026-10-12）：快照**不再重复存 blocks**（方案 §2.4：块归属只由索引行存完整版）。
      · 入参 blocks 保留仅为向后兼容（调用方可不传/传了也被忽略），快照恒不写该字段；
      · 读侧兼容：旧快照若已带 blocks，read_snapshot 原样读回、不报错；新快照无该字段也正常；
      · schemaVersion 不 bump（字段缺席向后兼容）。
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
    # N3：不写 blocks（块归属由 build_index_line 写完整版；入参 blocks 忽略）
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


# ── 9.5 head 定位（P5b：合并判定 / delta 需要读 head 节点快照 graph）──────
def _find_entry_by_seq(entries, seq):
    """按 seq 在索引里找 entry；找不到 → None。"""
    n = _to_int(seq, None)
    if n is None:
        return None
    for e in entries if isinstance(entries, list) else []:
        if isinstance(e, dict) and _to_int(e.get("seq"), None) == n:
            return e
    return None


def _read_graph_from_snapshot_file(dir_path, snapshot_file):
    """读某快照文件里的 graph（UI 格式对象）；路径非法/文件缺失/坏 JSON/非对象 → None。"""
    if not isinstance(snapshot_file, str) or not snapshot_file.strip():
        return None
    fname = snapshot_file.strip()
    if fname != os.path.basename(fname) or fname in (".", ".."):
        return None
    path = os.path.join(dir_path, fname)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            snap = json.loads(fh.read())
    except (OSError, ValueError):
        return None
    if not isinstance(snap, dict):
        return None
    graph = snap.get("graph")
    return graph if isinstance(graph, dict) else None


def _head_node_graph(dir_path, entries, head_seq):
    """按 headSeq 定位节点 → 读其快照 graph；定位不到 / file 缺失 / 读不到 → None。
    head_seq 指向 mergeInto 标记行时解析到其目标节点（容错）。
    """
    entry = _find_entry_by_seq(entries, head_seq)
    if entry is None:
        return None
    if entry.get("mergeInto") is not None:
        entry = _find_entry_by_seq(entries, entry.get("mergeInto"))
    return _read_graph_from_snapshot_file(dir_path, entry.get("file")) if entry else None


def _last_node_seq(entries):
    """线性默认头：索引里最后一条**节点主行**（无 mergeInto）的 seq；无 → None。
    mergeInto 标记行不入选（它不携带快照，不是节点）。
    """
    seq = None
    for e in entries if isinstance(entries, list) else []:
        if not isinstance(e, dict) or e.get("mergeInto") is not None:
            continue
        n = _to_int(e.get("seq"), None)
        if n is not None:
            seq = n
    return seq


# ── 9.6 HEAD 持久化（2026-10-23：修「回跳后提交不分叉」）──────────────────────
# 契约：docs/方案-修复提交图泳道与HEAD-20261023.md §3.2。
# HEAD = 当前所在的提交节点，是**图的状态**而非浏览器状态：落盘在历史目录 .head.json，
# 与 index.jsonl 同级；parent 由后端据此决定，前端 localStorage 只作 UI 缓存。
def head_file_path(dir_path):
    """HEAD 文件绝对路径：<history_dir>/.head.json。"""
    return os.path.join(dir_path, HEAD_FILE_NAME)


def _is_main_seq(entries, seq):
    """seq 是否指向索引里存在的**主行**（存在且无 mergeInto 标记）。"""
    n = _to_int(seq, None)
    if n is None:
        return False
    entry = _find_entry_by_seq(entries, n)
    return entry is not None and entry.get("mergeInto") is None


def read_head(dir_path, entries):
    """读持久化 HEAD。返回 {"seq": int, "at": str|None} 或 None。

    None 的四种情形（§3.2 读规则）：文件缺失 / 坏 JSON / 非对象 / seq 非有限数或
    指向**不存在的主行**。即：**不返回脏值**（history-list 的 head 字段取此口径）。
    """
    path = head_file_path(dir_path)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            obj = json.loads(fh.read())
    except (OSError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    seq = _to_int(obj.get("seq"), None)
    if seq is None or not _is_main_seq(entries, seq):
        return None
    at = obj.get("at")
    return {"seq": seq, "at": None if at is None else str(at)}


def _head_seq_or_last(dir_path, entries):
    """定 parent 用的 headSeq：HEAD 有效 → 其 seq；文件缺失 / 坏 JSON / 指向不存在的主行
    → 退回 `_last_node_seq(entries)`（§3.2 读规则最后一行）。
    """
    head = read_head(dir_path, entries)
    return head["seq"] if head else _last_node_seq(entries)


def _write_head(dir_path, seq, at=None):
    """原子写 .head.json（同目录 .tmp → os.replace，沿用本模块既有做法）。

    ⚠️ 失败语义未在 §3.2 覆盖；此处沿用本模块 `_write_meta_file` 的既有口径：
       失败静默（best-effort），不阻断已成功的提交——读侧有「退回末条」兜底。
    """
    obj = {"seq": _to_int(seq, 0), "at": _to_iso(at)}
    path = head_file_path(dir_path)
    tmp = path + ".tmp"
    try:
        os.makedirs(dir_path, exist_ok=True)
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            fh.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")))
        os.replace(tmp, path)
        return True
    except OSError:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        return False


def set_head(body, user_dir, workflow_id=None, path=None, temporary=None):
    """POST /hana_bridge/history-head-set 的实现：把持久化 HEAD 设为指定 seq。

    请求体: { workflow, workflowId?, workflowPath?, workflowTemporary?, seq, at? }
    返回 {ok:True, status:200, seq} 或 {ok:False, status:400, error:…}；
    error 取值：missing_workflow / missing_seq / seq_not_found。
    seq 必须指向索引里存在的**主行**（无 mergeInto），否则 400 seq_not_found。
    """
    b = body if isinstance(body, dict) else {}
    workflow = b.get("workflow") if isinstance(b.get("workflow"), str) else ""
    workflow = workflow.strip()
    if not workflow:
        return {"ok": False, "status": 400, "error": "missing_workflow"}
    seq = _to_int(b.get("seq"), None)
    if seq is None:
        return {"ok": False, "status": 400, "error": "missing_seq"}
    if not isinstance(user_dir, str) or not user_dir.strip():
        return {"ok": False, "status": 500, "error": "无法解析 ComfyUI 用户目录（user_dir 未就绪）"}

    dir_path = resolve_history_dir(user_dir, workflow, workflow_id, path=path, temporary=temporary)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)
    entries = []
    try:
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as fh:
                entries = parse_index(fh.read())["entries"]
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}

    if not _is_main_seq(entries, seq):
        return {"ok": False, "status": 400, "error": "seq_not_found"}

    _write_head(dir_path, seq, b.get("at"))
    return {"ok": True, "status": 200, "seq": seq}


# ── 10. 提交落盘 ────────────────────────────────────────────────────────────
def commit(body, user_dir, workflow_id=None, path=None, temporary=None):
    """处理一次提交上报：写快照 + 追加索引行。返回带 status 的结果对象，由路由拆出 HTTP 码。

    流程对齐 JS handleHistoryCommit（含顺序）：缺字段 400 → 读索引 → next_seq →
    构造/序列化快照 → 体积防护（超限不写盘、**不建目录**）→ mkdir → 原子写快照 →
    追加一行索引。

    P2-F2 可选入参：blocks —— 块归属（[{name, source, nodeIds:[…]}]，桥前端算好随请求体带上）。
    非列表 → 视为未提供，快照/索引均不写该字段；schemaVersion 不 bump（新增可选字段向后兼容）。

    P5b 新增入参：source（缺省 "user"）、kind（缺省 "run"，白名单 run/save）、parent（缺省 None）。
    合并判定（仅 kind=="run"）：headSeq 可读、且其快照 graph 的归一化签名（忽略 seed 类 widget）
    与本轮 graph 相同 → 追加一行 mergeInto 标记行（**不改已写行、不写新快照**），
    返回 {merged:True, targetSeq:headSeq}；否则新建节点（parent=headSeq、delta=compute_delta(headGraph, graph)）。

    2026-10-14：新增可选 workflow_id（画布身份 id，uuid）。给定 → 历史目录键走 id
    （resolve_history_dir，先 id 后名回退），并写目录 .meta.json；缺省 → 完全走原名键（老行为）。
    同日新增可选 path（画布文件相对路径）/ temporary（bool，未落盘画布）→ identity 归一化
    （见 _identity_of）：临时画布不受显示名变化影响，落地后 owner 升级、键仍 = id。
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

    # P5b：新字段
    src = b.get("source")
    if src is None:
        src = "user"
    kind = _norm_kind(b.get("kind"))
    parent_raw = b.get("parent")
    parent_given = parent_raw is not None and parent_raw != ""

    prompt_id = b.get("promptId")
    prompt_id = None if prompt_id is None else str(prompt_id)
    dir_path = resolve_history_dir(user_dir, workflow, workflow_id, path=path, temporary=temporary)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)

    # 读已有索引（不存在当空处理；容错解析交给 parse_index）
    entries = []
    try:
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as fh:
                entries = parse_index(fh.read())["entries"]
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}

    # 归一化签名（忽略 seed 类 widget）+ 确定 headSeq
    # 2026-10-23 契约（§3.2）：parent 优先级 = ①请求体显式 parent（且存在于索引主行）
    # ②.head.json 的 seq（且存在于索引主行）③_last_node_seq(entries)。
    # 旧代码 parent_given 只看「有没有传」；传了但索引里查不到（脏 parent）会让图断链，
    # 故降为未传（与契约「否则视为未给」一致）。
    sig = graph_sig_ignoring_seed(b.get("graph"))
    parent_norm = _norm_parent(parent_raw) if parent_given else None
    if parent_norm is not None and _is_main_seq(entries, parent_norm):
        head_seq = parent_norm
    else:
        head_seq = _head_seq_or_last(dir_path, entries)
    head_graph = _head_node_graph(dir_path, entries, head_seq)

    # 合并判定（仅 kind=="run"）：headSeq 存在 + 能读到 head 节点快照 graph + 签名相同
    if kind == "run" and head_seq is not None and head_graph is not None:
        if graph_sig_ignoring_seed(head_graph) == sig:
            seq = next_seq(entries)
            merge_line = json.dumps(
                {
                    "seq": seq,
                    "mergeInto": head_seq,
                    "promptId": prompt_id,
                    "at": _to_iso(b.get("at")),
                    "kind": "run",
                    "source": normalize_source(src),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            try:
                os.makedirs(dir_path, exist_ok=True)
                _write_meta_file(dir_path, workflow_id, workflow, path=path)
                with open(index_path, "a", encoding="utf-8", newline="") as fh:
                    fh.write(merge_line + "\n")
            except OSError as exc:
                return {"ok": False, "status": 500, "error": "追加合并行失败：%s" % exc}
            return {"ok": True, "status": 200, "merged": True, "targetSeq": head_seq, "dir": dir_path}

    # 新建节点（kind="save"、或签名不同 / 无 head）
    return _create_node(
        dir_path,
        index_path,
        entries,
        b.get("graph"),
        prompt_id=prompt_id,
        at=b.get("at"),
        source=src,
        blocks=b.get("blocks"),
        kind=kind,
        parent=head_seq,
        head_graph=head_graph,
        sig=sig,
        workflow_id=workflow_id,
        workflow_name=workflow,
        path=path,
    )


def _create_node(dir_path, index_path, entries, graph, prompt_id=None, at=None, source="unknown",
                 blocks=None, kind="run", parent=None, head_graph=None, sig=None,
                 workflow_id=None, workflow_name=None, path=None):
    """新建一个提交节点：算 delta → 写快照 → 追加索引主行。
    commit 的「新建」分支与 save_commit 共用（kind/promptId/parent/delta 由调用方给定）。
    返回 {ok, status, merged:False, seq, file, dir}；体积超限 → 413（不写盘、不建目录）。
    2026-10-14：可选 workflow_id/workflow_name → 目录落盘后写 .meta.json（仅 id 键目录）。
    """
    seq = next_seq(entries)
    file_name = snapshot_file_name(seq, prompt_id)
    abs_file = os.path.join(dir_path, file_name)

    # N3：快照不再写 blocks（build_snapshot 忽略 blocks 入参）
    snapshot = build_snapshot(graph, prompt_id, seq, at, source)
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

    # delta：相对 head 节点快照 graph（head 读不到 → None）
    delta = compute_delta(head_graph, graph)
    if sig is None:
        sig = graph_sig_ignoring_seed(graph)

    # 索引主行（不含 graph；字段取自 snapshot，保证与落盘快照一致）
    line = build_index_line(
        {
            "seq": seq,
            "file": file_name,
            "promptId": snapshot["promptId"],
            "at": snapshot["at"],
            "source": snapshot["source"],
            "kind": kind,
            "parent": parent,
            "sig": sig,
            "delta": delta,
            "nodeCount": snapshot["nodeCount"],
            "linkCount": snapshot["linkCount"],
            "blocks": blocks,  # N3：索引行仍写完整版 blocks（取自上报入参；与快照无关）
        }
    )

    # 目录不存在就递归创建（在体积防护之后，超限不落任何盘上痕迹）
    try:
        os.makedirs(dir_path, exist_ok=True)
        _write_meta_file(dir_path, workflow_id, workflow_name, path=path)
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

    # 2026-10-23（§3.2）：新建节点成功 → .head.json ← 新节点 seq。
    # 放在本函数（而非 commit/save_commit）里：两处新建都走这里，口径天然一致；
    # merge 分支不经过本函数，head 自然不变。写失败静默（读侧有退回末条兜底）。
    _write_head(dir_path, seq)

    return {"ok": True, "status": 200, "merged": False, "seq": seq, "file": file_name, "dir": dir_path}


def save_commit(body, user_dir, workflow_id=None, path=None, temporary=None):
    """P5b：存档当前画布 —— 永远**新建**一个 kind="save" 节点（无 promptId、不参与合并判定）。
    请求体: { workflow, graph, at?, source? }（无 promptId）。返回 {ok, status, seq, file, dir}。
    复用 _create_node；parent 取持久化 HEAD（.head.json，见 §3.2 读规则）——HEAD 缺失/
    坏 JSON/指向不存在的主行 → 退回索引末条主行；delta 相对该 head 节点的快照 graph 算。
    2026-10-14：新增可选 workflow_id → 键走 id（resolve_history_dir，先 id 后名回退）；缺省走原名键。
    同日新增可选 path / temporary → identity 归一化（见 history_key / _identity_of）。
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

    src = b.get("source")
    if src is None:
        src = "user"

    # 2026-10-23（§3.2）：parent 优先级与 commit 一致
    # ①请求体显式 parent（且存在于索引主行）②.head.json ③索引末条主行
    parent_raw = b.get("parent")
    parent_given = parent_raw is not None and parent_raw != ""

    dir_path = resolve_history_dir(user_dir, workflow, workflow_id, path=path, temporary=temporary)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)
    entries = []
    try:
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as fh:
                entries = parse_index(fh.read())["entries"]
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}

    parent_norm = _norm_parent(parent_raw) if parent_given else None
    if parent_norm is not None and _is_main_seq(entries, parent_norm):
        head_seq = parent_norm
    else:
        head_seq = _head_seq_or_last(dir_path, entries)
    head_graph = _head_node_graph(dir_path, entries, head_seq)

    return _create_node(
        dir_path,
        index_path,
        entries,
        b.get("graph"),
        prompt_id=None,
        at=b.get("at"),
        source=src,
        blocks=b.get("blocks"),
        kind="save",
        parent=head_seq,
        head_graph=head_graph,
        sig=graph_sig_ignoring_seed(b.get("graph")),
        workflow_id=workflow_id,
        workflow_name=workflow,
        path=path,
    )


# ── 10.4 改名迁移（2026-10-14：修「未保存画布保存后提交历史全丢」）──────────
# 根因：历史按工作流**显示名**做目录键。未保存画布用临时名累积提交，另存（改名）后
# 名字变正式名 → 读历史的键变成新名 → 命中空目录 → 表现为「全丢」（旧数据仍躺在旧名
# 目录里）。修法：改名时把旧名目录的历史迁移/并入新名目录。见
# docs/方案-修复历史保存后丢失-20261014.md §3.1。全部操作限定在
# <user_dir>/workflows/.history/ 目录树内。
def _shift_seq_in_name(file_name, new_seq):
    """快照文件名首段（seq，%04d）替换为新 seq；形态异常（无 `-` 分段 / 含路径）→ None。"""
    if not isinstance(file_name, str) or file_name != os.path.basename(file_name):
        return None
    cut = file_name.find("-")
    if cut <= 0:
        return None
    return str(new_seq).zfill(4) + file_name[cut:]


def migrate_history(from_name, to_name, user_dir):
    """改名迁移：把 <from> 的历史目录内容并入 <to> 的历史目录。

    返回 {ok, status, moved, merged, note?}（由路由拆 status）：
      · moved  = 源**主行**数（无 mergeInto 的节点行；与整体搬移口径一致）；
      · merged = 实际追加到目标索引的行数（含 mergeInto 标记行）；
      · note   = "same"（净化后同名，无事）/ "src_missing"（源目录不存在，无事）/
                 "renamed"（目标不存在 → 整体搬移）/ 省略（合并成功）/ "conflicts:N"（有
                 文件重名冲突被跳过，见下）。

    规则：
      · from/to 净化后同名（含都空 → untitled）→ {ok:True, status:200, moved:0, merged:0, note:"same"}。
      · 源目录不存在 → {ok:True, status:200, moved:0, merged:0, note:"src_missing"}。
      · 目标目录不存在 → os.rename(src_dir, dst_dir) 整体搬移（同盘最快，seq 保持原样不变）。
      · 目标已存在 → **合并**：
          - offset = next_seq(目标 entries)（新 seq = 旧 seq + offset）；
          - 逐条源行：seq += offset；parent 非 null 且 ≥1 → parent += offset；
            mergeInto 非 null → mergeInto += offset（保持父子引用自洽）；
          - 源快照 <seq>-id.json 与 <seq>-id.json.images.json sidecar 按新 seq 改名后
            移入目标目录（os.replace，同卷 rename）；
          - 追加改写后的行到目标 index.jsonl（一次写入，追加语义）；
          - 合并完成后删除源目录（内容已全部并入）。
      · 幂等/容错：坏行按 parse_index 口径容错（不进 entries）；文件重名冲突（理论上 seq
        已偏移不会撞）或源文件缺失 → 跳过该行并在 note 记 "conflicts:N"；源目录里索引未
        引用的余留文件（不冲突时）一并移入，不删数据。
    """
    if not isinstance(user_dir, str) or not user_dir.strip():
        return {"ok": False, "status": 500, "error": "无法解析 ComfyUI 用户目录（user_dir 未就绪）"}

    # 净化后同名 → 无事（含都空 → untitled）
    if sanitize_workflow_name(from_name) == sanitize_workflow_name(to_name):
        return {"ok": True, "status": 200, "moved": 0, "merged": 0, "note": "same"}

    src_dir = history_dir(user_dir, from_name)
    dst_dir = history_dir(user_dir, to_name)
    if not os.path.isdir(src_dir):
        return {"ok": True, "status": 200, "moved": 0, "merged": 0, "note": "src_missing"}

    src_index = os.path.join(src_dir, INDEX_FILE_NAME)

    # 读源索引（无索引当空；容错解析交给 parse_index）
    src_entries = []
    if os.path.isfile(src_index):
        try:
            with open(src_index, "r", encoding="utf-8") as fh:
                src_entries = parse_index(fh.read())["entries"]
        except OSError as exc:
            return {"ok": False, "status": 500, "error": "读取源索引失败：%s" % exc}
    src_mains = [e for e in src_entries if e.get("mergeInto") is None]

    # 目标目录不存在 → 整体搬移（同盘 rename 最快；文件名/seq 原样保留）
    if not os.path.isdir(dst_dir):
        try:
            os.rename(src_dir, dst_dir)
        except OSError as exc:
            return {"ok": False, "status": 500, "error": "整体搬移失败：%s" % exc}
        return {"ok": True, "status": 200, "moved": len(src_mains), "merged": 0, "note": "renamed"}

    # 目标已存在 → 合并
    dst_index = os.path.join(dst_dir, INDEX_FILE_NAME)
    dst_entries = []
    if os.path.isfile(dst_index):
        try:
            with open(dst_index, "r", encoding="utf-8") as fh:
                dst_entries = parse_index(fh.read())["entries"]
        except OSError as exc:
            return {"ok": False, "status": 500, "error": "读取目标索引失败：%s" % exc}
    offset = next_seq(dst_entries)  # 起点：目标的下一条空位（源 seq 整体后移 offset）

    out_lines = []
    out_rows = []  # 与 out_lines 同序：合并后用于校正 HEAD 的末条主行
    conflicts = 0
    for e in src_entries:
        new_seq = _to_int(e.get("seq"), 0) + offset
        row = dict(e)
        row["seq"] = new_seq
        # parent：非 null 且 ≥1 → 同步偏移（保持父子引用自洽）
        p = _norm_parent(e.get("parent"))
        if p is not None and p >= 1:
            row["parent"] = p + offset
        # mergeInto：非 null → 同步偏移（合并行指回偏移后的目标主行）
        m = _norm_parent(e.get("mergeInto"))
        if m is not None:
            row["mergeInto"] = m + offset

        # 快照文件（只有主行带 file；mergeInto 行不携带快照）
        raw_file = e.get("file")
        if isinstance(raw_file, str) and raw_file.strip():
            old_name = raw_file.strip()
            new_name = _shift_seq_in_name(old_name, new_seq)
            src_file = os.path.join(src_dir, old_name) if new_name else ""
            dst_file = os.path.join(dst_dir, new_name) if new_name else ""
            if new_name is None or not os.path.isfile(src_file) or os.path.exists(dst_file):
                conflicts += 1  # 形态异常 / 源文件缺失 / 重名冲突 → 跳过该行
                continue
            try:
                os.replace(src_file, dst_file)
            except OSError:
                conflicts += 1
                continue
            # .images.json sidecar 与主快照同名 → 同步改名移入
            old_side = _sidecar_file_name(old_name)
            if old_side and os.path.isfile(os.path.join(src_dir, old_side)):
                new_side = _sidecar_file_name(new_name)
                dst_side = os.path.join(dst_dir, new_side)
                if os.path.exists(dst_side):
                    conflicts += 1
                else:
                    try:
                        os.replace(os.path.join(src_dir, old_side), dst_side)
                    except OSError:
                        pass  # sidecar 迁移失败不阻断合并（产物图列表可重建）
            row["file"] = new_name
        out_lines.append(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
        out_rows.append(row)

    # 追加改写后的行（追加写，禁止读全文重写整份索引）
    if out_lines:
        try:
            with open(dst_index, "a", encoding="utf-8", newline="") as fh:
                fh.write("\n".join(out_lines) + "\n")
        except OSError as exc:
            return {
                "ok": False,
                "status": 500,
                "error": "追加目标索引失败：%s" % exc,
                "moved": len(src_mains),
                "merged": 0,
            }

    # 2026-10-23：合并成功后校正目标 HEAD —— 目标目录的 .head.json 仍是迁移前旧值，
    # 会让迁移后首次提交 parent 指回旧末条，在图上凭空长出一条泳道。
    # 口径：HEAD = 合并后索引的末条**主行**（含刚追加的行，不用迁移前的 entries）。
    # 未追加任何行（全冲突/空源）→ 图未变，不动 HEAD（避免覆盖用户已设的回跳 HEAD）。
    if out_lines:
        merged_head = _last_node_seq(list(dst_entries) + out_rows)
        if merged_head is not None:
            _write_head(dst_dir, merged_head)

    # 源目录里索引未引用的余留文件（弃用快照等）：不冲突就一并移入（不丢数据）
    # 2026-10-23：HEAD 文件不走「余留」通道 —— 它是**每个历史目录各自的**单值状态，
    # 不能当作可搬运的产物（目标已有自己的 HEAD 时不搬，会导致源目录删不干净）。
    try:
        leftover = os.listdir(src_dir)
    except OSError:
        leftover = []
    for name in leftover:
        if name in (INDEX_FILE_NAME, HEAD_FILE_NAME):
            continue
        src_p = os.path.join(src_dir, name)
        dst_p = os.path.join(dst_dir, name)
        if not os.path.isfile(src_p) or os.path.exists(dst_p):
            continue
        try:
            os.replace(src_p, dst_p)
        except OSError:
            pass

    # 内容已全部并入 → 删源索引 + 源 HEAD + 源目录（删不干净不算失败）
    try:
        if os.path.isfile(src_index):
            os.remove(src_index)
        src_head = head_file_path(src_dir)
        if os.path.isfile(src_head):
            os.remove(src_head)
        os.rmdir(src_dir)
    except OSError:
        pass

    out = {"ok": True, "status": 200, "moved": len(src_mains), "merged": len(out_lines)}
    if conflicts:
        out["note"] = "conflicts:%d" % conflicts
    return out


# ── 10.5 框视角：一条提交 → 碰过的框（P6，只读计算，不落盘）────────────────
def _block_names_for_entry(entry):
    """一条 entry「碰过」的框名列表（只读计算，不改索引磁盘内容）。

    判定：一条提交碰过框 B ⟺ delta 的 changed/added/removed 里任一节点 id ∈ B.nodeIds。
    三种返回值（blockNames 字段语义）：
      · None     —— **无法判定**：旧数据（delta 非 dict），或 blocks 非 list，
                    或 blocks 里任一项缺 nodeIds / nodeIds 非数组；
      · []       —— 有数据但没碰任何框（delta + blocks 完整，无一命中）；
      · [名字…]  —— 命中的框名列表（按 blocks 顺序，name 缺省补 ""）。
    id 一律 str 后比较（索引里 nodeIds 是 number，delta 里可能 number/string，统一避类型坑）。
    """
    e = entry if isinstance(entry, dict) else {}
    delta = e.get("delta")
    if not isinstance(delta, dict):
        return None
    blocks = e.get("blocks")
    if not isinstance(blocks, list):
        return None
    hit_ids = set()
    for k in ("changed", "added", "removed"):
        items = delta.get(k)
        if not isinstance(items, list):
            continue
        for x in items:
            if not isinstance(x, dict):
                continue
            nid = x.get("id")
            if nid is not None:
                hit_ids.add(str(nid))
    names = []
    for b in blocks:
        if not isinstance(b, dict):
            return None  # 块形态不可读 → 无法判定
        ids = b.get("nodeIds")
        if not isinstance(ids, list):
            return None  # 有块但无 nodeIds = 旧数据（无法判定）
        if any(str(i) in hit_ids for i in ids):
            names.append("" if b.get("name") is None else str(b.get("name")))
    return names


# ── 11. 查询 ────────────────────────────────────────────────────────────────
def list_commits(workflow, user_dir, workflow_id=None, path=None, temporary=None):
    """读某工作流的索引。目录不存在 → 空 entries（ok=True）；索引坏行只计数不抛异常。

    2026-10-14：新增可选 workflow_id → 目录键走 id（resolve_history_dir，先 id 后名回退）；
    缺省 → 完全走原名键（老行为）。同日新增可选 path / temporary → identity 归一化。

    P5b：折叠 mergeInto 行 + 新字段。每条主行 entry **只读合并**（不写回索引磁盘）：
      · parent/kind/sig/delta —— 由 normalize_entry 缺省补全（旧条目兼容）
      · runs   —— 该节点的全部 run（主行 promptId + 各 mergeInto 行的 promptId +
                  sidecar 里其余 run），去重排序；每 run 的 images 由 sidecar 提供
      · images —— runs 里所有 images 的扁平合并
      · blockNames —— P6 框视角：该提交碰过的框名列表（null=无法判定；[]=没碰任何框）
    mergeInto 行**不单独成 entry**（其 promptId 并入目标节点的 runs）。
    """
    if not isinstance(user_dir, str) or not user_dir.strip():
        return {"ok": False, "status": 500, "error": "无法解析 ComfyUI 用户目录（user_dir 未就绪）"}
    dir_path = resolve_history_dir(user_dir, workflow, workflow_id, path=path, temporary=temporary)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)
    if not os.path.isdir(dir_path):
        return {"ok": True, "status": 200, "entries": [], "badLines": 0, "head": None}
    try:
        with open(index_path, "r", encoding="utf-8") as fh:
            parsed = parse_index(fh.read())
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}

    # 折叠 mergeInto 行：目标 seq → [merge 行…]（按索引顺序）
    merge_rows = {}
    for e in parsed["entries"]:
        if not isinstance(e, dict) or e.get("mergeInto") is None:
            continue
        key = _to_int(e.get("mergeInto"), None)
        if key is not None:
            merge_rows.setdefault(key, []).append(e)

    out_entries = []
    for e in parsed["entries"]:
        if not isinstance(e, dict):
            out_entries.append(e)
            continue
        if e.get("mergeInto") is not None:
            continue  # 折叠：不单独成 entry
        norm = normalize_entry(e)
        norm["blockNames"] = _block_names_for_entry(e)
        snapshot_file = _entry_snapshot_file(e)
        sidecar_runs = _read_sidecar_runs(dir_path, snapshot_file) if snapshot_file else []
        seq_key = _to_int(e.get("seq"), None)
        rows = merge_rows.get(seq_key, []) if seq_key is not None else []
        norm["runs"] = _node_runs(e, sidecar_runs, rows)
        norm["images"] = _merge_images([], [im for r in norm["runs"] for im in r["images"]])
        out_entries.append(norm)
    return {
        "ok": True,
        "status": 200,
        "entries": out_entries,
        "badLines": parsed["badLines"],
        # 2026-10-23（§3.2）：持久化 HEAD；指向不存在的主行 / 文件缺失 / 坏 JSON → null
        "head": read_head(dir_path, parsed["entries"]),
    }


# ── 12. 快照全文读取（P3-G1：回跳用）───────────────────────────────────────
def read_snapshot(workflow, user_dir, seq=None, file_name=None, workflow_id=None, path=None, temporary=None):
    """读一份提交快照的完整 JSON（含 graph 本体）。返回带 status 的结果对象，由路由拆出 HTTP 码。

    定位：file 优先（直接点名，回跳前端走这条）；否则用 seq 从索引解析出 file（history-list
    只有摘要、无 graph 本体，本函数是回跳拿完整快照的入口）。
    file 只接受纯文件名（拒绝任何含路径分隔的值，防穿越）；索引缺失/无该条 → 404。
    失败码：400 参数缺失/非法；404 快照不存在；500 读取/解析失败（含坏 JSON）。
    2026-10-14：新增可选 workflow_id → 目录键走 id（先 id 后名回退）；缺省走原名键。
    同日新增可选 path / temporary → identity 归一化（见 history_key）。
    """
    if not isinstance(user_dir, str) or not user_dir.strip():
        return {"ok": False, "status": 500, "error": "无法解析 ComfyUI 用户目录（user_dir 未就绪）"}
    if not isinstance(workflow, str) or not workflow.strip():
        return {"ok": False, "status": 400, "error": "需要 workflow（工作流名）"}
    dir_path = resolve_history_dir(user_dir, workflow, workflow_id, path=path, temporary=temporary)
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


def _sidecar_obj_to_runs(obj):
    """sidecar 对象 → runs 归一化列表（P5b）。
    新形态 {runs:[{promptId,at,images}]} → 归一；
    旧形态 {promptId,images,updatedAt} → 单元素 runs（at 取 updatedAt）；
    其余/非对象 → []。
    """
    if not isinstance(obj, dict):
        return []
    if isinstance(obj.get("runs"), list):
        return _norm_runs(obj.get("runs"))
    if "promptId" in obj or "images" in obj:
        return _norm_runs(
            [{"promptId": obj.get("promptId"), "at": obj.get("updatedAt"), "images": obj.get("images")}]
        )
    return []


def _read_sidecar_runs(dir_path, snapshot_file):
    """读 <dir>/<snapshot_file>.images.json 的 runs（含旧形态归一）；无/坏/非对象 → []。"""
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
    return _sidecar_obj_to_runs(obj)


def _find_target_entry_by_prompt_id(entries, prompt_id):
    """按 promptId 定位其所属的**主行节点** entry（P5b）。
    先查主行（无 mergeInto）；未中再查 mergeInto 行，解析其 mergeInto=目标 seq 回主行。
    合并场景下第二次运行的 promptId 只出现在 mergeInto 行 —— 本函数负责归位。找不到 → None。
    """
    pid = None if prompt_id is None else str(prompt_id)
    if not pid:
        return None
    lst = entries if isinstance(entries, list) else []
    for e in lst:
        if not isinstance(e, dict):
            continue
        if e.get("mergeInto") is None and e.get("promptId") is not None and str(e.get("promptId")) == pid:
            return e
    for e in lst:
        if not isinstance(e, dict):
            continue
        if e.get("mergeInto") is not None and e.get("promptId") is not None and str(e.get("promptId")) == pid:
            return _find_entry_by_seq(lst, e.get("mergeInto"))
    return None


def _entry_snapshot_file(entry):
    """取主行 entry 的快照文件名（带路径穿越防护）；非法 → None。"""
    if not isinstance(entry, dict):
        return None
    raw = entry.get("file")
    if not isinstance(raw, str) or not raw.strip():
        return None
    fname = raw.strip()
    if fname != os.path.basename(fname) or fname in (".", ".."):
        return None
    return fname


def read_images_for(workflow, user_dir, prompt_id, workflow_id=None, path=None, temporary=None):
    """内部用：读某工作流某 promptId 所属 run 的产物图 list；无 sidecar / 无该 promptId → []。
    2026-10-14：新增可选 workflow_id → 目录键走 id（先 id 后名回退）；缺省走原名键。
    同日新增可选 path / temporary → identity 归一化。
    """
    if not isinstance(workflow, str) or not workflow.strip():
        return []
    if not isinstance(user_dir, str) or not user_dir.strip():
        return []
    if prompt_id is None or not str(prompt_id):
        return []
    dir_path = resolve_history_dir(user_dir, workflow, workflow_id, path=path, temporary=temporary)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)
    if not os.path.isfile(index_path):
        return []
    try:
        with open(index_path, "r", encoding="utf-8") as fh:
            entries = parse_index(fh.read())["entries"]
    except OSError:
        return []
    entry = _find_target_entry_by_prompt_id(entries, prompt_id)
    snapshot_file = _entry_snapshot_file(entry)
    if snapshot_file is None:
        return []
    pid = str(prompt_id)
    for r in _read_sidecar_runs(dir_path, snapshot_file):
        if r["promptId"] == pid:
            return r["images"]
    return []


def _node_runs(entry, sidecar_runs, merge_rows):
    """拼一个节点的 runs（P5b）：
    顺序 = 主 run（entry.promptId）→ 各 mergeInto 行的 run（按索引顺序）→ sidecar 里其余 run。
    同一 promptId 只保留一条；有 sidecar images 则并入；at 优先取索引行的 at（权威运行时间），
    索引无（仅 sidecar 有）则用 sidecar 的 at。save 节点（promptId=None）不产主 run。
    """
    by_pid = {}
    for r in sidecar_runs:
        if r["promptId"] is not None and r["promptId"] not in by_pid:
            by_pid[r["promptId"]] = r
    ordered = []
    seen = set()

    def add(pid, at):
        if pid is None:
            return
        k = str(pid)
        if k in seen:
            return
        seen.add(k)
        r = by_pid.get(k)
        ordered.append(
            {
                "promptId": k,
                "at": at if at else (r["at"] if r else None),
                "images": list(r["images"]) if r else [],
            }
        )

    add(entry.get("promptId"), entry.get("at"))
    for m in merge_rows:
        add(m.get("promptId"), m.get("at"))
    for r in sidecar_runs:
        if r["promptId"] is not None and r["promptId"] not in seen:
            seen.add(r["promptId"])
            ordered.append(r)
    return ordered


def attach_images(workflow, user_dir, prompt_id, images, at=None, workflow_id=None, path=None, temporary=None):
    """把一次出图的产物文件名持久化到 sidecar（P4 修；P5b 升级为 runs）。

    校验 workflow / promptId / images（非空数组，每项含 filename）→ 非法 400；
    读索引按 promptId 定位所属**主行节点**（含 mergeInto 归位）→ 找不到 404；
    取其 file 基名 → sidecar = <基名>.images.json；
    读旧 sidecar（含旧形态归一）→ 按 promptId 找该 run → 去重合并 images；无则新建 run；
    原子写回（.tmp → os.replace）。
    返回 {ok, status, file, count}；file = sidecar 文件名，count = 该 run 累计张数。
    2026-10-14：新增可选 workflow_id → 目录键走 id（先 id 后名回退）；缺省走原名键。
    同日新增可选 path / temporary → identity 归一化。
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

    dir_path = resolve_history_dir(user_dir, wf, workflow_id, path=path, temporary=temporary)
    index_path = os.path.join(dir_path, INDEX_FILE_NAME)
    entries = []
    try:
        if os.path.isfile(index_path):
            with open(index_path, "r", encoding="utf-8") as fh:
                entries = parse_index(fh.read())["entries"]
    except OSError as exc:
        return {"ok": False, "status": 500, "error": "读取索引失败：%s" % exc}
    entry = _find_target_entry_by_prompt_id(entries, pid)
    if entry is None:
        return {"ok": False, "status": 404, "error": "索引里没有 promptId=%s 这条提交" % pid}
    snapshot_file = _entry_snapshot_file(entry)
    if snapshot_file is None:
        return {"ok": False, "status": 500, "error": "索引条目缺少/非法 file 字段"}

    sidecar_name = _sidecar_file_name(snapshot_file)
    sidecar_path = os.path.join(dir_path, sidecar_name)
    runs = _read_sidecar_runs(dir_path, snapshot_file)
    target = next((r for r in runs if r["promptId"] == pid), None)
    if target is None:
        target = {"promptId": pid, "at": _to_iso(at), "images": []}
        runs.append(target)
    target["images"] = _merge_images(target["images"], norm_in)
    merged = target["images"]
    obj = {"runs": runs}
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
