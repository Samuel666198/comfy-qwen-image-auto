"""Pure compatibility parsing for the Qwen panel's saved component state."""

import json
import math
import re


REF_MARKER = re.compile(r"\[\[qwen-ref:([^\]]+)\]\]")


def resolve_prompt_refs(prompt, refs, loaded_indices=None):
    """Replace stable reference IDs with the current Qwen <imageN> label."""
    positions = {item.get("id"): i for i, item in enumerate(refs[:10], 1)
                 if isinstance(item, dict) and isinstance(item.get("id"), str)}
    def replace(match):
        ref_id = match.group(1)
        index = positions.get(ref_id)
        if index is None:
            raise ValueError("提示词中的参考图标签已失效，请重新选择图片")
        if loaded_indices is not None and index not in loaded_indices:
            raise ValueError(f"提示词中的参考图 {index} 无法读取，请重新添加图片")
        if loaded_indices is not None and any(i not in loaded_indices for i in range(1, index)):
            raise ValueError(f"参考图 {index} 前有无法读取的图片，请重新添加后再生成")
        return f"<image{index}>"
    return REF_MARKER.sub(replace, prompt or "")


def pixel_budget_size(width_ratio, height_ratio, resolution):
    """Choose multiples of 32 near resolution squared at the requested ratio."""
    side = resolution if resolution and resolution > 0 else 1024
    width = side * math.sqrt(width_ratio / height_ratio)
    height = side * math.sqrt(height_ratio / width_ratio)
    return (max(64, int(round(width / 32) * 32)),
            max(64, int(round(height / 32) * 32)))


def parse_lora_rows(raw):
    try:
        values = json.loads(raw or "[]") if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return []
    if not isinstance(values, list):
        return []
    rows = []
    for item in values:
        if not isinstance(item, dict):
            continue
        try:
            strength = float(item.get("strength", item.get("lora_strength", 1)))
            if not math.isfinite(strength):
                strength = 1.0
        except (TypeError, ValueError):
            strength = 1.0
        rows.append({
            "name": str(item.get("name") or item.get("lora_name") or "").strip(),
            "strength": strength,
            "enabled": item.get("enabled") is not False,
        })
    return rows


def resolve_accelerators(raw, *, enable_te_speed=True, te_attention="kitchen_int8",
                         te_step_cache="te_predictor", te_reuse_threshold=0.06,
                         te_predictor_error_limit=0.08, cache_device="cpu",
                         cache_dtype="int8", status=None):
    if raw:
        try:
            source = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError):
            source = None
        if not isinstance(source, list):
            if status is not None:
                status.append("加速组件: 配置无效，已使用旧参数")
            source = None
    else:
        source = None
    if source is None:
        source = [
            {"type": "te_speed", "enabled": enable_te_speed, "config": {
                "attention": te_attention, "step_cache": te_step_cache,
                "reuse_threshold": te_reuse_threshold,
                "predictor_error_limit": te_predictor_error_limit,
            }},
            {"type": "kv_cache", "enabled": True, "config": {
                "device": cache_device, "dtype": cache_dtype,
            }},
        ]
    seen = set()
    cards = []
    for item in source:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind not in ("te_speed", "kv_cache") or kind in seen:
            if status is not None:
                status.append(f"加速组件: 已跳过未知或重复项 {kind}")
            continue
        seen.add(kind)
        config = item.get("config")
        cards.append({"type": kind, "enabled": item.get("enabled") is not False,
                      "config": config if isinstance(config, dict) else {}})
    return cards


def resolve_kv_cache(cards, *, cache_device="cpu", cache_dtype="int8"):
    """Resolve the Qwen model cache, including an explicit off for removed cards."""
    card = next((item for item in cards if item["type"] == "kv_cache"), None)
    if card is None or not card["enabled"]:
        return "off", "default"
    config = card["config"]
    device = config.get("device", cache_device)
    dtype = config.get("dtype", cache_dtype)
    if device not in ("auto", "gpu", "cpu", "off") or dtype not in ("default", "int8", "int4"):
        return "off", "default"
    return device, dtype
