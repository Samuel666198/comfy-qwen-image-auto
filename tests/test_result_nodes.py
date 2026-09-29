import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


class ResultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        (self.output / "qwen_auto").mkdir()
        Image.new("RGB", (16, 24)).save(self.output / "qwen_auto/source.png")
        self.paths = types.ModuleType("folder_paths")
        self.paths.get_output_directory = lambda: str(self.output)
        self.paths.get_filename_list = lambda name: []
        self.core = types.ModuleType("nodes")
        self.save = Mock(return_value={"ui": {"images": [{"filename": "saved.png", "subfolder": "qwen_auto", "type": "output"}]}})
        self.core.SaveImage = lambda: types.SimpleNamespace(save_images=self.save)
        self.rtx = Mock()
        self.rtx.execute.return_value = types.SimpleNamespace(args=(torch.zeros((1, 48, 32, 3)),))
        self.core.NODE_CLASS_MAPPINGS = {"RTXVideoSuperResolution": self.rtx}
        self.interrupt = Mock()
        self.patcher = patch.dict(sys.modules, {"folder_paths": self.paths, "nodes": self.core,
            "comfy.model_management": types.SimpleNamespace(throw_exception_if_processing_interrupted=self.interrupt)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        spec = importlib.util.spec_from_file_location("qwen_test_result", ROOT / "result_nodes.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_upscale_passes_parameters_and_returns_only_custom_preview(self):
        result = self.module.QwenImage21AutoUpscale().upscale("source.png", "qwen_auto", 2, "ULTRA", "r1")
        kwargs = self.rtx.execute.call_args.kwargs
        self.assertEqual(kwargs["resize_type"], {"resize_type": "scale by multiplier", "scale": 2})
        self.assertEqual(kwargs["quality"], "ULTRA")
        self.assertEqual(tuple(kwargs["images"].shape), (1, 24, 16, 3))
        self.assertEqual(list(result["ui"]), ["qwen_upscale"])
        item = result["ui"]["qwen_upscale"][0]
        self.assertEqual(item["resultId"], "r1")
        self.assertEqual((item["file"]["width"], item["file"]["height"]), (32, 48))
        self.assertTrue(self.save.call_args.kwargs["filename_prefix"].startswith("qwen_auto/upscaled/"))

    def test_invalid_parameters_and_paths_do_not_execute_rtx(self):
        for scale in [0, 5, True, "2", None, float("nan"), float("inf"), -float("inf")]:
            with self.assertRaises(ValueError):
                self.module.QwenImage21AutoUpscale().upscale("source.png", "qwen_auto", scale, "ULTRA", "r1")
        for filename, subfolder in [("../source.png", "qwen_auto"), ("source.png", "../"),
                                     ("source.png", "."), ("x:stream", "qwen_auto")]:
            with self.assertRaises(ValueError):
                self.module.resolve_original(filename, subfolder)
        with self.assertRaises(ValueError):
            self.module.QwenImage21AutoUpscale().upscale("source.png", "qwen_auto", 2, "BAD", "r1")
        self.rtx.execute.assert_not_called()

    def test_fractional_upscale_drops_alpha_and_preserves_original(self):
        path = self.output / "qwen_auto/transparent.png"
        Image.new("RGBA", (16, 24), (32, 64, 128, 0)).save(path)
        original_bytes = path.read_bytes()
        for scale in [1, 1.5, 2.37, 4]:
            with self.subTest(scale=scale):
                result = self.module.QwenImage21AutoUpscale().upscale(
                    path.name, "qwen_auto", scale, "ULTRA", "r1")
                kwargs = self.rtx.execute.call_args.kwargs
                self.assertEqual(kwargs["resize_type"]["scale"], scale)
                self.assertEqual(tuple(kwargs["images"].shape), (1, 24, 16, 3))
                torch.testing.assert_close(kwargs["images"][0, 0, 0], torch.tensor([32, 64, 128]) / 255.0)
                self.assertEqual(result["ui"]["qwen_upscale"][0]["file"]["scale"], scale)
                self.assertEqual(path.read_bytes(), original_bytes)
        with Image.open(path) as original:
            self.assertEqual(original.mode, "RGBA")

    def test_interrupt_before_and_after_rtx_prevents_save(self):
        for checkpoint in (0, 1, 2):
            self.interrupt.reset_mock()
            self.rtx.execute.reset_mock()
            self.interrupt.side_effect = [None] * checkpoint + [RuntimeError("interrupted")]
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                self.module.QwenImage21AutoUpscale().upscale("source.png", "qwen_auto", 2, "ULTRA", "r1")
            self.save.assert_not_called()
            self.assertEqual(self.rtx.execute.call_count, 0 if checkpoint == 0 else 1)

    def test_missing_source_or_rtx_and_processing_failure_preserve_no_success(self):
        with self.assertRaises(FileNotFoundError):
            self.module.resolve_original("missing.png", "qwen_auto")
        self.rtx.execute.side_effect = RuntimeError("GPU failure")
        with self.assertRaisesRegex(RuntimeError, "GPU failure"):
            self.module.QwenImage21AutoUpscale().upscale("source.png", "qwen_auto", 2, "ULTRA", "r1")
        self.core.NODE_CLASS_MAPPINGS.clear()
        with self.assertRaisesRegex(RuntimeError, "未加载"):
            self.module.QwenImage21AutoUpscale().upscale("source.png", "qwen_auto", 2, "ULTRA", "r1")
        self.save.assert_not_called()

    def test_default_title_uses_local_date_and_saved_daily_counter(self):
        with patch.object(self.module, "datetime") as clock:
            clock.now.return_value.strftime.return_value = "qwen_image_2026_09_26"
            for counter in (1, 2, 100):
                filename = f"qwen_image_2026_09_26_{counter:05d}_.png"
                self.save.return_value = {"ui": {"images": [{"filename": filename, "subfolder": "qwen_auto", "type": "output"}]}}
                result = self.module.make_result(torch.zeros((1, 24, 16, 3)), {})
                self.assertEqual(result["title"], f"qwen_image_2026_09_26_{counter:02d}")
                self.assertEqual(self.save.call_args.kwargs["filename_prefix"], "qwen_auto/qwen_image_2026_09_26")

    def test_result_snapshot_is_detached_and_metadata_is_forwarded(self):
        snapshot = {"seed": 100, "refs": [{"id": "a"}]}
        prompt = {"1": {"inputs": {}}}
        record = self.module.make_result(torch.zeros((1, 24, 16, 3)), snapshot, prompt, {"workflow": {}})
        snapshot["refs"][0]["id"] = "b"
        self.assertEqual(record["snapshot"]["refs"][0]["id"], "a")
        self.assertEqual(record["original"]["width"], 16)
        self.assertEqual(self.save.call_args.kwargs["prompt"], prompt)
        json.dumps(record)
        self.save.side_effect = OSError("disk full")
        with self.assertRaises(OSError):
            self.module.make_result(torch.zeros((1, 24, 16, 3)), {})

    def test_stage_has_prompt_and_node_ownership(self):
        server = types.SimpleNamespace(last_node_id="7", send_sync=Mock(),
            prompt_queue=types.SimpleNamespace(get_current_queue=lambda: ([(0, "p1", {"7": {}}, {"client_id": "c1"})], [])))
        with patch.dict(sys.modules, {"server": types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=server))}):
            self.module.emit_stage("8", "sampling")
            server.send_sync.assert_not_called()
            self.module.emit_stage("7", "sampling")
            server.send_sync.assert_called_once_with("qwen_stage", {"prompt_id": "p1", "node": "7", "stage": "sampling"}, "c1")

    def test_generation_and_upscale_return_detached_workbench_context(self):
        context = {'operation': 'edit', 'targetResultId': 'r1', 'sourceVersionId': 'v2',
                   'draft': {'prompt': 'edit', 'refs': [{'id': 'ref1'}]}}
        extra = {'qwen_operation': context, 'workflow': {}}
        generated = self.module.make_result(torch.zeros((1, 24, 16, 3)), {}, extra_pnginfo=extra)
        upscale = self.module.QwenImage21AutoUpscale().upscale('source.png', 'qwen_auto', 2, 'ULTRA', 'r1',
                                                               extra_pnginfo=extra, execution_token='request1')
        context['draft']['refs'][0]['id'] = 'changed'
        self.assertEqual(generated['workbenchContext']['draft']['refs'][0]['id'], 'ref1')
        self.assertEqual(upscale['ui']['qwen_upscale'][0]['workbenchContext']['sourceVersionId'], 'v2')
        self.assertEqual(upscale['ui']['qwen_upscale'][0]['workbenchContext']['draft']['refs'][0]['id'], 'ref1')
        self.assertIsNone(self.module.make_result(torch.zeros((1, 24, 16, 3)), {})['workbenchContext'])

    def test_generation_keeps_outputs_and_actual_snapshot(self):
        package = types.ModuleType("qwen_backend_test")
        package.__path__ = [str(ROOT)]
        samplers = types.SimpleNamespace(KSampler=types.SimpleNamespace(SAMPLERS=["euler"], SCHEDULERS=["simple"]))
        comfy = types.ModuleType("comfy")
        comfy.__path__ = []
        comfy.samplers = samplers
        qwen = types.ModuleType("comfy_extras.nodes_qwen")
        latent = {"samples": "original latent"}
        qwen.TextEncodeQwenImage21 = types.SimpleNamespace(execute=Mock(return_value=("positive", "negative", latent)))
        qwen.QwenImage21Cache = types.SimpleNamespace(execute=Mock(return_value=("cached model",)))
        for name in ["UNETLoader", "CLIPLoader", "VAELoader", "EmptyLatentImage", "LoraLoaderModelOnly"]:
            setattr(self.core, name, Mock())
        sampler = Mock()
        sampler.sample.return_value = ({"samples": "sampled latent"},)
        self.core.KSampler = lambda: sampler
        decoder = Mock()
        decoder.decode.return_value = (torch.zeros((1, 24, 16, 3)),)
        self.core.VAEDecode = lambda: decoder
        modules = {"qwen_backend_test": package, "qwen_backend_test.result_nodes": self.module,
                   "comfy": comfy, "comfy.samplers": samplers,
                   "comfy_extras": types.ModuleType("comfy_extras"), "comfy_extras.nodes_qwen": qwen}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location("qwen_backend_test.nodes", ROOT / "nodes.py")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            node = mod.QwenImage21Auto()
            schema = node.INPUT_TYPES()
            self.assertEqual(schema["required"]["steps"][1]["default"], 24)
            self.assertEqual(list(schema["optional"])[-4:], ["rtx_scale", "rtx_quality", "execution_token", "region_json"])
            self.assertTrue(schema["optional"]["execution_token"][1]["forceInput"])
            self.assertTrue(schema["optional"]["region_json"][1]["forceInput"])
            self.assertEqual(schema["optional"]["rtx_scale"], self.module.QwenImage21AutoUpscale.INPUT_TYPES()["required"]["scale"])
            self.assertEqual(schema["optional"]["rtx_scale"][0], "FLOAT")
            self.assertTrue(node.OUTPUT_NODE)
            result = node.generate(prompt="hello", negative_prompt="ignored", unet_name="unet", clip_name="clip", vae_name="vae",
                aspect_ratio="auto", width=1024, height=1024, steps=18, cfg=1, seed=100, denoise=1,
                show_advanced=False, model="injected model", clip="injected clip", vae="injected vae", enable_te_speed=False,
                cache_device="off")
            self.assertEqual(result["result"][2], latent)
            self.assertEqual(len(result["result"]), 4)
            self.assertEqual(list(result["ui"]), ["qwen_result"])
            snapshot = result["ui"]["qwen_result"][0]["snapshot"]
            self.assertEqual((snapshot["seed"], snapshot["steps"], snapshot["width"], snapshot["height"]), (100, 18, 16, 24))
            self.assertEqual(snapshot["negative_prompt"], "")
            self.assertEqual(snapshot["effective_cache_device"], "off")
            self.assertEqual(sampler.sample.call_args.kwargs["seed"], 100)
            json.dumps(result["ui"])


if __name__ == "__main__":
    unittest.main()
