import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import types
import tempfile
import unittest
from unittest.mock import patch

from aiohttp import web


class OptimizerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        spec = importlib.util.spec_from_file_location('optimizer_test', Path(__file__).resolve().parents[1] / 'prompt_optimizer.py')
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'folder_paths': types.SimpleNamespace()}):
            spec.loader.exec_module(self.module)
        self.calls = []
        self.content = '{"rewritten_prompt":"A cat."}'
        self.unload_ok = True
        self.chat_error = False
        self.api_calls = []
        self.api_modalities = ['text', 'image']
        self.api_answer = '{"rewritten_prompt":"编辑 <image1>"}'
        self.models_unavailable = False
        async def api(request):
            body = await request.json() if request.method == 'POST' else None
            self.calls.append((request.path, body))
            if request.path == '/api/tags':
                return web.json_response({'models': [{'name': 'test'}, {'name': 'embed'}]})
            if request.path == '/api/show':
                return web.json_response({'capabilities': ['embedding'] if body['model'] == 'embed' else ['completion', 'thinking'], 'thinking': {'values': [False, True]}})
            if request.path == '/api/chat':
                if body.get('stream'):
                    parts = [
                        {'message': {'thinking': 'PRIVATE_THOUGHT'}, 'done': False},
                        {'message': {'content': self.content}, 'done': False},
                        {'message': {}, 'done': True, 'done_reason': 'stop'},
                    ]
                    return web.Response(text=''.join(json.dumps(part) + '\n' for part in parts), content_type='application/x-ndjson')
                return web.json_response({'error': 'test failure'} if self.chat_error else {'done': True, 'message': {'content': self.content}})
            return web.json_response({'done': True, 'done_reason': 'unload' if self.unload_ok else 'stop'})
        async def responses_models(request):
            if self.models_unavailable:
                return web.json_response({'error': {'message': 'not implemented'}}, status=404)
            return web.json_response({'data': [{'id': 'vision-model', 'name': 'Vision model',
                'input_modalities': self.api_modalities, 'effort': {'supported_levels': ['low', 'high', 'max']}}]})
        async def responses(request):
            body = await request.json()
            self.api_calls.append(body)
            if not body.get('stream'):
                return web.json_response({'output_text': '{"modules":[]}'} )
            answer = self.api_answer
            events = [
                {'type': 'response.reasoning_summary_text.delta', 'delta': 'PRIVATE_THOUGHT'},
                {'type': 'response.output_text.delta', 'delta': answer},
                {'type': 'response.completed', 'response': {'output_text': answer, 'output': []}},
            ]
            payload = ''.join('data: ' + __import__('json').dumps(item, ensure_ascii=False) + '\n\n' for item in events)
            return web.Response(text=payload, content_type='text/event-stream')
        app = web.Application()
        app.router.add_route('*', '/api/{path}', api)
        app.router.add_get('/models', responses_models)
        app.router.add_post('/responses', responses)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await self.site.start()
        self.address = f'http://127.0.0.1:{self.site._server.sockets[0].getsockname()[1]}'
        self.body = {'address': self.address, 'model': 'test', 'prompt': 'cat', 'think': False}

    async def asyncTearDown(self):
        await self.runner.cleanup()

    async def test_success_uses_chinese_on_demand_templates_and_unloads(self):
        body = {**self.body, 'instruction': '保持主体不变', 'prompt_length': {'weighted_count': 3, 'limit': 680}}
        result, status = await self.module.optimize(body)
        self.assertEqual(status, 200)
        self.assertEqual(result['prompt'], 'A cat.')
        self.assertTrue(result['unloaded'])
        payload = [body for path, body in self.calls if path == '/api/chat'][-1]
        self.assertIn('Qwen-Image 2.1 文生图提示词改写助手', payload['messages'][0]['content'])
        self.assertIs(payload['think'], False)
        self.assertEqual(payload['keep_alive'], '5m')
        self.assertEqual(payload['messages'][1]['content'], 'cat\n\n补充优化要求：\n保持主体不变')
        self.assertIn('当前加权数 3/680', payload['messages'][0]['content'])
        self.assertIn('不要自行计算', payload['messages'][0]['content'])
        self.assertEqual(self.calls[-1][0], '/api/generate')

    async def test_ollama_stream_emits_only_thinking_stage_not_thought_content(self):
        events = []
        async def emit(event): events.append(event)
        result, status = await self.module.optimize(self.body, emit=emit)
        self.assertEqual(status, 200)
        self.assertEqual(result['prompt'], 'A cat.')
        self.assertIn('thinking', [event.get('stage') for event in events])
        self.assertNotIn('PRIVATE_THOUGHT', json.dumps(events, ensure_ascii=False))

    async def test_responses_edit_sends_ordered_images_with_prompt_and_effort(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ref.png').write_bytes(b'fake png bytes')
            (root / 'second.png').write_bytes(b'second fake png bytes')
            paths = types.SimpleNamespace(
                get_input_directory=lambda: directory, get_output_directory=lambda: directory,
                get_temp_directory=lambda: directory,
                get_annotated_filepath=lambda name: str(root / name.split(' [')[0]))
            with patch.object(self.module, 'folder_paths', paths), \
                 patch.object(self.module, 'read_api_config', return_value={'base_url': self.address, 'api_key': 'local-secret'}):
                result, status = await self.module.optimize({'provider': 'responses', 'model': 'vision-model',
                    'effort': 'high', 'prompt': '改成黄昏 <image1> <image2>', 'instruction':'保留人物构图',
                    'prompt_length': {'weighted_count': 2.5, 'limit': 680}, 'refs': [
                        {'name': 'second.png', 'type': 'input'}, {'name': 'ref.png', 'type': 'input'}]})
        self.assertEqual(status, 200)
        self.assertEqual(result['prompt'], '编辑 <image1>')
        rewrite = [call for call in self.api_calls if call.get('stream')][-1]
        self.assertEqual(rewrite['reasoning'], {'effort': 'high'})
        self.assertIn('当前加权数 2.5/680', rewrite['instructions'])
        self.assertIn('不要自行计算', rewrite['instructions'])
        content = rewrite['input'][0]['content']
        self.assertEqual(content[0]['type'], 'input_image')
        self.assertEqual(content[0]['image_url'], 'data:image/png;base64,' + __import__('base64').b64encode(b'second fake png bytes').decode('ascii'))
        self.assertEqual(content[1]['image_url'], 'data:image/png;base64,' + __import__('base64').b64encode(b'fake png bytes').decode('ascii'))
        self.assertEqual(content[2], {'type': 'input_text', 'text': '改成黄昏 <image1> <image2>\n\n补充优化要求：\n保留人物构图'})
        self.assertIsInstance(self.api_calls[0]['input'], str)
        self.assertNotIn('input_image', str(self.api_calls[0]))
        self.assertNotIn('local-secret', str(self.api_calls))

    async def test_responses_rejects_explicitly_text_only_model_for_image_edit(self):
        self.api_modalities = ['text']
        with patch.object(self.module, 'read_api_config', return_value={'base_url': self.address, 'api_key': 'key'}):
            result, status = await self.module.optimize({'provider': 'responses', 'model': 'vision-model',
                'prompt': 'edit', 'refs': [{'name': 'placeholder.png'}]})
        self.assertEqual(status, 502)
        self.assertIn('不支持图片', result['error'])
        self.assertEqual(self.api_calls, [])

    async def test_responses_allows_manual_model_when_service_has_no_models_route(self):
        self.models_unavailable = True
        self.api_answer = '{"rewritten_prompt":"A cat."}'
        with patch.object(self.module, 'read_api_config', return_value={'base_url': self.address, 'api_key': 'key'}):
            result, status = await self.module.optimize({'provider': 'responses', 'model': 'private-model', 'prompt': 'cat'})
        self.assertEqual(status, 200)
        self.assertEqual(result['prompt'], 'A cat.')

    async def test_responses_stream_emits_thinking_stage_without_reasoning_text(self):
        events = []
        self.api_answer = '{"rewritten_prompt":"A cat."}'
        async def emit(event): events.append(event)
        with patch.object(self.module, 'read_api_config', return_value={'base_url': self.address, 'api_key': 'key'}):
            result, status = await self.module.optimize({'provider': 'responses', 'model': 'vision-model', 'prompt': 'cat'}, emit=emit)
        self.assertEqual(status, 200, result)
        self.assertIn('thinking', [event.get('stage') for event in events])
        self.assertNotIn('PRIVATE_THOUGHT', json.dumps(events, ensure_ascii=False))

    def test_api_key_config_is_local_and_never_returned_by_public_config(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = types.SimpleNamespace(user_directory=directory)
            with patch.object(self.module, 'folder_paths', paths):
                self.module.write_api_config('https://api.deepseek.com', 'do-not-return-this')
                public = self.module.read_public_api_config()
                stored = json.loads(self.module.optimizer_config_path().read_text(encoding='utf-8'))
        self.assertEqual(public, {'base_url': 'https://api.deepseek.com', 'has_api_key': True})
        self.assertNotIn('api_key', public)
        self.assertEqual(stored['api_key'], 'do-not-return-this')

    def test_responses_url_and_effort_validation(self):
        for value in ('http://example.com', 'https://user:pass@example.com', 'https://example.com/responses'):
            with self.assertRaises(ValueError):
                self.module.normalize_api_url(value)
        self.assertEqual(self.module.normalize_api_url('https://api.deepseek.com/'), 'https://api.deepseek.com')

    async def test_parse_failure_still_unloads(self):
        self.content = 'not JSON'
        result, status = await self.module.optimize(self.body)
        self.assertEqual(status, 502)
        self.assertTrue(result['unloaded'])
        self.assertNotIn('prompt', result)

    async def test_chat_failure_still_unloads(self):
        self.chat_error = True
        result, status = await self.module.optimize(self.body)
        self.assertEqual(status, 502)
        self.assertTrue(result['unloaded'])

    async def test_unload_failure_preserves_success(self):
        self.unload_ok = False
        result, status = await self.module.optimize(self.body)
        self.assertEqual(status, 200)
        self.assertEqual(result['prompt'], 'A cat.')
        self.assertFalse(result['unloaded'])
        self.assertIn('unload_error', result)

    async def test_unsupported_settings_rejected_before_loading(self):
        for changes in ({'model': 'embed'}, {'think': 'high'}, {'refs': [{'name': 'x'}]}, {'num_predict': 0}):
            with self.assertRaises(ValueError):
                await self.module.optimize({**self.body, **changes})
        self.assertFalse(any(path in ('/api/chat', '/api/generate') for path, _ in self.calls))

    async def test_concurrent_operation_rejected(self):
        async with self.module._operation_lock:
            result, status = await self.module.optimize(self.body)
        self.assertEqual(status, 409)
        self.assertEqual(self.calls, [])

    def test_local_address_and_reference_contract(self):
        for address in ('https://example.com', 'http://127.0.0.1@evil.com', 'http://127.0.0.1/api', 'http://192.168.1.2'):
            with self.assertRaises(ValueError):
                self.module.local_address(address)
        self.assertEqual(self.module.local_address('http://localhost:11434'), 'http://127.0.0.1:11434')
        self.assertEqual(self.module.rewritten_text('<think>private</think>```json\n{"rewritten_prompt":"Use <image1>."}\n```', 1), 'Use <image1>.')
        with self.assertRaises(ValueError):
            self.module.rewritten_text('{"rewritten_prompt":"Use <image2>."}', 1)

    def test_no_thinking_template_quirk_accepts_only_whole_answer_object(self):
        message = {'content': '', 'thinking': '{"rewritten_prompt":"A cat."}'}
        self.assertEqual(self.module.reply_text(message, False, 0), 'A cat.')
        for thinking in ('I should write a cat.', 'Reasoning\n{"rewritten_prompt":"A cat."}', '<think>x</think>{"rewritten_prompt":"A cat."}'):
            with self.assertRaises(ValueError):
                self.module.reply_text({'content': '', 'thinking': thinking}, False, 0)
        with self.assertRaises(ValueError):
            self.module.reply_text(message, True, 0)

    def test_references_preserve_order_and_reject_outside_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'one.png').write_bytes(b'first')
            (root / 'two.png').write_bytes(b'second')
            paths = types.SimpleNamespace(get_input_directory=lambda: directory,
                get_output_directory=lambda: directory, get_temp_directory=lambda: directory,
                get_annotated_filepath=lambda name: str(root / name))
            with patch.object(self.module, 'folder_paths', paths):
                self.assertEqual(self.module.reference_images([{'name': 'two.png'}, {'name': 'one.png'}]), ['c2Vjb25k', 'Zmlyc3Q='])
                with self.assertRaises(ValueError):
                    self.module.reference_images([{'name': '../outside.png'}])
                seen = []
                def annotated(name):
                    seen.append(name)
                    return str(root / 'one.png')
                paths.get_annotated_filepath = annotated
                self.module.reference_images([{'name': 'qwen_auto/one.png', 'type': 'output'}])
                self.assertEqual(seen, ['qwen_auto/one.png [output]'])
