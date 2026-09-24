# -*- coding: utf-8 -*-
"""生成 Hana-ComfyUI 的占位图资产（纯标准库，无第三方依赖）。· v2 简洁扁平版

产物：
  app/assets/icon.png     256x256  App 身份图标
  app/ui/assets/cover.png 640x400  卡片封面

设计：纯色 + 几何（节点方块 + 直线连线，呼应 ComfyUI 节点画布）；
小圆角、无点缀、无渐变。以 4x 超采样后盒式降采样做抗锯齿。可重复执行，幂等覆盖。
"""
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # D:\HanakoWorks\ComfyUI

BG = (30, 34, 43)             # 底色（深石板蓝）
NODE_FILL = (43, 52, 70)      # 普通节点填充
NODE_STROKE = (124, 156, 198)  # 节点描边 / 冷蓝
ACCENT = (232, 168, 124)      # 强调节点（暖橙）
WIRE = (109, 132, 168)        # 连线
SS = 4                        # 超采样倍率


def blend(dst, src, a):
    return tuple(int(round(d + (s - d) * a)) for d, s in zip(dst, src))


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r + 1e-6


def seg_hit(x, y, x0, y0, x1, y1, half):
    vx, vy = x1 - x0, y1 - y0
    wx, wy = x - x0, y - y0
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    px, py = x0 + t * vx, y0 + t * vy
    return (x - px) ** 2 + (y - py) ** 2 <= half * half


def center(n):
    x0, y0, x1, y1, _r, _style = n
    return ((x0 + x1) / 2, (y0 + y1) / 2)


def render(w, h, nodes, wires):
    """nodes: [(x0,y0,x1,y1,r,style)]，坐标为最终像素；wires: 节点下标对。"""
    W, H = w * SS, h * SS
    # 先算超采样坐标
    def sn(n):
        x0, y0, x1, y1, r, style = n
        return (x0 * SS, y0 * SS, x1 * SS, y1 * SS, r * SS, style)
    snodes = [sn(n) for n in nodes]
    swires = [(center(nodes[a]), center(nodes[b])) for a, b in wires]
    px = []
    for yy in range(H):
        row = []
        for xx in range(W):
            c = BG
            # 连线（先画，节点覆盖其上）
            for ((ax, ay), (bx, by)) in swires:
                if seg_hit(xx, yy, ax * SS, ay * SS, bx * SS, by * SS, 1.4 * SS):
                    c = blend(c, WIRE, 1.0)
            # 节点
            for (x0, y0, x1, y1, r, style) in snodes:
                if in_rounded_rect(xx, yy, x0, y0, x1, y1, r):
                    if style == "accent":
                        c = ACCENT
                    else:
                        edge = not in_rounded_rect(xx, yy, x0 + 1.0 * SS, y0 + 1.0 * SS,
                                                   x1 - 1.0 * SS, y1 - 1.0 * SS, max(r - 1.0 * SS, 0))
                        c = NODE_STROKE if edge else NODE_FILL
            row.append(c)
        px.append(row)
    # 盒式降采样
    out = []
    for yy in range(h):
        row = []
        for xx in range(w):
            rs = gs = bs = n = 0
            for dy in range(SS):
                for dx in range(SS):
                    r, g, b = px[yy * SS + dy][xx * SS + dx]
                    rs += r; gs += g; bs += b; n += 1
            row.append((rs // n, gs // n, bs // n))
        out.append(row)
    return out


def write_png(path, w, h, pixels):
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("BBB", *p) for p in row) for row in pixels
    )

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def main():
    app = ROOT / "app"

    # 图标 256×256：三个节点（右上强调），两条连线
    icon_nodes = [
        (46, 70, 112, 136, 10, "plain"),    # 左
        (150, 44, 216, 110, 10, "accent"),  # 右上
        (98, 150, 164, 216, 10, "plain"),   # 下中
    ]
    icon_wires = [(0, 1), (0, 2)]
    write_png(app / "assets" / "icon.png", 256, 256, render(256, 256, icon_nodes, icon_wires))

    # 封面 640×400：五节点两列流（中上强调），五条连线
    cover_nodes = [
        (54, 156, 136, 238, 12, "plain"),   # A 左
        (214, 84, 296, 166, 12, "accent"),  # B 中上
        (214, 250, 296, 332, 12, "plain"),  # C 中下
        (392, 84, 474, 166, 12, "plain"),   # D 右上
        (392, 250, 474, 332, 12, "plain"),  # E 右下
    ]
    cover_wires = [(0, 1), (0, 2), (1, 2), (1, 3), (2, 4)]
    write_png(app / "ui" / "assets" / "cover.png", 640, 400, render(640, 400, cover_nodes, cover_wires))

    print("written:", app / "assets" / "icon.png")
    print("written:", app / "ui" / "assets" / "cover.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
