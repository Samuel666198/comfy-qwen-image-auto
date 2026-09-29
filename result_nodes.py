"""Persistent workbench results and isolated RTX post-processing."""
import copy
import math
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageOps

QUALITIES = ["LOW", "MEDIUM", "HIGH", "ULTRA"]


def emit_stage(unique_id, stage):
    """Never broadcast an unowned stage or guess from a queued prompt."""
    if unique_id is None:
        return
    try:
        from server import PromptServer
        server = PromptServer.instance
        running, _ = server.prompt_queue.get_current_queue()
        matches = [item for item in running if str(unique_id) in item[2]]
        if len(matches) != 1 or str(server.last_node_id) != str(unique_id):
            return
        item = matches[0]
        server.send_sync("qwen_stage", {
            "prompt_id": item[1], "node": str(unique_id), "stage": stage,
        }, item[3].get("client_id"))
    except (ImportError, AttributeError, IndexError, TypeError):
        # Direct calls and headless tests need no websocket server.
        return


def save_result_image(images, prefix, full_prompt=None, extra_pnginfo=None):
    from nodes import SaveImage
    saved = SaveImage().save_images(images, filename_prefix=prefix,
                                   prompt=full_prompt, extra_pnginfo=extra_pnginfo)
    files = saved["ui"]["images"]
    if not files:
        raise RuntimeError("图片保存失败：未返回输出文件")
    return {**files[0], "width": int(images.shape[2]), "height": int(images.shape[1])}


def make_result(images, snapshot, full_prompt=None, extra_pnginfo=None):
    result_id = str(uuid.uuid4())
    daily_name = datetime.now().strftime("qwen_image_%Y_%m_%d")
    # SaveImage obtains the next counter from existing files, including after restart.
    original = save_result_image(images, f"qwen_auto/{daily_name}", full_prompt, extra_pnginfo)
    counter = re.search(r"_(\d+)_\.png$", original["filename"])
    title = f"{daily_name}_{int(counter.group(1)) if counter else 1:02d}"
    return {"id": result_id, "title": title, "createdAt": int(time.time() * 1000),
            "original": original, "upscaled": None, "selectedVersion": "original",
            "snapshot": copy.deepcopy(snapshot),
            "workbenchContext": copy.deepcopy((extra_pnginfo or {}).get("qwen_operation"))}


def resolve_original(filename, subfolder):
    if not isinstance(filename, str) or not filename or Path(filename).name != filename \
            or any(c in filename for c in ("/", "\\", ":")):
        raise ValueError("原图文件名无效")
    output = Path(folder_paths.get_output_directory()).resolve()
    root = (output / "qwen_auto").resolve()
    if not root.is_relative_to(output):
        raise ValueError("qwen_auto 目录不能指向输出目录之外")
    path = (output / subfolder / filename).resolve()
    if not path.is_relative_to(root):
        raise ValueError("只允许读取 output/qwen_auto 内的原图")
    if not path.is_file():
        raise FileNotFoundError("原图文件已丢失，请重新生成")
    return path


class QwenImage21AutoUpscale:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "filename": ("STRING", {"default": ""}),
            "subfolder": ("STRING", {"default": "qwen_auto"}),
            "scale": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.01}),
            "quality": (QUALITIES, {"default": "ULTRA"}),
            "result_id": ("STRING", {"default": ""}),
        }, "optional": {"execution_token": ("STRING", {"default": "", "forceInput": True})},
            "hidden": {"full_prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO",
                      "unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "upscale"
    CATEGORY = "image/qwen/internal"
    OUTPUT_NODE = True

    def upscale(self, filename, subfolder, scale, quality, result_id,
                full_prompt=None, extra_pnginfo=None, unique_id=None, execution_token=""):
        if type(scale) not in (int, float) or not 1 <= scale <= 4 or not math.isfinite(scale):
            raise ValueError("RTX 倍率必须为 1～4 的有效数值，可输入小数")
        if quality not in QUALITIES:
            raise ValueError("RTX 质量档位无效")
        if not isinstance(result_id, str) or not result_id:
            raise ValueError("缺少原图结果 ID")
        path = resolve_original(filename, subfolder)
        from nodes import NODE_CLASS_MAPPINGS
        cls = NODE_CLASS_MAPPINGS.get("RTXVideoSuperResolution")
        if cls is None:
            raise RuntimeError("RTXVideoSuperResolution 未加载，请检查 RTX 节点安装")
        from comfy.model_management import throw_exception_if_processing_interrupted
        throw_exception_if_processing_interrupted()
        emit_stage(unique_id, "loading")
        with Image.open(path) as source:
            # RTX accepts RGB only. Drop alpha without changing the original file.
            pixels = np.array(ImageOps.exif_transpose(source).convert("RGB"), dtype=np.float32) / 255.0
        images = torch.from_numpy(pixels)[None,]
        # RTX is a V3 ComfyNode: execute is a classmethod and returns NodeOutput.args.
        result = cls.execute(images=images,
                             resize_type={"resize_type": "scale by multiplier", "scale": scale},
                             quality=quality)
        throw_exception_if_processing_interrupted()
        images = result.args[0] if hasattr(result, "args") else result[0]
        emit_stage(unique_id, "saving")
        throw_exception_if_processing_interrupted()
        file = save_result_image(images, f"qwen_auto/upscaled/{uuid.uuid4()}", full_prompt, extra_pnginfo)
        file.update(scale=scale, quality=quality)
        return {"ui": {"qwen_upscale": [{"resultId": result_id, "file": file,
                 "workbenchContext": copy.deepcopy((extra_pnginfo or {}).get("qwen_operation"))}]}, "result": (images,)}
