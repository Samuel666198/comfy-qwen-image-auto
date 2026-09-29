import test from 'node:test';
import assert from 'node:assert/strict';
import { hoverPreviewPosition } from '../web/image-hover.mjs';

test('hover preview prefers right, flips near edge and clamps below viewport', () => {
  assert.deepEqual(hoverPreviewPosition({left:20,right:56,top:30},320,400,1000,800),{left:64,top:30});
  assert.deepEqual(hoverPreviewPosition({left:900,right:936,top:650},320,400,1000,800),{left:572,top:392});
  assert.deepEqual(hoverPreviewPosition({left:0,right:36,top:-30},320,400,350,430),{left:8,top:8});
});
