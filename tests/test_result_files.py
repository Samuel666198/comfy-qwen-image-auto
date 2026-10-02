import importlib.util
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile


class ResultFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        (self.output / 'qwen_auto/upscaled').mkdir(parents=True)
        self.original = {'filename': 'original.png', 'subfolder': 'qwen_auto', 'type': 'output'}
        self.upscaled = {'filename': 'up.png', 'subfolder': 'qwen_auto/upscaled', 'type': 'output'}
        (self.output / 'qwen_auto/original.png').write_bytes(b'original')
        (self.output / 'qwen_auto/upscaled/up.png').write_bytes(b'upscale')
        self.item = {'id': 'one', 'title': '作品', 'original': self.original, 'upscaled': self.upscaled}
        paths = types.SimpleNamespace(get_output_directory=lambda: str(self.output))
        with patch.dict(sys.modules, {'folder_paths': paths}):
            spec = importlib.util.spec_from_file_location('qwen_result_files_test', Path(__file__).resolve().parents[1] / 'result_files.py')
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)

    def test_delete_associated_versions_and_missing_is_idempotent(self):
        self.item['upscaleHistory'] = [self.upscaled]
        for _ in range(2):
            response = self.module.delete_results([self.item])
            self.assertTrue(response['results'][0]['ok'])
        self.assertFalse((self.output / 'qwen_auto/original.png').exists())
        self.assertFalse((self.output / 'qwen_auto/upscaled/up.png').exists())

    def test_bad_associated_path_preserves_original_and_other_results_continue(self):
        bad = {**self.item, 'upscaled': {**self.upscaled, 'subfolder': 'qwen_auto/../elsewhere'}}
        good = {'id': 'two', 'original': self.upscaled}
        response = self.module.delete_results([bad, good])['results']
        self.assertFalse(response[0]['ok'])
        self.assertTrue(response[1]['ok'])
        self.assertTrue((self.output / 'qwen_auto/original.png').exists())

    def test_rejects_external_and_nonimage_paths(self):
        invalid = [
            {'filename': '../outside.png', 'subfolder': 'qwen_auto'},
            {'filename': 'outside.png', 'subfolder': '/qwen_auto'},
            {'filename': 'outside.png', 'subfolder': 'qwen_auto/../../'},
            {'filename': 'outside.png', 'subfolder': 'C:\\qwen_auto'},
            {'filename': 'file.py', 'subfolder': 'qwen_auto'},
            {**self.original, 'type': 'input'},
        ]
        for descriptor in invalid:
            with self.subTest(descriptor=descriptor), self.assertRaises(ValueError):
                self.module.resolve_file(descriptor, missing_ok=True)

    def test_symlink_rejected_even_if_target_inside(self):
        link = self.output / 'qwen_auto/link.png'
        try:
            link.symlink_to(self.output / 'qwen_auto/original.png')
        except OSError:
            self.skipTest('OS does not permit symlink creation')
        with self.assertRaises(ValueError):
            self.module.resolve_file({**self.original, 'filename': 'link.png'})

    def test_windows_reparse_point_rejected(self):
        original_lstat = Path.lstat
        def reparse(path, *args, **kwargs):
            info = original_lstat(path, *args, **kwargs)
            if path.name == 'qwen_auto':
                return types.SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
            return info
        with patch.object(Path, 'lstat', reparse), self.assertRaises(ValueError):
            self.module.resolve_file(self.original)

    def test_http_routes_delete_download_and_bad_request(self):
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
        async def check():
            routes = web.RouteTableDef()
            server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes)))
            with patch.dict(sys.modules, {'server': server}):
                self.module.register_routes()
            app = web.Application()
            app.add_routes(routes)
            async with TestClient(TestServer(app)) as client:
                response = await client.post('/qwen_auto/results/download', json={'results': [self.item], 'version': 'all'})
                self.assertEqual(response.status, 200)
                self.assertEqual(response.headers['Content-Type'], 'application/zip')
                self.assertTrue((await response.read()).startswith(b'PK'))
                form_body = json.dumps({'results': [self.versioned_item()], 'version': 'current', 'filename': 'qwen_image_2026_10_01_01.zip'})
                response = await client.post('/qwen_auto/results/download', data={'payload': form_body})
                self.assertEqual(response.status, 200)
                self.assertIn('filename="qwen_image_2026_10_01_01.zip"', response.headers['Content-Disposition'])
                self.assertTrue((await response.read()).startswith(b'PK'))
                response = await client.post('/qwen_auto/results/download', data={'payload': json.dumps({'results': [self.item], 'filename': '../bad.zip'})})
                self.assertEqual(response.status, 400)
                response = await client.post('/qwen_auto/results/delete', json={'results': [self.item]})
                self.assertTrue((await response.json())['results'][0]['ok'])
                response = await client.post('/qwen_auto/results/delete', json={'results': []})
                self.assertEqual(response.status, 400)
        asyncio.run(check())

    def test_zip_versions_unique_sanitized_names_and_contents(self):
        duplicate = {**self.item, 'id': 'two'}
        archive = self.module.build_archive([self.item, duplicate], 'all')
        self.addCleanup(lambda: archive.unlink(missing_ok=True))
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(zipped.namelist(), ['作品_original.png', '作品_upscaled.png', '作品_original_2.png', '作品_upscaled_2.png'])
            self.assertEqual(zipped.read('作品_original.png'), b'original')
            self.assertEqual(zipped.read('作品_upscaled.png'), b'upscale')
        self.assertNotIn('/', self.module.archive_title('../../bad:name'))

    def test_missing_requested_version_errors_instead_of_silent_skip(self):
        with self.assertRaises(ValueError):
            self.module.build_archive([{**self.item, 'upscaled': None}], 'upscaled')
        with self.assertRaises(FileNotFoundError):
            self.module.build_archive([{**self.item, 'original': {**self.original, 'filename': 'gone.png'}}], 'original')

    def versioned_item(self):
        return {**self.item, 'versions': [
            {'id': 'v1', 'number': 1, 'file': self.original},
            {'id': 'v2', 'number': 2, 'file': self.upscaled},
        ], 'selectedVersionId': 'v2'}

    def test_current_zip_uses_selected_version_not_legacy_projection(self):
        item = self.versioned_item()
        archive = self.module.build_archive([item], 'current')
        self.addCleanup(lambda: archive.unlink(missing_ok=True))
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(zipped.namelist(), ['作品.png'])
            self.assertEqual(zipped.read('作品.png'), b'upscale')
        with self.assertRaises(ValueError):
            self.module.build_archive([{**item, 'selectedVersionId': 'missing'}], 'current')

    def test_delete_versioned_work_removes_all_versions(self):
        item = self.versioned_item()
        response = self.module.delete_results([item])['results'][0]
        self.assertTrue(response['ok'])
        self.assertEqual(len(response['deleted']), 2)
        self.assertFalse((self.output / 'qwen_auto/original.png').exists())
        self.assertFalse((self.output / 'qwen_auto/upscaled/up.png').exists())

    def test_keep_files_protects_shared_file_during_version_removal(self):
        response = self.module.delete_results([self.versioned_item()], keep_files=[self.upscaled])['results'][0]
        self.assertTrue(response['ok'])
        self.assertEqual(response['deleted'], [self.original])
        self.assertEqual(response['skipped'], [self.upscaled])
        self.assertFalse((self.output / 'qwen_auto/original.png').exists())
        self.assertEqual((self.output / 'qwen_auto/upscaled/up.png').read_bytes(), b'upscale')

    def test_failed_version_does_not_prevent_other_version_deletion(self):
        items = [{'id': v['id'], 'versions': [v]} for v in self.versioned_item()['versions']]
        unlink = Path.unlink
        def locked(path, *args, **kwargs):
            if path.name == 'original.png':
                raise PermissionError('locked image')
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', locked):
            response = self.module.delete_results(items)['results']
        self.assertFalse(response[0]['ok'])
        self.assertIn('locked image', response[0]['error'])
        self.assertTrue(response[1]['ok'])
        self.assertTrue((self.output / 'qwen_auto/original.png').exists())
        self.assertFalse((self.output / 'qwen_auto/upscaled/up.png').exists())

    def test_malformed_versions_fail_before_deleting_files(self):
        for versions in [[], [None], [{'id': 'v1'}], [{'file': self.original}, {'file': None}]]:
            with self.subTest(versions=versions):
                response = self.module.delete_results([{**self.item, 'versions': versions}])['results'][0]
                self.assertFalse(response['ok'])
                self.assertTrue((self.output / 'qwen_auto/original.png').exists())

    def test_file_metadata_reports_size_mtime_and_deduplicates_canonical_paths(self):
        path = self.output / 'qwen_auto/original.png'
        timestamp = 1_700_000_123_456
        import os
        os.utime(path, ns=(timestamp * 1_000_000, timestamp * 1_000_000))
        alternate = {**self.original, 'subfolder': 'qwen_auto\\'}
        files = self.module.file_metadata([self.original, alternate])
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]['size'], len(b'original'))
        self.assertEqual(files[0]['mtime'], timestamp)
        self.assertNotIn(str(self.output), str(files))

    def test_file_metadata_keeps_peer_errors_for_missing_and_invalid_files(self):
        missing = {**self.original, 'filename': 'missing.png'}
        invalid = {**self.original, 'type': 'input'}
        files = self.module.file_metadata([self.original, missing, invalid])
        self.assertEqual(len(files), 3)
        self.assertEqual(files[0]['size'], len(b'original'))
        self.assertIn('error', files[1])
        self.assertIn('error', files[2])

    def test_file_metadata_indexes_mixed_results_and_deduplicates_successes(self):
        missing = {**self.original, 'filename': 'missing.png'}
        invalid = {**self.original, 'subfolder': 'qwen_auto/../outside'}
        files = self.module.file_metadata([self.original, missing, self.original, invalid])
        self.assertEqual([item['index'] for item in files], [0, 1, 3])
        self.assertEqual(files[0]['file'], self.original)
        self.assertIn('error', files[1])
        self.assertIn('error', files[2])
        self.assertNotIn(str(self.output), str(files))

    def test_file_metadata_retries_duplicate_when_first_stat_fails(self):
        original_stat = Path.stat
        calls = {'count': 0}
        def fail_once(path, *args, **kwargs):
            if path.name == 'original.png':
                calls['count'] += 1
                if calls['count'] == 1:
                    raise PermissionError('temporary read failure')
            return original_stat(path, *args, **kwargs)
        with patch.object(Path, 'stat', fail_once):
            files = self.module.file_metadata([self.original, {**self.original, 'subfolder': 'qwen_auto\\'}])
        self.assertEqual([item['index'] for item in files], [0, 1])
        self.assertIn('error', files[0])
        self.assertEqual(files[1]['size'], len(b'original'))

    def test_file_metadata_rejects_empty_malformed_and_oversized_input(self):
        for files in ([], None, [self.original] * 10001):
            with self.subTest(count=(len(files) if isinstance(files, list) else files)), self.assertRaises(ValueError):
                self.module.file_metadata(files)

    def test_metadata_http_route_and_bad_requests(self):
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
        async def check():
            routes = web.RouteTableDef()
            server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes)))
            with patch.dict(sys.modules, {'server': server}):
                self.module.register_routes()
            app = web.Application()
            app.add_routes(routes)
            async with TestClient(TestServer(app)) as client:
                response = await client.post('/qwen_auto/results/metadata', json={'files': [self.original]})
                self.assertEqual(response.status, 200)
                body = await response.json()
                self.assertEqual(body['files'][0]['size'], len(b'original'))
                for invalid in ({}, {'files': []}, {'files': [self.original] * 10001}):
                    response = await client.post('/qwen_auto/results/metadata', json=invalid)
                    self.assertEqual(response.status, 400)
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
