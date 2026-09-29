"""Local Ollama prompt rewriting; never installs models or changes generation settings."""
import asyncio
import base64
import codecs
import ipaddress
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
from urllib.parse import urlsplit

import aiohttp
import folder_paths
from PIL import Image

_operation_lock = asyncio.Lock()
_config_lock = threading.Lock()
PROMPTS = Path(__file__).parent / 'prompts'
MODULES = ('text_in_image', 'graphic_layout', 'style_transfer', 'localized_edit', 'reference_composition')
MODULE_LABELS = {
    'text_in_image': '画面文字', 'graphic_layout': '设计排版', 'style_transfer': '风格转换',
    'localized_edit': '局部修改', 'reference_composition': '多图组合',
}
DEFAULT_RESPONSES_URL = 'https://api.deepseek.com'


def optimizer_config_path():
    user_directory = getattr(folder_paths, 'get_user_directory', None)
    if callable(user_directory):
        root = Path(user_directory())
    elif getattr(folder_paths, 'user_directory', None):
        root = Path(folder_paths.user_directory)
    else:
        module_path = getattr(folder_paths, '__file__', None)
        root = (Path(module_path).resolve().parent / 'user' if module_path
                else Path(__file__).resolve().parents[2] / 'user')
    root.mkdir(parents=True, exist_ok=True)
    return root / 'qwen_image_auto_prompt_optimizer.json'


def read_api_config():
    path = optimizer_config_path()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError, TypeError):
        raise ValueError('本机提示词优化配置无法读取，请检查 ComfyUI user 目录') from None
    if not isinstance(data, dict):
        raise ValueError('本机提示词优化配置格式无效')
    return {'base_url': normalize_api_url(data.get('base_url', DEFAULT_RESPONSES_URL)),
            'api_key': data.get('api_key', '') if isinstance(data.get('api_key', ''), str) else ''}


def write_api_config(base_url, api_key):
    value = {'base_url': normalize_api_url(base_url), 'api_key': api_key}
    path = optimizer_config_path()
    temp_name = None
    with _config_lock:
        try:
            with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                             prefix='.qwen-prompt-', suffix='.tmp', delete=False) as stream:
                temp_name = stream.name
                json.dump(value, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp_name, path)
        except OSError:
            if temp_name:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass
            raise ValueError('无法保存本机 API 配置，请检查 ComfyUI user 目录权限') from None


def normalize_api_url(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 2048:
        raise ValueError('请填写 Responses API 服务地址')
    value = value.strip().rstrip('/')
    parsed = urlsplit(value)
    if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('API 地址必须是有效的 HTTPS 地址（本机服务可使用 HTTP）')
    try:
        parsed.port
        host = parsed.hostname.encode('idna').decode('ascii').lower()
    except (ValueError, UnicodeError):
        raise ValueError('API 地址格式无效') from None
    if parsed.scheme == 'http':
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host == 'localhost'
        if not loopback:
            raise ValueError('远程 Responses API 必须使用 HTTPS')
    # Base URL may include a provider prefix such as /v1, but not a specific endpoint.
    if parsed.path.endswith(('/responses', '/models')):
        raise ValueError('请填写 API 基础地址，不要附加 /responses 或 /models')
    return value


def api_key_value(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(char) < 32 for char in value):
        raise ValueError('API 密钥格式无效')
    return value.strip()


def local_address(value):
    value = value or 'http://127.0.0.1:11434'
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Ollama 地址必须是本机 HTTP 服务地址')
    host = parsed.hostname or ''
    if host == 'localhost':
        host = '127.0.0.1'
    try:
        if not ipaddress.ip_address(host).is_loopback:
            raise ValueError()
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    except ValueError:
        raise ValueError('Ollama 仅支持本机回环地址') from None
    host = f'[{host}]' if ':' in host else host
    return f'{parsed.scheme}://{host}:{port}'


async def call(session, address, endpoint, body=None, timeout=30):
    async with session.request('GET' if body is None else 'POST', address + endpoint,
                               json=body, allow_redirects=False,
                               timeout=aiohttp.ClientTimeout(total=timeout)) as response:
        if response.status != 200:
            raise ValueError(f'Ollama 请求失败（HTTP {response.status}）')
        data = await response.json()
        if data.get('error'):
            raise ValueError(str(data['error'])[:500])
        return data


async def list_models(session, address):
    tags = await call(session, address, '/api/tags')
    models = []
    for item in tags.get('models', []):
        name = item.get('name')
        if not name:
            continue
        info = await call(session, address, '/api/show', {'model': name})
        caps = info.get('capabilities', [])
        if 'completion' not in caps or info.get('remote_model') or info.get('remote_host'):
            continue
        models.append({'name': name, 'size': item.get('size'), 'capabilities': caps,
                       'thinking': info.get('thinking', {})})
    return models


def reference_files(refs):
    if not isinstance(refs, list) or len(refs) > 10:
        raise ValueError('参考图最多 10 张')
    images = []
    for ref in refs:
        if not isinstance(ref, dict):
            raise ValueError('参考图记录无效')
        name = ref.get('name', '')
        if not isinstance(name, str) or not name:
            raise ValueError('参考图名称无效')
        # Same annotated name convention as the node, constrained to Comfy image roots.
        kind = ref.get('type')
        if kind is not None and kind not in ('input', 'output', 'temp'):
            raise ValueError('参考图类型无效')
        if kind:
            name = re.sub(r'\s+\[(?:input|output|temp)\]$', '', name)
            name = f'{name} [{kind}]'
        path = Path(folder_paths.get_annotated_filepath(name))
        roots = [Path(folder_paths.get_input_directory()).resolve(),
                 Path(folder_paths.get_output_directory()).resolve(),
                 Path(folder_paths.get_temp_directory()).resolve()]
        absolute = path.absolute()
        root = next((root for root in roots if absolute.is_relative_to(root)), None)
        if root is None or not path.resolve().is_relative_to(root):
            raise ValueError('参考图路径超出 ComfyUI 图片目录')
        part = root
        for segment in absolute.relative_to(root).parts:
            part /= segment
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('参考图不允许使用链接路径')
        if not path.is_file() or path.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp', '.bmp'):
            raise ValueError('参考图片不存在或格式不支持')
        if path.stat().st_size > 25 * 1024 * 1024:
            raise ValueError('单张参考图片不能超过 25 MB')
        images.append(path)
    return images


def reference_images(refs):
    return [base64.b64encode(path.read_bytes()).decode('ascii') for path in reference_files(refs)]


def reference_data_urls(refs):
    images = []
    paths = reference_files(refs)
    if sum(path.stat().st_size for path in paths) > 45 * 1024 * 1024:
        raise ValueError('API 参考图总量不能超过 45 MiB')
    for path in paths:
        if path.stat().st_size > 20 * 1024 * 1024:
            raise ValueError('API 单张参考图不能超过 20 MiB')
        mime = mimetypes.guess_type(path.name)[0]
        data = path.read_bytes()
        if path.suffix.lower() == '.bmp':
            try:
                converted = io.BytesIO()
                with Image.open(io.BytesIO(data)) as image:
                    image.save(converted, format='PNG')
                data, mime = converted.getvalue(), 'image/png'
            except (OSError, ValueError):
                raise ValueError('BMP 参考图无法转换为 API 支持的 PNG 格式') from None
        if mime not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif'):
            raise ValueError(f'当前 API 不支持参考图格式：{path.suffix or "未知"}')
        images.append(f'data:{mime};base64,{base64.b64encode(data).decode("ascii")}')
    return images


def rewritten_text(content, reference_count):
    text = re.sub(r'<think>.*?</think>', '', content or '', flags=re.S).strip()
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text).strip()
    try:
        result = json.loads(text)
    except (ValueError, TypeError):
        raise ValueError('模型未返回有效的优化结果，请尝试其他模型或增加输出长度') from None
    prompt = result.get('rewritten_prompt') if isinstance(result, dict) else None
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('模型返回的提示词为空')
    if any(not 1 <= int(index) <= reference_count for index in re.findall(r'<image(\d+)>', prompt)):
        raise ValueError('模型返回了不存在的图片引用')
    return prompt.strip()


def reply_text(message, think, reference_count):
    content = message.get('content', '')
    # Some local Qwen templates route a no-thinking JSON answer into `thinking`.
    # Accept only the complete answer object; never use free-form reasoning as a prompt.
    if not content.strip() and think is False:
        try:
            answer = json.loads(message.get('thinking', ''))
        except (ValueError, TypeError):
            answer = None
        if isinstance(answer, dict) and isinstance(answer.get('rewritten_prompt'), str):
            content = json.dumps(answer)
    return rewritten_text(content, reference_count)


def route_modules(message):
    content = message.get('content', '')
    if not content.strip():
        content = message.get('thinking', '')
    try:
        value = json.loads(content)
    except (ValueError, TypeError):
        return []
    modules = value.get('modules') if isinstance(value, dict) else None
    if not isinstance(modules, list):
        return []
    selected = set(item for item in modules if isinstance(item, str) and item in MODULES)
    return [item for item in MODULES if item in selected]


def rewrite_system_prompt(task, modules, reference_count, prompt_length=None):
    parts = [(PROMPTS / f'optimizer_{task}_core.txt').read_text(encoding='utf-8')]
    if reference_count > 1 and 'reference_composition' not in modules:
        modules = [*modules, 'reference_composition']
    for module in modules:
        parts.append((PROMPTS / 'modules' / f'{module}.txt').read_text(encoding='utf-8'))
    if isinstance(prompt_length, dict):
        weighted_count = prompt_length.get('weighted_count')
        limit = prompt_length.get('limit')
        if (isinstance(weighted_count, (int, float)) and not isinstance(weighted_count, bool)
                and 0 <= weighted_count <= 1_000_000 and limit == 680):
            parts.append(f'提示词长度参考（由界面脚本计算）：当前加权数 {weighted_count:g}/{limit}。请尽量简洁并以不超过 {limit} 加权字数为目标；用户明确要求优先。不要自行计算、复核或在输出中提及任何长度、token 或计数。')
    return '\n\n'.join(parts), modules


def streamed_json_field(raw, field='rewritten_prompt'):
    """Decode the current prefix of a JSON string field for live preview."""
    marker = re.search(r'"' + re.escape(field) + r'"\s*:\s*"', raw)
    if not marker:
        return ''
    chars, index = [], marker.end()
    while index < len(raw):
        char = raw[index]
        if char == '"':
            break
        if char != '\\':
            chars.append(char)
            index += 1
            continue
        index += 1
        if index >= len(raw):
            break
        escape = raw[index]
        index += 1
        replacements = {'"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t'}
        if escape in replacements:
            chars.append(replacements[escape])
        elif escape == 'u':
            digits = raw[index:index + 4]
            if len(digits) != 4 or not re.fullmatch(r'[0-9a-fA-F]{4}', digits):
                break
            codepoint = int(digits, 16)
            index += 4
            if 0xD800 <= codepoint <= 0xDBFF and raw[index:index + 2] == '\\u':
                low = raw[index + 2:index + 6]
                if len(low) == 4 and re.fullmatch(r'[0-9a-fA-F]{4}', low):
                    second = int(low, 16)
                    if 0xDC00 <= second <= 0xDFFF:
                        chars.append(chr(0x10000 + ((codepoint - 0xD800) << 10) + second - 0xDC00))
                        index += 6
                        continue
            if not 0xD800 <= codepoint <= 0xDFFF:
                chars.append(chr(codepoint))
    return ''.join(chars)


async def stream_chat(session, address, payload, on_delta, on_stage=None):
    content_parts, thinking_parts = [], []
    async with session.post(address + '/api/chat', json=payload, allow_redirects=False,
                            timeout=aiohttp.ClientTimeout(total=600)) as response:
        if response.status != 200:
            raise ValueError(f'Ollama 请求失败（HTTP {response.status}）')
        done = False
        async for line in response.content:
            if not line.strip():
                continue
            try:
                part = json.loads(line)
            except (ValueError, TypeError):
                raise ValueError('Ollama 流式响应格式无效') from None
            if part.get('error'):
                raise ValueError(str(part['error'])[:500])
            message = part.get('message') or {}
            if message.get('thinking') and not thinking_parts and on_stage:
                await on_stage('thinking')
            text = message.get('content', '')
            if text:
                if not content_parts and on_stage:
                    await on_stage('rewriting')
                content_parts.append(text)
                await on_delta(''.join(content_parts))
            thinking = message.get('thinking', '')
            if thinking:
                thinking_parts.append(thinking)
            if part.get('done'):
                if part.get('done_reason') == 'length':
                    raise ValueError('优化输出未完成，请增加输出长度')
                done = True
                break
        if not done:
            raise ValueError('Ollama 流式响应意外结束')
    return {'content': ''.join(content_parts), 'thinking': ''.join(thinking_parts)}


async def optimize_ollama(body, emit=None):
    address = local_address(body.get('address'))
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 50000:
        raise ValueError('请输入 1～50000 字的提示词')
    instruction = body.get('instruction', '')
    if not isinstance(instruction, str) or len(instruction) > 10000:
        raise ValueError('补充优化要求最多 10000 字')
    instruction = instruction.strip()
    if _operation_lock.locked():
        result = {'error': '另一个提示词正在优化，请稍后再试'}
        if emit:
            await emit({'type': 'error', **result})
        return result, 409
    async with _operation_lock:
        async with aiohttp.ClientSession(trust_env=False) as session:
            models = await list_models(session, address)
            model = next((model for model in models if model['name'] == body.get('model')), None)
            if not model:
                raise ValueError('请选择实际已安装且支持文本生成的本地模型')
            refs = body.get('refs', [])
            if refs and 'vision' not in model['capabilities']:
                raise ValueError('当前模型不支持参考图片，请在扩展中选择视觉模型')
            images = await asyncio.to_thread(reference_images, refs)
            think = body.get('think', 'auto')
            values = model.get('thinking', {}).get('values', [])
            if think != 'auto' and not any(type(think) is type(value) and think == value for value in values):
                raise ValueError('当前模型不支持所选思考模式，请刷新模型列表')
            temperature = body.get('temperature', 1)
            tokens = body.get('num_predict', 4096)
            if isinstance(temperature, bool) or not isinstance(temperature, (int, float)) or not 0 <= temperature <= 2:
                raise ValueError('温度必须在 0～2 之间')
            if isinstance(tokens, bool) or not isinstance(tokens, int) or not 128 <= tokens <= 8192:
                raise ValueError('输出长度必须在 128～8192 之间')
            task = 'edit' if images else 't2i'
            result, status, model_name = {'task': task}, 200, model['name']
            try:
                if emit:
                    await emit({'type': 'stage', 'stage': 'routing', 'text': '正在判断需要的提示词类型…'})
                router_body = json.dumps({'prompt': prompt, 'instruction': instruction, 'has_references': bool(images),
                                          'reference_count': len(images)}, ensure_ascii=False)
                router_payload = {'model': model_name, 'stream': False, 'keep_alive': '5m', 'format': 'json',
                                  'messages': [{'role': 'system', 'content': (PROMPTS / 'optimizer_router.txt').read_text(encoding='utf-8')},
                                               {'role': 'user', 'content': router_body}],
                                  'options': {'temperature': 0, 'num_predict': 192}}
                if False in model.get('thinking', {}).get('values', []):
                    router_payload['think'] = False
                routed = await call(session, address, '/api/chat', router_payload, timeout=120)
                modules = route_modules(routed.get('message') or {})
                system_prompt, modules = rewrite_system_prompt(task, modules, len(images), body.get('prompt_length'))
                result['modules'] = modules
                if emit:
                    await emit({'type': 'route', 'task': task, 'modules': modules,
                                'labels': [MODULE_LABELS[name] for name in modules]})
                user_text = prompt if not instruction else f'{prompt}\n\n补充优化要求：\n{instruction}'
                user = {'role': 'user', 'content': user_text}
                if images:
                    user['images'] = images
                payload = {'model': model_name, 'stream': True, 'keep_alive': '5m', 'format': 'json',
                           'messages': [{'role': 'system', 'content': system_prompt}, user],
                           'options': {'temperature': temperature, 'num_predict': tokens}}
                if think != 'auto':
                    payload['think'] = think

                async def delta(value):
                    partial = streamed_json_field(value)
                    if emit and partial:
                        await emit({'type': 'delta', 'text': partial})

                async def stream_stage(stage):
                    if emit:
                        label = '模型正在思考…' if stage == 'thinking' else '正在流式改写提示词…'
                        await emit({'type': 'stage', 'stage': stage, 'text': label})

                reply_message = await stream_chat(session, address, payload, delta, stream_stage)
                result['prompt'] = reply_text(reply_message, think, len(refs))
            except asyncio.CancelledError:
                raise
            except (ValueError, aiohttp.ClientError, asyncio.TimeoutError, OSError) as error:
                result['error'] = str(error) or 'Ollama 请求超时或连接中断'
                status = 502
            finally:
                # Keep the model resident across routing and rewriting, then always unload it.
                async def unload():
                    reply = await call(session, address, '/api/generate',
                                       {'model': model_name, 'keep_alive': 0, 'stream': False}, timeout=60)
                    if not reply.get('done') or reply.get('done_reason') != 'unload':
                        raise ValueError('Ollama 未确认模型卸载')
                cleanup = asyncio.create_task(unload())
                try:
                    await asyncio.shield(cleanup)
                    result['unloaded'] = True
                except asyncio.CancelledError:
                    try:
                        await cleanup
                    finally:
                        raise
                except (ValueError, aiohttp.ClientError, asyncio.TimeoutError, OSError) as error:
                    result['unloaded'] = False
                    result['unload_error'] = str(error) or '模型卸载超时'
            if emit:
                try:
                    if status == 200:
                        await emit({'type': 'done', 'prompt': result['prompt'], 'unloaded': result.get('unloaded', False),
                                    'unload_error': result.get('unload_error'), 'task': task, 'modules': result.get('modules', [])})
                    else:
                        await emit({'type': 'error', 'error': result['error'], 'unloaded': result.get('unloaded', False),
                                    'unload_error': result.get('unload_error')})
                except (ConnectionResetError, BrokenPipeError, OSError, aiohttp.ClientError, RuntimeError):
                    pass
            return result, status


def api_error_text(data, status):
    error = data.get('error') if isinstance(data, dict) else None
    if not error and isinstance(data, dict):
        error = (data.get('response') or {}).get('error') if isinstance(data.get('response'), dict) else None
    if isinstance(error, dict):
        message = error.get('message') or error.get('type')
    else:
        message = error
    if not isinstance(message, str) or not message.strip():
        message = f'Responses API 请求失败（HTTP {status}）'
    return message[:600]


async def responses_json(session, config, path, payload=None, timeout=60):
    url = config['base_url'] + path
    headers = {'Authorization': f"Bearer {config['api_key']}", 'Accept': 'application/json'}
    async with session.request('GET' if payload is None else 'POST', url, json=payload,
                               headers=headers, allow_redirects=False,
                               timeout=aiohttp.ClientTimeout(total=timeout)) as response:
        try:
            data = await response.json(content_type=None)
        except (ValueError, aiohttp.ContentTypeError):
            data = {}
        if response.status != 200:
            raise ValueError(f'{api_error_text(data, response.status)} (HTTP {response.status})')
        if not isinstance(data, dict):
            raise ValueError('Responses API 返回格式无效')
        return data


def response_output_text(data):
    if isinstance(data.get('output_text'), str) and data['output_text']:
        return data['output_text']
    chunks = []
    for item in data.get('output', []) if isinstance(data.get('output'), list) else []:
        if not isinstance(item, dict) or item.get('type') != 'message':
            continue
        for part in item.get('content', []) if isinstance(item.get('content'), list) else []:
            if isinstance(part, dict) and part.get('type') == 'output_text' and isinstance(part.get('text'), str):
                chunks.append(part['text'])
    return ''.join(chunks)


async def stream_responses(session, config, payload, on_delta, on_stage=None):
    headers = {'Authorization': f"Bearer {config['api_key']}",
               'Accept': 'text/event-stream', 'Content-Type': 'application/json'}
    async with session.post(config['base_url'] + '/responses', json=payload, headers=headers,
                            allow_redirects=False, timeout=aiohttp.ClientTimeout(total=600)) as response:
        if response.status != 200:
            try:
                data = await response.json(content_type=None)
            except (ValueError, aiohttp.ContentTypeError):
                data = {}
            raise ValueError(f'{api_error_text(data, response.status)} (HTTP {response.status})')
        if 'text/event-stream' not in response.headers.get('Content-Type', '').lower():
            raise ValueError('Responses API 未返回 SSE 流，请检查服务地址与流式接口兼容性')
        buffer, text_parts, final_data = '', [], None
        decoder = codecs.getincrementaldecoder('utf-8')()

        async def dispatch(frame):
            nonlocal final_data
            data_lines = [line[5:].lstrip() for line in frame.splitlines() if line.startswith('data:')]
            if not data_lines:
                return
            raw = '\n'.join(data_lines)
            if raw == '[DONE]':
                return
            try:
                event = json.loads(raw)
            except (ValueError, TypeError):
                raise ValueError('Responses API 流式事件格式无效') from None
            kind = event.get('type', '')
            item = event.get('item') or {}
            if (kind in ('response.reasoning_summary_text.delta', 'response.reasoning_text.delta')
                    or (kind == 'response.output_item.added' and item.get('type') == 'reasoning')) and on_stage:
                await on_stage('thinking')
            elif kind == 'response.output_text.delta' and on_stage and not text_parts:
                await on_stage('rewriting')
            if kind == 'response.output_text.delta':
                delta = event.get('delta', '')
                if isinstance(delta, str) and delta:
                    text_parts.append(delta)
                    await on_delta(''.join(text_parts))
            elif kind in ('response.failed', 'error'):
                raise ValueError(api_error_text(event, 502))
            elif kind == 'response.incomplete':
                response_data = event.get('response') or {}
                reason = (response_data.get('incomplete_details') or {}).get('reason')
                raise ValueError('Responses API 输出不完整' + ('（达到输出上限）' if reason == 'max_output_tokens' else ''))
            elif kind == 'response.completed':
                final_data = event.get('response') or {}

        async for chunk in response.content.iter_any():
            buffer += decoder.decode(chunk)
            frames = re.split(r'\r?\n\r?\n', buffer)
            buffer = frames.pop() if frames else ''
            for frame in frames:
                await dispatch(frame)
        buffer += decoder.decode(b'', final=True)
        if buffer.strip():
            await dispatch(buffer)
        if final_data is None:
            raise ValueError('Responses API 流式响应未正常完成')
        output = ''.join(text_parts) or response_output_text(final_data)
        if not output.strip():
            raise ValueError('Responses API 未返回可用的提示词内容')
        return output


def model_by_id(models, name):
    return next((item for item in models if item.get('id') == name), None)


async def list_responses_models(session, config):
    data = await responses_json(session, config, '/models', timeout=60)
    models = []
    for item in data.get('data', []):
        if not isinstance(item, dict) or not isinstance(item.get('id'), str):
            continue
        modalities = item.get('input_modalities')
        effort = item.get('effort') if isinstance(item.get('effort'), dict) else {}
        models.append({'id': item['id'], 'name': item.get('name') or item['id'],
                       'input_modalities': modalities if isinstance(modalities, list) else None,
                       'effort': {'supported_levels': effort.get('supported_levels', []),
                                  'default_level': effort.get('default_level')}})
    return models


def read_public_api_config():
    config = read_api_config()
    return {'base_url': config['base_url'], 'has_api_key': bool(config['api_key'])}


async def optimize_responses(body, emit=None):
    config = read_api_config()
    if not config['api_key']:
        raise ValueError('请先在扩展中保存 Responses API 密钥')
    model = body.get('model')
    if not isinstance(model, str) or not model.strip() or len(model) > 200:
        raise ValueError('请在扩展中填写 Responses API 模型名称')
    model = model.strip()
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 50000:
        raise ValueError('请输入 1～50000 字的提示词')
    instruction = body.get('instruction', '')
    if not isinstance(instruction, str) or len(instruction) > 10000:
        raise ValueError('补充优化要求最多 10000 字')
    instruction = instruction.strip()
    refs = body.get('refs', [])
    if not isinstance(refs, list) or len(refs) > 10:
        raise ValueError('参考图最多 10 张')
    effort = body.get('effort', 'auto')
    if effort not in ('auto', 'none', 'low', 'medium', 'high', 'max'):
        raise ValueError('推理强度选项无效')
    if _operation_lock.locked():
        result = {'error': '另一个提示词正在优化，请稍后再试'}
        if emit:
            await emit({'type': 'error', **result})
        return result, 409
    async with _operation_lock:
        async with aiohttp.ClientSession(trust_env=False) as session:
            result, status = {'task': 'edit' if refs else 't2i'}, 200
            try:
                try:
                    models = await list_responses_models(session, config)
                except ValueError as error:
                    if not any(f'HTTP {code}' in str(error) for code in (404, 405, 501)):
                        raise
                    models = []  # Some compatible services omit GET /models; allow an explicitly entered model ID.
                selected = model_by_id(models, model)
                if refs and selected and isinstance(selected.get('input_modalities'), list) and 'image' not in selected['input_modalities']:
                    raise ValueError('当前模型不支持图片输入，无法优化图片编辑提示词')
                image_urls = await asyncio.to_thread(reference_data_urls, refs)
                if sum(len(value) for value in image_urls) > 90 * 1024 * 1024:
                    raise ValueError('参考图总量过大，请减少图片数量或尺寸后重试')
                task = result['task']
                if emit:
                    await emit({'type': 'stage', 'stage': 'routing', 'text': '正在判断提示词类型…'})
                router_body = json.dumps({'prompt': prompt, 'instruction': instruction, 'has_references': bool(refs),
                                          'reference_count': len(refs)}, ensure_ascii=False)
                router_payload = {'model': model, 'instructions': (PROMPTS / 'optimizer_router.txt').read_text(encoding='utf-8'),
                                  'input': router_body, 'stream': False, 'max_output_tokens': 256,
                                  'reasoning': {'effort': 'none'}}
                routed = await responses_json(session, config, '/responses', router_payload, timeout=120)
                modules = route_modules({'content': response_output_text(routed)})
                system_prompt, modules = rewrite_system_prompt(task, modules, len(refs), body.get('prompt_length'))
                result['modules'] = modules
                if emit:
                    await emit({'type': 'route', 'task': task, 'modules': modules,
                                'labels': [MODULE_LABELS[name] for name in modules]})
                content = [{'type': 'input_image', 'image_url': value, 'detail': 'auto'} for value in image_urls]
                user_text = prompt if not instruction else f'{prompt}\n\n补充优化要求：\n{instruction}'
                content.append({'type': 'input_text', 'text': user_text})
                payload = {'model': model, 'instructions': system_prompt,
                           'input': [{'role': 'user', 'content': content}],
                           'stream': True, 'max_output_tokens': 4096}
                if effort != 'auto':
                    payload['reasoning'] = {'effort': effort}

                async def delta(value):
                    partial = streamed_json_field(value)
                    if emit and partial:
                        await emit({'type': 'delta', 'text': partial})

                async def stream_stage(stage):
                    if emit:
                        label = '模型正在思考…' if stage == 'thinking' else '正在流式改写提示词…'
                        await emit({'type': 'stage', 'stage': stage, 'text': label})

                answer = await stream_responses(session, config, payload, delta, stream_stage)
                result['prompt'] = rewritten_text(answer, len(refs))
            except asyncio.CancelledError:
                raise
            except (ValueError, aiohttp.ClientError, asyncio.TimeoutError, OSError) as error:
                result['error'] = (str(error).replace(config['api_key'], '[密钥已隐藏]') if config['api_key'] else str(error)) or 'Responses API 请求失败'
                status = 502
            if emit:
                try:
                    if status == 200:
                        await emit({'type': 'done', 'prompt': result['prompt'], 'task': result['task'],
                                    'modules': result.get('modules', [])})
                    else:
                        await emit({'type': 'error', 'error': result['error']})
                except (ConnectionResetError, BrokenPipeError, OSError, aiohttp.ClientError, RuntimeError):
                    pass
            return result, status


async def optimize(body, emit=None):
    if body.get('provider', 'ollama') == 'responses':
        return await optimize_responses(body, emit)
    return await optimize_ollama(body, emit)


def register_routes():
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post('/qwen_auto/optimizer/api-config')
    async def api_config(request):
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError('配置格式无效')
            current = read_api_config()
            if body.get('action') == 'clear_key':
                write_api_config(current['base_url'], '')
            elif body.get('action') == 'save':
                base_url = body.get('base_url', current['base_url'])
                base_url = normalize_api_url(base_url)
                key = (current['api_key'] if base_url == current['base_url'] else '') if 'api_key' not in body else api_key_value(body['api_key'])
                write_api_config(base_url, key)
            return web.json_response(read_public_api_config())
        except (ValueError, TypeError, AttributeError, OSError) as error:
            return web.json_response({'error': str(error) or '无法读取本机 API 设置'}, status=400)

    @PromptServer.instance.routes.post('/qwen_auto/responses/models')
    async def response_models(request):
        try:
            config = read_api_config()
            if not config['api_key']:
                raise ValueError('请先保存 Responses API 密钥')
            async with aiohttp.ClientSession(trust_env=False) as session:
                return web.json_response({'models': await list_responses_models(session, config)})
        except (ValueError, TypeError, AttributeError, OSError, aiohttp.ClientError, asyncio.TimeoutError) as error:
            return web.json_response({'error': str(error) or '无法获取 Responses API 模型'}, status=400)

    @PromptServer.instance.routes.post('/qwen_auto/ollama/models')
    async def models(request):
        try:
            body = await request.json()
            async with aiohttp.ClientSession(trust_env=False) as session:
                return web.json_response({'models': await list_models(session, local_address(body.get('address')))})
        except (ValueError, TypeError, AttributeError, OSError, aiohttp.ClientError, asyncio.TimeoutError) as error:
            return web.json_response({'error': str(error) or '无法连接 Ollama 本地服务'}, status=400)

    @PromptServer.instance.routes.post('/qwen_auto/optimizer/optimize')
    @PromptServer.instance.routes.post('/qwen_auto/ollama/optimize')
    async def rewrite(request):
        try:
            body = await request.json()
            response = web.StreamResponse(status=200, headers={
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'X-Accel-Buffering': 'no',
            })
            await response.prepare(request)

            async def emit(event):
                data = json.dumps(event, ensure_ascii=False, separators=(',', ':'))
                await response.write(f'data: {data}\n\n'.encode('utf-8'))

            async def wait_for_disconnect():
                while True:
                    transport = request.transport
                    if transport is None or transport.is_closing():
                        return
                    await asyncio.sleep(0.25)

            operation = asyncio.create_task(optimize(body, emit))
            disconnect = asyncio.create_task(wait_for_disconnect())
            try:
                done, _ = await asyncio.wait((operation, disconnect), return_when=asyncio.FIRST_COMPLETED)
                if disconnect in done and not operation.done():
                    operation.cancel()
                    try:
                        await operation
                    except asyncio.CancelledError:
                        pass
                else:
                    await operation
            except (ValueError, TypeError, AttributeError, OSError, aiohttp.ClientError, asyncio.TimeoutError) as error:
                try:
                    await emit({'type': 'error', 'error': str(error) or '无法连接 Ollama 本地服务'})
                except (ConnectionResetError, BrokenPipeError, OSError, aiohttp.ClientError, RuntimeError):
                    pass
            finally:
                disconnect.cancel()
                if not operation.done():
                    operation.cancel()
                await asyncio.gather(disconnect, return_exceptions=True)
                if not operation.done():
                    await asyncio.gather(operation, return_exceptions=True)
            try:
                await response.write_eof()
            except (ConnectionResetError, RuntimeError):
                pass
            return response
        except (ValueError, TypeError, AttributeError, OSError, aiohttp.ClientError, asyncio.TimeoutError) as error:
            return web.json_response({'error': str(error) or '无法连接 Ollama 本地服务'}, status=400)
