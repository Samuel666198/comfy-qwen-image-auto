"""QwenImage21Auto — 单节点封装 Qwen Image 2.1 文生图 / 参考图编辑.

用法:
- 只填 prompt、不填参考图路径  -> 文生图 (自动按比例生成空白 latent)
- 填入 image_1_path ~ image_10_path 中的任一/多个 -> 图片编辑 / 参考图生图
  (文本框支持点击右侧文件浏览器选择, 也可直接把图片文件拖进文本框自动填路径)
- prompt 里用 <image1>..<image10> 引用对应参考图
- 可选接入多槽位 LoRA + TE-speed 文本编码器加速 (未安装时自动跳过并给出提示)

模型链路:
  UNETLoader -> [Lora1..4?] -> [TESpeedQwenImage21?]
             -> QwenImage21Cache -> KSampler -> VAEDecode -> IMAGE
"""

import sys
import os
import json
import inspect
from .result_nodes import QUALITIES, emit_stage, make_result
from .panel_config import parse_lora_rows, resolve_accelerators, resolve_kv_cache, resolve_prompt_refs, pixel_budget_size
from .region_edit import prepare_region, finish_region

import torch
import folder_paths
import comfy.samplers
from PIL import Image
import numpy as np


# ---------------------------------------------------------------------------
# 环境兜底: 新版 ComfyUI 默认开启"动态显存内存编译器"(comfy_aimdo / comfy 编译器,
#  CUDA graphs)。它在部分环境(尤其 int8 8B 模型 + 8GB 显存)下会在采样第一帧抛
#  "aimdo memory compile error"。这里在导入时关闭该编译器, 让它退回标准 PyTorch
#  内存路径, 保证 Qwen 采样稳定。仅影响内存编译优化, 不影响画质/参数。
#  若有 `--disable-comfy-compiler` 启动参数, 此处复用同一开关, 结果一致。
#  想保留该优化时, 把下面整段注释掉即可。
# ---------------------------------------------------------------------------
def _disable_comfy_compiler():
    try:
        import comfy.model_management as _mm
        from comfy import memory_management as _mem
        args = getattr(_mm, "args", None)
        if args is not None and not getattr(args, "disable_comfy_compiler", False):
            args.disable_comfy_compiler = True
            args.disable_cuda_graphs = True
        if getattr(_mem, "aimdo_enabled", False):
            _mem.aimdo_enabled = False
    except Exception:
        pass


_disable_comfy_compiler()


# ---------------------------------------------------------------------------
# 工具:把不同风格节点的返回值统一成列表 (io.NodeOutput / 老式 tuple)
# ---------------------------------------------------------------------------
def _as_list(result):
    """兼容 io.NodeOutput(.args) 与老式 tuple 返回值, 返回 value 列表."""
    if result is None:
        return []
    if hasattr(result, "args") and isinstance(result.args, tuple):
        return list(result.args)
    if isinstance(result, (tuple, list)):
        return list(result)
    return [result]


# ---------------------------------------------------------------------------
# 工具:按名称扫描已加载模块里的 TESpeedQwenImage21 (不写死安装路径)
# ---------------------------------------------------------------------------
def _find_class_in_modules(class_name):
    for name, mod in list(sys.modules.items()):
        if mod is None:
            continue
        try:
            cls = getattr(mod, class_name, None)
        except Exception:
            continue
        if isinstance(cls, type):
            return cls
    return None


def _call_node(cls, fn_name, **kwargs):
    """以 (实例, 方法名) 或 (类, classmethod execute) 的方式调用一个节点."""
    # 老式节点: FUNCTION 属性指向实例方法
    func = getattr(cls, "FUNCTION", None)
    if func:
        return getattr(cls(), func)(**kwargs)
    # 新式 io.ComfyNode: classmethod execute, 但只传签名里存在的参数
    execute = getattr(cls, "execute", None)
    if execute is None:
        raise RuntimeError(f"节点 {cls.__name__} 不支持 execute/FUNCTION")
    sig = inspect.signature(execute)
    params = set(sig.parameters)
    filtered = {k: v for k, v in kwargs.items() if k in params}
    return execute(**filtered)


# ---------------------------------------------------------------------------
# 负面提示词通用预设
# ---------------------------------------------------------------------------
NEGATIVE_PRESETS = {
    "不使用": "",
    "通用低质量": "低分辨率, 模糊, 明显噪点, 压缩伪影, 变形, 结构错误, 过度锐化, 过饱和, 水印",
    "人像增强": "面部扭曲, 五官错位, 手部畸形, 多余手指, 皮肤蜡像感, 过度磨皮, 表情僵硬",
    "文字排版": "错别字, 缺字, 重复文字, 字符变形, 文字模糊, 排版混乱, 低对比度",
    "商品展示": "商品变形, 比例错误, 反光过曝, 边缘模糊, 杂乱背景, 多余商品, 品牌文字错误",
    "自定义": "",
}
NEGATIVE_DEFAULT = "不使用"


# ---------------------------------------------------------------------------
# 画布比例 (宽:高)
# ---------------------------------------------------------------------------
ASPECT_RATIOS = ["auto", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "custom"]
RATIO_MAP = {
    "1:1": (1, 1), "4:3": (4, 3), "3:4": (3, 4),
    "16:9": (16, 9), "9:16": (9, 16),
    "3:2": (3, 2), "2:3": (2, 3), "21:9": (21, 9),
}


def _ratio_size(aspect_ratio, resolution):
    """按正方形等效像素预算和画幅计算宽高，均取 32 倍数。"""
    ratio = RATIO_MAP.get(aspect_ratio)
    if ratio is None:
        return None
    return pixel_budget_size(*ratio, resolution)


# ---------------------------------------------------------------------------
# 工具:从文件路径加载参考图 -> IMAGE 张量 (B,H,W,C) float [0,1]
# ---------------------------------------------------------------------------
def _load_image_file(path):
    path = (path or "").strip().strip('"').strip("'")
    if not path:
        return None
    if not os.path.isabs(path):
        # 相对路径相对 workfolder (comfyui/models 上一级通常即安装目录) 尝试解析
        cand = os.path.join(folder_paths.get_folder_paths("temp")[0], path)
        if os.path.exists(cand):
            path = cand
    if not os.path.isfile(path):
        return None
    img = Image.open(path)
    img = img.convert("RGB")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return torch.from_numpy(arr)[None,]  # 1,H,W,3


# ---------------------------------------------------------------------------
# 工具:解析面板持有的 JSON 列表; 解析失败/非列表返回 []
# ---------------------------------------------------------------------------
def _parse_json_list(s, status, what):
    s = (s or "").strip()
    if not s:
        return []
    try:
        v = json.loads(s)
    except Exception as e:
        status.append(f"{what}: JSON 解析失败 ({e})")
        return []
    return v if isinstance(v, list) else []


class QwenImage21Auto:
    """Qwen Image 2.1 单节点: 填参考图路径即编辑, 不填即文生图."""

    @classmethod
    def INPUT_TYPES(cls):
        lora_list = ["None"] + folder_paths.get_filename_list("loras")
        optional = {
            "negative_preset": (list(NEGATIVE_PRESETS),
                                {"default": NEGATIVE_DEFAULT,
                                 "tooltip": "选择预设或使用自定义排除内容。"}),
            # 前端自绘面板持有 (refs_json=参考图缩略图列表, lora_json=可增删替换 LoRA 列表)
            "refs_json": ("STRING", {"default": "[]", "multiline": False,
                                     "tooltip": "参考图缩略图列表 (由前端缩略图面板维护, 请勿手改)。"}),
            "lora_json": ("STRING", {"default": "[]", "multiline": False,
                                     "tooltip": "LoRA 列表 (由前端加速面板动态增/删/替换, 请勿手改)。"}),
            # 仅把本地 LoRA 文件名透传给前端下拉选择器, 值本身后端忽略
            "lora_list": (lora_list, {"default": "None"}),
            "enable_te_speed": ("BOOLEAN", {"default": True,
                                            "tooltip": "启用 TE-speed 文本编码器加速(Qwen-Image-Fast)。"}),
            "te_attention": ("STRING", {"default": "kitchen_int8"}),
            "te_step_cache": ("STRING", {"default": "te_predictor"}),
            "te_reuse_threshold": ("FLOAT", {"default": 0.06, "min": 0.0, "max": 1.0, "step": 0.01}),
            "te_predictor_error_limit": ("FLOAT", {"default": 0.08, "min": 0.0, "max": 1.0, "step": 0.01}),
            # 高级采样 (折叠)
            "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
            "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
            "resolution": ("INT", {"default": 1024, "min": 0, "max": 4096, "step": 32,
                                   "tooltip": "总像素预算为此数值的平方；画幅决定宽高。参考图编辑时用作参考图缩放预算，0 保留参考图原尺寸。"}),
            "cache_device": (["auto", "gpu", "cpu", "off"], {"default": "cpu",
                                 "tooltip": "KV 缓存设备。cpu=预取到内存(省显存)。off=每步重算(慢)。"}),
            "cache_dtype": (["default", "int8", "int4"], {"default": "int8"}),
            "accel_json": ("STRING", {"default": "", "multiline": False,
                                      "tooltip": "TE-speed 与模型缓存卡片状态，由前端维护；空值按旧参数执行。"}),
            "inference_preset": (["快速", "均衡", "精细", "自定义"], {"default": "均衡",
                                  "tooltip": "界面上的推理强度选择；实际采样步数以 steps 为准。"}),
            # 模型注入接口: 连了就替代内部加载器
            "model": ("MODEL",),
            "clip": ("CLIP",),
            "vae": ("VAE",),
            "rtx_scale": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.01}),
            "rtx_quality": (QUALITIES, {"default": "ULTRA"}),
            "execution_token": ("STRING", {"default": "", "forceInput": True}),
            "region_json": ("STRING", {"default": "", "forceInput": True}),
        }
        required = {
            "prompt": ("STRING", {"multiline": True}),
            "negative_prompt": ("STRING", {"multiline": True, "default": "",
                                           "tooltip": "仅在「负面预设」选「自定义」时生效; 选预设时由预设文本接管。"}),
            "unet_name": (folder_paths.get_filename_list("diffusion_models"),
                          {"default": "qwen_image_2.1_int8_convrot.safetensors"}),
            "clip_name": (folder_paths.get_filename_list("text_encoders"),
                          {"default": "qwen3vl_8b_int8_convrot.safetensors"}),
            "vae_name": (folder_paths.get_filename_list("vae"),
                         {"default": "qwen_image_2.1_vae_bf16.safetensors"}),
            "aspect_ratio": (ASPECT_RATIOS, {
                "default": "auto",
                "tooltip": "文生图画布比例。auto=按 resolution 基准; 选具体比例按其生成宽高(32倍数); custom=用下方 width/height。有参考图时忽略本比例。"}),
            "width": ("INT", {"default": 1024, "min": 32, "max": 4096, "step": 32,
                              "tooltip": "aspect_ratio=custom 时生效的固定宽度."}),
            "height": ("INT", {"default": 1024, "min": 32, "max": 4096, "step": 32,
                               "tooltip": "aspect_ratio=custom 时生效的固定高度."}),
            "steps": ("INT", {"default": 24, "min": 1, "max": 200}),
            "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.05}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF,
                             "control_after_generate": True}),
            "denoise": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            "show_advanced": ("BOOLEAN", {"default": False,
                                          "tooltip": "展开模型与采样技术参数；KV 缓存和 TE-speed 可在各自卡片设置。"}),
        }
        return {"required": required, "optional": optional,
                "hidden": {"full_prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO",
                           "unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ("IMAGE", "MODEL", "LATENT", "STRING")
    RETURN_NAMES = ("image", "model", "latent", "status")
    OUTPUT_NODE = True
    FUNCTION = "generate"
    CATEGORY = "image/qwen"

    def generate(self, prompt, negative_prompt, unet_name, clip_name, vae_name,
                 aspect_ratio, width, height, steps, cfg, seed, denoise, show_advanced,
                 negative_preset=NEGATIVE_DEFAULT,
                 refs_json="[]", lora_json="[]", lora_list="None", accel_json="",
                 inference_preset="均衡",
                 enable_te_speed=True,
                 te_attention="kitchen_int8", te_step_cache="te_predictor",
                 te_reuse_threshold=0.06, te_predictor_error_limit=0.08,
                 sampler_name="euler", scheduler="simple",
                 resolution=1024, cache_device="cpu", cache_dtype="int8",
                 model=None, clip=None, vae=None, rtx_scale=2, rtx_quality="ULTRA",
                 full_prompt=None, extra_pnginfo=None, unique_id=None, execution_token="", region_json=""):
        from nodes import (UNETLoader, CLIPLoader, VAELoader, KSampler, VAEDecode,
                           EmptyLatentImage, LoraLoaderModelOnly)
        from comfy_extras.nodes_qwen import TextEncodeQwenImage21, QwenImage21Cache

        snapshot = {key: value for key, value in locals().items()
                    if key in inspect.signature(self.generate).parameters
                    and key not in {"model", "clip", "vae", "full_prompt", "extra_pnginfo", "unique_id", "execution_token"}}
        snapshot["injected"] = {"model": model is not None, "clip": clip is not None, "vae": vae is not None}
        status = []
        emit_stage(unique_id, "loading")
        _disable_comfy_compiler()

        # ---- 参考图: 解析 refs_json 文件名列表, 生成 image_N 张量 dict ----
        refs = _parse_json_list(refs_json, status, "参考图")
        region = prepare_region(region_json, refs)
        images = {}
        for i, ref in enumerate(refs[:10], 1):
            if isinstance(ref, dict):
                name = (ref.get("name") or ref.get("filename") or "").strip()
            else:
                name = str(ref or "").strip()
            if not name:
                continue
            try:
                p = folder_paths.get_annotated_filepath(name)
            except Exception:
                p = name
            img = _load_image_file(p)
            if img is None:
                raise ValueError(f"参考图 {i}: 无法读取 {name}，请重新添加或移除后再生成")
            else:
                images[f"image_{i}"] = img
        prompt = resolve_prompt_refs(prompt, refs, {int(key.rsplit("_", 1)[1]) for key in images})
        if region is not None:
            images[f"image_{len(refs) + 1}"] = region['auxiliary']
            prompt += region['instruction']
        has_ref = bool(images)
        if has_ref:
            status.append(f"参考图: 已载入 {len(images)} 张")

        # ---- 负面提示词: 预设接管 / 自定义 ----
        preset = (negative_preset or NEGATIVE_DEFAULT)
        if preset != "自定义" and preset in NEGATIVE_PRESETS:
            neg = NEGATIVE_PRESETS[preset]
        else:
            neg = negative_prompt or ""

        # ---- 模型加载: 外部注入优先 ----
        if model is None:
            model = UNETLoader().load_unet(unet_name=unet_name, weight_dtype="default")[0]
        if clip is None:
            clip = CLIPLoader().load_clip(clip_name=clip_name, type="qwen_image", device="default")[0]
        if vae is None:
            vae = VAELoader().load_vae(vae_name=vae_name)[0]

        # ---- LoRA 列表: 解析 lora_json, 依次叠加 (可增/删/替换) ----
        lora_slots = parse_lora_rows(lora_json)
        applied_loras = []
        available_loras = set(folder_paths.get_filename_list("loras"))
        for idx, item in enumerate(lora_slots, 1):
            if not isinstance(item, dict):
                continue
            lname = item["name"]
            lstr = item["strength"]
            if not lname or lname == "None":
                continue
            if not item["enabled"]:
                status.append(f"LoRA{idx}: {lname} 已禁用")
                continue
            if lname not in available_loras:
                status.append(f"LoRA{idx}: 找不到 {lname}, 已跳过")
                continue
            try:
                model = LoraLoaderModelOnly().load_lora_model_only(
                    model=model, lora_name=lname, strength_model=lstr)[0]
                applied_loras.append(dict(item))
                status.append(f"LoRA{idx}: {lname} ×{lstr}")
            except Exception as e:
                status.append(f"LoRA{idx}: 加载失败, 已跳过 ({e})")

        # ---- 推理加速与模型缓存: 新配置优先；旧工作流沿用旧字段 ----
        accelerators = resolve_accelerators(
            accel_json, enable_te_speed=enable_te_speed,
            te_attention=te_attention, te_step_cache=te_step_cache,
            te_reuse_threshold=te_reuse_threshold,
            te_predictor_error_limit=te_predictor_error_limit,
            cache_device=cache_device, cache_dtype=cache_dtype, status=status)
        cards = {card["type"]: card for card in accelerators}
        # TE-speed 先包装模型；Qwen Prefix KV 缓存随后应用到最终模型。
        te_applied = False
        te_card = cards.get("te_speed")
        if te_card and te_card["enabled"]:
            te_config = te_card["config"]
            te_cls = _find_class_in_modules("TESpeedQwenImage21")
            if te_cls is None:
                status.append("TE-speed: 未安装节点包, 已跳过")
            else:
                try:
                    te_out = _call_node(
                        te_cls, "execute",
                        model=model,
                        attention=te_config.get("attention", te_attention),
                        step_cache=te_config.get("step_cache", te_step_cache),
                        start_percent=0, end_percent=0,
                        reuse_threshold=te_config.get("reuse_threshold", te_reuse_threshold),
                        predictor_error_limit=te_config.get("predictor_error_limit", te_predictor_error_limit),
                        verbose=False,
                    )
                    model = _as_list(te_out)[0]
                    te_applied = True
                    status.append("TE-speed: 已启用")
                except Exception as e:
                    status.append(f"TE-speed: 调用失败, 已跳过 ({e})")

        elif te_card:
            status.append("TE-speed: 已禁用")

        # 核心 Qwen 2.1 默认使用 Prefix KV 缓存；仅跳过配置节点并不会关闭它。
        cache_device_effective, cache_dtype_effective = resolve_kv_cache(
            accelerators, cache_device=cache_device, cache_dtype=cache_dtype)
        kv_card = cards.get("kv_cache")
        if kv_card and kv_card["enabled"] and cache_device_effective == "off" \
                and kv_card["config"].get("device", cache_device) != "off":
            status.append("KV 缓存: 参数无效，已关闭")
        model = _as_list(QwenImage21Cache.execute(
            model=model, device=cache_device_effective, dtype=cache_dtype_effective))[0]
        status.append("KV 缓存: 已关闭" if cache_device_effective == "off"
                      else f"KV 缓存: {cache_device_effective}/{cache_dtype_effective}")

        emit_stage(unique_id, "encoding")
        # ---- 文本编码 + 参考图注入 ----
        te_out = _as_list(TextEncodeQwenImage21.execute(
            clip=clip, prompt=prompt, negative_prompt=neg,
            vae=vae, resolution=resolution, images=images))
        positive, negative, encode_latent = te_out[0], te_out[1], te_out[2]

        # ---- 画布: 比例 / 自定义 / auto ----
        if region is not None or (has_ref and aspect_ratio not in ("custom", "auto")):
            # 有参考图时尊重参考图原比例, 忽略 aspect_ratio (避免破坏对齐)
            latent = encode_latent
        elif aspect_ratio == "custom":
            latent = EmptyLatentImage().generate(width=width, height=height, batch_size=1)[0]
        elif aspect_ratio != "auto":
            w, h = _ratio_size(aspect_ratio, resolution)
            latent = EmptyLatentImage().generate(width=w, height=h, batch_size=1)[0]
            status.append(f"画布: {aspect_ratio} -> {w}×{h}")
        else:
            latent = encode_latent

        emit_stage(unique_id, "sampling")
        # ---- 采样 ----
        out_latent = KSampler().sample(
            model=model, seed=seed, steps=steps, cfg=cfg,
            sampler_name=sampler_name, scheduler=scheduler,
            positive=positive, negative=negative,
            latent_image=latent, denoise=denoise)[0]

        emit_stage(unique_id, "decoding")
        # ---- 解码 ----
        out_image = VAEDecode().decode(samples=out_latent, vae=vae)[0]
        out_image = finish_region(out_image, region)

        snapshot.update(prompt=prompt, negative_prompt=neg, refs=refs,
                        loaded_reference_indices=[int(key.rsplit("_", 1)[1]) for key in images],
                        applied_loras=applied_loras, te_speed_applied=te_applied,
                        effective_cache_device=cache_device_effective, effective_cache_dtype=cache_dtype_effective,
                        width=int(out_image.shape[2]), height=int(out_image.shape[1]))
        emit_stage(unique_id, "saving")
        record = make_result(out_image, snapshot, full_prompt, extra_pnginfo)
        return {"ui": {"qwen_result": [record]},
                "result": (out_image, model, latent, "\n".join(status) if status else "")}



NODE_CLASS_MAPPINGS = {
    "QwenImage21Auto": QwenImage21Auto,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "QwenImage21Auto": "Qwen Image 2.1 生图/编辑",
}
