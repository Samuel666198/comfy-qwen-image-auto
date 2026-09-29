"""Validate internal region references and composite masked edits without changing sampling."""
import json
import math
import stat
from pathlib import Path, PurePosixPath

import numpy as np
from PIL import Image, ImageFilter
import torch
import torch.nn.functional as F
import folder_paths


def resolve_region_file(descriptor):
    if not isinstance(descriptor, dict):
        raise ValueError("区域编辑图片描述无效")
    kind = descriptor.get('type', 'input')
    name = descriptor.get('name', '')
    # Existing refs use ComfyUI annotated names; accept only matching annotation.
    for suffix in ('input', 'output', 'temp'):
        if isinstance(name, str) and name.endswith(f' [{suffix}]'):
            if 'type' in descriptor and kind != suffix:
                raise ValueError("区域编辑图片类型不一致")
            kind = suffix
            name = name[:-(len(suffix) + 3)]
    if kind not in ('input', 'output', 'temp') or not isinstance(name, str) or ':' in name:
        raise ValueError("区域编辑图片路径无效")
    relative = PurePosixPath(name.replace('\\', '/'))
    if not relative.parts or relative.is_absolute() or '..' in relative.parts:
        raise ValueError("区域编辑图片路径无效")
    root = Path(getattr(folder_paths, f'get_{kind}_directory')()).resolve()
    path = root
    for part in relative.parts:
        path /= part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError("区域编辑不支持链接文件")
    if not path.resolve().is_relative_to(root) or not path.is_file():
        raise ValueError("区域编辑图片不在允许目录内")
    return path


def image_tensor(image):
    return torch.from_numpy(np.array(image, dtype=np.float32) / 255.0).unsqueeze(0)


def prepare_region(region_json, refs):
    if not region_json:
        return None
    try:
        region = json.loads(region_json)
    except (ValueError, TypeError) as error:
        raise ValueError("区域编辑数据无效") from error
    if not isinstance(region, dict) or region.get('mode') not in ('comments', 'mask'):
        raise ValueError("区域编辑模式无效")
    if not isinstance(refs, list) or not refs or len(refs) + 1 > 10:
        raise ValueError("区域编辑需要原图，且参考图与辅助图合计不能超过 10 张")
    source_path = resolve_region_file(region.get('source'))
    if source_path != resolve_region_file(refs[0]):
        raise ValueError("区域编辑来源必须是第一张参考图，请重新进入编辑")
    with Image.open(source_path) as source:
        source = source.convert('RGBA' if 'A' in source.getbands() or 'transparency' in source.info else 'RGB')
    with Image.open(resolve_region_file(region.get('auxiliary'))) as auxiliary:
        auxiliary = auxiliary.convert('RGB')
    width, height = source.size
    if region.get('width') != width or region.get('height') != height or auxiliary.size != source.size:
        raise ValueError("区域编辑尺寸与来源图片不一致，请重新标注")
    feather = region.get('feather', 0)
    if isinstance(feather, bool) or not isinstance(feather, (int, float)) or not math.isfinite(feather) or not 0 <= feather <= 64:
        raise ValueError("羽化范围必须为 0～64 像素")
    mask = None
    if region['mode'] == 'mask':
        # New edits upload the marked source and a separate grayscale matte.
        # Older saved drafts used the auxiliary itself as a black/white mask.
        mask_path = resolve_region_file(region['maskImage']) if region.get('maskImage') else None
        if mask_path:
            with Image.open(mask_path) as mask_source:
                mask_image = mask_source.convert('L')
        else:
            mask_image = auxiliary.convert('L')
        if mask_image.size != source.size:
            raise ValueError("蒙版尺寸与来源图片不一致，请重新标注")
        if mask_image.getextrema()[1] == 0:
            raise ValueError("蒙版为空，请先绘制要修改的区域")
        if feather:
            # Canvas preview uses CSS blur(feather / 2); PIL radius is its sigma.
            mask_image = mask_image.filter(ImageFilter.GaussianBlur(feather / 2))
        mask = image_tensor(mask_image).unsqueeze(-1)
    index = len(refs) + 1
    instruction = (f'\n区域编辑来源是 <image1>，原始尺寸 {width}×{height}。'
                   f'<image{index}> 是内部辅助图，不是新的编辑对象。')
    if region['mode'] == 'mask':
        if region.get('maskImage'):
            instruction += '辅助图是在原图上叠加的彩色区域标注，用于结合文字识别位置；按文字要求修改蒙版范围内的内容，不要将紫色涂抹、彩色笔迹或矩形框画入结果。'
        else:
            instruction += '旧版辅助图白色为需要修改的区域，黑色为保留区域。按文字要求编辑原图白色区域，保持其余内容不变。'
    else:
        instruction += '辅助图包含原图上的编号和位置标记。按对应编号的文字要求修改原图，不要把编号、框线或标记画入结果。'
    return {'source': image_tensor(source), 'auxiliary': image_tensor(auxiliary),
            'mask': mask, 'instruction': instruction, 'width': width, 'height': height}


def finish_region(generated, region):
    if region is None:
        return generated
    if generated.ndim != 4 or generated.shape[-1] not in (3, 4):
        raise ValueError("区域编辑输出必须为 RGB 或 RGBA 图片")
    if generated.shape[1:3] != (region['height'], region['width']):
        generated = F.interpolate(generated.movedim(-1, 1), size=(region['height'], region['width']),
                            mode='bilinear', align_corners=False).movedim(1, -1)
    if region['mask'] is None:
        return generated
    source = region['source'].to(device=generated.device, dtype=generated.dtype)
    mask = region['mask'].to(device=generated.device, dtype=generated.dtype)
    # RGB generation is opaque in the painted area; retain alpha from an RGBA
    # model output. Outside the mask the source remains exactly unchanged.
    if source.shape[-1] == 4 or generated.shape[-1] == 4:
        if source.shape[-1] == 3:
            source = torch.cat((source, torch.ones_like(source[..., :1])), dim=-1)
        if generated.shape[-1] == 3:
            generated = torch.cat((generated, torch.ones_like(generated[..., :1])), dim=-1)
    blended = source * (1 - mask) + generated * mask
    # Keep untouched pixels bit-exact, including fully transparent source pixels.
    blended = torch.where(mask == 0, source, blended)
    return blended
