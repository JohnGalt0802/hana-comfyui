"""thumbs.py — 桥缩图端点后端（纯模块，可在 ComfyUI 环境外单测）。

干什么：把 ComfyUI 目录（output/temp/input）里的原图缩到 ≤w 像素、编码 WEBP，
并落到 `<user_dir>/.thumb-cache/<sha1>.webp` 磁盘缓存；命中缓存时直接返回文件字节
（先于解码原图，比每次重解码快）。

为什么需要：ComfyUI 的 `/view?preview=` 只压格式+质量、**不改分辨率**（2K 原图 → webp;75
仍 213KB），且无缓存头（每次重下）；而预览显示尺寸最多 720px。见
docs/方案-预览图降分辨率与缓存-20261014.md §1/§2。

安全：路径定位/校验规则**照抄** ComfyUI server.py 的 view_image ——
  · filename 拒绝 `/` 开头、拒绝含 `..`；
  · type 仅 output/temp/input（get_directory_by_type 返回 None 即非法）；
  · subfolder 用 os.path.commonpath 校验必须落在 output_dir 内，否则拒。
  本模块只读，不写原图。

缓存键：sha1(f"{filename}|{subfolder}|{type}|{mtime_ns}|{w}|{q}")——含原图 mtime，
  图变 → 键变 → 新缓存（旧缓存不误用）。
原子写：先写 .tmp 再 os.replace（同卷 rename，Windows 上亦原子）。
降级：目录懒创建；缓存写入失败静默（仍返回本次生成的字节）。

异常路径：统一抛 ThumbError(status, error)，由端点转成 JSON {ok:false,error}。
"""

from __future__ import annotations

import hashlib
import os
from io import BytesIO

try:
    from PIL import Image

    _PIL_ERR = None
except Exception as _exc:  # 脱离运行环境时的保护（正常部署 PIL 必装）
    Image = None
    _PIL_ERR = _exc

try:
    import folder_paths as _folder_paths

    _FP_ERR = None
except Exception as _exc:  # 脱离 ComfyUI 环境单独 import 时的保护
    _folder_paths = None
    _FP_ERR = _exc

CONTENT_TYPE = "image/webp"
# 缓存目录名（相对 user_dir）；`_history_user_dir()` 给的就是 user/default。
CACHE_DIR_NAME = ".thumb-cache"
# 缩图长边上限 = w 的倍数（thumbnail 的第二个参数，防止极端长图不缩）。
_MAX_H_FACTOR = 8
# 支持的图源类型（对齐 folder_paths.get_directory_by_type）
_VALID_TYPES = ("output", "temp", "input")


class ThumbError(Exception):
    """缩图端点错误：携带 HTTP 状态码与简短 error 串。"""

    def __init__(self, status, error):
        super().__init__(error)
        self.status = int(status)
        self.error = str(error)


def _resolve_source(filename, subfolder, type_name):
    """定位原图绝对路径。规则与 ComfyUI server.py 的 view_image 一致（照抄其校验）。"""
    if not filename:
        raise ThumbError(400, "missing_filename")
    if _folder_paths is None:
        raise ThumbError(500, "folder_paths_unavailable: %s" % (_FP_ERR,))
    # 安全：防止访问任意路径——拒绝对路径与上跳（对齐 view_image）。
    if filename[0] == "/" or ".." in filename:
        raise ThumbError(400, "invalid_filename")
    if type_name not in _VALID_TYPES:
        raise ThumbError(400, "invalid_type")
    base = _folder_paths.get_directory_by_type(type_name)
    if not base:
        raise ThumbError(400, "invalid_type")
    base = os.path.abspath(base)
    out_dir = base
    if subfolder:
        full_output_dir = os.path.join(base, subfolder)
        try:
            inside = os.path.commonpath((os.path.abspath(full_output_dir), base)) == base
        except ValueError:  # 跨盘等异常 → 视为越界
            inside = False
        if not inside:
            raise ThumbError(403, "invalid_subfolder")
        out_dir = full_output_dir
    path = os.path.join(out_dir, os.path.basename(filename))
    if not os.path.isfile(path):
        raise ThumbError(404, "image_not_found")
    return path


def _render(path, width, quality):
    """解码原图 → 只缩小不放大 → 编码 WEBP，返回字节。"""
    if Image is None:
        raise ThumbError(500, "PIL_unavailable: %s" % (_PIL_ERR,))
    try:
        with Image.open(path) as img:
            if img.mode not in ("RGB", "RGBA"):
                has_alpha = "A" in img.getbands() or (
                    img.mode in ("P", "LA") and "transparency" in img.info
                )
                img = img.convert("RGBA" if has_alpha else "RGB")
            # thumbnail 只缩小、不放大：原图已小于 w 时保持原尺寸。
            img.thumbnail((width, width * _MAX_H_FACTOR), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="WEBP", quality=quality)
            return buf.getvalue()
    except ThumbError:
        raise
    except Exception as exc:  # PIL 解码/编码失败
        raise ThumbError(500, "decode_failed: %s" % exc)


def _cache_write(cache_path, data):
    """原子写缓存（.tmp → os.replace）；任何 OSError 静默降级。"""
    tmp = "%s.%d.tmp" % (cache_path, os.getpid())
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, cache_path)
    except OSError:
        try:
            if os.path.isfile(tmp):
                os.remove(tmp)
        except OSError:
            pass


def make_thumb(filename, subfolder="", type_name="output", width=720, quality=72, user_dir=None):
    """缩图主入口。

    参数：filename 必填；subfolder 可空；type_name ∈ output/temp/input；width 目标像素宽；
          quality WEBP 质量；user_dir 缓存根目录（通常为 <user_dir>）。签名对端点友好。
    返回：(bytes, content_type, cache_hit)；异常抛 ThumbError。
    """
    if not filename:
        raise ThumbError(400, "missing_filename")
    try:
        width = int(width)
    except (TypeError, ValueError):
        raise ThumbError(400, "invalid_width")
    try:
        quality = int(quality)
    except (TypeError, ValueError):
        raise ThumbError(400, "invalid_quality")
    if width <= 0:
        raise ThumbError(400, "invalid_width")
    if not 1 <= quality <= 100:
        raise ThumbError(400, "invalid_quality")

    subfolder = subfolder or ""
    type_name = type_name or "output"
    path = _resolve_source(filename, subfolder, type_name)

    try:
        mtime_ns = os.stat(path).st_mtime_ns
    except OSError as exc:
        raise ThumbError(500, "stat_failed: %s" % exc)

    cache_path = None
    if user_dir:
        key = hashlib.sha1(
            ("%s|%s|%s|%d|%d|%d" % (filename, subfolder, type_name, mtime_ns, width, quality)).encode("utf-8")
        ).hexdigest()
        cache_path = os.path.join(user_dir, CACHE_DIR_NAME, key + ".webp")
        # 命中：直接读文件（先于解码原图）。
        if os.path.isfile(cache_path):
            try:
                with open(cache_path, "rb") as fh:
                    data = fh.read()
                if data:
                    return data, CONTENT_TYPE, True
            except OSError:
                pass  # 读缓存失败 → 走正常生成

    data = _render(path, width, quality)
    if cache_path:
        _cache_write(cache_path, data)  # 写失败静默降级
    return data, CONTENT_TYPE, False
