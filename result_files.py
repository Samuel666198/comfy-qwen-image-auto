"""File operations restricted to the workbench's generated output directory."""
import asyncio
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import zipfile
from urllib.parse import quote

import folder_paths


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def resolve_file(descriptor, *, missing_ok=False):
    if not isinstance(descriptor, dict) or descriptor.get("type", "output") != "output":
        raise ValueError("只允许操作本节点的输出图片")
    name = descriptor.get("filename")
    subfolder = descriptor.get("subfolder", "")
    if not isinstance(name, str) or not name or any(c in name for c in '/\\:') \
            or Path(name).suffix.lower() not in IMAGE_SUFFIXES:
        raise ValueError("图片文件名无效")
    if not isinstance(subfolder, str) or ':' in subfolder:
        raise ValueError("图片目录无效")
    relative = PurePosixPath(subfolder.replace('\\', '/'))
    if relative.is_absolute() or not relative.parts or relative.parts[0] != 'qwen_auto' \
            or '..' in relative.parts:
        raise ValueError("只允许操作 output/qwen_auto 内的图片")
    output = Path(folder_paths.get_output_directory()).resolve()
    path = output
    for part in (*relative.parts, name):
        path /= part
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError("不允许操作符号链接或目录联接中的图片")
    if not path.resolve().is_relative_to(output / 'qwen_auto'):
        raise ValueError("图片路径超出允许范围")
    if path.exists() and not path.is_file():
        raise ValueError("目标不是图片文件")
    if not missing_ok and not path.is_file():
        raise FileNotFoundError("图片文件已丢失")
    return path


def validate_results(results):
    if not isinstance(results, list) or not results or len(results) > 10000:
        raise ValueError("请选择 1～10000 项作品")
    if any(not isinstance(item, dict) or not isinstance(item.get('id'), str) for item in results):
        raise ValueError("作品记录无效")
    return results


def result_files(item, history=False):
    if isinstance(item.get('versions'), list):
        if not item['versions'] or any(not isinstance(version, dict) or not isinstance(version.get('file'), dict)
                                       for version in item['versions']):
            raise ValueError("图片版本记录无效")
        if history:
            return [version['file'] for version in item['versions']]
        current = next((v for v in item['versions'] if v.get('id') == item.get('selectedVersionId')), None)
        return [current['file']] if current else []
    files = [file for file in (item.get('original'), item.get('upscaled')) if file is not None]
    if history:
        prior = item.get('upscaleHistory', [])
        if not isinstance(prior, list):
            raise ValueError("超分历史记录无效")
        files.extend(prior)
    if not files:
        raise ValueError("作品没有图片文件")
    return files


def file_metadata(files):
    """Return safe size and modification metadata for unique output images."""
    if not isinstance(files, list) or not files or len(files) > 10000:
        raise ValueError("请选择 1～10000 个文件")

    output = Path(folder_paths.get_output_directory()).resolve()
    outcomes = []
    seen = set()
    for index, descriptor in enumerate(files):
        try:
            path = resolve_file(descriptor)
            canonical = path.resolve()
            if canonical in seen:
                continue
            info = canonical.stat()
            relative = canonical.relative_to(output / 'qwen_auto')
            safe_file = {
                'filename': relative.name,
                'subfolder': PurePosixPath('qwen_auto', *relative.parts[:-1]).as_posix(),
                'type': 'output',
            }
            outcomes.append({
                'index': index,
                'file': safe_file,
                'size': info.st_size,
                'mtime': info.st_mtime_ns // 1_000_000,
            })
            seen.add(canonical)
        except ValueError as error:
            outcomes.append({'index': index, 'error': str(error)})
        except OSError:
            outcomes.append({'index': index, 'error': "图片文件读取失败"})
    return outcomes


def delete_results(results, keep_files=None):
    protected = {resolve_file(file, missing_ok=True) for file in (keep_files or [])}
    outcomes = []
    for item in validate_results(results):
        outcome = {'id': item['id'], 'ok': False, 'deleted': [], 'skipped': []}
        try:
            files = result_files(item, history=True)
            # Validate every associated file before deleting any file in this work.
            for file in files:
                resolve_file(file, missing_ok=True)
            for file in files:
                path = resolve_file(file, missing_ok=True)
                if path in protected:
                    outcome['skipped'].append(file)
                else:
                    path.unlink(missing_ok=True)
                    outcome['deleted'].append(file)
            outcome['ok'] = True
        except (ValueError, OSError) as error:
            outcome['error'] = str(error)
        outcomes.append(outcome)
    return {'results': outcomes}


def archive_title(value):
    title = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '_', str(value or 'qwen_image')).strip(' .')[:160]
    return title or 'qwen_image'


def build_archive(results, version):
    if version not in ('original', 'upscaled', 'all', 'current'):
        raise ValueError("下载版本无效")
    selected = []
    names = set()
    for item in validate_results(results):
        if version == 'current':
            files = result_files(item)
            if not files:
                raise ValueError("作品缺少当前版本")
            item = {**item, 'original': files[0]}
        requested = 'original' if version == 'current' else version
        variants = ('original', 'upscaled') if requested == 'all' else (requested,)
        for variant in variants:
            file = item.get(variant)
            if not file:
                if version != 'all':
                    raise ValueError(f"{archive_title(item.get('title'))} 没有所选版本")
                continue
            path = resolve_file(file)
            base = archive_title(item.get('title')) + ('' if version == 'current' else '_original' if variant == 'original' else '_upscaled')
            name = base + path.suffix.lower()
            counter = 2
            while name.casefold() in names:
                name = f'{base}_{counter}{path.suffix.lower()}'
                counter += 1
            names.add(name.casefold())
            selected.append((file, name))
    if not selected:
        raise ValueError("没有可下载的图片")
    fd, temporary = tempfile.mkstemp(prefix='qwen-download-', suffix='.zip')
    os.close(fd)
    try:
        # Images are already compressed; STORE avoids needless CPU and memory use.
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
            for file, name in selected:
                archive.write(resolve_file(file), name)
        return Path(temporary)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def register_routes():
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post('/qwen_auto/results/metadata')
    async def metadata(request):
        try:
            body = await request.json()
            if not isinstance(body, dict) or 'files' not in body:
                raise ValueError("请求格式无效")
            result = await asyncio.to_thread(file_metadata, body['files'])
            return web.json_response({'files': result})
        except (ValueError, TypeError, AttributeError, web.HTTPException) as error:
            return web.json_response({'error': str(error)}, status=400)

    @PromptServer.instance.routes.post('/qwen_auto/results/delete')
    async def delete(request):
        try:
            body = await request.json()
            result = await asyncio.to_thread(delete_results, body.get('results'), body.get('keep_files'))
            return web.json_response(result)
        except (ValueError, TypeError, AttributeError) as error:
            return web.json_response({'error': str(error)}, status=400)

    @PromptServer.instance.routes.post('/qwen_auto/results/download')
    async def download(request):
        temporary = None
        try:
            if request.content_type == 'application/x-www-form-urlencoded':
                form = await request.post()
                body = json.loads(form.get('payload', ''))
            else:
                body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("请求格式无效")
            filename = body.get('filename', 'qwen_images.zip')
            if not isinstance(filename, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}\.zip', filename):
                raise ValueError("压缩包文件名无效")
            temporary = await asyncio.to_thread(build_archive, body.get('results'), body.get('version', 'original'))
        except (ValueError, OSError, TypeError, AttributeError, web.HTTPException) as error:
            return web.json_response({'error': str(error)}, status=400)
        try:
            response = web.StreamResponse(headers={
                'Content-Type': 'application/zip',
                'Content-Disposition': f'attachment; filename="{filename}"; filename*=UTF-8\'\'{quote(filename)}',
                'Content-Length': str(temporary.stat().st_size),
            })
            await response.prepare(request)
            with temporary.open('rb') as source:
                while block := await asyncio.to_thread(source.read, 1024 * 1024):
                    await response.write(block)
            await response.write_eof()
            return response
        finally:
            temporary.unlink(missing_ok=True)
