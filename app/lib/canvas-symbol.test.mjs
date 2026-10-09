// app/lib/canvas-symbol.test.mjs — 画布语义层 T2：符号行/语义版本单测（自含 · 零依赖）
// 运行：node app/lib/canvas-symbol.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import assert from "node:assert";
import { SEMANTIC_REV, formatNodeSymbol } from "./canvas-symbol.mjs";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail += 1;
    const detail = e && e.stack ? String(e.stack).split("\n").slice(0, 3).join("\n      ") : String(e);
    console.log(`FAIL  ${name}\n      ${detail}`);
  }
}

test("规范形（题面示例）：#27 PrimitiveInt \"宽度\" = 1248", () => {
  assert.strictEqual(
    formatNodeSymbol({ id: 27, type: "PrimitiveInt", title: "宽度", widgets_values: [1248] }),
    '#27 PrimitiveInt "宽度" = 1248',
  );
});

test("各段按存在与否拼装：无 title / 无 widgets / 多值直接给数组", () => {
  assert.strictEqual(formatNodeSymbol({ id: 12, type: "KSampler", widgets_values: [42, "euler", 20] }), '#12 KSampler = [42,"euler",20]');
  assert.strictEqual(formatNodeSymbol({ id: 8, type: "SizeApply", title: "尺寸" }), '#8 SizeApply "尺寸"');
  assert.strictEqual(formatNodeSymbol({ id: 31, type: "SaveImage", title: "保存", widgets_values: ["ComfyUI"] }), '#31 SaveImage "保存" = "ComfyUI"');
  assert.strictEqual(formatNodeSymbol({ id: 7, type: "Note", title: "  ", widgets_values: [] }), "#7 Note"); // 空白 title 视为空；空数组不给值
});

test("值截断（>40 字符加 …）；id 缺失给 #?", () => {
  const s = formatNodeSymbol({ id: 1, type: "T", widgets_values: ["x".repeat(80)] });
  const valuePart = s.slice(s.indexOf(" = ") + 3);
  assert.strictEqual(valuePart.length, 41); // 40 字符 + …
  assert.ok(valuePart.endsWith("…"));
  assert.strictEqual(formatNodeSymbol({ type: "T" }), "#? T");
});

test("非对象 → 抛 Error；数字字符串 id 原样", () => {
  assert.throws(() => formatNodeSymbol(null), /node 非对象/);
  assert.throws(() => formatNodeSymbol("x"), /node 非对象/);
  assert.strictEqual(formatNodeSymbol({ id: "8", type: "T" }), "#8 T");
});

test("SEMANTIC_REV = s1", () => {
  assert.strictEqual(SEMANTIC_REV, "s1");
});

console.log(`\n${pass + fail} 个用例：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
