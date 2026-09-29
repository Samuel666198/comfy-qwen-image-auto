import test from 'node:test';
import assert from 'node:assert/strict';
import {regionPrompt,replaceRegionPrompt,regionForSubmission} from '../web/region-state.mjs';
import {addPromptSnapshot} from '../web/version-state.mjs';
test('quadrant-tagged region prompt updates once and rejects modified block',()=>{
  const r={mode:'mask',width:896,height:1184,annotations:[{kind:'annotationRect',color:'blue',bounds:{x1:500,y1:20,x2:800,y2:240},text:'变蓝'}]};
  const block=regionPrompt(r,'stable');assert.match(block,/图片右上角的蓝色标注区域：变蓝/);assert.doesNotMatch(block,/请基于|qwen-ref:|坐标原点|未标注区域保持/);
  const prompt=replaceRegionPrompt('保留光照',null,block);
  assert.equal(replaceRegionPrompt(prompt,block,block),prompt);
  assert.throws(()=>replaceRegionPrompt('用户改写过',block,'new'),/手动修改/);
});
test('source binding, auxiliary limit, and region snapshots survive independently',()=>{
  const source={name:'test.png',type:'output'},r={mode:'mask',source,drawings:[{kind:'rect',x1:0,y1:0,x2:20,y2:20}]};
  assert.equal(JSON.parse(regionForSubmission(r,[source])).mode,'mask');
  assert.throws(()=>regionForSubmission(r,[{...source,type:'input'}]),/第一张/);
  assert.throws(()=>regionForSubmission(r,Array(10).fill(source)),/最多9/);
  const history=addPromptSnapshot([],{id:'h',prompt:'mask',refs:[source],region:r});r.drawings[0].x2=100;
  assert.equal(history[0].region.drawings[0].x2,20);
  assert.equal(addPromptSnapshot(history,{prompt:'mask',refs:[source],region:r}).length,2);
});
