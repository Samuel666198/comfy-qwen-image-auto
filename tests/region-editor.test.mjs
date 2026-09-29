import test from 'node:test';
import assert from 'node:assert/strict';
import { containRect, imagePoint, normalizedRectangle } from '../web/region-editor.mjs';

test('portrait image excludes horizontal letterboxing before coordinate conversion', () => {
  const r = containRect(896, 1184, 1000, 600);
  assert.equal(r.height, 600);
  assert.ok(r.left > 270);
  const rect = { left: 30 + r.left, top: 50 + r.top, width: r.width, height: r.height };
  assert.deepEqual(imagePoint(rect.left + rect.width / 2, rect.top + rect.height / 2, rect, 896, 1184), { x: 448, y: 592 });
});
test('resized landscape image gives identical original coordinates', () => {
  for (const [width,height] of [[900,600],[450,300],[1600,400]]) {
    const r=containRect(1600,900,width,height);
    const rect={left:10+r.left,top:20+r.top,width:r.width,height:r.height};
    assert.deepEqual(imagePoint(rect.left+rect.width*.25,rect.top+rect.height*.75,rect,1600,900),{x:400,y:675});
  }
});
test('captured pointer dragged past image bounds stays within source pixels', () => {
  const rect={left:100,top:200,width:400,height:600};
  assert.deepEqual(imagePoint(-100,-200,rect,800,1200),{x:0,y:0});
  assert.deepEqual(imagePoint(1000,2000,rect,800,1200),{x:799,y:1199});
});
test('rectangle drawn in reverse is normalized to top-left and bottom-right', () => {
  assert.deepEqual(normalizedRectangle({x:700,y:1000},{x:20,y:35}),{x1:20,y1:35,x2:700,y2:1000});
});
