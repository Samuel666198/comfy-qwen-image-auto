import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from panel_config import parse_lora_rows, resolve_accelerators, resolve_kv_cache, resolve_prompt_refs, pixel_budget_size


class PanelConfigTests(unittest.TestCase):
    def test_resolution_is_square_equivalent_pixel_budget(self):
        for side in (1024, 2048, 4096):
            width, height = pixel_budget_size(16, 9, side)
            self.assertAlmostEqual(width / height, 16 / 9, delta=0.03)
            self.assertAlmostEqual(width * height, side * side, delta=side * side * 0.03)
            self.assertEqual(width % 32, 0)
            self.assertEqual(height % 32, 0)
        self.assertEqual(pixel_budget_size(1, 1, 1024), (1024, 1024))
    def test_prompt_tags_follow_reference_identity(self):
        refs = [{"id": "b"}, {"id": "a"}]
        self.assertEqual(resolve_prompt_refs("画 [[qwen-ref:a]] 和 [[qwen-ref:b]]", refs, {1, 2}), "画 <image2> 和 <image1>")
        self.assertEqual(resolve_prompt_refs("旧 <image1> 文字", refs), "旧 <image1> 文字")
        with self.assertRaisesRegex(ValueError, "已失效"):
            resolve_prompt_refs("[[qwen-ref:deleted]]", refs)
        with self.assertRaisesRegex(ValueError, "无法读取"):
            resolve_prompt_refs("[[qwen-ref:a]]", refs, {1})
        with self.assertRaisesRegex(ValueError, "前有无法读取"):
            resolve_prompt_refs("[[qwen-ref:a]]", refs, {2})
    def test_lora_state_preserves_zero_and_disabled(self):
        rows = parse_lora_rows('[{"name":"a","strength":0},{"name":"b","enabled":false,"strength":"bad"}]')
        self.assertEqual(rows[0], {"name": "a", "strength": 0.0, "enabled": True})
        self.assertEqual(rows[1], {"name": "b", "strength": 1.0, "enabled": False})

    def test_old_accelerators_and_new_card_filtering(self):
        old = resolve_accelerators("", enable_te_speed=False, cache_device="cpu")
        self.assertEqual([(c["type"], c["enabled"]) for c in old],
                         [("te_speed", False), ("kv_cache", True)])
        status = []
        cards = resolve_accelerators('[{"type":"kv_cache","enabled":false},{"type":"kv_cache"},{"type":"other"}]', status=status)
        self.assertEqual([(c["type"], c["enabled"]) for c in cards], [("kv_cache", False)])
        self.assertEqual(len(status), 2)

    def test_disabled_or_removed_kv_card_explicitly_turns_off_core_cache(self):
        for raw in ('[{"type":"kv_cache","enabled":false}]',
                    '[{"type":"te_speed","enabled":true}]', '[]'):
            cards = resolve_accelerators(raw)
            self.assertEqual(resolve_kv_cache(cards), ("off", "default"))
        old = resolve_accelerators("", cache_device="cpu", cache_dtype="int8")
        self.assertEqual(resolve_kv_cache(old), ("cpu", "int8"))
        bad = resolve_accelerators('[{"type":"kv_cache","config":{"device":"bad"}}]')
        self.assertEqual(resolve_kv_cache(bad), ("off", "default"))


if __name__ == "__main__":
    unittest.main()
