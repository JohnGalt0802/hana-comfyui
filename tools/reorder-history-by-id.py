#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一次性重排脚本：把 .history 下「按名字」目录改为「按画布身份 id」目录。

背景：历史目录原按工作流显示名为键（.history/<净化名>/）；后端已改为按画布身份 id
为键（.history/<uuid>/）。本脚本把存量名键目录重排成 id 键目录，使历史「跟随画布身份」。

用法：
  python tools/reorder-history-by-id.py                  # 默认 dry-run（只读，只打印计划表）
  python tools/reorder-history-by-id.py --apply          # 真正执行（先全量备份）
  python tools/reorder-history-by-id.py --user-dir <path># 覆盖 ComfyUI user/default 目录

规则：
  · 每个名键目录 d → 读 index.jsonl 首条带 file 的提交 → 读快照 graph.id。
  · 有效 uuid 且该 id 在 workflows/*.json 顶层 id 集合内 → 目标 = .history/<uuid>/（rename）。
  · 拿不到 graph.id / 非 uuid / id 不在现存画布集合内 → 目标 = .history/_orphans/<原名>/（orphan）。
  · 目标目录已存在 → conflict（不覆盖，跳过并报告）。
  · 已是 uuid 形的目录 → skip(已是id)。

幂等：重复跑无副作用（已 id 目录跳过；已移走的源不存在 → 跳过）。
全部操作限定在 <user_dir>/workflows/.history/ 与 D:\\HanakoWorks\\ComfyUI\\_backup\\ 内。
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import sys

# 复用后端（app/bridge/history_store.py）同一套口径：净化 / 键 / 索引解析 / meta 落盘。
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "app", "bridge"))
from history_store import (  # noqa: E402
    INDEX_FILE_NAME,
    _read_claims,
    _write_claims,
    is_valid_uuid,
    parse_index,
    sanitize_workflow_name,
    _write_meta_file,
)

DEFAULT_USER_DIR = r"D:\ComfyUI\ComfyUI\user\default"
BACKUP_ROOT = r"D:\HanakoWorks\ComfyUI\_backup"
ORPHAN_DIR_NAME = "_orphans"

_UUID_SHAPE_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _history_root(user_dir):
    return os.path.abspath(os.path.join(user_dir, "workflows", ".history"))


def _count_lines(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return sum(1 for ln in fh if ln.strip())
    except OSError:
        return 0


def _count_snapshots(d):
    """真快照数：排除 index.jsonl 与 .images.json sidecar。"""
    n = 0
    try:
        for name in os.listdir(d):
            if not name.endswith(".json"):
                continue
            if name == INDEX_FILE_NAME or name.endswith(".json.images.json"):
                continue
            if os.path.isfile(os.path.join(d, name)):
                n += 1
    except OSError:
        pass
    return n


def _first_snapshot_gid(d):
    """读 index.jsonl 首条带 file 的提交，返回其快照 graph.id（拿不到 → None）。"""
    idx = os.path.join(d, INDEX_FILE_NAME)
    if not os.path.isfile(idx):
        return None
    try:
        with open(idx, "r", encoding="utf-8") as fh:
            entries = parse_index(fh.read())["entries"]
    except OSError:
        return None
    for e in entries:
        f = e.get("file")
        if not (isinstance(f, str) and f):
            continue
        sp = os.path.join(d, f)
        if not os.path.isfile(sp):
            continue
        try:
            with open(sp, "r", encoding="utf-8") as fh:
                obj = json.loads(fh.read())
        except (OSError, ValueError):
            return None
        g = obj.get("graph") if isinstance(obj, dict) else None
        gid = g.get("id") if isinstance(g, dict) else None
        return str(gid) if isinstance(gid, str) and gid.strip() else None
    return None


def _canvas_ids(user_dir):
    """现存画布顶层 id 集合（读 workflows/*.json 顶层 id）。"""
    ids = set()
    wf = os.path.join(user_dir, "workflows")
    try:
        names = os.listdir(wf)
    except OSError:
        return ids
    for name in names:
        if not name.endswith(".json"):
            continue
        p = os.path.join(wf, name)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as fh:
                obj = json.loads(fh.read())
        except (OSError, ValueError):
            continue
        v = obj.get("id") if isinstance(obj, dict) else None
        if isinstance(v, str) and v.strip():
            ids.add(v.strip())
    return ids


def _canvas_paths_by_id(user_dir):
    """现存画布 id → [相对路径 workflows/<文件名>, ...]（同一 id 可多张）。"""
    m = {}
    wf = os.path.join(user_dir, "workflows")
    try:
        names = os.listdir(wf)
    except OSError:
        return m
    for name in names:
        if not name.endswith(".json"):
            continue
        p = os.path.join(wf, name)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as fh:
                obj = json.loads(fh.read())
        except (OSError, ValueError):
            continue
        v = obj.get("id") if isinstance(obj, dict) else None
        if isinstance(v, str) and v.strip():
            m.setdefault(v.strip(), []).append("workflows/" + name)
    return m


def build_plan(user_dir):
    """返回 (history_root, canvas_ids, plans[])；plans 每项为 dict，不改动任何文件。"""
    root = _history_root(user_dir)
    cids = _canvas_ids(user_dir)
    idpaths = _canvas_paths_by_id(user_dir)
    plans = []
    if not os.path.isdir(root):
        return root, cids, plans
    for name in sorted(os.listdir(root)):
        if name.startswith("."):
            continue
        d = os.path.join(root, name)
        if not os.path.isdir(d):
            continue
        lines = _count_lines(os.path.join(d, INDEX_FILE_NAME))
        snaps = _count_snapshots(d)
        if _UUID_SHAPE_RE.match(name):
            plans.append({"src": name, "key": name, "lines": lines, "snaps": snaps, "mark": "skip(已是id)"})
            continue
        gid = _first_snapshot_gid(d)
        owner_path = None
        if is_valid_uuid(gid) and gid.strip() in cids:
            key, mark = gid.strip(), "rename"
            # 该 id 对应的画布 path：优先“净化名 == 目录原名”的那个（共享 id 时锁定正确的那张）
            cands = idpaths.get(key) or []
            for cand in cands:
                base = cand[len("workflows/"):-len(".json")] if cand.endswith(".json") else cand
                if sanitize_workflow_name(base) == name:
                    owner_path = cand
                    break
            if owner_path is None and cands:
                owner_path = cands[0]
        else:
            key, mark = os.path.join(ORPHAN_DIR_NAME, sanitize_workflow_name(name)), "orphan"
        dst = os.path.join(root, key)
        if os.path.isdir(dst):
            mark = "conflict"
        plans.append({"src": name, "key": key, "dst": dst, "lines": lines, "snaps": snaps,
                      "mark": mark, "gid": gid, "owner_path": owner_path})
    return root, cids, plans


def _print_plan(root, cids, plans):
    print("历史重排计划（dry-run，未做任何改动）")
    print("history 根：%s" % root)
    print("现存画布 id 数：%d" % len(cids))
    print("-" * 78)
    print("%-42s %-54s %5s %5s  %s" % ("原名", "目标键", "行数", "快照", "标记"))
    print("-" * 78)
    for p in plans:
        print("%-42s %-54s %5d %5d  %s" % (p["src"][:42], p["key"][:54], p["lines"], p["snaps"], p["mark"]))
    print("-" * 78)
    tally = {}
    for p in plans:
        tally[p["mark"]] = tally.get(p["mark"], 0) + 1
    print("合计：%d 项（%s）" % (len(plans), "，".join("%s=%d" % (k, v) for k, v in sorted(tally.items()))))
    print("dry-run 结束：未改动任何文件。加 --apply 才执行（执行前会全量备份）。")


def _claim_primary(user_dir, uid, owner_path):
    """重排后登记：把 id uid 的 owner 预占为重排目录对应的画布 path（owner_path）。
    目的：防止共享同一 id 的其它画布（如 Qwen21 Turbo EasyCache t2i 与 Qwen21 t2i 质量版
    同为 2236888a）在重排后运行图时“先认领”该 id 把两者历史混掉。
    预占后该 path 命中 owner 直接得键=id；其它正式 path 因“已有 owner”走 mint 各算各的。
    幂等：已登记则不动。失败静默（不阻断重排）。
    """
    if not owner_path:
        return  # 无法定位画布 path → 不预占（退化为首次认领，可接受）
    try:
        claims, ok = _read_claims(user_dir)
        if not ok:
            return
        rec = claims.get(uid)
        rec = dict(rec) if isinstance(rec, dict) else {}
        if rec:
            return  # 已有登记，不动
        claims[uid] = {owner_path: "primary"}
        _write_claims(user_dir, claims)
    except Exception:
        pass


def do_apply(root, plans, user_dir):
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dest = os.path.join(BACKUP_ROOT, "history-reorder-%s" % ts)
    if os.path.exists(backup_dest):
        print("备份目标已存在，终止：%s" % backup_dest)
        return 2
    os.makedirs(BACKUP_ROOT, exist_ok=True)
    shutil.copytree(root, backup_dest)
    print("备份完成：%s" % backup_dest)

    moves = [p for p in plans if p["mark"] in ("rename", "orphan")]
    for p in moves:
        src = os.path.join(root, p["src"])
        dst = p["dst"]
        if not os.path.isdir(src):
            print("[skip] 源不存在（已处理过）：%s" % p["src"])
            continue
        if os.path.isdir(dst):
            print("[conflict] 目标已存在，跳过不覆盖：%s → %s" % (p["src"], p["key"]))
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.rename(src, dst)
        if p["mark"] == "rename":
            _write_meta_file(dst, p["key"], p["src"])
            _claim_primary(user_dir, p["key"], p.get("owner_path"))
            print("[rename] %s → %s（已写 .meta.json + 登记 claims：%s）" % (p["src"], p["key"], p.get("owner_path") or "-"))
        else:
            print("[orphan] %s → %s" % (p["src"], p["key"]))

    for p in plans:
        if p["mark"] in ("skip(已是id)", "conflict"):
            print("[%s] %s，未改动" % (p["mark"], p["src"]))
    print("apply 结束。重复执行安全（幂等）：已 id 目录跳过，已移走的源不再存在。")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="把 ComfyUI .history 名键目录重排为画布 id 键目录")
    ap.add_argument("--apply", action="store_true", help="真正执行（默认只做 dry-run，只读）")
    ap.add_argument("--user-dir", default=DEFAULT_USER_DIR, help="ComfyUI user/default 目录")
    args = ap.parse_args(argv)

    user_dir = os.path.abspath(args.user_dir)
    root, cids, plans = build_plan(user_dir)
    _print_plan(root, cids, plans)

    if not args.apply:
        return 0
    if not plans:
        print("无可处理项，且已跳过备份。")
        return 0
    return do_apply(root, plans, user_dir)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 致命错：报告原文，退出码 1
        print("致命错误：%s" % exc)
        sys.exit(1)
