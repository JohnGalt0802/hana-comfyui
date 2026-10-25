"""history_store.test.py — 画布提交历史 P1-C1 单测（全部用 tempfile 临时目录）。

运行：python -m unittest app.bridge.history_store.test -v
（或直接：python app/bridge/history_store.test.py —— 文件底部有 __main__ 入口，
以 D:\\HanakoWorks\\ComfyUI 为 cwd 时两种方式都可；本文件对 app 包无依赖，
不 import ComfyUI 任何东西。）

绝不写 D:\\ComfyUI\\ComfyUI\\user\\default\\workflows——所有落盘经 self._tmp()
（tempfile.mkdtemp + addCleanup shutil.rmtree）。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

if __package__:
    from . import history_store as hs
else:  # 直接以脚本方式运行（python app/bridge/history_store.test.py）
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import history_store as hs


class TempRootTestCase(unittest.TestCase):
    """给每个用例一个临时根目录（user_dir），用完即删。"""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="hui-history-test-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def commit(self, body):
        return hs.commit(body, self.root)


class TestSanitizeWorkflowName(TempRootTestCase):
    def test_chinese_kept(self):
        self.assertEqual(hs.sanitize_workflow_name("我的 工作流"), "我的 工作流")

    def test_illegal_chars_removed(self):
        # / \ : * ? " < > | 全部剔除，中间普通字符保留
        self.assertEqual(hs.sanitize_workflow_name('a/b\\c:d*e?f"g<h>i|j'), "abcdefghij")

    def test_edge_whitespace_and_dots(self):
        self.assertEqual(hs.sanitize_workflow_name("  ..name.. \t"), "name")
        self.assertEqual(hs.sanitize_workflow_name(".hidden."), "hidden")

    def test_too_long_truncated_to_80(self):
        long_name = "流" * 100
        out = hs.sanitize_workflow_name(long_name)
        self.assertEqual(len(out), 80)
        self.assertEqual(out, "流" * 80)

    def test_empty_variants(self):
        self.assertEqual(hs.sanitize_workflow_name(""), "untitled")
        self.assertEqual(hs.sanitize_workflow_name("   "), "untitled")
        self.assertEqual(hs.sanitize_workflow_name("..."), "untitled")
        self.assertEqual(hs.sanitize_workflow_name("///"), "untitled")
        self.assertEqual(hs.sanitize_workflow_name(None), "untitled")

    def test_ctrl_chars_removed(self):
        self.assertEqual(hs.sanitize_workflow_name("a\x00b\x1fc\x7fd"), "abcd")

    def test_truncation_then_edge_trim(self):
        # 截断后末尾落在点上 → 再次去尾（对齐 JS 两次 EDGE 清洗）
        out = hs.sanitize_workflow_name("a" * 79 + ".")
        self.assertEqual(out, "a" * 79)


class TestSnapshotFileName(TempRootTestCase):
    def test_basic(self):
        self.assertEqual(hs.snapshot_file_name(1, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc"), "0001-a3f9c2e1.json")

    def test_seq_padded_and_overflow(self):
        self.assertEqual(hs.snapshot_file_name(42, "abcd"), "0042-abcd.json")
        self.assertEqual(hs.snapshot_file_name(12345, "abcd"), "12345-abcd.json")

    def test_seq_non_finite_is_zero(self):
        self.assertEqual(hs.snapshot_file_name(None, "abcd"), "0000-abcd.json")
        self.assertEqual(hs.snapshot_file_name("x", "abcd"), "0000-abcd.json")

    def test_prompt_id_cleaned(self):
        # 口径同 JS：先取前 8 位、再剔非法字符（剔完不足 8 位不回补）
        self.assertEqual(hs.snapshot_file_name(1, "ab/cd:ef*gh"), "0001-abcdef.json")
        self.assertEqual(hs.snapshot_file_name(1, "ab.cd+ef=x!"), "0001-abcdef.json")
        # 连字符保留（本批规格 [A-Za-z0-9-]）
        self.assertEqual(hs.snapshot_file_name(1, "a3f9c2e1"), "0001-a3f9c2e1.json")

    def test_empty_prompt_id_is_noid(self):
        self.assertEqual(hs.snapshot_file_name(1, ""), "0001-noid.json")
        self.assertEqual(hs.snapshot_file_name(1, None), "0001-noid.json")
        self.assertEqual(hs.snapshot_file_name(1, "***"), "0001-noid.json")


class TestBuildSnapshot(TempRootTestCase):
    def test_full_shape(self):
        graph = {"nodes": [{"id": 1}, {"id": 2}], "links": [[1, 2]]}
        snap = hs.build_snapshot(graph, "a3f9c2e1-xxxx", 3, "2026-10-11T00:00:00.000Z", "agent")
        self.assertEqual(snap["schemaVersion"], 2)
        self.assertEqual(snap["seq"], 3)
        self.assertEqual(snap["promptId"], "a3f9c2e1-xxxx")
        self.assertEqual(snap["at"], "2026-10-11T00:00:00.000Z")
        self.assertEqual(snap["source"], "agent")
        self.assertEqual(snap["nodeCount"], 2)
        self.assertEqual(snap["linkCount"], 1)
        self.assertIs(snap["graph"], graph)

    def test_source_whitelist(self):
        for bad in ("robot", "", None, "USER"):
            self.assertEqual(hs.build_snapshot({}, source=bad)["source"], "unknown")
        for good in ("user", "agent", "unknown"):
            self.assertEqual(hs.build_snapshot({}, source=good)["source"], good)

    def test_datetime_converted_to_iso(self):
        import datetime

        dt = datetime.datetime(2026, 10, 11, 8, 30, 0, 123000, tzinfo=datetime.timezone(datetime.timedelta(hours=8)))
        out = hs.build_snapshot({}, at=dt)
        self.assertEqual(out["at"], "2026-10-11T00:30:00.123Z")
        self.assertEqual(hs.build_snapshot({}, at=None)["at"], hs.build_snapshot({}, at=None)["at"])  # 都能产出 ISO
        naive = datetime.datetime(2026, 1, 2, 3, 4, 5, 6)
        self.assertEqual(hs.build_snapshot({}, at=naive)["at"], "2026-01-02T03:04:05.000Z")

    def test_counts_from_graph_only_lists(self):
        self.assertEqual(hs.build_snapshot({"nodes": "not-a-list", "links": None})["nodeCount"], 0)
        self.assertEqual(hs.build_snapshot({})["linkCount"], 0)
        self.assertEqual(hs.build_snapshot(None)["graph"], None or hs.build_snapshot(None)["graph"])
        self.assertEqual(hs.build_snapshot(None)["nodeCount"], 0)

    def test_blocks_never_in_snapshot(self):
        # N3：快照不再重复存 blocks（块归属只由索引行存）；入参 blocks 被忽略，恒不写该字段
        blocks = [{"name": "加载", "source": "group", "nodeIds": [3, 1, 2]}]
        snap = hs.build_snapshot({"nodes": [], "links": []}, blocks=blocks)
        self.assertNotIn("blocks", snap)
        self.assertNotIn("blocks", hs.build_snapshot({}))
        self.assertNotIn("blocks", hs.build_snapshot({}, blocks=None))
        # 非列表（畸形态，防御性）→ 同样不写该字段
        self.assertNotIn("blocks", hs.build_snapshot({}, blocks="bad"))
        self.assertNotIn("blocks", hs.build_snapshot({}, blocks={}))


class TestStripHeavyFields(TempRootTestCase):
    def test_strips_and_records_paths(self):
        graph = {
            "nodes": [
                {"id": 1, "widgets_values": ["data:image/png;base64,AAAA"]},
                {"id": 2, "widgets_values": [{"img": "data:image/jpeg;base64,BBBB", "ok": 1}]},
            ],
            "links": [],
        }
        original = json.dumps(graph, ensure_ascii=False)
        out = hs.strip_heavy_fields(graph)
        # 入参不被修改
        self.assertEqual(json.dumps(graph, ensure_ascii=False), original)
        self.assertEqual(graph["nodes"][0]["widgets_values"][0], "data:image/png;base64,AAAA")
        # 拷贝里被替换为占位（空串），结构不丢
        self.assertEqual(out["graph"]["nodes"][0]["widgets_values"][0], "")
        self.assertEqual(out["graph"]["nodes"][1]["widgets_values"][0]["img"], "")
        self.assertEqual(out["graph"]["nodes"][1]["widgets_values"][0]["ok"], 1)
        self.assertEqual(out["stripped"], ["nodes[0].widgets_values[0]", "nodes[1].widgets_values[0].img"])

    def test_no_hit_no_stripped(self):
        out = hs.strip_heavy_fields({"a": 1, "b": ["x", "y"]})
        self.assertEqual(out["graph"], {"a": 1, "b": ["x", "y"]})
        self.assertEqual(out["stripped"], [])

    def test_array_and_scalar_paths(self):
        out = hs.strip_heavy_fields({"arr": ["data:image/webp;base64,CC"], "n": 3, "nil": None})
        self.assertEqual(out["graph"]["arr"][0], "")
        self.assertEqual(out["graph"]["n"], 3)
        self.assertEqual(out["graph"]["nil"], None)
        self.assertEqual(out["stripped"], ["arr[0]"])


class TestIndex(TempRootTestCase):
    def test_build_index_line_no_graph(self):
        line = hs.build_index_line(
            {"seq": 2, "file": "0002-abcd.json", "promptId": "abcd", "at": "2026-10-11T00:00:00.000Z",
             "source": "user", "nodeCount": 5, "linkCount": 4}
        )
        obj = json.loads(line)
        self.assertEqual(
            sorted(obj.keys()),
            ["at", "blocks", "delta", "file", "kind", "linkCount", "nodeCount", "parent", "promptId", "runs", "seq", "sig", "source"],
        )
        self.assertEqual(obj["file"], "0002-abcd.json")
        # P5 新字段缺省
        self.assertIsNone(obj["parent"])
        self.assertEqual(obj["kind"], "run")
        self.assertEqual(obj["sig"], "")
        self.assertEqual(obj["blocks"], [])
        self.assertIsNone(obj["delta"])
        self.assertEqual(obj["runs"], [])

    def test_build_index_line_new_fields(self):
        line = hs.build_index_line(
            {"seq": 3, "file": "0003-x.json", "parent": 2, "kind": "save", "sig": "deadbeef",
             "blocks": [{"name": "组1", "source": "group", "nodeIds": [1, 2], "color": None}],
             "delta": {"changed": [], "added": [{"id": 5, "title": "X"}], "removed": []},
             "runs": [{"promptId": "p1", "at": "2026-10-11T00:00:00.000Z",
                       "images": [{"filename": "a.png", "subfolder": "", "type": "output"}]}]}
        )
        obj = json.loads(line)
        self.assertEqual(obj["parent"], 2)
        self.assertEqual(obj["kind"], "save")
        self.assertEqual(obj["sig"], "deadbeef")
        self.assertEqual(obj["blocks"], [{"name": "组1", "source": "group", "nodeIds": [1, 2], "color": None}])
        self.assertEqual(obj["runs"][0]["promptId"], "p1")
        self.assertEqual(obj["runs"][0]["images"][0]["filename"], "a.png")
        # 非法 kind → run；blocks 缺 source/nodeIds → 补 group/[]
        obj2 = json.loads(hs.build_index_line({"kind": "bot", "blocks": [{"name": "b"}]}))
        self.assertEqual(obj2["kind"], "run")
        self.assertEqual(obj2["blocks"], [{"name": "b", "source": "group", "nodeIds": [], "color": None}])
        # blocks 非列表 → []

    def test_build_index_line_blocks_full(self):
        # P5：索引行写**完整版** blocks（name + source + nodeIds + color），不再是摘要
        line = hs.build_index_line(
            {"seq": 1, "file": "0001-a.json",
             "blocks": [
                 {"name": "加载", "source": "group", "nodeIds": [1, 2, 3], "color": None},
                 {"name": "采样", "source": "role", "nodeIds": [9, 8], "color": None},
             ]}
        )
        obj = json.loads(line)
        self.assertEqual(
            obj["blocks"],
            [{"name": "加载", "source": "group", "nodeIds": [1, 2, 3], "color": None},
             {"name": "采样", "source": "role", "nodeIds": [9, 8], "color": None}],
        )
        # 缺 source/nodeIds 的块 → 补 group/[]；nodeIds 值原样保留；非对象块剔除
        line2 = json.loads(hs.build_index_line({"blocks": ["bad", {"name": "x"}]}))
        self.assertEqual(line2["blocks"], [{"name": "x", "source": "group", "nodeIds": [], "color": None}])
        self.assertEqual(json.loads(hs.build_index_line({"blocks": "bad"}))["blocks"], [])
        self.assertEqual(json.loads(hs.build_index_line({}))["blocks"], [])

    def test_block_color_kept(self):
        # 2026-10-20：block.color 是提交时的框色快照，_norm_block / build_index_line 都要保留，
        # 不再回落 None（旧条目无该字段时才缺省 None）
        blk = {"name": "框A", "source": "group", "nodeIds": [], "color": "#5aa0d8"}
        self.assertEqual(hs._norm_block(blk), {"name": "框A", "source": "group", "nodeIds": [], "color": "#5aa0d8"})
        line = json.loads(hs.build_index_line({"seq": 1, "blocks": [blk]}))
        self.assertEqual(line["blocks"], [{"name": "框A", "source": "group", "nodeIds": [], "color": "#5aa0d8"}])

    def test_parse_index_good_bad_blank(self):
        good1 = json.dumps({"seq": 1, "file": "0001-a.json"})
        good2 = json.dumps({"seq": 2, "file": "0002-b.json"})
        text = "\n".join([good1, "", "not json at all", "[1,2]", good2, ""])
        out = hs.parse_index(text)
        self.assertEqual(len(out["entries"]), 2)
        self.assertEqual(out["entries"][0]["file"], "0001-a.json")
        self.assertEqual(out["entries"][1]["file"], "0002-b.json")
        self.assertEqual(out["badLines"], 2)

    def test_parse_index_empty_text(self):
        self.assertEqual(hs.parse_index("")["entries"], [])
        self.assertEqual(hs.parse_index(None)["badLines"], 0)

    def test_next_seq_and_latest(self):
        self.assertEqual(hs.next_seq([]), 1)
        self.assertEqual(hs.next_seq([{"seq": "bad"}, {"no_seq": 1}]), 1)
        entries = [{"seq": 3}, {"seq": "x"}, {"seq": 7.5}, {"seq": 5}]
        self.assertEqual(hs.next_seq(entries), 8)
        self.assertEqual(hs.latest_entry(entries), {"seq": 5})
        self.assertIsNone(hs.latest_entry([]))


class TestCommit(TempRootTestCase):
    def test_missing_workflow_400_and_no_disk_write(self):
        out = self.commit({"graph": {}})
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 400)
        self.assertFalse(os.path.exists(os.path.join(self.root, ".history")), "错误路径不应创建任何目录/文件")

    def test_missing_graph_400_and_no_disk_write(self):
        out = self.commit({"workflow": "wf"})
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 400)
        self.assertFalse(os.path.exists(os.path.join(self.root, ".history")), "错误路径不应创建任何目录/文件")

    def test_full_commit_shape(self):
        out = self.commit(
            {
                "workflow": "my workflow",
                "promptId": "a3f9c2e1-9b7c-4d2e-8f01-234567890abc",
                "graph": {"nodes": [{"id": 1}], "links": []},
                "source": "user",
            }
        )
        self.assertTrue(out["ok"])
        self.assertEqual(out["seq"], 1)
        self.assertEqual(out["file"], "0001-a3f9c2e1.json")
        self.assertEqual(out["dir"], os.path.join(self.root, "workflows", ".history", "my workflow"))
        with open(os.path.join(out["dir"], out["file"]), encoding="utf-8") as fh:
            snap = json.loads(fh.read())
        self.assertEqual(snap["schemaVersion"], 2)
        self.assertEqual(snap["promptId"], "a3f9c2e1-9b7c-4d2e-8f01-234567890abc")
        self.assertEqual(snap["nodeCount"], 1)
        self.assertEqual(snap["graph"]["nodes"][0]["id"], 1)

    def test_commit_with_blocks_index_full(self):
        # N3：索引行仍存**完整版** blocks（含 source / nodeIds / color），但快照**不再重复存**
        blocks = [
            {"name": "组1", "source": "group", "nodeIds": [1, 2], "color": None},
            {"name": "采样", "source": "role", "nodeIds": [7], "color": None},
        ]
        out = self.commit(
            {
                "workflow": "wf",
                "promptId": "aaaaaaaa-1",
                "graph": {"nodes": [{"id": 1}, {"id": 2}, {"id": 7}], "links": []},
                "blocks": blocks,
            }
        )
        self.assertTrue(out["ok"])
        with open(os.path.join(out["dir"], out["file"]), encoding="utf-8") as fh:
            snap = json.loads(fh.read())
        self.assertNotIn("blocks", snap)  # N3：快照不再写 blocks（去重）
        self.assertEqual(snap["schemaVersion"], 2)
        with open(os.path.join(out["dir"], hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            entry = json.loads(fh.readline())
        self.assertEqual(entry["blocks"], blocks)  # 索引行完整版（name + source + nodeIds + color）
        # list_commits 读回：响应里 blocks 已瘦身（去 nodeIds，只留实际存在的键）
        listed = hs.list_commits("wf", self.root)
        self.assertEqual(
            listed["entries"][0]["blocks"],
            [{"name": "组1", "source": "group", "color": None},
             {"name": "采样", "source": "role", "color": None}],
        )

    def test_read_snapshot_legacy_with_blocks_ok(self):
        # N3 兼容口径：旧快照（尚带 blocks 字段）读取正常，不报错、字段原样读回
        out = self.commit({"workflow": "wf", "promptId": "cccccccc-3", "graph": {"nodes": [{"id": 1}], "links": []}})
        self.assertTrue(out["ok"])
        abs_file = os.path.join(out["dir"], out["file"])
        # 手工改写为「旧形态」（含 blocks），再读回
        with open(abs_file, encoding="utf-8") as fh:
            snap = json.loads(fh.read())
        legacy_blocks = [{"name": "组1", "source": "group", "nodeIds": [1]}]
        snap["blocks"] = legacy_blocks
        with open(abs_file, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(snap, ensure_ascii=False))
        got = hs.read_snapshot("wf", self.root, seq=1)
        self.assertTrue(got["ok"])
        self.assertEqual(got["status"], 200)
        self.assertEqual(got["snapshot"]["blocks"], legacy_blocks)

    def test_commit_without_blocks_reads_back_empty(self):
        # P5：不带 blocks 的提交 → 快照无该字段；索引行 blocks 缺省为 []（新形态总写该字段）
        out = self.commit({"workflow": "旧", "promptId": "bbbbbbbb-2", "graph": {"nodes": [], "links": []}})
        self.assertTrue(out["ok"])
        with open(os.path.join(out["dir"], out["file"]), encoding="utf-8") as fh:
            snap = json.loads(fh.read())
        self.assertNotIn("blocks", snap)
        with open(os.path.join(out["dir"], hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            entry = json.loads(fh.readline())
        self.assertEqual(entry["blocks"], [])
        self.assertEqual(entry["kind"], "run")
        self.assertIsNone(entry["parent"])
        self.assertEqual(entry["runs"], [])
        listed = hs.list_commits("旧", self.root)
        self.assertTrue(listed["ok"])
        self.assertEqual(listed["entries"][0]["blocks"], [])

    def test_list_commits_legacy_entries_no_blocks_ok(self):
        # P2-F2 兼容：手写一条 P1 旧格式索引行（无 blocks）+ 一个旧格式快照，list 读回不报错
        d = os.path.join(self.root, "workflows", ".history", "legacy")
        os.makedirs(d)
        legacy_line = json.dumps(
            {"seq": 1, "file": "0001-noid.json", "promptId": None, "at": "2026-01-01T00:00:00.000Z",
             "source": "unknown", "nodeCount": 0, "linkCount": 0},
            ensure_ascii=False,
        )
        with open(os.path.join(d, hs.INDEX_FILE_NAME), "w", encoding="utf-8") as fh:
            fh.write(legacy_line + "\n")
        with open(os.path.join(d, "0001-noid.json"), "w", encoding="utf-8") as fh:
            json.dump({"schemaVersion": 2, "seq": 1, "graph": {"nodes": [], "links": []}}, fh)
        out = hs.list_commits("legacy", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(len(out["entries"]), 1)
        self.assertEqual(out["entries"][0].get("blocks"), [])  # P5b：旧条目经 normalize_entry 补全为 []
        self.assertEqual(out["badLines"], 0)

    def test_second_commit_appends_not_overwrites(self):
        first = self.commit({"workflow": "wf", "graph": {"nodes": [{"id": 1}]}, "promptId": "aaaaaaaa-1"})
        second = self.commit({"workflow": "wf", "graph": {"nodes": [{"id": 1}, {"id": 2}]}, "promptId": "bbbbbbbb-2"})
        self.assertEqual((first["seq"], second["seq"]), (1, 2))
        self.assertEqual((first["file"], second["file"]), ("0001-aaaaaaaa.json", "0002-bbbbbbbb.json"))
        # 两个快照文件都在
        d = first["dir"]
        for f in (first["file"], second["file"]):
            self.assertTrue(os.path.exists(os.path.join(d, f)), "缺文件 %s" % f)
        # 索引恰好两行、第一行未被覆盖
        with open(os.path.join(d, hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[0])["file"], "0001-aaaaaaaa.json")
        self.assertEqual(json.loads(lines[1])["seq"], 2)

    def test_atomic_write_roundtrip(self):
        # 造 10 次提交，全部读回且内容逐字节等于直接序列化结果（.tmp 已被 replace 消费掉）；
        # at 用固定值，排除「两次调用各取当前时间」的毫秒差干扰。
        graphs = [{"nodes": [{"id": i, "widgets_values": ["值-%d" % i]}], "links": []} for i in range(10)]
        fixed_at = "2026-10-11T00:00:00.000Z"
        outs = [
            self.commit({"workflow": "原子", "graph": g, "promptId": "pid%08d" % i, "at": fixed_at})
            for i, g in enumerate(graphs)
        ]
        self.assertTrue(all(o["ok"] for o in outs))
        for i, (g, o) in enumerate(zip(graphs, outs)):
            path = os.path.join(o["dir"], o["file"])
            self.assertTrue(os.path.exists(path))
            self.assertFalse(os.path.exists(path + ".tmp"), "临时文件应已被 os.replace 消费")
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
            expect = json.dumps(
                hs.build_snapshot(g, "pid%08d" % i, i + 1, fixed_at, "user"),
                ensure_ascii=False,
                separators=(",", ":"),
            )
            self.assertEqual(text, expect)
        with open(os.path.join(outs[-1]["dir"], hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            parsed = hs.parse_index(fh.read())
        self.assertEqual(len(parsed["entries"]), 10)
        self.assertEqual(parsed["badLines"], 0)

    def test_oversize_413_and_no_disk_write(self):
        big = "x" * (hs.MAX_SNAPSHOT_BYTES + 1)
        out = self.commit({"workflow": "wf", "graph": {"nodes": [big]}})
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 413)
        self.assertIn("size", out)
        self.assertFalse(os.path.exists(os.path.join(self.root, ".history")), "体积超限不得写盘（连目录都不该建）")

    def test_workflow_name_sanitized_in_dir(self):
        out = self.commit({"workflow": "a/b\\c", "graph": {"nodes": [], "links": []}})
        self.assertTrue(out["ok"])
        self.assertEqual(os.path.basename(out["dir"]), "abc")

    def test_list_commits_after_commits(self):
        # 两次用不同 graph（sig 不同）→ 两个节点（同 sig 会被 P5b 合并）
        self.commit({"workflow": "wf", "graph": {"nodes": [], "links": []}, "promptId": "aaaaaaaa-1"})
        self.commit({"workflow": "wf", "graph": {"nodes": [{"id": 1}], "links": []}, "promptId": "bbbbbbbb-2"})
        out = hs.list_commits("wf", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(len(out["entries"]), 2)
        self.assertEqual(out["badLines"], 0)
        self.assertEqual(out["entries"][0]["file"], "0001-aaaaaaaa.json")

    def test_list_commits_unknown_workflow_empty(self):
        out = hs.list_commits("不存在", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(out["entries"], [])
        self.assertEqual(out["badLines"], 0)
        self.assertFalse(os.path.exists(os.path.join(self.root, "workflows")), "查询不该创建任何目录")

    def test_list_commits_with_bad_lines_counts_only(self):
        d = os.path.join(self.root, "workflows", ".history", "wf")
        os.makedirs(d)
        with open(os.path.join(d, hs.INDEX_FILE_NAME), "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"seq": 1, "file": "0001-a.json"}) + "\n")
            fh.write("rubbish line\n")
            fh.write("\n")
        out = hs.list_commits("wf", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(len(out["entries"]), 1)
        self.assertEqual(out["badLines"], 1)


class TestReadSnapshot(TempRootTestCase):
    """P3-G1：read_snapshot —— 回跳用的快照全文读取。"""

    def commit_one(self):
        return self.commit(
            {
                "workflow": "wf",
                "graph": {"nodes": [{"id": 1, "widgets_values": ["提示词"]}], "links": [[1, 1, 1, "A", "B"]]},
                "promptId": "a3f9c2e1-xxxx",
            }
        )

    def test_read_by_seq_and_by_file(self):
        out = self.commit_one()
        self.assertTrue(out["ok"])
        # 按 seq 定位：返回完整快照（含 graph 本体）
        by_seq = hs.read_snapshot("wf", self.root, seq=1)
        self.assertTrue(by_seq["ok"])
        self.assertEqual(by_seq["status"], 200)
        self.assertEqual(by_seq["file"], out["file"])
        self.assertEqual(by_seq["seq"], 1)
        self.assertEqual(by_seq["snapshot"]["graph"]["nodes"][0]["widgets_values"], ["提示词"])
        self.assertEqual(by_seq["snapshot"]["promptId"], "a3f9c2e1-xxxx")
        # 按 file 直接点名：同一份
        by_file = hs.read_snapshot("wf", self.root, file_name=out["file"])
        self.assertTrue(by_file["ok"])
        self.assertEqual(by_file["snapshot"], by_seq["snapshot"])

    def test_seq_not_in_index_404(self):
        self.commit_one()
        out = hs.read_snapshot("wf", self.root, seq=99)
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 404)

    def test_missing_snapshot_file_404(self):
        out = self.commit_one()
        out_dir = out["dir"]
        os.remove(os.path.join(out_dir, out["file"]))
        out2 = hs.read_snapshot("wf", self.root, seq=1)
        self.assertFalse(out2["ok"])
        self.assertEqual(out2["status"], 404)
        # 目录存在但索引在、文件没了 → 仍 404（不是 500）
        self.assertTrue(os.path.isdir(out_dir))

    def test_bad_json_snapshot_500(self):
        out = self.commit_one()
        with open(os.path.join(out["dir"], out["file"]), "w", encoding="utf-8") as fh:
            fh.write("{ not valid json !!")
        bad = hs.read_snapshot("wf", self.root, file_name=out["file"])
        self.assertFalse(bad["ok"])
        self.assertEqual(bad["status"], 500)
        self.assertIn("JSON", bad["error"])
        # 非对象的合法 JSON 同样按 500 拒绝
        with open(os.path.join(out["dir"], out["file"]), "w", encoding="utf-8") as fh:
            fh.write("[1,2,3]")
        arr = hs.read_snapshot("wf", self.root, file_name=out["file"])
        self.assertFalse(arr["ok"])
        self.assertEqual(arr["status"], 500)

    def test_param_and_traversal_guards(self):
        self.commit_one()
        # 缺 seq 与 file → 400
        self.assertEqual(hs.read_snapshot("wf", self.root)["status"], 400)
        # 缺 workflow → 400
        self.assertEqual(hs.read_snapshot("", self.root, seq=1)["status"], 400)
        # file 带路径分隔/上级目录 → 400（拒绝穿越，不落盘任何东西）
        for bad in (r"..\0001-a3f9c2e1.json", r"..\evil.json", "sub/0001-a3f9c2e1.json", "..", "."):
            out = hs.read_snapshot("wf", self.root, file_name=bad)
            self.assertFalse(out["ok"])
            self.assertEqual(out["status"], 400, bad)
        # seq 非法（非整数）→ 400
        out = hs.read_snapshot("wf", self.root, seq="abc")
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 400)

    def test_unknown_workflow_404_no_dir_created(self):
        out = hs.read_snapshot("不存在", self.root, seq=1)
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 404)
        self.assertFalse(os.path.exists(os.path.join(self.root, "workflows")), "查询不该创建任何目录")

    def test_file_from_index_with_traversal_not_followed(self):
        # 索引条目 file 字段被手改为含路径 → 500 拒绝（不穿越）
        self.commit_one()
        d = os.path.join(self.root, "workflows", ".history", "wf")
        with open(os.path.join(d, hs.INDEX_FILE_NAME), "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        entry = json.loads(lines[0])
        entry["file"] = "..\\evil.json"
        with open(os.path.join(d, hs.INDEX_FILE_NAME), "w", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
        out = hs.read_snapshot("wf", self.root, seq=1)
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 500)


class TestP5Purity(TempRootTestCase):
    """P5a：纯逻辑层（graphSigIgnoringSeed / computeDelta / shouldMergeWithHead / normalizeEntry）。"""

    SIG_GRAPH = {
        "nodes": [
            {"id": 1, "type": "CheckpointLoaderSimple", "widgets_values": ["model.safetensors"]},
            {"id": 2, "type": "KSampler", "widgets_values_named": {"seed": 42, "steps": 20, "cfg": 7}},
            {"id": 3, "type": "EmptyLatentImage", "widgets_values_named": {"width": 512, "height": 512}},
        ],
        "links": [[1, 1, 0, 2, 0, "MODEL"]],
    }

    def test_schema_version_is_2(self):
        self.assertEqual(hs.SCHEMA_VERSION, 2)

    def test_graph_sig_ignoring_seed_stable(self):
        sig = hs.graph_sig_ignoring_seed(self.SIG_GRAPH)
        self.assertRegex(sig, r"^v4:[0-9a-f]{8}$")
        self.assertEqual(sig, "v4:b740be6d")  # 跨语言一致基准（JS 侧同值；v4 = groups + 节点 explicit title）
        self.assertEqual(hs.graph_sig_ignoring_seed(self.SIG_GRAPH), sig)

    def test_graph_sig_v3_mode_sensitive(self):
        """2026-10-26（v3）：节点 mode 参与签名 —— bypass(4) / mute(2) 必须另起新节点。

        修前：签名不含 mode，关掉一个模块后签名不变 → 被判成「图没变」而合并。
        """
        import copy

        base = {"nodes": [
            {"id": 1, "type": "A", "mode": 0, "widgets_values": [1]},
            {"id": 2, "type": "B", "widgets_values": [2]},
        ], "links": []}
        s0 = hs.graph_sig_ignoring_seed(base)
        bypass = copy.deepcopy(base)
        bypass["nodes"][0]["mode"] = 4
        mute = copy.deepcopy(base)
        mute["nodes"][0]["mode"] = 2
        self.assertNotEqual(hs.graph_sig_ignoring_seed(bypass), s0, "bypass 应改签名")
        self.assertNotEqual(hs.graph_sig_ignoring_seed(mute), s0, "mute 应改签名")
        self.assertNotEqual(hs.graph_sig_ignoring_seed(bypass), hs.graph_sig_ignoring_seed(mute))
        # mode 缺失与 mode=0 等价
        nomode = copy.deepcopy(base)
        nomode["nodes"][0].pop("mode")
        self.assertEqual(hs.graph_sig_ignoring_seed(nomode), s0)

    def test_graph_sig_v2_links_sensitive_seed_insensitive(self):
        """v2 语义：纯连线改动 → 签名变化；仅换 seed → 签名不变（与 JS §12 用例对应）。"""
        import copy

        base = self.SIG_GRAPH
        base_sig = hs.graph_sig_ignoring_seed(base)
        # 纯连线改动（节点 widget 未变）→ 端点变化改签名
        relinked = copy.deepcopy(base)
        relinked["links"] = [[1, 1, 0, 3, 0, "MODEL"]]
        self.assertNotEqual(hs.graph_sig_ignoring_seed(relinked), base_sig)
        # 同条数换端点 → 仍变化（按端点对集合，不按条数）
        swap = copy.deepcopy(base)
        swap["links"] = [[1, 1, 1, 2, 1, "MODEL"]]
        self.assertNotEqual(hs.graph_sig_ignoring_seed(swap), base_sig)
        # 连线顺序无关，多一条连线改签名
        reordered = copy.deepcopy(base)
        reordered["links"] = [[1, 1, 0, 2, 0, "MODEL"], [2, 2, 0, 3, 0, "LATENT"]]
        reordered2 = copy.deepcopy(base)
        reordered2["links"] = [[2, 2, 0, 3, 0, "LATENT"], [1, 1, 0, 2, 0, "MODEL"]]
        self.assertEqual(hs.graph_sig_ignoring_seed(reordered2), hs.graph_sig_ignoring_seed(reordered))
        self.assertNotEqual(hs.graph_sig_ignoring_seed(reordered), base_sig)
        # 对象数组格式与数组数组格式等价
        obj_links = copy.deepcopy(base)
        obj_links["links"] = [{"id": 1, "origin_id": 1, "origin_slot": 0, "target_id": 2, "target_slot": 0, "type": "MODEL"}]
        self.assertEqual(hs.graph_sig_ignoring_seed(obj_links), base_sig)
        # 仅换 seed → 签名不变（不回归）
        seed_only = copy.deepcopy(base)
        seed_only["nodes"][1]["widgets_values_named"]["seed"] = 999999
        self.assertEqual(hs.graph_sig_ignoring_seed(seed_only), base_sig)

    def test_graph_sig_ignores_seed_sensitive_otherwise(self):
        import copy

        seed_changed = copy.deepcopy(self.SIG_GRAPH)
        seed_changed["nodes"][1]["widgets_values_named"]["seed"] = 999999
        self.assertEqual(hs.graph_sig_ignoring_seed(seed_changed), hs.graph_sig_ignoring_seed(self.SIG_GRAPH))
        steps_changed = copy.deepcopy(self.SIG_GRAPH)
        steps_changed["nodes"][1]["widgets_values_named"]["steps"] = 30
        self.assertNotEqual(hs.graph_sig_ignoring_seed(steps_changed), hs.graph_sig_ignoring_seed(self.SIG_GRAPH))
        noise_seed = copy.deepcopy(self.SIG_GRAPH)
        noise_seed["nodes"][1]["widgets_values_named"]["noise_seed"] = 7
        self.assertEqual(hs.graph_sig_ignoring_seed(noise_seed), hs.graph_sig_ignoring_seed(self.SIG_GRAPH))

    def test_compute_delta_three_kinds(self):
        prev = {"nodes": [
            {"id": 1, "type": "A", "title": "甲", "widgets_values_named": {"value": 1, "steps": 20}},
            {"id": 2, "type": "B"},
        ]}
        nxt = {"nodes": [
            {"id": 1, "type": "A", "title": "甲", "widgets_values_named": {"value": 1, "steps": 30}},
            {"id": 3, "type": "C"},
        ]}
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["changed"], [{"id": 1, "title": "甲", "fields": ["steps"]}])
        self.assertEqual(d["added"], [{"id": 3, "title": "C"}])
        self.assertEqual(d["removed"], [{"id": 2, "title": "B"}])

    def test_compute_delta_type_and_positional_widgets(self):
        prev = {"nodes": [{"id": 1, "type": "A", "widgets_values": ["a", "b"]}]}
        nxt = {"nodes": [{"id": 1, "type": "A2", "widgets_values": ["a", "z"]}]}
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["changed"], [{"id": 1, "title": "A2", "fields": ["type", "widget_1"]}])

    def test_compute_delta_removed_links_resolve_endpoints_in_prev(self):
        # 被删连线存在于 prev 图，端点 type 必须取自 prev（而非 next）——与 JS 侧同语义用例对应。
        # (a) 端点节点在 next 中缺失 → 不得退化为 id 兜底
        prev = {"nodes": [{"id": 1, "type": "A"}, {"id": 2, "type": "B"}],
                "links": [[1, 1, 0, 2, 0, "X"]]}
        nxt = {"nodes": [{"id": 1, "type": "A"}], "links": []}
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["links"]["added"], [])
        self.assertEqual(d["links"]["removed"],
                         [{"from": {"type": "A", "slot": 0}, "to": {"type": "B", "slot": 0}}])
        # (b) 端点节点在 next 中 type 已变 → 不得用 next 的新 type
        prev2 = {"nodes": [{"id": 1, "type": "A"}, {"id": 2, "type": "B"}],
                 "links": [[1, 1, 0, 2, 0, "X"]]}
        nxt2 = {"nodes": [{"id": 1, "type": "A"}, {"id": 2, "type": "B2"}], "links": []}
        d2 = hs.compute_delta(prev2, nxt2)
        self.assertEqual(d2["links"]["added"], [])
        self.assertEqual(d2["links"]["removed"],
                         [{"from": {"type": "A", "slot": 0}, "to": {"type": "B", "slot": 0}}])

    def test_compute_delta_none_for_invalid_prev(self):
        self.assertIsNone(hs.compute_delta(None, {}))
        self.assertIsNone(hs.compute_delta("x", {}))
        self.assertIsNone(hs.compute_delta([], {}))

    # ── 2026-10-26（v4）：delta 把节点改名记为改动 ──────────────────────
    def test_compute_delta_node_title_change(self):
        """只改节点 title（type / widgets 全不动）→ changed 含 fields:["title"]。

        John 已定「改节点 title 算一次真实改动」；悬停气泡会把 title 映射成「名字」。
        """
        prev = {"nodes": [{"id": 1, "type": "KSampler", "title": "旧名",
                           "widgets_values_named": {"seed": 1, "steps": 20}}]}
        nxt = {"nodes": [{"id": 1, "type": "KSampler", "title": "新名",
                          "widgets_values_named": {"seed": 1, "steps": 20}}]}
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["changed"], [{"id": 1, "title": "新名", "fields": ["title"]}])
        # 起名 / 删名（title 从无到有、从有到无）也算改名
        no_title = {"nodes": [{"id": 1, "type": "KSampler", "widgets_values_named": {"steps": 20}}]}
        named = {"nodes": [{"id": 1, "type": "KSampler", "title": "甲", "widgets_values_named": {"steps": 20}}]}
        self.assertEqual(hs.compute_delta(no_title, named)["changed"],
                         [{"id": 1, "title": "甲", "fields": ["title"]}])
        self.assertEqual(hs.compute_delta(named, no_title)["changed"],
                         [{"id": 1, "title": "KSampler", "fields": ["title"]}])
        # 纯改 type（两侧都没显式 title）→ 只报 type，不重复报 title
        a = {"nodes": [{"id": 1, "type": "A"}]}
        b = {"nodes": [{"id": 1, "type": "B"}]}
        self.assertEqual(hs.compute_delta(a, b)["changed"], [{"id": 1, "title": "B", "fields": ["type"]}])
        # title 与 widgets 同时变 → title 在列表里（顺序 type → mode → title → widgets）
        c = {"nodes": [{"id": 1, "type": "A", "title": "x", "widgets_values_named": {"steps": 1}}]}
        e = {"nodes": [{"id": 1, "type": "A", "title": "y", "widgets_values_named": {"steps": 2}}]}
        self.assertEqual(hs.compute_delta(c, e)["changed"], [{"id": 1, "title": "y", "fields": ["title", "steps"]}])

    def test_should_merge_with_head(self):
        self.assertTrue(hs.should_merge_with_head("abc", "abc"))
        self.assertFalse(hs.should_merge_with_head("abc", "abd"))
        self.assertFalse(hs.should_merge_with_head(None, None))
        self.assertFalse(hs.should_merge_with_head(1, 1))

    def test_normalize_entry_legacy(self):
        old = {"seq": 1, "file": "0001-noid.json", "promptId": "p9", "at": "2026-01-01T00:00:00.000Z",
               "source": "user", "nodeCount": 2, "linkCount": 1}
        n = hs.normalize_entry(old)
        self.assertIsNone(n["parent"])
        self.assertEqual(n["kind"], "run")
        self.assertEqual(n["sig"], "")
        self.assertIsNone(n["delta"])
        self.assertEqual(n["blocks"], [])
        self.assertEqual(n["runs"], [{"promptId": "p9", "at": "2026-01-01T00:00:00.000Z", "images": []}])
        self.assertNotIn("parent", old)  # 不改入参

    def test_normalize_entry_keeps_new_fields(self):
        n = hs.normalize_entry({"seq": 5, "kind": "save", "parent": 3, "sig": "aa",
                                "blocks": [{"name": "b", "source": "role", "nodeIds": [7], "color": None}], "runs": []})
        self.assertEqual(n["runs"], [])
        self.assertEqual(n["kind"], "save")
        self.assertEqual(n["parent"], 3)
        self.assertEqual(n["sig"], "aa")
        self.assertEqual(n["blocks"], [{"name": "b", "source": "role", "nodeIds": [7], "color": None}])

    def test_joint_sig_matches_js_fixture(self):
        # 跨语言一致性固定 fixture：与 JS 测试里的同一 graph 必须同串
        fixture = {"nodes": [
            {"id": 1, "type": "PrimitiveInt", "widgets_values": [1024]},
            {"id": 2, "type": "KSampler", "widgets_values_named": {"seed": 123, "sampler_name": "euler", "steps": 20}},
        ]}
        self.assertEqual(hs.graph_sig_ignoring_seed(fixture), "v4:9c90ed0e")

    # ── 2026-10-26（v4）：groups 进签名 ─────────────────────────────────
    @staticmethod
    def _sig_base():
        return {
            "nodes": [
                {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 20}},
                {"id": 2, "type": "VAEDecode"},
            ],
            "links": [],
            "groups": [{"id": 1, "title": "G", "color": "#3f789e", "bounding": [11, -100, 398.897, 349.751], "flags": {}}],
        }

    def test_graph_sig_v4_group_color_change(self):
        """只改框颜色（节点完全不动）→ 签名必须变。

        这是本版修的原始症状：修前签名不含 groups → 只改框色被判成「图没变」→ 合并
        → delta 不生成 → 色条永远不亮。
        """
        import copy

        base = self._sig_base()
        s0 = hs.graph_sig_ignoring_seed(base)
        recolored = copy.deepcopy(base)
        recolored["groups"][0]["color"] = "#a85a5a"
        s1 = hs.graph_sig_ignoring_seed(recolored)
        self.assertRegex(s1, r"^v4:[0-9a-f]{8}$")
        self.assertNotEqual(s1, s0, "只改框颜色应改签名")
        # 颜色大小写差异规范化后同色 → 签名不变（与 delta 侧 _canon_group_color 同口径）
        same_case = copy.deepcopy(base)
        same_case["groups"][0]["color"] = "#3F789E"
        self.assertEqual(hs.graph_sig_ignoring_seed(same_case), s0)

    def test_graph_sig_v4_group_bounding_change(self):
        """只改框范围（bounding 微移 1px）→ 签名必须变。"""
        import copy

        base = self._sig_base()
        s0 = hs.graph_sig_ignoring_seed(base)
        moved = copy.deepcopy(base)
        moved["groups"][0]["bounding"] = [11, -100, 399.897, 349.751]
        s1 = hs.graph_sig_ignoring_seed(moved)
        self.assertNotEqual(s1, s0, "只改框范围应改签名")
        # 整数型 float 与整数同值 → 签名不变（_canon_group_bounding 口径）
        same_val = copy.deepcopy(base)
        same_val["groups"][0]["bounding"] = [11.0, -100.0, 398.897, 349.751]
        self.assertEqual(hs.graph_sig_ignoring_seed(same_val), s0)

    def test_graph_sig_v4_group_title_change(self):
        """只改框名 → 签名必须变（改框名也是一次真实改动）。"""
        import copy

        base = self._sig_base()
        s0 = hs.graph_sig_ignoring_seed(base)
        renamed = copy.deepcopy(base)
        renamed["groups"][0]["title"] = "H"
        s1 = hs.graph_sig_ignoring_seed(renamed)
        self.assertNotEqual(s1, s0, "只改框名应改签名")

    def test_graph_sig_v4_group_unchanged(self):
        """框全都没变 → 签名不变；无 groups 键与 groups:[] 同串；非对象框项被忽略。"""
        import copy

        base = self._sig_base()
        s0 = hs.graph_sig_ignoring_seed(base)
        self.assertEqual(hs.graph_sig_ignoring_seed(copy.deepcopy(base)), s0)
        # groups 缺失 / 空数组 → groups_part 同为 ""（不因键缺失改签名）
        no_groups = copy.deepcopy(base)
        no_groups.pop("groups")
        empty_groups = copy.deepcopy(base)
        empty_groups["groups"] = []
        self.assertEqual(hs.graph_sig_ignoring_seed(no_groups), hs.graph_sig_ignoring_seed(empty_groups))
        # 非对象框项剔除（与 _groups_by_title 一致）
        junk = copy.deepcopy(base)
        junk["groups"] = ["bad", None, base["groups"][0]]
        self.assertEqual(hs.graph_sig_ignoring_seed(junk), s0)

    def test_graph_sig_v4_group_order_and_missing_fields(self):
        """框顺序参与签名（按 graph.groups 顺序）；title/bounding 缺失按 "" 处理。"""
        import copy

        base = self._sig_base()
        base["groups"] = [
            {"id": 1, "title": "A", "color": "#111111", "bounding": [0, 0, 10, 10]},
            {"id": 2, "title": "B", "color": "#222222", "bounding": [0, 0, 20, 20]},
        ]
        s0 = hs.graph_sig_ignoring_seed(base)
        swapped = copy.deepcopy(base)
        swapped["groups"] = list(reversed(swapped["groups"]))
        self.assertNotEqual(hs.graph_sig_ignoring_seed(swapped), s0, "框顺序应参与签名")
        # 缺 title / 缺 color / 非法 bounding → 各自按 "" 参与，不报错
        bare = copy.deepcopy(base)
        bare["groups"] = [{"id": 1, "title": "A", "color": "#111111", "bounding": [0, 0, 10, 10]},
                          {"id": 2}]
        s_bare = hs.graph_sig_ignoring_seed(bare)
        self.assertRegex(s_bare, r"^v4:[0-9a-f]{8}$")
        self.assertNotEqual(s_bare, s0)
        # bounding 非法 vs 缺失 → 同串（都归 ""）
        bad = copy.deepcopy(bare)
        bad["groups"][1]["bounding"] = "not-an-array"
        self.assertEqual(hs.graph_sig_ignoring_seed(bad), s_bare)

    # ── 2026-10-26（v4 补）：节点 explicit title 进签名 ────────────────
    def test_graph_sig_v4_node_title_change(self):
        """只改节点 title（type / mode / widgets 全不动）→ 签名必须变。

        修前：delta 已把改名记为 fields:["title"]，但签名不含 title → kind=run 的
        改名仍被判成「图没变」而合并 → delta 根本不生成，等于白记。
        """
        import copy

        base = self._sig_base()
        base["nodes"][0]["title"] = "旧名"
        s0 = hs.graph_sig_ignoring_seed(base)
        renamed = copy.deepcopy(base)
        renamed["nodes"][0]["title"] = "新名"
        s1 = hs.graph_sig_ignoring_seed(renamed)
        self.assertRegex(s1, r"^v4:[0-9a-f]{8}$")
        self.assertNotEqual(s1, s0, "只改节点 title 应改签名")
        # 删名（有 → 无）同样改签名
        unnamed = copy.deepcopy(base)
        unnamed["nodes"][0].pop("title")
        s_unnamed = hs.graph_sig_ignoring_seed(unnamed)
        self.assertNotEqual(s_unnamed, s0, "删名应改签名")

    def test_graph_sig_v4_node_title_missing_equals_empty(self):
        """节点 title 缺失与空串等价（都归 ""）；非法 title（非字符串）同样归 ""。"""
        import copy

        plain = self._sig_base()
        s_plain = hs.graph_sig_ignoring_seed(plain)
        missing = copy.deepcopy(plain)
        missing["nodes"][0].pop("title", None)
        empty = copy.deepcopy(plain)
        empty["nodes"][0]["title"] = ""
        self.assertEqual(hs.graph_sig_ignoring_seed(missing), s_plain)
        self.assertEqual(hs.graph_sig_ignoring_seed(empty), s_plain)
        self.assertEqual(hs.graph_sig_ignoring_seed(missing), hs.graph_sig_ignoring_seed(empty))
        for bad in (None, 123, {}, []):
            g = copy.deepcopy(plain)
            g["nodes"][0]["title"] = bad
            self.assertEqual(hs.graph_sig_ignoring_seed(g), s_plain, "非法 title %r 应归空串" % (bad,))

    def test_graph_sig_v4_pure_type_change_uses_explicit_title(self):
        """签名用 _explicit_title（不用 _node_title）：显式 title 相同、只换 type → 只差在 type 位。"""
        import copy

        a = {"nodes": [{"id": 1, "type": "A", "title": "同名", "widgets_values": [1]}]}
        b = copy.deepcopy(a)
        b["nodes"][0]["type"] = "B"
        self.assertNotEqual(hs.graph_sig_ignoring_seed(a), hs.graph_sig_ignoring_seed(b))
        # 两侧都无 title 时，节点段 title 位恒为 ""（补一个空串 title 不改签名）
        c = {"nodes": [{"id": 1, "type": "A", "widgets_values": [1]}]}
        c2 = copy.deepcopy(c)
        c2["nodes"][0]["title"] = ""
        self.assertEqual(hs.graph_sig_ignoring_seed(c), hs.graph_sig_ignoring_seed(c2))

    # ── 2026-10-26（v4）：seed 忽略改精确匹配 ────────────────────────────
    def test_graph_sig_seed_ignore_exact_names_only(self):
        """seed / noise_seed 忽略；seed_mode 等含 seed 字样的普通参数**必须**参与签名。

        修前 _SEED_WIDGET_RE = re.compile("seed") 是子串匹配，seed_mode 被静默吞掉；
        种子快照那边用的是精确名 ("seed", "noise_seed")，两边口径不一致。
        """
        import copy

        base = {"nodes": [{"id": 1, "type": "KSampler",
                           "widgets_values_named": {"seed": 1, "noise_seed": 2, "seed_mode": "randomize", "steps": 20}}]}
        s0 = hs.graph_sig_ignoring_seed(base)
        seed_changed = copy.deepcopy(base)
        seed_changed["nodes"][0]["widgets_values_named"]["seed"] = 999999
        self.assertEqual(hs.graph_sig_ignoring_seed(seed_changed), s0, "seed 变化应忽略")
        noise_changed = copy.deepcopy(base)
        noise_changed["nodes"][0]["widgets_values_named"]["noise_seed"] = 888888
        self.assertEqual(hs.graph_sig_ignoring_seed(noise_changed), s0, "noise_seed 变化应忽略")
        mode_changed = copy.deepcopy(base)
        mode_changed["nodes"][0]["widgets_values_named"]["seed_mode"] = "fixed"
        self.assertNotEqual(hs.graph_sig_ignoring_seed(mode_changed), s0, "seed_mode 变化必须改签名（子串 bug 已修）")
        # dict 型 widgets_values 上的同名忽略 / 敏感性一致
        base_d = {"nodes": [{"id": 1, "type": "K", "widgets_values": {"seed": 1, "seed_mode": "randomize"}}]}
        sd0 = hs.graph_sig_ignoring_seed(base_d)
        d_seed = copy.deepcopy(base_d)
        d_seed["nodes"][0]["widgets_values"]["seed"] = 5
        self.assertEqual(hs.graph_sig_ignoring_seed(d_seed), sd0)
        d_mode = copy.deepcopy(base_d)
        d_mode["nodes"][0]["widgets_values"]["seed_mode"] = "fixed"
        self.assertNotEqual(hs.graph_sig_ignoring_seed(d_mode), sd0)


class TestP5bWiring(TempRootTestCase):
    """P5b：commit 新字段/合并判定/分支/save/sidecar runs 升级/list 折叠。"""

    # 仅 seed 变化 → 同 sig
    G_BASE = {"nodes": [
        {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 20}},
        {"id": 2, "type": "EmptyLatentImage", "widgets_values_named": {"width": 512}},
    ], "links": []}
    G_SEED2 = {"nodes": [
        {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 999, "steps": 20}},
        {"id": 2, "type": "EmptyLatentImage", "widgets_values_named": {"width": 512}},
    ], "links": []}
    G_STEPS = {"nodes": [
        {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 30}},
        {"id": 2, "type": "EmptyLatentImage", "widgets_values_named": {"width": 512}},
    ], "links": []}

    def index_lines(self):
        path = os.path.join(self.root, "workflows", ".history", "wf", hs.INDEX_FILE_NAME)
        with open(path, encoding="utf-8") as fh:
            return [json.loads(x) for x in fh.read().splitlines()]

    def test_commit_writes_new_fields(self):
        out = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1", "source": "agent", "kind": "run"})
        self.assertTrue(out["ok"])
        self.assertFalse(out["merged"])
        e = self.index_lines()[0]
        self.assertEqual(e["kind"], "run")
        self.assertEqual(e["source"], "agent")
        self.assertIsNone(e["parent"])
        self.assertEqual(e["sig"], hs.graph_sig_ignoring_seed(self.G_BASE))
        self.assertIsNone(e["delta"])  # 无 head -> None

    def test_commit_defaults_source_user_kind_run(self):
        out = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        self.assertTrue(out["ok"])
        e = self.index_lines()[0]
        self.assertEqual(e["source"], "user")
        self.assertEqual(e["kind"], "run")

    def test_merge_on_same_sig(self):
        # 连提两次，仅改 seed → 索引多 1 主行 + 1 mergeInto 行
        first = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        second = self.commit({"workflow": "wf", "graph": self.G_SEED2, "promptId": "p2", "source": "user"})
        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        self.assertTrue(second["merged"])
        self.assertEqual(second["targetSeq"], first["seq"])
        lines = self.index_lines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["seq"], 1)
        self.assertNotIn("mergeInto", lines[0])  # 主行未被改
        self.assertEqual(lines[1]["mergeInto"], 1)
        self.assertEqual(lines[1]["promptId"], "p2")
        self.assertEqual(lines[1]["kind"], "run")
        # 合并不写新快照
        d = os.path.join(self.root, "workflows", ".history", "wf")
        snaps = [
            f
            for f in os.listdir(d)
            if f.endswith(".json") and not f.endswith(hs.IMAGES_SUFFIX) and f != hs.HEAD_FILE_NAME
        ]
        self.assertEqual(snaps, ["0001-p1.json"])
        # list 折叠：该节点 runs 有 2 条
        listed = hs.list_commits("wf", self.root)
        self.assertEqual(len(listed["entries"]), 1)
        runs = listed["entries"][0]["runs"]
        self.assertEqual([r["promptId"] for r in runs], ["p1", "p2"])

    def test_no_merge_on_different_sig(self):
        first = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        second = self.commit({"workflow": "wf", "graph": self.G_STEPS, "promptId": "p2"})
        self.assertFalse(second["merged"])
        self.assertEqual(second["seq"], 2)
        self.assertEqual(len(self.index_lines()), 2)
        # parent = 上一节点
        self.assertEqual(self.index_lines()[1]["parent"], first["seq"])
        # delta 相对 head 算（steps 变）
        delta = self.index_lines()[1]["delta"]
        self.assertEqual(delta["changed"], [{"id": 1, "title": "KSampler", "fields": ["steps"]}])

    def test_branch_parent_given(self):
        r1 = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        r2 = self.commit({"workflow": "wf", "graph": self.G_STEPS, "promptId": "p2"})
        # 回跳到 #1，改（sig 与 #1 不同）再提交 → 新节点，parent 指向 1
        r3 = self.commit({"workflow": "wf", "graph": self.G_STEPS, "promptId": "p3", "parent": r1["seq"]})
        self.assertFalse(r3["merged"])
        self.assertEqual(self.index_lines()[2]["parent"], 1)
        # parent 传值优先于索引末条（末条是 #2）
        self.assertNotEqual(self.index_lines()[2]["parent"], r2["seq"])

    def test_merge_uses_given_parent_head(self):
        r1 = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        r2 = self.commit({"workflow": "wf", "graph": self.G_STEPS, "promptId": "p2"})
        # parent 指回 #1（sig == #1 的 sig）→ 合并进 #1（不是末条 #2）
        r3 = self.commit({"workflow": "wf", "graph": self.G_SEED2, "promptId": "p3", "parent": r1["seq"]})
        self.assertTrue(r3["merged"])
        self.assertEqual(r3["targetSeq"], 1)
        listed = hs.list_commits("wf", self.root)
        self.assertEqual(len(listed["entries"]), 2)
        self.assertEqual([x["seq"] for x in listed["entries"]], [1, 2])
        self.assertEqual([r["promptId"] for r in listed["entries"][0]["runs"]], ["p1", "p3"])

    def test_merge_with_parent_given_nonexistent_no_merge(self):
        self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        # 2026-10-23 契约变更（§3.2）：parent 传了但索引里查不到 → **视为未传**，
        # 按 head 优先级继续（HEAD 已被 #1 写成 1）。
        # 故旧的「脏 parent 直捣进索引」不再成立：本例 sig 与 #1 相同 → 合并进 #1。
        out = self.commit({"workflow": "wf", "graph": self.G_SEED2, "promptId": "p2", "parent": 999})
        self.assertTrue(out["merged"])
        self.assertEqual(out["targetSeq"], 1)
        self.assertEqual(len(self.index_lines()), 2)
        self.assertEqual(self.index_lines()[1]["mergeInto"], 1)

    def test_dirty_parent_falls_back_to_head_not_written(self):
        # 脏 parent + sig 不同 → 新建节点，parent 不得落脏值（应为 head = 索引末条主行）
        self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        out = self.commit({"workflow": "wf", "graph": self.G_STEPS, "promptId": "p2", "parent": 999})
        self.assertFalse(out["merged"])
        self.assertEqual(self.index_lines()[1]["parent"], 1)

    def test_save_commit_always_new(self):
        r1 = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        # save 即使 sig 相同也不合并
        s1 = hs.save_commit({"workflow": "wf", "graph": self.G_SEED2, "source": "user"}, self.root)
        self.assertTrue(s1["ok"])
        self.assertFalse(s1["merged"])
        e = self.index_lines()[1]
        self.assertEqual(e["kind"], "save")
        self.assertIsNone(e["promptId"])
        self.assertEqual(e["parent"], r1["seq"])
        self.assertEqual(e["source"], "user")
        self.assertNotIn("mergeInto", e)
        # 再存档一次（同 sig）仍新建
        s2 = hs.save_commit({"workflow": "wf", "graph": self.G_BASE, "source": "agent"}, self.root)
        self.assertFalse(s2["merged"])
        self.assertEqual(len(self.index_lines()), 3)
        self.assertEqual(self.index_lines()[2]["kind"], "save")
        self.assertEqual(self.index_lines()[2]["source"], "agent")
        # 存档文件名用 noid
        self.assertTrue(self.index_lines()[1]["file"].endswith("-noid.json"))

    def test_save_commit_bad_params(self):
        self.assertEqual(hs.save_commit({"graph": {}}, self.root)["status"], 400)
        self.assertEqual(hs.save_commit({"workflow": "wf"}, self.root)["status"], 400)
        self.assertEqual(hs.save_commit({"workflow": "wf", "graph": {}}, "")["status"], 500)

    def test_sidecar_runs_upgrade_and_list(self):
        r1 = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        r2 = self.commit({"workflow": "wf", "graph": self.G_SEED2, "promptId": "p2"})  # 合并进 p1
        self.assertTrue(r2["merged"])
        # 两个 promptId 的图都回填 → 都进同一节点的同一 sidecar
        hs.attach_images("wf", self.root, "p1", [{"filename": "a.png"}])
        hs.attach_images("wf", self.root, "p2", [{"filename": "b.png"}])
        sidecar = os.path.join(r1["dir"], "0001-p1.json" + hs.IMAGES_SUFFIX)
        with open(sidecar, encoding="utf-8") as fh:
            obj = json.loads(fh.read())
        self.assertEqual([x["promptId"] for x in obj["runs"]], ["p1", "p2"])
        self.assertEqual(obj["runs"][0]["images"], [{"filename": "a.png", "subfolder": "", "type": "output"}])
        self.assertEqual(obj["runs"][1]["images"], [{"filename": "b.png", "subfolder": "", "type": "output"}])
        # list：节点一条，runs 两条（响应已瘦身：只有 promptId + imageCount），images 扁平保留明细
        listed = hs.list_commits("wf", self.root)
        self.assertEqual(len(listed["entries"]), 1)
        entry = listed["entries"][0]
        self.assertEqual(entry["runs"], [{"promptId": "p1", "imageCount": 1},
                                         {"promptId": "p2", "imageCount": 1}])
        self.assertEqual([im["filename"] for im in entry["images"]], ["a.png", "b.png"])

    def test_attach_locates_node_via_merge_row(self):
        # p2 只出现在 mergeInto 行；attach 须归位到目标节点 0001 的 sidecar
        self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        self.commit({"workflow": "wf", "graph": self.G_SEED2, "promptId": "p2"})
        res = hs.attach_images("wf", self.root, "p2", [{"filename": "z.png"}])
        self.assertTrue(res["ok"])
        self.assertEqual(res["file"], "0001-p1.json" + hs.IMAGES_SUFFIX)
        self.assertEqual(hs.read_images_for("wf", self.root, "p2"), [{"filename": "z.png", "subfolder": "", "type": "output"}])
        self.assertEqual(hs.read_images_for("wf", self.root, "p1"), [])

    def test_sidecar_legacy_shape_reads_as_single_run(self):
        out = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        sidecar = os.path.join(out["dir"], out["file"] + hs.IMAGES_SUFFIX)
        # 手写旧形态
        with open(sidecar, "w", encoding="utf-8") as fh:
            json.dump(
                {"promptId": "p1", "images": [{"filename": "old.png", "subfolder": "", "type": "output"}],
                 "updatedAt": "2026-10-11T00:00:00.000Z"},
                fh,
            )
        self.assertEqual(
            hs.read_images_for("wf", self.root, "p1"),
            [{"filename": "old.png", "subfolder": "", "type": "output"}],
        )
        listed = hs.list_commits("wf", self.root)
        self.assertEqual([im["filename"] for im in listed["entries"][0]["images"]], ["old.png"])
        # 旧形态上 attach → 升级为新形态，且保留旧 run
        res = hs.attach_images("wf", self.root, "p1", [{"filename": "new.png"}])
        self.assertEqual(res["count"], 2)
        with open(sidecar, encoding="utf-8") as fh:
            obj = json.loads(fh.read())
        self.assertEqual(list(obj.keys()), ["runs"])
        self.assertEqual([im["filename"] for im in obj["runs"][0]["images"]], ["old.png", "new.png"])

    def test_list_folds_merge_into_single_entry(self):
        # 3 次提交：1 主 + 2 合并（同 sig）→ list 只 1 entry
        self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        self.commit({"workflow": "wf", "graph": self.G_SEED2, "promptId": "p2"})
        self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p3"})
        self.assertEqual(len(self.index_lines()), 3)
        listed = hs.list_commits("wf", self.root)
        self.assertEqual(len(listed["entries"]), 1)
        self.assertEqual([r["promptId"] for r in listed["entries"][0]["runs"]], ["p1", "p2", "p3"])

    def test_list_entry_has_new_fields(self):
        r1 = self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        r2 = self.commit({"workflow": "wf", "graph": self.G_STEPS, "promptId": "p2", "kind": "run"})
        listed = hs.list_commits("wf", self.root)
        e1 = listed["entries"][1]
        self.assertEqual(e1["parent"], 1)
        self.assertEqual(e1["kind"], "run")
        self.assertEqual(e1["sig"], hs.graph_sig_ignoring_seed(self.G_STEPS))
        self.assertIsNotNone(e1["delta"])

    def test_no_real_history_dir_touched(self):
        self.commit({"workflow": "wf", "graph": self.G_BASE, "promptId": "p1"})
        hs.save_commit({"workflow": "wf", "graph": self.G_STEPS}, self.root)
        self.assertFalse(os.path.exists(os.path.join(os.getcwd(), ".history")))


class TestListResponseSlim(TempRootTestCase):
    """2026-10-26：list_commits 响应瘦身（runs → {promptId,imageCount}；blocks 去 nodeIds）。

    只改读取侧输出：索引磁盘结构不变、entry.images（扁平明细）原样保留。
    """

    WF = "wf"

    def write_index(self, entries):
        path = os.path.join(self.root, "workflows", ".history", self.WF, hs.INDEX_FILE_NAME)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n")
        return path

    def write_sidecar(self, entries, runs):
        """为主行 entry 的 file 写 sidecar runs（{runs:[{promptId,at,images}]}）。"""
        path = self.write_index(entries)
        sidecar = os.path.join(os.path.dirname(path), entries[0]["file"] + hs.IMAGES_SUFFIX)
        with open(sidecar, "w", encoding="utf-8") as fh:
            json.dump({"runs": runs}, fh, ensure_ascii=False)
        return sidecar

    def base_entry(self, seq=1, **extra):
        e = {
            "seq": seq,
            "file": "%04d-p%d.json" % (seq, seq),
            "promptId": "p%d" % seq,
            "at": "2026-10-11T00:00:00.000Z",
            "source": "user",
            "kind": "run",
            "blocks": [],
            "delta": None,
        }
        e.update(extra)
        return e

    # ① runs 精简后只有 promptId / imageCount 两个键
    def test_runs_have_only_prompt_id_and_image_count(self):
        entries = [self.base_entry()]
        self.write_sidecar(entries, [
            {"promptId": "p1", "at": "2026-10-11T00:00:00.000Z",
             "images": [{"filename": "a.png", "subfolder": "", "type": "output"},
                        {"filename": "b.png", "subfolder": "", "type": "output"}]},
            {"promptId": "p2", "at": "2026-10-11T00:05:00.000Z",
             "images": [{"filename": "c.png", "subfolder": "", "type": "output"}]},
        ])
        listed = hs.list_commits(self.WF, self.root)
        self.assertTrue(listed["ok"])
        entry = listed["entries"][0]
        self.assertEqual(entry["runs"], [{"promptId": "p1", "imageCount": 2},
                                         {"promptId": "p2", "imageCount": 1}])
        for r in entry["runs"]:
            self.assertEqual(sorted(r.keys()), ["imageCount", "promptId"])
        # at / images 明细彻底不出现
        self.assertEqual(json.dumps(entry["runs"], ensure_ascii=False).count("\"at\""), 0)
        self.assertEqual(json.dumps(entry["runs"], ensure_ascii=False).count("\"images\""), 0)
        # entry.images 不受影响：仍是对应 run 图的扁平合并明细
        self.assertEqual([im["filename"] for im in entry["images"]], ["a.png", "b.png", "c.png"])

    # ② blocks 里不含 nodeIds（且不存在的键不补 null）
    def test_blocks_have_no_node_ids(self):
        entries = [self.base_entry(
            blocks=[
                {"name": "A", "source": "group", "nodeIds": [1, 2], "color": "#3f789e"},
                {"name": "B", "source": "group", "nodeIds": [3]},
                {"name": "C", "title": "标题", "source": "role", "nodeIds": [4], "color": None},
                {"nodeIds": [5]},
            ],
            delta={"changed": [{"id": 1, "title": "x", "fields": ["steps"]}], "added": [], "removed": []},
        )]
        self.write_index(entries)
        listed = hs.list_commits(self.WF, self.root)
        entry = listed["entries"][0]
        self.assertEqual(entry["blocks"], [
            {"name": "A", "source": "group", "color": "#3f789e"},     # 保留四键中实际存在的
            {"name": "B", "source": "group"},                          # 缺 color → 不补 null
            {"name": "C", "title": "标题", "source": "role", "color": None},  # color 原值 null 保留
            {},                                                          # 只有 nodeIds → 瘦身后为空对象
        ])
        self.assertNotIn("nodeIds", json.dumps(entry["blocks"], ensure_ascii=False))
        # 瘦身只影响响应：blockNames（内部计算）仍靠原 nodeIds 命中，磁盘索引未变
        self.assertEqual(entry["blockNames"], ["A"])
        with open(os.path.join(self.root, "workflows", ".history", self.WF, hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            raw = json.loads(fh.readline())
        self.assertEqual(raw["blocks"][0]["nodeIds"], [1, 2])


class TestHeadPersistence(TempRootTestCase):
    """2026-10-23：后端 HEAD 持久化（.head.json）—— 方案 §3.2 契约。

    测点：读侧四种兜底（缺失/坏 JSON/指向不存在/指向 merge 行）、新建与合并对 head 的影响、
    parent 优先级（显式 parent > head > 末条）、head-set 端点语义、list 的 head 字段、
    save_commit 同口径。
    """

    def graph(self, steps, seed=1):
        return {"nodes": [
            {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": seed, "steps": steps}},
            {"id": 2, "type": "EmptyLatentImage", "widgets_values_named": {"width": 512}},
        ], "links": []}

    def hist_dir(self, name="wf"):
        return os.path.join(self.root, "workflows", ".history", hs.sanitize_workflow_name(name))

    def head_path(self, name="wf"):
        return os.path.join(self.hist_dir(name), hs.HEAD_FILE_NAME)

    def read_head_file(self, name="wf"):
        with open(self.head_path(name), encoding="utf-8") as fh:
            return json.loads(fh.read())

    def write_head_file(self, text, name="wf"):
        with open(self.head_path(name), "w", encoding="utf-8") as fh:
            fh.write(text)

    def index_lines(self, name="wf"):
        path = os.path.join(self.hist_dir(name), hs.INDEX_FILE_NAME)
        with open(path, encoding="utf-8") as fh:
            return [json.loads(x) for x in fh.read().splitlines() if x.strip()]

    def three_nodes(self, name="wf"):
        """建 3 个主行（seq 1/2/3，各自 sig 不同 → 不合并），返回各自 seq。"""
        seqs = []
        for i, steps in enumerate((10, 20, 30), start=1):
            out = self.commit({"workflow": name, "graph": self.graph(steps), "promptId": "p%d" % i})
            self.assertFalse(out["merged"])
            seqs.append(out["seq"])
        self.assertEqual(seqs, [1, 2, 3])
        return seqs

    # ① 无 .head.json → parent 退回索引末条（老行为不变）
    def test_missing_head_falls_back_to_last(self):
        first = self.commit({"workflow": "wf", "graph": self.graph(10), "promptId": "p1"})
        self.assertEqual(self.read_head_file()["seq"], 1)  # 新建即写 head
        os.remove(self.head_path())  # 抹掉 head，模拟无 head 的老目录
        out = self.commit({"workflow": "wf", "graph": self.graph(20), "promptId": "p2"})
        self.assertFalse(out["merged"])
        self.assertEqual(self.index_lines()[1]["parent"], first["seq"])
        self.assertEqual(out["seq"], 2)

    # ② 新建节点后 .head.json 跟随新 seq
    def test_new_node_advances_head(self):
        self.three_nodes()
        self.assertEqual(self.read_head_file()["seq"], 3)
        self.assertIn("at", self.read_head_file())
        # 快照/索引目录同级
        self.assertEqual(os.path.dirname(self.head_path()), self.hist_dir())
        # 无 .tmp 残留
        self.assertFalse(os.path.exists(self.head_path() + ".tmp"))

    # ③ 合并（mergeInto）后 .head.json 不变
    def test_merge_keeps_head(self):
        r1 = self.commit({"workflow": "wf", "graph": self.graph(10), "promptId": "p1"})
        before = self.read_head_file()
        # 仅改 seed → 同 sig → 合并进行 #1
        merged = self.commit({"workflow": "wf", "graph": self.graph(10, seed=999), "promptId": "p2"})
        self.assertTrue(merged["merged"])
        self.assertEqual(merged["targetSeq"], r1["seq"])
        self.assertEqual(self.read_head_file(), before)

    # ④ 回跳设 head 到中间节点后提交 → 新行 parent = 回跳目标（真分叉）
    def test_set_head_then_commit_forks(self):
        seqs = self.three_nodes()
        target = seqs[0]
        res = hs.set_head({"workflow": "wf", "seq": target, "at": "2026-10-23T00:00:00.000Z"}, self.root)
        self.assertTrue(res["ok"])
        self.assertEqual(res["seq"], target)
        self.assertEqual(self.read_head_file()["seq"], target)
        self.assertEqual(self.read_head_file()["at"], "2026-10-23T00:00:00.000Z")

        out = self.commit({"workflow": "wf", "graph": self.graph(40), "promptId": "p4"})
        self.assertFalse(out["merged"])
        lines = self.index_lines()
        self.assertEqual(lines[-1]["seq"], 4)
        self.assertEqual(lines[-1]["parent"], target)  # 真分叉，不是末条 3
        self.assertNotEqual(lines[-1]["parent"], 3)
        # 提交后 head 前进到新节点
        self.assertEqual(self.read_head_file()["seq"], 4)
        # 图确实分叉：节点 1 有子 2 与 4
        children = {}
        for ln in lines:
            if ln.get("parent") is not None:
                children.setdefault(ln["parent"], []).append(ln["seq"])
        self.assertEqual(sorted(children[target]), [2, 4])

    # ⑤ .head.json 坏 JSON → 退回末条，不抛异常
    def test_bad_json_head_falls_back(self):
        self.three_nodes()
        self.write_head_file("{ 这不是 json")
        self.assertIsNone(hs.read_head(self.hist_dir(), self.index_lines()))
        listed = hs.list_commits("wf", self.root)
        self.assertTrue(listed["ok"])
        self.assertIsNone(listed["head"])
        out = self.commit({"workflow": "wf", "graph": self.graph(40), "promptId": "p4"})
        self.assertFalse(out["merged"])
        self.assertEqual(self.index_lines()[-1]["parent"], 3)  # 退回末条
        # 新提交把 head 写回正轨
        self.assertEqual(self.read_head_file()["seq"], 4)

    def test_head_not_object_falls_back(self):
        self.three_nodes()
        self.write_head_file("[1,2,3]")
        self.assertIsNone(hs.read_head(self.hist_dir(), self.index_lines()))
        out = self.commit({"workflow": "wf", "graph": self.graph(40), "promptId": "p4"})
        self.assertEqual(self.index_lines()[-1]["parent"], 3)

    # ⑥ .head.json 指向已不存在的 seq → head-set 判 400，读 head 退回末条
    def test_head_points_to_missing_seq(self):
        self.three_nodes()
        res = hs.set_head({"workflow": "wf", "seq": 99}, self.root)
        self.assertFalse(res["ok"])
        self.assertEqual(res["status"], 400)
        self.assertEqual(res["error"], "seq_not_found")
        # 拒绝的写入不能改掉已有 head
        self.assertEqual(self.read_head_file()["seq"], 3)
        # 手写脏值（模拟用户删了历史文件）→ 读侧退回末条
        self.write_head_file(json.dumps({"seq": 99, "at": "2026-10-23T00:00:00.000Z"}))
        self.assertIsNone(hs.read_head(self.hist_dir(), self.index_lines()))
        self.assertIsNone(hs.list_commits("wf", self.root)["head"])
        out = self.commit({"workflow": "wf", "graph": self.graph(40), "promptId": "p4"})
        self.assertEqual(self.index_lines()[-1]["parent"], 3)

    def test_head_set_rejects_merge_row_seq(self):
        r1 = self.commit({"workflow": "wf", "graph": self.graph(10), "promptId": "p1"})
        merged = self.commit({"workflow": "wf", "graph": self.graph(10, seed=7), "promptId": "p2"})
        self.assertTrue(merged["merged"])
        merge_seq = max(x["seq"] for x in self.index_lines())
        self.assertEqual(merge_seq, 2)
        res = hs.set_head({"workflow": "wf", "seq": merge_seq}, self.root)
        self.assertEqual(res["status"], 400)
        self.assertEqual(res["error"], "seq_not_found")
        self.assertEqual(self.read_head_file()["seq"], r1["seq"])

    def test_head_set_param_guards(self):
        self.three_nodes()
        self.assertEqual(hs.set_head({"graph": {}}, self.root)["error"], "missing_workflow")
        self.assertEqual(hs.set_head({"workflow": "  "}, self.root)["error"], "missing_workflow")
        self.assertEqual(hs.set_head({"workflow": "wf"}, self.root)["error"], "missing_seq")
        self.assertEqual(hs.set_head({"workflow": "wf", "seq": "abc"}, self.root)["error"], "missing_seq")
        self.assertEqual(hs.set_head({"workflow": "wf", "seq": 2}, "")["status"], 500)

    # ⑦ save_commit 也走 head（不再直接取末条）
    def test_save_commit_uses_head(self):
        seqs = self.three_nodes()
        res = hs.set_head({"workflow": "wf", "seq": seqs[0]}, self.root)
        self.assertTrue(res["ok"])
        saved = hs.save_commit({"workflow": "wf", "graph": self.graph(40)}, self.root)
        self.assertTrue(saved["ok"])
        self.assertFalse(saved["merged"])
        lines = self.index_lines()
        self.assertEqual(lines[-1]["kind"], "save")
        self.assertEqual(lines[-1]["parent"], seqs[0])  # head 而非末条 3
        self.assertEqual(self.read_head_file()["seq"], saved["seq"])

    # list_commits 的 head 字段
    def test_list_returns_head(self):
        self.three_nodes()
        listed = hs.list_commits("wf", self.root)
        self.assertEqual(listed["head"]["seq"], 3)
        self.assertIn("at", listed["head"])
        # 空历史 / 目录不存在 → head 为 None
        empty = hs.list_commits("没有这个", self.root)
        self.assertEqual(empty["entries"], [])
        self.assertIsNone(empty["head"])

    def test_list_head_none_when_no_file(self):
        self.three_nodes()
        os.remove(self.head_path())
        self.assertIsNone(hs.list_commits("wf", self.root)["head"])

    # 显式 parent 仍优先于 head（agent 通道）；但脏 parent 不再写进索引
    def test_explicit_parent_beats_head(self):
        seqs = self.three_nodes()
        res = hs.set_head({"workflow": "wf", "seq": seqs[2]}, self.root)
        self.assertTrue(res["ok"])
        out = self.commit({"workflow": "wf", "graph": self.graph(40), "promptId": "p4", "parent": seqs[0]})
        self.assertFalse(out["merged"])
        self.assertEqual(self.index_lines()[-1]["parent"], seqs[0])


class TestAttachImages(TempRootTestCase):
    """P4 修：产物图 sidecar（attach_images / read_images_for / list_commits 合并）。"""

    def commit_one(self, workflow="wf", prompt_id="a3f9c2e1-9b7c-4d2e-8f01-234567890abc"):
        out = self.commit(
            {"workflow": workflow, "graph": {"nodes": [{"id": 1}], "links": []}, "promptId": prompt_id}
        )
        self.assertTrue(out["ok"])
        return out

    def sidecar_path_for(self, out):
        # 快照 0001-a3f9c2e1.json → sidecar 0001-a3f9c2e1.json.images.json
        return os.path.join(out["dir"], out["file"] + hs.IMAGES_SUFFIX)

    def test_suffix_constant(self):
        self.assertEqual(hs.IMAGES_SUFFIX, ".images.json")

    def test_attach_roundtrip(self):
        out = self.commit_one()
        res = hs.attach_images(
            "wf", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc",
            [{"filename": "a.png", "subfolder": "", "type": "output"}],
            at="2026-10-11T00:00:00.000Z",
        )
        self.assertTrue(res["ok"])
        self.assertEqual(res["status"], 200)
        self.assertEqual(res["file"], "0001-a3f9c2e1.json.images.json")
        self.assertEqual(res["count"], 1)
        # 侧车文件真的写在快照同名目录、名为 <快照名>.images.json
        path = self.sidecar_path_for(out)
        self.assertTrue(os.path.isfile(path))
        self.assertFalse(os.path.exists(path + ".tmp"), "临时文件应已被 os.replace 消费")
        with open(path, encoding="utf-8") as fh:
            obj = json.loads(fh.read())
        # P5b：sidecar 升级为 {runs:[{promptId, at, images}]}
        self.assertEqual(list(obj.keys()), ["runs"])
        self.assertEqual(obj["runs"], [{
            "promptId": "a3f9c2e1-9b7c-4d2e-8f01-234567890abc",
            "at": "2026-10-11T00:00:00.000Z",
            "images": [{"filename": "a.png", "subfolder": "", "type": "output"}],
        }])
        # 读回
        self.assertEqual(
            hs.read_images_for("wf", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc"),
            [{"filename": "a.png", "subfolder": "", "type": "output"}],
        )

    def test_attach_normalizes_and_drops_extra_fields(self):
        self.commit_one()
        res = hs.attach_images(
            "wf", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc",
            [{"filename": "a.png", "subfolder": "sub", "type": "temp", "extra": 1, "nodeId": 7}],
        )
        self.assertTrue(res["ok"])
        imgs = hs.read_images_for("wf", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc")
        self.assertEqual(imgs, [{"filename": "a.png", "subfolder": "sub", "type": "temp"}])
        # 缺 subfolder/type → "" / "output"
        res2 = hs.attach_images("wf", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc", [{"filename": "b.png"}])
        self.assertEqual(res2["count"], 2)
        imgs2 = hs.read_images_for("wf", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc")
        self.assertEqual(imgs2[1], {"filename": "b.png", "subfolder": "", "type": "output"})

    def test_attach_idempotent_same_and_append_new(self):
        self.commit_one()
        pid = "a3f9c2e1-9b7c-4d2e-8f01-234567890abc"
        img = {"filename": "a.png", "subfolder": "", "type": "output"}
        first = hs.attach_images("wf", self.root, pid, [img])
        self.assertEqual(first["count"], 1)
        # 同图重复上报 → 不累加
        again = hs.attach_images("wf", self.root, pid, [dict(img)])
        self.assertEqual(again["count"], 1)
        self.assertEqual(len(hs.read_images_for("wf", self.root, pid)), 1)
        # 新图 → 追加
        newer = hs.attach_images("wf", self.root, pid, [{"filename": "b.png", "subfolder": "", "type": "output"}])
        self.assertEqual(newer["count"], 2)
        # 批内去重
        batch = hs.attach_images(
            "wf", self.root, pid,
            [{"filename": "c.png", "subfolder": "", "type": "output"}, {"filename": "c.png", "subfolder": "", "type": "output"}],
        )
        self.assertEqual(batch["count"], 3)
        names = [im["filename"] for im in hs.read_images_for("wf", self.root, pid)]
        self.assertEqual(names, ["a.png", "b.png", "c.png"])

    def test_attach_same_filename_diff_subfolder_not_deduped(self):
        self.commit_one()
        pid = "a3f9c2e1-9b7c-4d2e-8f01-234567890abc"
        hs.attach_images("wf", self.root, pid, [{"filename": "a.png", "subfolder": "", "type": "output"}])
        res = hs.attach_images("wf", self.root, pid, [{"filename": "a.png", "subfolder": "s", "type": "output"}])
        self.assertEqual(res["count"], 2)

    def test_attach_404_unknown_prompt_id(self):
        self.commit_one()
        res = hs.attach_images("wf", self.root, "does-not-exist", [{"filename": "a.png"}])
        self.assertFalse(res["ok"])
        self.assertEqual(res["status"], 404)
        self.assertFalse(os.path.exists(self.sidecar_path_for(self.commit_one("wf2", "zzzzzzzz-1"))))

    def test_attach_404_unknown_workflow(self):
        self.commit_one()
        res = hs.attach_images("不存在", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc", [{"filename": "a.png"}])
        self.assertFalse(res["ok"])
        self.assertEqual(res["status"], 404)

    def test_attach_400_missing_fields(self):
        self.commit_one()
        pid = "a3f9c2e1-9b7c-4d2e-8f01-234567890abc"
        img = [{"filename": "a.png"}]
        for wf, p, imgs in (("", pid, img), (None, pid, img), ("wf", "", img), ("wf", None, img)):
            out = hs.attach_images(wf, self.root, p, imgs)
            self.assertFalse(out["ok"], (wf, p, imgs))
            self.assertEqual(out["status"], 400)
        # images 非数组 / 空数组 → 400
        for bad in (None, "x", {}, [], "a.png"):
            out = hs.attach_images("wf", self.root, pid, bad)
            self.assertFalse(out["ok"], bad)
            self.assertEqual(out["status"], 400)
        # 图项无 filename / filename 空 / 非对象项 → 400
        for bad in ([{"subfolder": "s"}], [{"filename": ""}], [{"filename": None}], ["a.png"], [1]):
            out = hs.attach_images("wf", self.root, pid, bad)
            self.assertFalse(out["ok"], bad)
            self.assertEqual(out["status"], 400)
        # 以上 400 路径都不该落 sidecar
        self.assertFalse(os.path.exists(os.path.join(self.root, "workflows", ".history", "wf", "0001-a3f9c2e1.json.images.json")))

    def test_attach_500_missing_user_dir(self):
        out = hs.attach_images("wf", "", "pid", [{"filename": "a.png"}])
        self.assertFalse(out["ok"])
        self.assertEqual(out["status"], 500)

    def test_read_images_for_absent(self):
        self.commit_one()
        # 有索引但无 sidecar → []
        self.assertEqual(hs.read_images_for("wf", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc"), [])
        # 未知 workflow / 未知 promptId → []
        self.assertEqual(hs.read_images_for("不存在", self.root, "x"), [])
        self.assertEqual(hs.read_images_for("wf", self.root, "x"), [])

    def test_list_commits_merges_sidecar(self):
        # 两次提交用**不同** graph（sig 不同）→ 两个节点；否则同 sig 会被 P5b 合并
        a = self.commit({"workflow": "wf", "promptId": "aaaaaaaa-1111", "graph": {"nodes": [{"id": 1, "widgets_values": ["a"]}], "links": []}})
        b = self.commit({"workflow": "wf", "promptId": "bbbbbbbb-2222", "graph": {"nodes": [{"id": 1, "widgets_values": ["b"]}], "links": []}})
        hs.attach_images(
            "wf", self.root, "aaaaaaaa-1111",
            [{"filename": "a1.png", "subfolder": "", "type": "output"}, {"filename": "a2.png", "subfolder": "", "type": "output"}],
            at="2026-10-11T01:00:00.000Z",
        )
        listed = hs.list_commits("wf", self.root)
        self.assertTrue(listed["ok"])
        self.assertEqual(len(listed["entries"]), 2)
        e0, e1 = listed["entries"]
        # runs[].at 取该 entry 的提交时间 at（P5a 形态），非 sidecar.updatedAt
        with open(os.path.join(a["dir"], hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        entry0_at = json.loads(lines[0])["at"]
        entry1_at = json.loads(lines[1])["at"]
        # 有 sidecar 的 entry → 单元素 runs（瘦身：promptId + imageCount）+ 扁平 images（明细）
        self.assertEqual(e0["runs"], [{"promptId": "aaaaaaaa-1111", "imageCount": 2}])
        self.assertEqual(e0["images"], [{"filename": "a1.png", "subfolder": "", "type": "output"},
                                       {"filename": "a2.png", "subfolder": "", "type": "output"}])
        # 无 sidecar 的 entry → 单 run（promptId 在、imageCount 0）
        self.assertEqual(e1["runs"], [{"promptId": "bbbbbbbb-2222", "imageCount": 0}])
        self.assertEqual(e1["images"], [])
        self.assertTrue(entry0_at and entry1_at)  # 索引行 at 仍在（只是响应 runs 里不再带）
        # 索引磁盘内容未被改（主行 runs 仍为 P5 缺省 []、无 images 字段；仍两行）
        with open(os.path.join(a["dir"], hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            raw = json.loads(fh.readline())
        self.assertEqual(raw["runs"], [])
        self.assertNotIn("images", raw)
        self.assertEqual(len(lines), 2)

    def test_list_commits_no_sidecar_all_empty(self):
        # P5b：无 sidecar 时，主行 promptId 仍作为一条 run（images 空）；images 扁平为空
        self.commit_one("wf", "aaaaaaaa-1111")
        listed = hs.list_commits("wf", self.root)
        e0 = listed["entries"][0]
        self.assertEqual(len(e0["runs"]), 1)
        self.assertEqual(e0["runs"][0]["promptId"], "aaaaaaaa-1111")
        self.assertEqual(e0["runs"][0]["imageCount"], 0)
        self.assertEqual(e0["images"], [])

    def test_sidecar_bad_json_reads_empty(self):
        out = self.commit_one()
        with open(self.sidecar_path_for(out), "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        pid = "a3f9c2e1-9b7c-4d2e-8f01-234567890abc"
        self.assertEqual(hs.read_images_for("wf", self.root, pid), [])
        self.assertEqual(hs.list_commits("wf", self.root)["entries"][0]["images"], [])

    def test_attach_does_not_touch_real_history_dir(self):
        # 所有落盘都在 tempfile 临时根下，绝不在 cwd / 真实 .history 下建任何东西
        self.commit_one()
        hs.attach_images("wf", self.root, "a3f9c2e1-9b7c-4d2e-8f01-234567890abc", [{"filename": "a.png"}])
        self.assertFalse(os.path.exists(os.path.join(os.getcwd(), ".history")))
        self.assertTrue(os.path.isdir(os.path.join(self.root, "workflows", ".history", "wf")))


class TestBlockNames(TempRootTestCase):
    """P6 框视角：list_commits 每条 entry 的 blockNames（null / [] / 名字列表）。

    判定：一条提交碰过框 B ⟺ delta 的 changed/added/removed 里任一节点 id ∈ B.nodeIds。
    索引行直接手写以精确控制 delta / blocks 形态；全部落 tempfile，不碰真实 .history。
    """

    WF = "wf"

    def write_index(self, entries):
        path = os.path.join(self.root, "workflows", ".history", self.WF, hs.INDEX_FILE_NAME)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n")
        return path

    def block_names(self, entries):
        self.write_index(entries)
        listed = hs.list_commits(self.WF, self.root)
        self.assertTrue(listed["ok"])
        return [e.get("blockNames") for e in listed["entries"]]

    @staticmethod
    def base_entry(seq=1, **extra):
        e = {
            "seq": seq,
            "file": "%04d-p%d.json" % (seq, seq),
            "promptId": "p%d" % seq,
            "at": "2026-10-11T00:00:00.000Z",
            "source": "user",
            "kind": "run",
            "blocks": [],
            "delta": None,
        }
        e.update(extra)
        return e

    def test_hits_one_block(self):
        # 实测口径：delta.changed=[{id:16}] → 精确命中 3 号框，其余不命中
        entries = [self.base_entry(
            blocks=[
                {"name": "1. Load", "source": "group", "nodeIds": [1, 2]},
                {"name": "2. Sampler", "source": "group", "nodeIds": [14, 15]},
                {"name": "3. Prompt enhancer (optional)", "source": "group", "nodeIds": [16, 17]},
            ],
            delta={"changed": [{"id": 16, "title": "x", "fields": ["steps"]}], "added": [], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [["3. Prompt enhancer (optional)"]])

    def test_hits_multiple_blocks(self):
        entries = [self.base_entry(
            blocks=[
                {"name": "A", "source": "group", "nodeIds": [1]},
                {"name": "B", "source": "group", "nodeIds": [2, 3]},
                {"name": "C", "source": "group", "nodeIds": [4]},
            ],
            delta={
                "changed": [{"id": 1}],
                "added": [{"id": 3}],
                "removed": [{"id": 4}],
            },
        )]
        # 按 blocks 顺序；三个类别的 id 各自命中一个框
        self.assertEqual(self.block_names(entries), [["A", "B", "C"]])

    def test_changed_added_removed_all_counted(self):
        entries = [self.base_entry(
            blocks=[{"name": "OnlyAdded", "source": "group", "nodeIds": [9]}],
            delta={"changed": [], "added": [{"id": 9, "title": "n"}], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [["OnlyAdded"]])
        entries = [self.base_entry(
            blocks=[{"name": "OnlyRemoved", "source": "group", "nodeIds": [9]}],
            delta={"changed": [], "added": [], "removed": [{"id": 9, "title": "n"}]},
        )]
        self.assertEqual(self.block_names(entries), [["OnlyRemoved"]])

    def test_no_hit_returns_empty_list(self):
        # 有完整 delta + blocks，但没碰任何框 → [] （区别于 null）
        entries = [self.base_entry(
            blocks=[
                {"name": "A", "source": "group", "nodeIds": [1, 2]},
                {"name": "B", "source": "group", "nodeIds": [3]},
            ],
            delta={"changed": [{"id": 99}], "added": [], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [[]])

    def test_no_blocks_at_all_with_delta_returns_empty(self):
        entries = [self.base_entry(
            blocks=[],
            delta={"changed": [{"id": 1}], "added": [], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [[]])

    def test_legacy_no_delta_returns_null(self):
        # 旧数据：无 delta（索引行缺该字段 / delta 非 dict）→ null
        old = {"seq": 1, "file": "0001-p1.json", "promptId": "p1", "at": "2026-01-01T00:00:00.000Z",
               "source": "user", "blocks": [{"name": "A", "source": "group", "nodeIds": [1]}]}
        self.assertEqual(self.block_names([old]), [None])
        for bad in ([], "x", 3, None):
            self.assertEqual(self.block_names([self.base_entry(delta=bad, blocks=[{"name": "A", "nodeIds": [1]}])]), [None])

    def test_legacy_blocks_without_node_ids_returns_null(self):
        # blocks 有但项里缺 nodeIds（P5a 前的旧数据：{name,nodeCount}）→ null
        entries = [self.base_entry(
            blocks=[{"name": "A", "nodeCount": 3}],
            delta={"changed": [{"id": 1}], "added": [], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [None])
        # nodeIds 非数组 → null
        for bad in ("1,2", 5, None, {}):
            self.assertEqual(
                self.block_names([self.base_entry(blocks=[{"name": "A", "nodeIds": bad}],
                                                   delta={"changed": [{"id": 1}], "added": [], "removed": []})]),
                [None],
            )

    def test_blocks_not_list_returns_null(self):
        for bad in (None, "x", {}, 3):
            entries = [self.base_entry(
                blocks=bad,
                delta={"changed": [{"id": 1}], "added": [], "removed": []},
            )]
            # normalize_entry 把非 list blocks 读成 []，但 _block_names_for_entry 判原始形态 → null
            self.assertEqual(self.block_names(entries), [None])

    def test_any_block_missing_node_ids_makes_entry_null(self):
        # 只要有一个块缺 nodeIds，整条 entry 无法判定 → null（不是部分命中）
        entries = [self.base_entry(
            blocks=[
                {"name": "A", "source": "group", "nodeIds": [1]},
                {"name": "Legacy", "nodeCount": 2},
            ],
            delta={"changed": [{"id": 1}], "added": [], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [None])

    def test_id_type_mixed_number_and_string_still_match(self):
        # nodeIds 里是 number，delta 里是 string（反之亦然）→ str 比较仍命中
        entries = [self.base_entry(
            blocks=[{"name": "A", "source": "group", "nodeIds": [16, "21"]}],
            delta={"changed": [{"id": "16"}], "added": [{"id": 21}], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [["A"]])
        entries = [self.base_entry(
            blocks=[{"name": "A", "source": "group", "nodeIds": ["16"]}],
            delta={"changed": [{"id": 16}], "added": [], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [["A"]])

    def test_id_none_ignored(self):
        # delta 项 id 为 None → 不参与命中；无命中 → []
        entries = [self.base_entry(
            blocks=[{"name": "A", "nodeIds": [1]}],
            delta={"changed": [{"id": None}], "added": [], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [[]])

    def test_block_name_missing_yields_empty_string(self):
        entries = [self.base_entry(
            blocks=[{"source": "group", "nodeIds": [5]}],
            delta={"changed": [{"id": 5}], "added": [], "removed": []},
        )]
        self.assertEqual(self.block_names(entries), [[""]])

    def test_merge_into_rows_not_separate_entries(self):
        # mergeInto 行折叠：blockNames 只出现在主行 entry（数量与 entries 对齐）
        main = self.base_entry(
            seq=1,
            blocks=[{"name": "A", "source": "group", "nodeIds": [1]}],
            delta={"changed": [{"id": 1}], "added": [], "removed": []},
        )
        merged = {"seq": 2, "mergeInto": 1, "promptId": "p2", "at": "2026-10-11T00:00:01.000Z",
                  "kind": "run", "source": "user"}
        self.assertEqual(self.block_names([main, merged]), [["A"]])

    def test_real_commit_flow_block_names(self):
        # 端到端：真实 commit（带 blocks）→ list_commits 的 blockNames 命中
        g1 = {"nodes": [{"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 20}}, {"id": 2}], "links": []}
        g2 = {"nodes": [{"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 30}}, {"id": 2}], "links": []}
        blocks = [{"name": "采样", "source": "group", "nodeIds": [1]}, {"name": "加载", "source": "group", "nodeIds": [2]}]
        self.commit({"workflow": "wf", "graph": g1, "promptId": "p1", "blocks": blocks})
        self.commit({"workflow": "wf", "graph": g2, "promptId": "p2", "blocks": blocks})
        listed = hs.list_commits("wf", self.root)
        self.assertEqual(len(listed["entries"]), 2)
        # 第 1 条无 head → delta None → 无法判定
        self.assertIsNone(listed["entries"][0]["blockNames"])
        # 第 2 条 delta.changed=[{id:1}] → 命中「采样」
        self.assertEqual(listed["entries"][1]["blockNames"], ["采样"])

    def test_index_on_disk_untouched(self):
        # 只读计算：list_commits 不改索引磁盘内容
        path = self.write_index([self.base_entry(
            blocks=[{"name": "A", "source": "group", "nodeIds": [1]}],
            delta={"changed": [{"id": 1}], "added": [], "removed": []},
        )])
        with open(path, encoding="utf-8") as fh:
            before = fh.read()
        hs.list_commits("wf", self.root)
        with open(path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), before)
        self.assertNotIn("blockNames", before)


class TestGroupDelta(TempRootTestCase):
    """2026-10-26：delta 增加 groups 维度（框颜色 / 框名 / 框范围）+ 框级命中。

    匹配口径：按 title 对齐；fields 固定 color / bounding（改名走 removed+added）。
    全部落 tempfile，不碰真实 .history。
    """

    WF = "wf"

    @staticmethod
    def graph(groups=None, nodes=None):
        return {
            "nodes": nodes if nodes is not None else [
                {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 20}},
                {"id": 2, "type": "VAEDecode"},
            ],
            "links": [],
            "groups": groups if groups is not None else [],
        }

    @staticmethod
    def group(title="G", color="#3f789e", bounding=None):
        return {"id": 1, "title": title, "color": color,
                "bounding": bounding if bounding is not None else [11, -100, 398.89737130223807, 349.751277854283],
                "flags": {}}

    def blocks_of(self, *pairs):
        return [{"name": n, "source": "group", "nodeIds": list(ids)} for n, ids in pairs]

    def block_names(self, entries):
        path = os.path.join(self.root, "workflows", ".history", self.WF, hs.INDEX_FILE_NAME)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(json.dumps(e, ensure_ascii=False) for e in entries) + "\n")
        listed = hs.list_commits(self.WF, self.root)
        self.assertTrue(listed["ok"])
        return [e.get("blockNames") for e in listed["entries"]]

    @staticmethod
    def entry(seq, blocks, delta):
        return {"seq": seq, "file": "%04d-p%d.json" % (seq, seq), "promptId": "p%d" % seq,
                "at": "2026-10-26T00:00:00.000Z", "source": "user", "kind": "run",
                "blocks": blocks, "delta": delta}

    # ── 契约形状 ────────────────────────────────────────────────────────
    def test_groups_key_always_present(self):
        d = hs.compute_delta(self.graph(), self.graph())
        self.assertIn("groups", d)
        self.assertEqual(d["groups"], {"changed": [], "added": [], "removed": []})
        # prev 非法 → 整体 None（维持现状）
        self.assertIsNone(hs.compute_delta(None, self.graph()))
        # 图里没有 groups 键 → groups 三组空（不报错）
        self.assertEqual(hs.compute_delta({"nodes": []}, {"nodes": []})["groups"],
                         {"changed": [], "added": [], "removed": []})

    # ① 只改框颜色（节点完全不动）
    def test_color_only(self):
        prev = self.graph(groups=[self.group(color="#3f789e")])
        nxt = self.graph(groups=[self.group(color="#a85a5a")])
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["changed"], [])
        self.assertEqual(d["added"], [])
        self.assertEqual(d["removed"], [])
        self.assertEqual(d["groups"]["changed"], [{"name": "G", "fields": ["color"]}])
        self.assertEqual(d["groups"]["added"], [])
        self.assertEqual(d["groups"]["removed"], [])
        # 大小写差异不算变色（规范化后同串）
        same = self.graph(groups=[self.group(color="#3F789E")])
        self.assertEqual(hs.compute_delta(prev, same)["groups"]["changed"], [])

    # ② 只改框名 → removed(旧) + added(新)，changed 不含
    def test_rename_only(self):
        prev = self.graph(groups=[self.group(title="旧名")])
        nxt = self.graph(groups=[self.group(title="新名")])
        g = hs.compute_delta(prev, nxt)["groups"]
        self.assertEqual(g["changed"], [])
        self.assertEqual(g["removed"], [{"name": "旧名"}])
        self.assertEqual(g["added"], [{"name": "新名"}])

    # ③ 只改框范围 → fields 含 bounding
    def test_bounding_only(self):
        prev = self.graph(groups=[self.group(bounding=[0, 0, 100, 200])])
        nxt = self.graph(groups=[self.group(bounding=[0, 0, 101, 200])])
        g = hs.compute_delta(prev, nxt)["groups"]
        self.assertEqual(g["changed"], [{"name": "G", "fields": ["bounding"]}])
        # 数值规范化（整数型 float 不用小数尾巴）：11.0 与 11、-0.0 与 0 不算变化
        a = self.graph(groups=[self.group(bounding=[11, -100, 398.897, 349.751])])
        b = self.graph(groups=[self.group(bounding=[11.0, -100.0, 398.897, 349.751])])
        self.assertEqual(hs.compute_delta(a, b)["groups"]["changed"], [])
        z = self.graph(groups=[self.group(bounding=[-0.0, 0.0, 10, 10])])
        z2 = self.graph(groups=[self.group(bounding=[0, 0, 10, 10])])
        self.assertEqual(hs.compute_delta(z, z2)["groups"]["changed"], [])
        # 真实几何位移仍然算变化（不能把任何小数差都当尾差吞掉）
        c = self.graph(groups=[self.group(bounding=[11, -100, 398.897, 349.751])])
        d2 = self.graph(groups=[self.group(bounding=[11, -100, 398.898, 349.751])])
        self.assertEqual(hs.compute_delta(c, d2)["groups"]["changed"],
                         [{"name": "G", "fields": ["bounding"]}])

    # 颜色 + 范围同时改 → fields 两个都在（顺序 color → bounding）
    def test_color_and_bounding_together(self):
        prev = self.graph(groups=[self.group(color="#3f789e", bounding=[0, 0, 10, 10])])
        nxt = self.graph(groups=[self.group(color="#ffffff", bounding=[0, 0, 20, 10])])
        self.assertEqual(hs.compute_delta(prev, nxt)["groups"]["changed"],
                         [{"name": "G", "fields": ["color", "bounding"]}])

    # ④ 框和节点都没变 → groups 三组全空，且原有 changed 仍为空
    def test_no_change_keeps_node_delta_empty(self):
        prev = self.graph(groups=[self.group()])
        nxt = self.graph(groups=[self.group()])
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["changed"], [])
        self.assertEqual(d["groups"], {"changed": [], "added": [], "removed": []})

    # ⑤ 框变了 + 节点也变了 → 两组都记；blockNames 取并集
    def test_node_and_group_both_changed(self):
        prev = self.graph(groups=[self.group(color="#3f789e")])
        nxt = self.graph(groups=[self.group(color="#a85a5a")], nodes=[
            {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 30}},
            {"id": 2, "type": "VAEDecode"},
        ])
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["changed"], [{"id": 1, "title": "KSampler", "fields": ["steps"]}])
        self.assertEqual(d["groups"]["changed"], [{"name": "G", "fields": ["color"]}])
        blocks = self.blocks_of(("G", [1]), ("H", [2]))
        self.assertEqual(self.block_names([self.entry(1, blocks, d)]), [["G"]])
        # 节点只碰 H、框只碰 G → 并集两个都亮
        d2 = hs.compute_delta(prev, self.graph(groups=[self.group(color="#a85a5a")], nodes=[
            {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 20}},
            {"id": 2, "type": "VAEDecode2"},
        ]))
        self.assertEqual(d2["changed"], [{"id": 2, "title": "VAEDecode2", "fields": ["type"]}])
        self.assertEqual(self.block_names([self.entry(1, blocks, d2)]), [["G", "H"]])

    # 框级命中：只改框色（节点零改动）→ blockNames 命中该框
    def test_block_names_hit_by_group_change_only(self):
        prev = self.graph(groups=[self.group(color="#3f789e")])
        nxt = self.graph(groups=[self.group(color="#a85a5a")])
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["changed"], [])  # 节点确实一个都没动
        blocks = self.blocks_of(("G", [1, 2]), ("H", [99]))
        self.assertEqual(self.block_names([self.entry(1, blocks, d)]), [["G"]])

    # added 的框：在 blocks 里 → 命中；不在 blocks 里 → 忽略
    def test_block_names_added_group(self):
        prev = self.graph(groups=[])
        nxt = self.graph(groups=[self.group(title="新框")])
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["groups"]["added"], [{"name": "新框"}])
        self.assertEqual(self.block_names([self.entry(1, self.blocks_of(("新框", [1])), d)]), [["新框"]])
        self.assertEqual(self.block_names([self.entry(2, self.blocks_of(("别的框", [1])), d)]), [[]])

    # removed 的框：不算命中（框已不在画布，没有小条可亮）
    def test_block_names_removed_group_not_hit(self):
        prev = self.graph(groups=[self.group(title="旧框")])
        nxt = self.graph(groups=[])
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["groups"]["removed"], [{"name": "旧框"}])
        self.assertEqual(self.block_names([self.entry(1, self.blocks_of(("旧框", [1])), d)]), [[]])

    # ⑥ 旧条目（delta 无 groups 键）→ 行为与加本维度前完全一致
    def test_legacy_delta_without_groups_unchanged(self):
        blocks = self.blocks_of(("A", [1]), ("B", [2]))
        # 无 groups 键 + 节点 id 命中 → 照旧命中
        self.assertEqual(self.block_names([self.entry(1, blocks, {
            "changed": [{"id": 1}], "added": [], "removed": []})]), [["A"]])
        # 无 groups 键 + 节点 id 未命中 → []（不是 None）
        self.assertEqual(self.block_names([self.entry(2, blocks, {
            "changed": [{"id": 99}], "added": [], "removed": []})]), [[]])
        # groups 形态异常（非 dict）→ 忽略框级判据，不影响原判据
        self.assertEqual(self.block_names([self.entry(3, blocks, {
            "changed": [{"id": 2}], "added": [], "removed": [], "groups": "x"})]), [["B"]])
        # 三态不变：旧数据 delta 非 dict → None
        self.assertEqual(self.block_names([{"seq": 4, "file": "0004-p4.json", "promptId": "p4",
                                           "blocks": blocks}]), [None])

    # 端到端：真实 commit 只改框色 → 索引行带 groups → blockNames 命中
    # 2026-10-26（v4）：签名已纳入 groups，框色改动本身就是一次真改动 → kind=run 也不会合并；
    # 本用例仍用 kind=save 只是因为它是「必走新建节点」的最稳路径（见下一个用例的 kind=run 验证）。
    def test_commit_flow_group_color_only(self):
        g1 = self.graph(groups=[self.group(color="#3f789e")])
        g2 = self.graph(groups=[self.group(color="#a85a5a")])
        blocks = self.blocks_of(("G", [1, 2]))
        self.commit({"workflow": "wfg", "graph": g1, "promptId": "p1", "blocks": blocks})
        out = self.commit({"workflow": "wfg", "graph": g2, "promptId": "p2", "blocks": blocks, "kind": "save"})
        self.assertFalse(out.get("merged"))
        listed = hs.list_commits("wfg", self.root)
        self.assertEqual(len(listed["entries"]), 2)
        self.assertIsNone(listed["entries"][0]["blockNames"])
        self.assertEqual(listed["entries"][1]["blockNames"], ["G"])
        # 索引行确实带 groups（落盘可查）
        path = os.path.join(self.root, "workflows", ".history", "wfg", hs.INDEX_FILE_NAME)
        with open(path, encoding="utf-8") as fh:
            rows = [json.loads(x) for x in fh.read().splitlines() if x.strip()]
        self.assertEqual(rows[1]["delta"]["groups"]["changed"], [{"name": "G", "fields": ["color"]}])

    # 多个框：按 blocks 顺序输出，不重不漏
    def test_multiple_groups_ordered_by_blocks(self):
        prev = self.graph(groups=[self.group(title="Z", color="#111111"), self.group(title="A", color="#222222")])
        nxt = self.graph(groups=[self.group(title="Z", color="#333333"), self.group(title="A", color="#444444")])
        d = hs.compute_delta(prev, nxt)
        self.assertEqual(d["groups"]["changed"],
                         [{"name": "A", "fields": ["color"]}, {"name": "Z", "fields": ["color"]}])
        blocks = self.blocks_of(("Z", [1]), ("A", [2]))
        self.assertEqual(self.block_names([self.entry(1, blocks, d)]), [["Z", "A"]])

    # ⑦ 端到端（v4 核心）：只改框颜色 + kind=run → **不再合并**，产生新节点且 delta.groups 有内容
    # 修前：签名不含 groups → 只改框色时 sig 不变 → 走 merge 分支 → delta 根本不生成 → 色条永远不亮。
    def test_commit_run_group_color_only_not_merged(self):
        g1 = self.graph(groups=[self.group(color="#3f789e")])
        g2 = self.graph(groups=[self.group(color="#a85a5a")])
        blocks = self.blocks_of(("G", [1, 2]))
        out1 = self.commit({"workflow": "wfrun", "graph": g1, "promptId": "p1", "blocks": blocks, "kind": "run"})
        self.assertTrue(out1["ok"])
        self.assertFalse(out1.get("merged"))
        out2 = self.commit({"workflow": "wfrun", "graph": g2, "promptId": "p2", "blocks": blocks, "kind": "run"})
        self.assertTrue(out2["ok"])
        self.assertFalse(out2.get("merged"), "只改框颜色不应被判成「图没变」而合并")
        # 索引里多一行主行（不是 mergeInto 行），且该行 delta.groups.changed 有内容
        path = os.path.join(self.root, "workflows", ".history", "wfrun", hs.INDEX_FILE_NAME)
        with open(path, encoding="utf-8") as fh:
            rows = [json.loads(x) for x in fh.read().splitlines() if x.strip()]
        self.assertEqual(len(rows), 2)
        self.assertNotIn("mergeInto", rows[1])
        self.assertEqual(rows[1]["parent"], 1)
        self.assertEqual(rows[1]["delta"]["groups"]["changed"], [{"name": "G", "fields": ["color"]}])
        # list_commits 两条主行，后一条 blockNames 命中该框（色条能亮）
        listed = hs.list_commits("wfrun", self.root)
        self.assertEqual(len(listed["entries"]), 2)
        self.assertIsNone(listed["entries"][0]["blockNames"])
        self.assertEqual(listed["entries"][1]["blockNames"], ["G"])

    # ⑧ 端到端（v4 补）：只改节点名 + kind=run → **不再合并**，新节点且 delta.changed 含 fields:["title"]
    # 修前：delta 已能记 title，但签名不含 title → run 改名走 merge 分支 → delta 根本不生成。
    def test_commit_run_node_rename_not_merged(self):
        g1 = self.graph(nodes=[
            {"id": 1, "type": "KSampler", "title": "旧名", "widgets_values_named": {"seed": 1, "steps": 20}},
            {"id": 2, "type": "VAEDecode"},
        ])
        g2 = self.graph(nodes=[
            {"id": 1, "type": "KSampler", "title": "新名", "widgets_values_named": {"seed": 1, "steps": 20}},
            {"id": 2, "type": "VAEDecode"},
        ])
        out1 = self.commit({"workflow": "wfname", "graph": g1, "promptId": "n1", "kind": "run"})
        self.assertTrue(out1["ok"])
        self.assertFalse(out1.get("merged"))
        out2 = self.commit({"workflow": "wfname", "graph": g2, "promptId": "n2", "kind": "run"})
        self.assertTrue(out2["ok"])
        self.assertFalse(out2.get("merged"), "只改节点名不应被判成「图没变」而合并")
        # 索引里多一行主行（非 mergeInto），parent=1，delta.changed 含 fields:["title"]
        path = os.path.join(self.root, "workflows", ".history", "wfname", hs.INDEX_FILE_NAME)
        with open(path, encoding="utf-8") as fh:
            rows = [json.loads(x) for x in fh.read().splitlines() if x.strip()]
        self.assertEqual(len(rows), 2)
        self.assertNotIn("mergeInto", rows[1])
        self.assertEqual(rows[1]["parent"], 1)
        self.assertEqual(rows[1]["delta"]["changed"],
                         [{"id": 1, "title": "新名", "fields": ["title"]}])
        # 两次的 sig 必须不同
        self.assertNotEqual(rows[0]["sig"], rows[1]["sig"])
        self.assertRegex(rows[1]["sig"], r"^v4:[0-9a-f]{8}$")
        # list_commits 两条主行
        self.assertEqual(len(hs.list_commits("wfname", self.root)["entries"]), 2)


class TestMigrateHistory(TempRootTestCase):
    """2026-10-14：改名迁移（修「未保存画布保存后提交历史全丢」）。

    场景：未保存画布用临时名累积提交 → 另存改正式名 → 读历史的键变新名 → 命中空
    目录 → 「全丢」。修法：改名时把旧名目录迁移/并入新名目录。
    """

    # 仅 seed 变化 → 同 sig（会被合并）
    G_BASE = {"nodes": [
        {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 20}},
        {"id": 2, "type": "EmptyLatentImage", "widgets_values_named": {"width": 512}},
    ], "links": []}
    G_SEED2 = {"nodes": [
        {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 999, "steps": 20}},
        {"id": 2, "type": "EmptyLatentImage", "widgets_values_named": {"width": 512}},
    ], "links": []}
    # steps 变 → 不同 sig（会被新建节点）
    G_STEPS = {"nodes": [
        {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1, "steps": 30}},
        {"id": 2, "type": "EmptyLatentImage", "widgets_values_named": {"width": 512}},
    ], "links": []}

    def hist_dir(self, name):
        return os.path.join(self.root, "workflows", ".history", hs.sanitize_workflow_name(name))

    def index_lines(self, name):
        path = os.path.join(self.hist_dir(name), hs.INDEX_FILE_NAME)
        with open(path, encoding="utf-8") as fh:
            return [json.loads(x) for x in fh.read().splitlines()]

    def names(self, name):
        return sorted(
            n for n in os.listdir(self.hist_dir(name)) if n not in (hs.INDEX_FILE_NAME, hs.HEAD_FILE_NAME)
        )

    # ① from 不存在
    def test_src_missing_noop(self):
        out = hs.migrate_history("不存在的名", "另一个名", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(out["status"], 200)
        self.assertEqual(out["moved"], 0)
        self.assertEqual(out["merged"], 0)
        self.assertEqual(out["note"], "src_missing")
        # 无事发生：目标目录也没被创建
        self.assertFalse(os.path.exists(self.hist_dir("另一个名")))

    # ④ from == to（含净化后同名 / 都空）
    def test_same_name_noop(self):
        for a, b in (("画布", "画布"), ("a/b", "ab"), ("", "   "), ("...", ""), (None, None)):
            out = hs.migrate_history(a, b, self.root)
            self.assertTrue(out["ok"])
            self.assertEqual(out["status"], 200)
            self.assertEqual(out["moved"], 0)
            self.assertEqual(out["merged"], 0)
            self.assertEqual(out["note"], "same")

    def test_missing_user_dir_500(self):
        for bad in ("", "   ", None, 3):
            self.assertEqual(hs.migrate_history("a", "b", bad)["status"], 500)

    # ② 目标不存在 → 整体搬移（seq/文件名原样，目录改挂新名）
    def test_target_missing_moves_whole_dir(self):
        r1 = self.commit({"workflow": "临时 画布", "graph": self.G_BASE, "promptId": "aaaa1111"})
        r2 = self.commit({"workflow": "临时 画布", "graph": self.G_STEPS, "promptId": "bbbb2222"})
        hs.attach_images("临时 画布", self.root, "aaaa1111", [{"filename": "a.png"}])
        before = self.names("临时 画布")

        out = hs.migrate_history("临时 画布", "正式 画布", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(out["status"], 200)
        self.assertEqual(out["note"], "renamed")
        self.assertEqual(out["moved"], 2)  # 主行数
        self.assertEqual(out["merged"], 0)
        # 源目录已不存在；目标目录拿到全部文件（含 sidecar），名字一字不改
        self.assertFalse(os.path.exists(self.hist_dir("临时 画布")))
        self.assertEqual(self.names("正式 画布"), before)
        self.assertIn("0001-aaaa1111.json" + hs.IMAGES_SUFFIX, before)
        # 索引行 seq/parent 原样（整体搬移不重编号）
        lines = self.index_lines("正式 画布")
        self.assertEqual([x["seq"] for x in lines], [1, 2])
        self.assertIsNone(lines[0]["parent"])
        self.assertEqual(lines[1]["parent"], r1["seq"])
        self.assertEqual(lines[1]["file"], r2["file"])
        listed = hs.list_commits("正式 画布", self.root)
        self.assertEqual(len(listed["entries"]), 2)
        self.assertEqual(listed["entries"][0]["images"], [{"filename": "a.png", "subfolder": "", "type": "output"}])

    # ③ 目标已存在 → 合并（seq 重编号 + parent/mergeInto 偏移 + 快照同步改名）
    def test_merge_offsets_seq_parent_and_renames_files(self):
        # 目标（正式名）已有 #1
        self.commit({"workflow": "正式 画布", "graph": self.G_BASE, "promptId": "tgt1aaaa"})
        # 源（临时名）：主行 #1 + 合并行 #2（mergeInto 1）+ 主行 #3（parent 1）
        self.commit({"workflow": "临时 画布", "graph": self.G_BASE, "promptId": "src1aaaa"})
        m = self.commit({"workflow": "临时 画布", "graph": self.G_SEED2, "promptId": "src2bbbb"})
        self.assertTrue(m["merged"])
        self.commit({"workflow": "临时 画布", "graph": self.G_STEPS, "promptId": "src3cccc"})
        hs.attach_images("临时 画布", self.root, "src1aaaa", [{"filename": "a.png"}])
        src_seq = [x["seq"] for x in self.index_lines("临时 画布")]
        self.assertEqual(src_seq, [1, 2, 3])

        out = hs.migrate_history("临时 画布", "正式 画布", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(out["status"], 200)
        self.assertEqual(out["moved"], 2)   # 两条主行
        self.assertEqual(out["merged"], 3)  # 追加到目标索引的行数（含 mergeInto 行）
        self.assertNotIn("note", out)
        self.assertFalse(os.path.exists(self.hist_dir("临时 画布")), "合并后源目录应删除")

        # offset = next_seq(目标) = 2 → 源 seq 1/2/3 → 3/4/5
        lines = self.index_lines("正式 画布")
        self.assertEqual([x["seq"] for x in lines], [1, 3, 4, 5])
        self.assertEqual(lines[1]["parent"], None)          # 源 #1 无 parent
        self.assertEqual(lines[2]["mergeInto"], 3)          # 源 #2 的 mergeInto 1 → 3
        self.assertEqual(lines[3]["parent"], 3)             # 源 #3 的 parent 1 → 3
        self.assertEqual(lines[1]["file"], "0003-src1aaaa.json")
        self.assertEqual(lines[3]["file"], "0005-src3cccc.json")
        # 快照 + sidecar 同步改名移入；目标原有文件保留
        self.assertEqual(
            self.names("正式 画布"),
            ["0001-tgt1aaaa.json", "0003-src1aaaa.json", "0003-src1aaaa.json" + hs.IMAGES_SUFFIX, "0005-src3cccc.json"],
        )

        # 读回自洽：3 条主行；src1 节点含 src1+src2 两个 run 与产物图
        listed = hs.list_commits("正式 画布", self.root)
        self.assertEqual([x["seq"] for x in listed["entries"]], [1, 3, 5])
        runs = listed["entries"][1]["runs"]
        self.assertEqual([r["promptId"] for r in runs], ["src1aaaa", "src2bbbb"])
        self.assertEqual(listed["entries"][1]["images"], [{"filename": "a.png", "subfolder": "", "type": "output"}])

    # ③b 重名冲突 → 跳过该行并在 note 记数（不抛异常、不丢目标数据）
    def test_merge_file_conflict_skipped_with_note(self):
        self.commit({"workflow": "正式 画布", "graph": self.G_BASE, "promptId": "tgt1aaaa"})
        self.commit({"workflow": "正式 画布", "graph": self.G_STEPS, "promptId": "tgt2bbbb"})
        self.commit({"workflow": "临时 画布", "graph": self.G_BASE, "promptId": "aaaa1111"})
        # 源 #1 快照 0001-aaaa1111.json 合并后应叫 0004-aaaa1111.json（目标 2 条 → offset 3）；
        # 先占住这个名 → 冲突
        with open(os.path.join(self.hist_dir("正式 画布"), "0004-aaaa1111.json"), "w", encoding="utf-8") as fh:
            fh.write("{}")

        out = hs.migrate_history("临时 画布", "正式 画布", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(out["moved"], 1)
        self.assertEqual(out["merged"], 0)
        self.assertEqual(out["note"], "conflicts:1")
        # 目标索引未被追加；冲突文件保持原内容
        self.assertEqual([x["seq"] for x in self.index_lines("正式 画布")], [1, 2])
        with open(os.path.join(self.hist_dir("正式 画布"), "0004-aaaa1111.json"), encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "{}")

    # 索引坏行容错（对齐 parse_index 口径）：坏行不进 entries，好行照常迁移（合并路径）
    def test_bad_lines_tolerated(self):
        self.commit({"workflow": "正式 画布", "graph": self.G_STEPS, "promptId": "tgt1aaaa"})
        self.commit({"workflow": "临时 画布", "graph": self.G_BASE, "promptId": "aaaa1111"})
        path = os.path.join(self.hist_dir("临时 画布"), hs.INDEX_FILE_NAME)
        with open(path, "a", encoding="utf-8", newline="") as fh:
            fh.write("这不是 JSON\n")
            fh.write("[1,2,3]\n")
        out = hs.migrate_history("临时 画布", "正式 画布", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(out["moved"], 1)
        self.assertEqual(out["merged"], 1)  # 坏行被丢弃，不污染目标索引
        # 目标索引可被 parse_index 正常读回（无坏行）；目标 1 条 → offset 2 → 源 #1 → 3
        self.assertEqual([x["seq"] for x in self.index_lines("正式 画布")], [1, 3])
        self.assertFalse(os.path.exists(self.hist_dir("临时 画布")))

    # ⑤ 合并后校正目标 HEAD（2026-10-23：修「迁移后首次提交凭空长泳道」）
    def test_merge_fixes_target_head(self):
        self.commit({"workflow": "正式 画布", "graph": self.G_BASE, "promptId": "tgt1aaaa"})
        self.commit({"workflow": "正式 画布", "graph": self.G_STEPS, "promptId": "tgt2bbbb"})
        self.commit({"workflow": "临时 画布", "graph": self.G_BASE, "promptId": "src1aaaa"})
        self.commit({"workflow": "临时 画布", "graph": self.G_STEPS, "promptId": "src2bbbb"})
        self.assertEqual(hs.read_head(self.hist_dir("正式 画布"), self.index_lines("正式 画布"))["seq"], 2)

        out = hs.migrate_history("临时 画布", "正式 画布", self.root)
        self.assertTrue(out["ok"])
        lines = self.index_lines("正式 画布")
        self.assertEqual([x["seq"] for x in lines], [1, 2, 4, 5])
        # HEAD 跟到合并后末条主行（5），不再是迁移前的 2
        self.assertEqual(hs.read_head(self.hist_dir("正式 画布"), lines)["seq"], 5)
        # 迁移后首次提交的 parent = 5（与旧口径一致，不凭空长泳道）
        self.commit({"workflow": "正式 画布", "promptId": "after9999",
                     "graph": {"nodes": [{"id": 1, "type": "KSampler",
                                            "widgets_values_named": {"seed": 7, "steps": 11}}], "links": []}})
        self.assertEqual(self.index_lines("正式 画布")[-1]["parent"], 5)

    def test_no_real_history_dir_touched(self):
        # 全部落盘限定在 self.root 的 tempfile 临时目录内
        self.assertNotIn("user", os.path.abspath(self.root))


class TestHistoryKey(TempRootTestCase):
    """2026-10-14：历史主键改画布身份 id —— history_key / claims（新结构）/ 文件系统事实判据。

    claims 新结构：{ "<id>": { "<identity>": "primary" | "<sideId>" } }；
    identity = TEMP_IDENTITY（临时）/ 相对 path（正式）/ name（兜底）。
    核心判据基于**文件系统事实**（旧文件还在不在），不用会变的值判断变没变。
    全部落 tempfile，不碰真实 .history。
    """

    UUID = "11111111-2222-4333-8444-555555555555"
    UUID2 = "99999999-8888-4777-8666-555555555555"
    G_BASE = {"nodes": [{"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 1}}], "links": []}

    def claims_path(self):
        return os.path.join(self.root, "workflows", ".history", hs.CLAIMS_FILE_NAME)

    def read_claims(self):
        with open(self.claims_path(), encoding="utf-8") as fh:
            return json.loads(fh.read())

    def make_file(self, rel):
        """在 user_dir 下真实建一个画布文件（驱动 missing 的文件系统判定）。"""
        abspath = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(abspath), exist_ok=True)
        with open(abspath, "w", encoding="utf-8") as fh:
            fh.write("{}")
        return abspath

    # ① 有 id → 键 = id；首次认领登记 primary（新 claims 结构）
    def test_valid_id_yields_id_key(self):
        self.assertEqual(hs.history_key("画布A", self.UUID, self.root), self.UUID)
        self.assertEqual(self.read_claims()[self.UUID], {"画布A": "primary"})

    # ② 同 id 同 identity → 同键（幂等，不新增条目）
    def test_same_id_same_identity_same_key(self):
        k1 = hs.history_key("画布A", self.UUID, self.root)
        k2 = hs.history_key("画布A", self.UUID, self.root)
        self.assertEqual(k1, k2)
        self.assertEqual(k1, self.UUID)
        self.assertEqual(self.read_claims()[self.UUID], {"画布A": "primary"})

    # ③ 【核心验收】单张改名跟随：同 id，path 旧→新（真建/删文件）→ 两次键相同
    def test_single_rename_follows(self):
        old = "workflows/旧名.json"
        new = "workflows/新名.json"
        # 旧文件真实存在 → 首次认领（键 = id，primary）
        self.make_file(old)
        k1 = hs.history_key("旧名", self.UUID, self.root, old)
        self.assertEqual(k1, self.UUID)
        self.assertEqual(self.read_claims()[self.UUID], {old: "primary"})
        # 改名：删旧文件 + 建新文件（文件系统事实：旧文件消失、新文件在）
        os.remove(os.path.join(self.root, old))
        self.make_file(new)
        k2 = hs.history_key("新名", self.UUID, self.root, new)
        # 恰一个正式 path 消失 → 跟随：键不变
        self.assertEqual(k2, k1)
        # claims 里 primary 已挪到新 path（旧 path 删除）
        rec = self.read_claims()[self.UUID]
        self.assertEqual(rec, {new: "primary"})
        # 再次调用幂等
        self.assertEqual(hs.history_key("新名", self.UUID, self.root, new), k1)

    # ④ 【核心验收】临时 → 正式：同键（升级，不 mint）
    def test_temp_upgrade_follows(self):
        k1 = hs.history_key("临时画布", self.UUID, self.root, temporary=True)
        self.assertEqual(k1, self.UUID)
        self.assertEqual(self.read_claims()[self.UUID], {hs.TEMP_IDENTITY: "primary"})
        # 落地为正式 path → 键不变，primary 挪到正式 identity（TEMP 条目删除）
        k2 = hs.history_key("正式画布", self.UUID, self.root, "workflows/正式画布.json")
        self.assertEqual(k2, k1)
        self.assertEqual(self.read_claims()[self.UUID], {"workflows/正式画布.json": "primary"})
        # 后续正式态再调 → 仍 = id
        self.assertEqual(hs.history_key("正式画布", self.UUID, self.root, "workflows/正式画布.json"), self.UUID)

    # ⑤ 【核心验收】两张 live path（两文件都真实存在）→ 第二次 mint，幂等
    def test_two_live_paths_mint(self):
        pa = "workflows/画布A.json"
        pb = "workflows/画布B.json"
        self.make_file(pa)
        self.make_file(pb)  # 两个文件都真实存在（非改名，而是两张独立画布）
        k1 = hs.history_key("画布A", self.UUID, self.root, pa)
        self.assertEqual(k1, self.UUID)
        side = hs.history_key("画布B", self.UUID, self.root, pb)
        self.assertNotEqual(side, k1)
        self.assertTrue(hs.is_valid_uuid(side))
        # 幂等：同 side 再调 → 同 sideId
        self.assertEqual(hs.history_key("画布B", self.UUID, self.root, pb), side)
        # claims 记录：A=primary、B=sideId
        self.assertEqual(self.read_claims()[self.UUID], {pa: "primary", pb: side})

    # ⑥ 【核心验收】两次临时（名不同）→ 同键 = id
    def test_temp_name_change_same_key(self):
        k1 = hs.history_key("临时名甲", self.UUID, self.root, temporary=True)
        k2 = hs.history_key("临时名乙", self.UUID, self.root, temporary=True)
        self.assertEqual(k1, k2)
        self.assertEqual(k1, self.UUID)
        self.assertEqual(self.read_claims()[self.UUID], {hs.TEMP_IDENTITY: "primary"})

    # ⑦ 【核心验收】无 id → 名键（老行为，一字不改）
    def test_no_id_legacy(self):
        for bad in (None, "", "   ", "not-a-uuid", "12345678", 3):
            self.assertEqual(hs.history_key("我的 画布", bad, self.root), hs.sanitize_workflow_name("我的 画布"))
        # 无 id 不写 claims
        self.assertFalse(os.path.exists(self.claims_path()))

    # ⑧ id 键目录不存在 → 回退名键（兼容重排前/后）
    def test_resolve_falls_back_to_name_dir(self):
        name_dir = hs.history_dir(self.root, "画布A")
        os.makedirs(name_dir)
        # id 目录不存在、名目录在 → 回退名目录
        self.assertEqual(hs.resolve_history_dir(self.root, "画布A", self.UUID), name_dir)
        # 两者都不存在 → 返回 id 键目录（新写入按 id 落盘）
        id_dir = hs.history_dir(self.root, self.UUID)
        self.assertEqual(hs.resolve_history_dir(self.root, "画布B", self.UUID2), hs.history_dir(self.root, self.UUID2))
        # id 目录存在 → 优先 id（即便名目录也在）
        os.makedirs(id_dir)
        self.assertEqual(hs.resolve_history_dir(self.root, "画布A", self.UUID), id_dir)
        # 无 id → 名目录（老行为）
        self.assertEqual(hs.resolve_history_dir(self.root, "画布A", None), name_dir)

    # ⑨ claims 损坏 → 回退 id 键不炸（不覆盖损坏文件）
    def test_corrupt_claims_falls_back_to_id_key(self):
        os.makedirs(os.path.dirname(self.claims_path()), exist_ok=True)
        with open(self.claims_path(), "w", encoding="utf-8") as fh:
            fh.write("{ not json")
        self.assertEqual(hs.history_key("画布A", self.UUID, self.root), self.UUID)
        with open(self.claims_path(), encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "{ not json")
        # 非对象 JSON → 同样回退
        with open(self.claims_path(), "w", encoding="utf-8") as fh:
            fh.write("[1,2,3]")
        self.assertEqual(hs.history_key("画布A", self.UUID, self.root), self.UUID)

    # ⑩ 旧 claims 结构（{owner,paths}）→ 重置为空表，不炸；重新走新算法
    def test_legacy_claims_structure_reset(self):
        os.makedirs(os.path.dirname(self.claims_path()), exist_ok=True)
        with open(self.claims_path(), "w", encoding="utf-8") as fh:
            fh.write(json.dumps({self.UUID: {"owner": "画布A", "paths": {"画布A": "iso"}}}))
        # 视为空表 → 首次认领
        self.assertEqual(hs.history_key("画布A", self.UUID, self.root), self.UUID)
        self.assertEqual(self.read_claims()[self.UUID], {"画布A": "primary"})

    # ⑪ .meta.json 写入（id 键目录）
    def test_meta_file_written_for_id_dir(self):
        out = hs.commit({"workflow": "画布A", "graph": self.G_BASE, "promptId": "p1"}, self.root, self.UUID)
        self.assertTrue(out["ok"])
        self.assertEqual(os.path.basename(out["dir"]), self.UUID)
        meta_path = os.path.join(out["dir"], hs.META_FILE_NAME)
        self.assertTrue(os.path.isfile(meta_path))
        with open(meta_path, encoding="utf-8") as fh:
            meta = json.loads(fh.read())
        self.assertEqual(meta["id"], self.UUID)
        self.assertEqual(meta["name"], "画布A")
        self.assertIn("updatedAt", meta)
        # 名键老目录不写 .meta.json
        out2 = hs.commit({"workflow": "无 id 画布", "graph": self.G_BASE, "promptId": "p2"}, self.root)
        self.assertFalse(os.path.exists(os.path.join(out2["dir"], hs.META_FILE_NAME)))

    # 2026-10-24：meta 补 path —— 写入时带上传入的画布路径，供事后核对目录归属
    def test_meta_file_records_path(self):
        out = hs.commit({"workflow": "画布A", "graph": self.G_BASE, "promptId": "p1"},
                        self.root, self.UUID, path="workflows/A.json")
        self.assertTrue(out["ok"])
        with open(os.path.join(out["dir"], hs.META_FILE_NAME), encoding="utf-8") as fh:
            meta = json.loads(fh.read())
        self.assertEqual(meta.get("path"), "workflows/A.json")
        # 不传 path → 不带该字段（不凭空造 path）
        out2 = hs.commit({"workflow": "画布B", "graph": self.G_BASE, "promptId": "p2"},
                         self.root, self.UUID2)
        with open(os.path.join(out2["dir"], hs.META_FILE_NAME), encoding="utf-8") as fh:
            meta2 = json.loads(fh.read())
        self.assertNotIn("path", meta2)

    # ⑫ 向后兼容：workflow_id 缺省 → 落名键目录（与改前完全一致）
    def test_default_no_workflow_id_writes_name_dir(self):
        out = hs.commit({"workflow": "我的 画布", "graph": self.G_BASE, "promptId": "p1"}, self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(out["dir"], hs.history_dir(self.root, "我的 画布"))
        self.assertFalse(os.path.exists(self.claims_path()))
        self.assertTrue(os.path.isfile(os.path.join(out["dir"], hs.INDEX_FILE_NAME)))

    # ⑬ 多张同时消失（不止一个 missing）→ 不跟随（按首次/mint 处理，不丢数据）
    def test_multiple_missing_no_follow(self):
        pa = "workflows/A.json"
        pb = "workflows/B.json"
        self.make_file(pa)
        self.make_file(pb)
        hs.history_key("A", self.UUID, self.root, pa)          # primary
        side = hs.history_key("B", self.UUID, self.root, pb)   # sideId
        # 两个文件都消失，再来一个新 path → 不跟随（避免误判），按 mint 处理
        os.remove(os.path.join(self.root, pa))
        os.remove(os.path.join(self.root, pb))
        k = hs.history_key("C", self.UUID, self.root, "workflows/C.json")
        self.assertNotEqual(k, self.UUID)
        self.assertNotEqual(k, side)
        self.assertTrue(hs.is_valid_uuid(k))

    # ⑭ resolve_history_dir 内部用新 history_key（改名后仍解析到同一 id 目录）
    def test_resolve_dir_follows_rename(self):
        old = "workflows/旧名.json"
        new = "workflows/新名.json"
        self.make_file(old)
        d1 = hs.resolve_history_dir(self.root, "旧名", self.UUID, path=old)
        os.makedirs(d1, exist_ok=True)  # 历史目录已落 id 键
        os.remove(os.path.join(self.root, old))
        self.make_file(new)
        d2 = hs.resolve_history_dir(self.root, "新名", self.UUID, path=new)
        self.assertEqual(d1, d2)
        self.assertEqual(os.path.basename(d1), self.UUID)

    # ⑯ 2026-10-24 护栏：该 id 已登记多条身份时，即使恰一个 path 消失也不判改名（改 mint）
    # 背景：多个工作流文件可共享同一 id（同源派生，例如 5 个 minimax_h3_* 共用 e3f2b845）。
    #       其中一个旧文件被删后，打开另一个文件会被误判成「改名跟随」接管 primary 目录，
    #       两段不同历史并进同一目录。取舍：宁可多拆一个目录，也不要误并。
    def test_multi_identity_never_follows(self):
        pa = "workflows/a.json"
        pb = "workflows/b.json"
        pc = "workflows/c.json"
        self.make_file(pa)
        self.make_file(pb)
        primary = hs.history_key("A", self.UUID, self.root, pa)   # primary（键 = id）
        side = hs.history_key("B", self.UUID, self.root, pb)      # mint sideId
        self.assertEqual(primary, self.UUID)
        self.assertNotEqual(side, self.UUID)
        # 删掉 a：恰一个正式 path 消失，但该 id 已有多条登记 → 护栏拦下，不走③
        os.remove(os.path.join(self.root, pa))
        self.make_file(pc)
        kc = hs.history_key("C", self.UUID, self.root, pc)
        self.assertNotEqual(kc, primary, "不该接管 primary（会误并两段历史）")
        self.assertNotEqual(kc, side)
        self.assertTrue(hs.is_valid_uuid(kc))
        rec = self.read_claims()[self.UUID]
        self.assertEqual(len(rec), 3)  # a(primary) + b(side) + c(新 side)
        self.assertEqual(rec[pc], kc)

    # ⑯ 对照：该 id 只有一条登记时，改名仍然跟随（护栏不误伤原有能力）
    def test_single_identity_still_follows(self):
        pa = "workflows/only.json"
        pb = "workflows/renamed.json"
        self.make_file(pa)
        k1 = hs.history_key("only", self.UUID, self.root, pa)
        self.assertEqual(k1, self.UUID)
        os.remove(os.path.join(self.root, pa))
        self.make_file(pb)
        k2 = hs.history_key("renamed", self.UUID, self.root, pb)
        self.assertEqual(k2, k1, "单条登记时必须继续跟随改名")
        self.assertEqual(self.read_claims()[self.UUID], {pb: "primary"})


class TestSeedSnapshot(TempRootTestCase):
    """2026-10-26：种子快照（改种子仍合并，但悬停能看到该提交最新的种子）。

    契约：索引行 seeds=[{title,name,value}]；value 字符串；无命中 → []；
    旧条目无该字段 → normalize_entry 补 None；list 读时用最新 merge 行的 seeds 覆盖主行。
    """

    WF = "wf"

    def graph(self, seed, steps=20, title=None):
        node = {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": seed, "steps": steps}}
        if title:
            node["title"] = title
        return {"nodes": [node], "links": []}

    def index_lines(self):
        path = os.path.join(self.root, "workflows", ".history", self.WF, hs.INDEX_FILE_NAME)
        with open(path, encoding="utf-8") as fh:
            return [json.loads(x) for x in fh.read().splitlines() if x.strip()]

    # ① 提取：named 命中 seed / noise_seed；位置型与无命中 → []
    def test_seed_values_extract(self):
        g = {"nodes": [
            {"id": 1, "type": "KSampler", "widgets_values_named": {"seed": 12345, "steps": 20}},
            {"id": 2, "type": "KSamplerAdvanced", "title": "二次采样",
             "widgets_values_named": {"noise_seed": 777, "add_noise": "enable"}},
        ]}
        self.assertEqual(hs._seed_values(g), [
            {"title": "KSampler", "name": "seed", "value": "12345"},
            {"title": "二次采样", "name": "noise_seed", "value": "777"},
        ])
        # 位置型 widgets_values 无名字 → 不猜，不输出
        self.assertEqual(hs._seed_values({"nodes": [{"id": 1, "type": "KSampler", "widgets_values": [42, 20]}]}), [])
        # 无种子类 widget → []
        self.assertEqual(hs._seed_values({"nodes": [{"id": 1, "type": "LoadImage",
                                                   "widgets_values_named": {"image": "a.png"}}]}), [])
        # 非法入参不打挂
        self.assertEqual(hs._seed_values(None), [])
        self.assertEqual(hs._seed_values({"nodes": "x"}), [])

    # ② 值规范化：整数型 float 不出现小数尾巴；大整数不丢精度
    def test_seed_values_stringified(self):
        g = {"nodes": [{"id": 1, "type": "KSampler",
                        "widgets_values_named": {"seed": 12345.0}, "widgets_values": [12345.0]}]}
        self.assertEqual(hs._seed_values(g)[0]["value"], "12345")
        big = {"nodes": [{"id": 1, "type": "KSampler",
                          "widgets_values_named": {"seed": 1234567890123456789}}]}
        self.assertEqual(hs._seed_values(big)[0]["value"], "1234567890123456789")

    # ③ 新建节点：索引主行写 seeds
    def test_create_node_writes_seeds(self):
        out = self.commit({"workflow": self.WF, "graph": self.graph(12345), "promptId": "p1"})
        self.assertTrue(out["ok"])
        self.assertEqual(self.index_lines()[0]["seeds"],
                         [{"title": "KSampler", "name": "seed", "value": "12345"}])

    # ④ 三连：新建 → 只改种子合并 → 再只改种子合并；读回必须是第三次的种子
    def test_merge_override_latest_seed(self):
        r1 = self.commit({"workflow": self.WF, "graph": self.graph(111), "promptId": "p1"})
        r2 = self.commit({"workflow": self.WF, "graph": self.graph(222), "promptId": "p2"})
        r3 = self.commit({"workflow": self.WF, "graph": self.graph(333), "promptId": "p3"})
        self.assertFalse(r1["merged"])
        self.assertTrue(r2["merged"])
        self.assertTrue(r3["merged"])
        lines = self.index_lines()
        self.assertEqual(len(lines), 3)              # 1 主行 + 2 merge 行（索引仍只追加）
        self.assertNotIn("mergeInto", lines[0])      # 主行没被改写
        self.assertEqual(lines[1]["seeds"][0]["value"], "222")
        self.assertEqual(lines[2]["seeds"][0]["value"], "333")
        listed = hs.list_commits(self.WF, self.root)
        self.assertEqual(len(listed["entries"]), 1)  # merge 行不冒出来
        self.assertEqual(listed["entries"][0]["seq"], 1)
        self.assertEqual(listed["entries"][0]["seeds"],
                         [{"title": "KSampler", "name": "seed", "value": "333"}])

    # ⑤ 旧条目（无 seeds 字段）→ None；当时没种子（seeds:[]）→ []
    def test_legacy_missing_field_none(self):
        n = hs.normalize_entry({"seq": 1, "file": "0001-a.json", "promptId": "p1"})
        self.assertIn("seeds", n)
        self.assertIsNone(n["seeds"])
        self.assertEqual(hs.normalize_entry({"seq": 2, "seeds": []})["seeds"], [])

    # ⑥ build_index_line：meta 没 seeds → 不写该键（不补 null）
    def test_build_index_line_omits_absent_seeds(self):
        self.assertNotIn("seeds", json.loads(hs.build_index_line({"seq": 1})))
        self.assertEqual(json.loads(hs.build_index_line({"seq": 1, "seeds": []}))["seeds"], [])

    # ⑦ 合并行不带 seeds（旧数据）→ 不覆盖主行
    def test_merge_rows_without_seeds_do_not_override(self):
        path = os.path.join(self.root, "workflows", ".history", self.WF, hs.INDEX_FILE_NAME)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        rows = [
            {"seq": 1, "file": "0001-p1.json", "promptId": "p1", "at": "2026-10-26T00:00:00.000Z",
             "source": "user", "kind": "run", "seeds": [{"title": "KSampler", "name": "seed", "value": "1"}]},
            {"seq": 2, "mergeInto": 1, "promptId": "p2", "at": "2026-10-26T00:01:00.000Z",
             "kind": "run", "source": "user"},
        ]
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")
        listed = hs.list_commits(self.WF, self.root)
        self.assertEqual(len(listed["entries"]), 1)
        self.assertEqual(listed["entries"][0]["seeds"],
                         [{"title": "KSampler", "name": "seed", "value": "1"}])


if __name__ == "__main__":
    unittest.main(verbosity=2)
