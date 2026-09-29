import test from 'node:test';
import assert from 'node:assert/strict';
import {toOptimizerPrompt,fromOptimizerPrompt,ollamaRequest} from '../web/prompt-optimizer.mjs';
import {normalizeOptimizerSettings} from '../web/ollama-settings.mjs';

test('optimizer translates stable references in current image order and restores identity',()=>{
  const refs=[{id:'second'},{id:'first'}];
  assert.equal(toOptimizerPrompt('使用 [[qwen-ref:first]] 的背景',refs),'使用 <image2> 的背景');
  assert.equal(fromOptimizerPrompt('Use <image2> and <image1>.',refs),'Use [[qwen-ref:first]] and [[qwen-ref:second]].');
  assert.throws(()=>toOptimizerPrompt('[[qwen-ref:deleted]]',refs),/已删除/);
  assert.throws(()=>fromOptimizerPrompt('<image3>',refs),/不存在/);
  assert.throws(()=>fromOptimizerPrompt(' ',refs),/有效提示词/);
});
test('optimizer reports service errors and invalid response without replacing draft',async()=>{
  await assert.rejects(ollamaRequest({fetchApi:async()=>({ok:false,status:400,json:async()=>({error:'模型不支持图片'})})},'/test',{}),/模型不支持图片/);
  await assert.rejects(ollamaRequest({fetchApi:async()=>({json:async()=>{throw Error();}})},'/test',{}),/重启/);
});

test('optimizer settings migrate flat Ollama workflows and ignore missing nested values',()=>{
  assert.deepEqual(normalizeOptimizerSettings({model:'qwen3-vl:4b',address:'http://127.0.0.1:11434'}),{
    provider:'ollama',
    ollama:{address:'http://127.0.0.1:11434',model:'qwen3-vl:4b',think:'auto',temperature:0.7,num_predict:2048},
    responses:{model:'deepseek-flash',effort:'auto'},
  });
  assert.deepEqual(normalizeOptimizerSettings({provider:'ollama',ollama:{address:undefined,model:undefined},responses:{effort:undefined}}),{
    provider:'ollama',
    ollama:{address:'http://127.0.0.1:11434',model:'',think:'auto',temperature:0.7,num_predict:2048},
    responses:{model:'deepseek-flash',effort:'auto'},
  });
});
