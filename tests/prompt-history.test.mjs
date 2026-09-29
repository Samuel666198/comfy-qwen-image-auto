import test from 'node:test';
import assert from 'node:assert/strict';
import { readableSnapshotPrompt, mentionCandidates, resolveMentionReference } from '../web/prompt-history.mjs';

test('history copy preserves saved reference order and labels missing references', () => {
  assert.equal(readableSnapshotPrompt({prompt:'[[qwen-ref:b]] and [[qwen-ref:lost]]',refs:[{id:'a'},{id:'b'}]}), '@图片2 and @图片已删除');
});

test('mention search groups current refs and preserves generated version identity', () => {
  const generated = {id:'work-v2',label:'作品 A · V2',sourceResultId:'work',sourceVersionId:'v2'};
  const candidates = mentionCandidates([{id:'r',name:'upload.png'}], [generated]);
  assert.equal(candidates[0].mentionLabel, '图片1 · upload.png');
  assert.equal(candidates[1].mentionGroup, '已生成作品');
  assert.equal(candidates[1].sourceVersionId, 'v2');
  assert.equal(mentionCandidates([], [generated], 'V2').length, 1);
  assert.equal(mentionCandidates([], [generated], 'V3').length, 0);
});

test('generated mentions require successful synchronous registration before a chip is inserted', () => {
  const generated = {id:'work-v2',generated:true};
  assert.equal(resolveMentionReference(generated, () => null), null);
  assert.equal(resolveMentionReference(generated, () => { throw new Error('limit'); }), null);
  assert.equal(resolveMentionReference(generated, () => Promise.resolve({id:'r'})), null);
  assert.deepEqual(resolveMentionReference(generated, () => ({id:'registered'})), {id:'registered'});
  assert.equal(resolveMentionReference({id:'existing'}).id, 'existing');
});
