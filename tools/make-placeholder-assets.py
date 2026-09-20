# -*- coding: utf-8 -*-
"""生成 ComfyUI-Hana 的占位图资产（纯标准库，无第三方依赖）。

产物：
  app/assets/icon.png    256x256   App 身份图标
  app/ui/assets/cover.png 640x400 卡片封面

绘制内容：深色底 + 三个“工作流节点”圆角方块 + 连线（呼应 ComfyUI 的节点画布）。
以 2x 超采样后盒式降采样做抗锯齿。可重复执行，幂等覆盖。
"""
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # D:\HanakoWorks\ComfyUI

BG_TOP = (24, 27, 36)       # 深夜蓝黑
BG_BOTTOM = (33, 38, 52)
NODE_STROKE = (124, 156, 198)   # 冷蓝
NODE_FILL = (44, 52, 72)
ACCENT = (232, 168, 124)    # 暖橙（ComfyUI 风格点缀）
WIRE = (110, 130, 160)


def blend(dst, src, a):
    return tuple(int(round(d + (s - d) * a)) for d, s in zip(dst, src))


def in_rounded_rect(x, y, rx0, ry0, rx1, ry1, r):
    if x < rx0 or x > rx1 or y < ry0 or y > ry1:
        return False
    cx = min(max(x, rx0 + r), rx1 - r)
    cy = min(max(y, ry0 + r), ry1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r + 1e-6


def in_disc(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def seg_hit(x, y, x0, y0, x1, y1, half):
    # 点到线段的距离 < half
    vx, vy = x1 - x0, y1 - y0
    wx, wy = x - x0, y - y0
    L2 = vx * vx + vy * vy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L2))
    px, py = x0 + t * vx, y0 + t * vy
    return (x - px) ** 2 + (y - py) ** 2 <= half * half


def render(w, h, nodes, wires, ss=2):
    """nodes: [(x0,y0,x1,y1,radius)] 相对坐标乘 w/h；wires 连接 nodes 中心。"""
    W, H = w * ss, h * ss
    px = []
    for yy in range(H):
        row = []
        ty = yy / (H - 1) if H > 1 else 0
        bg = blend(BG_TOP, BG_BOTTOM, ty)
        for xx in range(W):
            nx, ny = xx / W, yy / H
            c = bg
            # 连线（先画，节点覆盖其上）
            for (a, b) in wires:
                ax, ay = nodes[a][0], nodes[a][1]
                bx, by = nodes[b][0], nodes[b][1]
                ax = (ax + nodes[a][2]) / 2 * W
                ay = (ay + nodes[a][3]) / 2 * H
                bx = (bx + nodes[b][2]) / 2 * W
                by = (by + nodes[b][3]) / 2 * H
                if seg_hit(xx, yy, ax, ay, bx, by, 1.6 * ss):
                    c = blend(c, WIRE, 0.9)
            for (x0, y0, x1, y1, r) in nodes:
                RX0, RY0, RX1, RY1 = x0 * W, y0 * H, x1 * W, y1 * H
                R = r * min(W, H)
                if in_rounded_rect(xx, yy, RX0, RY0, RX1, RY1, R):
                    edge = (
                        in_rounded_rect(xx, yy, RX0, RY0, RX1, RY1, R)
                        and not in_rounded_rect(xx, yy, RX0 + 1.5 * ss, RY0 + 1.5 * ss,
                                                RX1 - 1.5 * ss, RY1 - 1.5 * ss, max(R - 1.5 * ss, 0))
                    )
                    c = blend(c, NODE_STROKE if edge else NODE_FILL, 1.0)
            # 点缀圆点（节点“端口”）
            for (x0, y0, x1, y1, r) in nodes:
                for (fx, fy) in ((x0, (y0 + y1) / 2), (x1, (y0 + y1) / 2)):
                    if in_disc(xx, yy, fx * W, fy * H, 2.6 * ss):
                        c = blend(c, ACCENT, 1.0)
            row.append(c)
        px.append(row)
    # 盒式降采样
    out = []
    for yy in range(h):
        row = []
        for xx in range(w):
            rs = gs = bs = n = 0
            for dy in range(ss):
                for dx in range(ss):
                    r, g, b = px[yy * ss + dy][xx * ss + dx]
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
    icon_nodes = [
        (0.10, 0.22, 0.42, 0.46, 0.14),
        (0.58, 0.14, 0.90, 0.38, 0.14),
        (0.34, 0.58, 0.66, 0.82, 0.14),
    ]
    icon_wires = [(0, 1), (0, 2), (1, 2)]
    write_png(app / "assets" / "icon.png", 256, 256, render(256, 256, icon_nodes, icon_wires))

    cover_nodes = [
        (0.06, 0.20, 0.24, 0.52, 0.10),
        (0.36, 0.10, 0.54, 0.42, 0.10),
        (0.66, 0.24, 0.84, 0.56, 0.10),
        (0.20, 0.62, 0.44, 0.94, 0.10),
        (0.58, 0.60, 0.82, 0.92, 0.10),
    ]
    cover_wires = [(0, 1), (1, 2), (0, 3), (3, 4), (2, 4), (1, 3)]
    write_png(app / "ui" / "assets" / "cover.png", 640, 400, render(640, 400, cover_nodes, cover_wires))

    print("written:", app / "assets" / "icon.png")
    print("written:", app / "ui" / "assets" / "cover.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
