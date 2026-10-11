// app/runtime/history-commit.mjs — 画布提交历史 P1-B1：提交快照落盘（纯逻辑模块 · 单文件）
// ─────────────────────────────────────────────────────────────────────────────
// 干什么：接收一次「提交上报」→ 把画布快照写成一个文件 + 追加一行 JSONL 索引。
//   POST /_relay/history/commit 请求体: { workflow, promptId, graph, at, source }
//   成功: { ok:true, seq, file, dir }；失败: { ok:false, error }
//
// 为什么抽成模块（而非写在中继里）：中继 app/runtime/comfy-relay.mjs 是「import 即监听端口」
//   的结构，直接 import 它会起服务；抽出来才能单测，也才不会在测试里碰用户真实数据。
//   中继只负责注册路由、读 body、解析工作流目录，然后调用本模块。
//
// 返回值口径：本模块统一返回带 `status` 的结果对象（200/400/413/500），由调用方拆出
//   status 作 HTTP 码、其余字段作响应体——响应体形态与上述契约逐字对应（不多字段）。
//
// 落盘通道：复用共享的 writeFileAtomic（.tmp → rename 原子写，见 app/workflow-file.mjs）。
//   本模块不改 writeFileAtomic / workflow-file.mjs（app 侧也在用，影响面更大）；
//   「目录不存在自建」只收口在本端点路径内（mkdirSync recursive，写之前）。
// 体积防护：序列化后 > MAX_SNAPSHOT_BYTES（14 MiB，写上限 16 MiB 留裕量）→ 不写盘，返回 413 语义。
//
// 依赖：app/lib/canvas-history.mjs（纯逻辑，命名/构造/索引，已通过 37 项单测）+ 共享原子写。
// ─────────────────────────────────────────────────────────────────────────────
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIndexLine,
  buildSnapshot,
  historyDir,
  nextSeq,
  parseIndex,
  snapshotFileName,
} from "../lib/canvas-history.mjs";
import { writeFileAtomic } from "../workflow-file.mjs";

// 单份快照序列化后上限（写上限 16 MiB 留 ~2 MiB 裕量）
export const MAX_SNAPSHOT_BYTES = 14 * 1024 * 1024;
// 索引文件名（JSONL，一行一条；追加写，绝不读全文重写）
export const INDEX_FILE_NAME = "index.jsonl";

const msgOf = (e) => String((e && e.message) || e);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 处理一次提交上报：写快照 + 追加索引行。
 * @param {object} body  { workflow, promptId?, graph, at?, source? }
 * @param {{workflowsDir?: string}} opts
 * @returns {{status:number, ok:boolean, seq?:number, file?:string, dir?:string, error?:string, size?:number}}
 */
export function handleHistoryCommit(body, { workflowsDir } = {}) {
  const b = isObj(body) ? body : {};
  const workflow = typeof b.workflow === "string" ? b.workflow.trim() : "";
  if (!workflow) return { ok: false, status: 400, error: "需要 workflow（工作流名）" };
  if (!isObj(b.graph)) return { ok: false, status: 400, error: "需要 graph（画布快照对象）" };
  if (typeof workflowsDir !== "string" || !workflowsDir.trim()) {
    return { ok: false, status: 500, error: "无法解析 ComfyUI 工作流目录（安装探测未就绪？）" };
  }

  const promptId = b.promptId == null ? null : String(b.promptId);
  const dir = historyDir(workflowsDir, workflow);
  const indexPath = join(dir, INDEX_FILE_NAME);

  // 读已有索引（不存在当空处理；容错解析交给 parseIndex）
  let entries = [];
  try {
    if (existsSync(indexPath)) {
      entries = parseIndex(readFileSync(indexPath, "utf8")).entries;
    }
  } catch (e) {
    return { ok: false, status: 500, error: `读取索引失败：${msgOf(e)}` };
  }

  const seq = nextSeq(entries);
  const fileName = snapshotFileName(seq, promptId);
  const absFile = join(dir, fileName);

  const snapshot = buildSnapshot({ graph: b.graph, promptId, seq, at: b.at, source: b.source });
  let text;
  try {
    text = JSON.stringify(snapshot);
  } catch (e) {
    return { ok: false, status: 400, error: `快照序列化失败：${msgOf(e)}` };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SNAPSHOT_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `快照超过 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)} MiB 上限（${bytes} 字节）`,
      size: bytes,
    };
  }

  // 索引行（不含 graph；字段取自 snapshot，保证与落盘快照一致）
  const line = buildIndexLine({
    seq,
    file: fileName,
    promptId: snapshot.promptId,
    at: snapshot.at,
    source: snapshot.source,
    nodeCount: snapshot.nodeCount,
    linkCount: snapshot.linkCount,
  });

  // 目录不存在就递归创建（收口在本端点路径内；写之前确保存在）
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, status: 500, error: `创建历史目录失败：${msgOf(e)}` };
  }

  // 快照落盘（原子写 .tmp → rename）
  try {
    writeFileAtomic(absFile, text);
  } catch (e) {
    return { ok: false, status: 500, error: `写入快照失败：${msgOf(e)}` };
  }

  // 追加一行索引（追加写；禁止读全文重写整份索引）
  try {
    appendFileSync(indexPath, `${line}\n`);
  } catch (e) {
    return { ok: false, status: 500, error: `追加索引失败：${msgOf(e)}`, seq, file: fileName, dir };
  }

  return { ok: true, status: 200, seq, file: fileName, dir };
}
