import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import json

import numpy as np
from PIL import Image
import torch


class RegionEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for kind in ('input', 'output', 'temp'):
            (self.root / kind).mkdir()
        paths = types.SimpleNamespace(**{f'get_{kind}_directory': (lambda kind=kind: str(self.root / kind))
                                        for kind in ('input', 'output', 'temp')})
        with patch.dict(sys.modules, {'folder_paths': paths}):
            spec = importlib.util.spec_from_file_location('region_test_module', Path(__file__).resolve().parents[1] / 'region_edit.py')
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)
        self.source = np.zeros((6, 8, 4), dtype=np.uint8)
        self.source[:] = [25, 75, 120, 80]
        self.source[0, 0] = [32, 51, 92, 0]
        Image.fromarray(self.source).save(self.root / 'output/source.png')
        mask = np.zeros((6, 8), dtype=np.uint8)
        mask[2:4, 2:5] = 255
        Image.fromarray(mask).save(self.root / 'input/mask.png')
        self.descriptor = {'name': 'source.png [output]', 'type': 'output'}
        self.region = {'mode': 'mask', 'source': self.descriptor,
                       'auxiliary': {'name': 'mask.png', 'type': 'input'},
                       'width': 8, 'height': 6, 'feather': 0}

    def prepare(self, **changes):
        return self.module.prepare_region(json.dumps({**self.region, **changes}), [self.descriptor])

    def test_mask_preserves_outside_pixels_alpha_and_resizes_generated(self):
        region = self.prepare()
        output = self.module.finish_region(torch.ones((1, 3, 4, 3)), region)
        self.assertEqual(tuple(output.shape), (1, 6, 8, 4))
        keep = region['mask'][0, :, :, 0] == 0
        self.assertTrue(torch.equal(output[0][keep], region['source'][0][keep]))
        self.assertTrue(torch.all(output[0, 2:4, 2:5, 3] == 1))
        self.assertTrue(torch.all(output[0, 2:4, 2:5, :3] == 1))

    def test_feather_produces_blended_edge_and_rejects_empty_mask(self):
        region = self.prepare(feather=1)
        self.assertTrue(torch.any((region['mask'] > 0) & (region['mask'] < 1)))
        Image.new('L', (8, 6), 0).save(self.root / 'input/mask.png')
        with self.assertRaisesRegex(ValueError, '蒙版为空'):
            self.prepare()

    def test_dimensions_are_verified_against_both_actual_files(self):
        with self.assertRaisesRegex(ValueError, '尺寸'):
            self.prepare(width=9)
        Image.new('RGB', (7, 6)).save(self.root / 'input/mask.png')
        with self.assertRaisesRegex(ValueError, '尺寸'):
            self.prepare()

    def test_requires_source_first_and_reserves_auxiliary_reference_slot(self):
        other = {'name': 'other.png', 'type': 'output'}
        Image.new('RGB', (8, 6)).save(self.root / 'output/other.png')
        with self.assertRaisesRegex(ValueError, '第一张'):
            self.module.prepare_region(json.dumps(self.region), [other, self.descriptor])
        with self.assertRaisesRegex(ValueError, '10 张'):
            self.module.prepare_region(json.dumps(self.region), [self.descriptor] * 10)
        region = self.module.prepare_region(json.dumps(self.region), [self.descriptor] * 9)
        self.assertIn('<image10>', region['instruction'])

    def test_rejects_external_paths_and_mismatched_annotations(self):
        for name in ('../source.png', 'C:/source.png', '/source.png'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.prepare(source={'name': name, 'type': 'output'})
        with self.assertRaises(ValueError):
            self.prepare(source={'name': 'source.png [input]', 'type': 'output'})

    def test_comments_append_annotation_instruction_without_compositing(self):
        region = self.prepare(mode='comments')
        self.assertIsNone(region['mask'])
        self.assertIn('<image2>', region['instruction'])
        self.assertIn('不要把编号', region['instruction'])
        output = self.module.finish_region(torch.ones((1, 3, 4, 3)), region)
        self.assertEqual(tuple(output.shape), (1, 6, 8, 3))
        self.assertTrue(torch.all(output == 1))

    def test_rgba_generation_alpha_retained_for_comments_and_mask_inside(self):
        generated = torch.ones((1, 6, 8, 4))
        generated[..., 3] = 0.4
        self.assertTrue(torch.equal(self.module.finish_region(generated, self.prepare(mode='comments')), generated))
        region = self.prepare()
        output = self.module.finish_region(generated, region)
        self.assertTrue(torch.all(output[0, 2:4, 2:5, 3] == 0.4))
        keep = region['mask'][0, :, :, 0] == 0
        self.assertTrue(torch.equal(output[0][keep], region['source'][0][keep]))

    def test_malformed_reference_collection_fails_clearly(self):
        for refs in (None, {}, 'source.png', [None]):
            with self.subTest(refs=refs), self.assertRaises(ValueError):
                self.module.prepare_region(json.dumps(self.region), refs)

    def test_serialized_reference_annotation_supplies_missing_type(self):
        serialized_ref = {'name': 'source.png [output]', 'id': 'stable-reference-id'}
        region = self.module.prepare_region(json.dumps(self.region), [serialized_ref])
        self.assertEqual((region['width'], region['height']), (8, 6))
        self.assertTrue(torch.equal(region['source'][0], torch.from_numpy(self.source.astype(np.float32) / 255)))


if __name__ == '__main__':
    unittest.main()
