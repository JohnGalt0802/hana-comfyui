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
        self.assertEqual(snap["schemaVersion"], 1)
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

    def test_blocks_passthrough_and_omitted(self):
        # P2-F2：带 blocks → 原样透传（同一对象引用，不拷贝不改写）；None → 不写该字段
        blocks = [{"name": "加载", "source": "group", "nodeIds": [3, 1, 2]}]
        snap = hs.build_snapshot({"nodes": [], "links": []}, blocks=blocks)
        self.assertIs(snap["blocks"], blocks)
        self.assertEqual(snap["blocks"][0]["nodeIds"], [3, 1, 2])
        self.assertNotIn("blocks", hs.build_snapshot({}))
        self.assertNotIn("blocks", hs.build_snapshot({}, blocks=None))
        # 非列表（畸形态，防御性）→ 不写该字段
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
        self.assertEqual(sorted(obj.keys()), ["at", "file", "linkCount", "nodeCount", "promptId", "seq", "source"])
        self.assertEqual(obj["file"], "0002-abcd.json")

    def test_build_index_line_blocks_summary(self):
        # P2-F2：索引行只写摘要（name + nodeCount），不写 nodeIds / source 全量
        line = hs.build_index_line(
            {"seq": 1, "file": "0001-a.json",
             "blocks": [
                 {"name": "加载", "source": "group", "nodeIds": [1, 2, 3]},
                 {"name": "采样", "source": "role", "nodeIds": [9, 8]},
             ]}
        )
        obj = json.loads(line)
        self.assertEqual(obj["blocks"], [{"name": "加载", "nodeCount": 3}, {"name": "采样", "nodeCount": 2}])
        # 畸形块（非对象）剔除；nodeCount 非法 → 0；blocks 非列表 → 字段不出现
        line2 = json.loads(hs.build_index_line({"blocks": ["bad", {"name": "x", "nodeCount": "y"}]}))
        self.assertEqual(line2["blocks"], [{"name": "x", "nodeCount": 0}])
        self.assertNotIn("blocks", json.loads(hs.build_index_line({"blocks": "bad"})))
        self.assertNotIn("blocks", json.loads(hs.build_index_line({})))

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
        self.assertEqual(snap["schemaVersion"], 1)
        self.assertEqual(snap["promptId"], "a3f9c2e1-9b7c-4d2e-8f01-234567890abc")
        self.assertEqual(snap["nodeCount"], 1)
        self.assertEqual(snap["graph"]["nodes"][0]["id"], 1)

    def test_commit_with_blocks_and_index_summary(self):
        # P2-F2：带 blocks 的提交 → 快照含 blocks 原样、索引行只含摘要（name+nodeCount）
        blocks = [
            {"name": "组1", "source": "group", "nodeIds": [1, 2]},
            {"name": "采样", "source": "role", "nodeIds": [7]},
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
        self.assertEqual(snap["blocks"], blocks)  # 原样落盘
        self.assertEqual(snap["schemaVersion"], 1)  # schemaVersion 不 bump
        with open(os.path.join(out["dir"], hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            entry = json.loads(fh.readline())
        self.assertEqual(entry["blocks"], [{"name": "组1", "nodeCount": 2}, {"name": "采样", "nodeCount": 1}])
        self.assertNotIn("nodeIds", json.dumps(entry))  # 索引行不写 nodeIds 全量
        # list_commits 读回：索引行摘要可见
        listed = hs.list_commits("wf", self.root)
        self.assertEqual(listed["entries"][0]["blocks"], entry["blocks"])

    def test_commit_without_blocks_reads_back_null(self):
        # P2-F2 兼容：不带 blocks 的提交（等价旧快照）→ 落盘无该字段；索引行也无；list 读回不报错。
        # （「读回 blocks:null」语义：查询端消费方对缺失字段按 null 处理——索引行本身是 JSON 对象，
        #   字段缺失即 JSON null 语义；这里验证缺失且不出错。）
        out = self.commit({"workflow": "旧", "promptId": "bbbbbbbb-2", "graph": {"nodes": [], "links": []}})
        self.assertTrue(out["ok"])
        with open(os.path.join(out["dir"], out["file"]), encoding="utf-8") as fh:
            snap = json.loads(fh.read())
        self.assertNotIn("blocks", snap)
        with open(os.path.join(out["dir"], hs.INDEX_FILE_NAME), encoding="utf-8") as fh:
            entry = json.loads(fh.readline())
        self.assertNotIn("blocks", entry)
        self.assertEqual(entry.get("blocks"), None)  # 缺失字段按 null 读回
        listed = hs.list_commits("旧", self.root)
        self.assertTrue(listed["ok"])
        self.assertEqual(listed["entries"][0].get("blocks"), None)

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
            json.dump({"schemaVersion": 1, "seq": 1, "graph": {"nodes": [], "links": []}}, fh)
        out = hs.list_commits("legacy", self.root)
        self.assertTrue(out["ok"])
        self.assertEqual(len(out["entries"]), 1)
        self.assertEqual(out["entries"][0].get("blocks"), None)  # 旧条目 → null 语义
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
        graphs = [{"nodes": [{"id": i, "w": "值-%d" % i}], "links": []} for i in range(10)]
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
                hs.build_snapshot(g, "pid%08d" % i, i + 1, fixed_at, "unknown"),
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
        self.commit({"workflow": "wf", "graph": {"nodes": [], "links": []}, "promptId": "aaaaaaaa-1"})
        self.commit({"workflow": "wf", "graph": {"nodes": [], "links": []}, "promptId": "bbbbbbbb-2"})
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
        for bad in ("..\\0001-a3f9c2e1.json", "..\evil.json", "sub/0001-a3f9c2e1.json", "..", "."):
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
