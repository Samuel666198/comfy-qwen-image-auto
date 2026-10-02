import test from 'node:test';
import assert from 'node:assert/strict';
import {createGenerationController, estimateRemaining, graphReferencesNode} from '../web/generation-controller.mjs';
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
test('region is frozen before async workflow creation and sent to backend',async t=>{
  let release;
  const s=setup(t,{getWorkflow:()=>new Promise(resolve=>release=()=>resolve({output:{14:{inputs:{steps:1,seed:1}}},workflow:{nodes:[]}}))});
  const region={mode:'mask',sourceVersionId:'v1'};
  const pending=s.c.generate({operation:'inpaint',region});region.sourceVersionId='v2';release();await pending;
  const request=s.calls.find(c=>c.path==='/prompt').body;
  assert.equal(JSON.parse(request.prompt['14'].inputs.region_json).sourceVersionId,'v1');
});
test('transparent background prepends a runtime-only prompt constraint', async t=>{
  const s=setup(t,{getWorkflow:async()=>({output:{14:{inputs:{prompt:'原始提示词',steps:24}}},workflow:{}})});
  await s.c.generate({transparentBackground:true,draft:{prompt:'原始提示词'}});
  const posted=s.calls.find(call=>call.path==='/prompt').body.prompt['14'].inputs.prompt;
  assert.equal(posted,'这是一张带有 Alpha 通道的 RGBA 图像，主体之外的背景透明。\n原始提示词');
  assert.equal(s.c.getJob().snapshot.prompt,'原始提示词');
});
function setup(t, overrides = {}) {
  const calls = [], states = [], results = [], accepted = [];
  const api = new EventTarget(); api.clientId = 'client';
  let queue = {queue_running:[],queue_pending:[]}, history = {}, failQueue = false;
  api.fetchApi = async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    calls.push({path,body});
    if (overrides.fetch) { const response = await overrides.fetch(path,body); if (response) return response; }
    if (path === '/prompt') { queue.queue_pending.push([0,body.prompt_id,body.prompt,body.extra_data,body.partial_execution_targets]); return Response.json({prompt_id:body.prompt_id}); }
    if (path === '/queue') {
      if (failQueue) throw Error('offline');
      if (body) queue.queue_pending = queue.queue_pending.filter(item => !body.delete.includes(item[1]));
      return Response.json(queue);
    }
    if (/^\/api\/jobs\/[^/]+\/cancel$/.test(path)) {
      if (failQueue) throw Error('offline');
      const id=decodeURIComponent(path.split('/')[3]);
      queue.queue_running=queue.queue_running.filter(item=>item[1]!==id);
      queue.queue_pending=queue.queue_pending.filter(item=>item[1]!==id);
      return Response.json({cancelled:true});
    }
    if (path.startsWith('/history/')) return Response.json(history);
    throw Error(path);
  };
  const node = {id:14,properties:{qwenWorkbench:{ownerId:'owner',activeJob:null}}};
  const c = createGenerationController({node,api,getWorkflow:overrides.getWorkflow || (async()=>({output:{14:{inputs:{steps:24,seed:100},class_type:'QwenImage21Auto'}},workflow:{nodes:[{id:14,properties:{qwenWorkbench:{ownerId:'owner'}}}]}})),onState:job=>states.push(job),onResult:(...r)=>results.push(r),onAccepted:job=>accepted.push(job),getSeedNext:()=>101});
  t.after(()=>c.destroy());
  return {c,api,node,calls,states,results,accepted, emit(type,detail){api.dispatchEvent(new CustomEvent(type,{detail}));},setQueue(value){queue=value;},setHistory(value){history=value;},setOffline(value){failQueue=value;}};
}
test('estimate and dependency targeting', () => {
  assert.equal(estimateRemaining({steps:18}),54); assert.equal(estimateRemaining({steps:24}),72); assert.equal(estimateRemaining({steps:40}),120);
  assert.equal(estimateRemaining({steps:24,completedSteps:6,sampleElapsedMs:24000}),72);
  const graph={14:{inputs:{}},15:{inputs:{image:['14',0]}},16:{inputs:{image:['17',0]}},17:{inputs:{image:['16',0]}}};
  assert.equal(graphReferencesNode(graph,['15'],'14'),true); assert.equal(graphReferencesNode(graph,['16'],'14'),false);
});
test('submission is non-reentrant and accepted seed update occurs once', async t => {
  const s=setup(t); const first=s.c.generate(); assert.equal(await s.c.generate(),false); await first; await flush();
  assert.equal(s.calls.filter(c=>c.path==='/prompt').length,1); assert.equal(s.accepted.length,1);
  assert.equal(s.accepted[0].snapshot.seed,100); assert.equal(s.accepted[0].seedNext,101);
  await s.c.reconcile(); s.emit('execution_start',{prompt_id:s.c.getJob().promptId}); assert.equal(s.accepted.length,1);
});
test('foreign events and other node progress cannot mutate the tracked job', async t => {
  const s=setup(t); await s.c.generate(); await flush(); const id=s.c.getJob().promptId;
  s.emit('execution_start',{prompt_id:id}); s.emit('executing','14'); s.emit('progress',{value:2,max:24});
  assert.equal(s.c.getJob().completedSteps,2);
  s.emit('executed',{prompt_id:'foreign',node:'14',output:{qwen_result:[{id:'wrong'}]}});
  s.emit('execution_success',{prompt_id:'foreign'}); s.emit('progress',{prompt_id:id,node:'15',value:20,max:24});
  assert.equal(s.c.getJob().state,'running'); assert.equal(s.c.getJob().completedSteps,2); assert.equal(s.results.length,0);
  s.emit('executing',null); s.emit('progress',{value:9,max:24}); assert.equal(s.c.getJob().completedSteps,2);
});
test('cancel uses only tracked prompt and waits for queue/history confirmation', async t => {
  const s=setup(t); await s.c.generate(); await flush(); const id=s.c.getJob().promptId; await s.c.cancel();
  assert.deepEqual(s.calls.find(c=>c.path===`/api/jobs/${id}/cancel`).body,{});
  assert.equal(s.calls.some(c=>c.path==='/interrupt'||(c.path==='/queue'&&c.body)),false); assert.equal(s.c.getJob().state,'cancelled');
});
test('completion wins cancel race and result delivered once', async t => {
  const s=setup(t); await s.c.generate(); await flush(); const id=s.c.getJob().promptId;
  const result={id:'image'}; const output={qwen_result:[result]};
  s.emit('executed',{prompt_id:id,node:'14',output});
  s.setHistory({[id]:{outputs:{14:output},status:{completed:true,messages:[]}}}); s.setQueue({queue_pending:[],queue_running:[]});
  await s.c.cancel(); assert.equal(s.c.getJob().state,'completed'); assert.equal(s.results.length,1);
});
test('ambiguous accepted request recovers without duplicate seed consumption or submission', async t => {
  let pending;
  const s=setup(t,{fetch(path,body){if(path==='/prompt'){pending=body; throw Error('lost response');}}});
  await s.c.generate(); await flush(); assert.equal(s.c.getJob().state,'reconciling'); assert.equal(s.accepted.length,0);
  s.setQueue({queue_pending:[[0,pending.prompt_id,pending.prompt,pending.extra_data,pending.partial_execution_targets]],queue_running:[]});
  await s.c.reconcile(); assert.equal(s.c.getJob().state,'queued'); assert.equal(s.accepted.length,1);
  s.emit('reconnected',{}); await flush(); assert.equal(s.accepted.length,1); assert.equal(s.calls.filter(c=>c.path==='/prompt').length,1);
});
test('failure before HTTP submission is immediately editable', async t => {
  const s=setup(t,{getWorkflow:async()=>{throw Error('invalid graph');}}); await s.c.generate();
  assert.equal(s.c.getJob().state,'failed'); assert.equal(s.accepted.length,0); assert.equal(s.calls.filter(c=>c.path==='/prompt').length,0);
});
test('destroy blocks new submissions and removes listeners', async t => {
  const s=setup(t); s.c.destroy(); assert.equal(await s.c.generate(),false); assert.equal(s.calls.length,0);
});
test('upscale uses saved original and never consumes generation seed', async t => {
  const s=setup(t); await s.c.upscale({id:'result',original:{filename:'saved.png',subfolder:'qwen_auto'}},{scale:2,quality:'ULTRA'}); await flush();
  const body=s.calls.find(c=>c.path==='/prompt').body; assert.equal(body.prompt['14'].class_type,'QwenImage21AutoUpscale');
  assert.equal(body.prompt['14'].inputs.filename,'saved.png'); assert.equal(s.accepted.length,0);
});

test('HTTP rejection leaves seed untouched and allows retry', async t => {
  const s=setup(t,{fetch(path){if(path==='/prompt')return Response.json({error:{message:'bad input'}},{status:400});}});
  await s.c.generate(); assert.equal(s.c.getJob().state,'failed'); assert.equal(s.accepted.length,0);
});
test('cancel intent survives a disconnected confirmation and reconnect', async t => {
  const s=setup(t); await s.c.generate(); await flush(); s.setOffline(true); await s.c.cancel();
  assert.equal(s.c.getJob().state,'reconciling'); s.setOffline(false);
  s.setQueue({queue_pending:[],queue_running:[]}); await s.c.reconcile();
  assert.equal(s.c.getJob().state,'cancelled');
});

test('offline cancellation retries the atomic endpoint while the owned task remains queued', async t => {
  const s=setup(t); await s.c.generate(); await flush(); const id=s.c.getJob().promptId;
  s.setOffline(true); await s.c.cancel(); assert.equal(s.c.getJob().state,'reconciling');
  const before=s.calls.filter(call=>call.path===`/api/jobs/${id}/cancel`).length;
  s.setOffline(false); await s.c.reconcile();
  assert.equal(s.calls.filter(call=>call.path===`/api/jobs/${id}/cancel`).length,before+1);
  await s.c.reconcile(); assert.equal(s.c.getJob().state,'cancelled');
  assert.equal(s.calls.some(call=>call.path==='/interrupt'||(call.path==='/queue'&&call.body)),false);
});

test('safe cancel unsupported never falls back or repeatedly sends unavailable endpoint', async t => {
  const s=setup(t,{fetch(path){if(path.endsWith('/cancel'))return Response.json({error:'unsupported'},{status:404});}});
  await s.c.generate(); await flush(); await s.c.cancel();
  assert.equal(s.c.getJob().cancelUnsupported,true);
  assert.match(s.c.getJob().message,/不支持安全定向取消/);
  const before=s.calls.length; await s.c.reconcile();
  assert.equal(s.calls.slice(before).some(call=>call.path.endsWith('/cancel')),false);
  assert.equal(s.calls.some(call=>call.path==='/interrupt'||(call.path==='/queue'&&call.body)),false);
});

test('atomic cancel no-op is not proof of cancellation and does not target a successor', async t => {
  const s=setup(t,{fetch(path){if(path.endsWith('/cancel'))return Response.json({cancelled:false});}});
  await s.c.generate(); await flush(); const id=s.c.getJob().promptId;
  await s.c.cancel(); assert.equal(s.c.getJob().state,'cancelling');
  s.setQueue({queue_running:[[0,'successor',{}, {},['99']]],queue_pending:[]});
  s.setHistory({[id]:{outputs:{},status:{completed:true,messages:[]}}});
  await s.c.reconcile(); assert.equal(s.c.getJob().state,'completed');
  assert.equal(s.calls.filter(call=>call.path.endsWith('/cancel')).every(call=>call.path===`/api/jobs/${id}/cancel`),true);
});
test('global queue matching requires owner identity and upstream dependency', async t => {
  const s=setup(t); const prompt={14:{inputs:{steps:18}},15:{inputs:{image:['14',0]}}};
  const item=[1,'external',prompt,{extra_pnginfo:{workflow:{nodes:[{id:14,properties:{qwenWorkbench:{ownerId:'other'}}}]}}},['15']];
  s.setQueue({queue_pending:[item],queue_running:[]}); await s.c.reconcile(); assert.equal(s.c.getJob(),null);
  item[3].extra_pnginfo.workflow.nodes[0].properties.qwenWorkbench.ownerId='owner';
  await s.c.reconcile(); assert.equal(s.c.getJob().promptId,'external'); assert.equal(s.c.getJob().owned,false);
  await s.c.cancel(); assert.equal(s.calls.filter(c=>c.path==='/interrupt').length,0);
});
test('stale queue response cannot revive completed job or overwrite newer submission', async t => {
  let resolveQueue, hold=false;
  const s=setup(t,{fetch(path,body){if(path==='/queue'&&!body&&hold)return new Promise(resolve=>{resolveQueue=resolve;});}});
  await s.c.generate(); await flush(); const old=s.c.getJob().promptId;
  hold=true; const reconciliation=s.c.reconcile();
  s.emit('execution_success',{prompt_id:old}); await s.c.generate(); const next=s.c.getJob().promptId;
  assert.notEqual(next,old); resolveQueue(Response.json({queue_pending:[],queue_running:[]})); await reconciliation;
  assert.equal(s.c.getJob().promptId,next); assert.equal(s.c.getJob().state,'queued');
});
test('history after completion supplies cached outputs once', async t => {
  const s=setup(t); await s.c.generate(); await flush(); const id=s.c.getJob().promptId;
  s.setHistory({[id]:{outputs:{14:{qwen_result:[{id:'cached'}]}},status:{completed:true}}});
  s.emit('execution_success',{prompt_id:id}); await flush(); s.emit('execution_success',{prompt_id:id}); await flush();
  assert.equal(s.results.length,1); assert.equal(s.c.getJob().state,'completed');
});

test('restore reads configured properties without rebuilding listeners or consuming seed twice', async t => {
  const s=setup(t); await s.c.generate(); await flush(); const old=s.c.getJob().promptId;
  s.emit('execution_start',{prompt_id:old}); s.emit('executing','14');
  const restored={promptId:'restored',nodeId:'14',kind:'generate',state:'queued',submittedAt:Date.now(),owned:true,accepted:true,seedUpdated:true,snapshot:{steps:40}};
  s.node.properties.qwenWorkbench={ownerId:'owner',activeJob:restored};
  s.setQueue({queue_running:[[0,'restored',{}, {},['14']]],queue_pending:[]});
  await s.c.restore(); assert.equal(s.c.getJob().promptId,'restored'); assert.equal(s.c.getJob().state,'running');
  s.emit('progress',{value:8,max:40}); assert.equal(s.c.getJob().completedSteps,undefined);
  s.emit('execution_success',{prompt_id:old}); assert.equal(s.c.getJob().state,'running');
  assert.equal(s.accepted.length,1);
  s.emit('executed',{prompt_id:'restored',node:'14',output:{qwen_result:[{id:'restore-result'}]}});
  assert.equal(s.results.length,1);
  s.node.properties.qwenWorkbench.activeJob=null; await s.c.restore(); assert.equal(s.c.getJob(),null);
  assert.equal(s.calls.filter(c=>c.path==='/interrupt').length,0);
});
test('restore waits out previous queue read and then checks the restored prompt', async t => {
  let finish, hold=false;
  const s=setup(t,{fetch(path,body){if(path==='/queue'&&!body&&hold){hold=false;return new Promise(resolve=>{finish=resolve;});}}});
  await s.c.generate(); await flush(); hold=true; const oldCheck=s.c.reconcile();
  s.node.properties.qwenWorkbench.activeJob={promptId:'configured',nodeId:'14',kind:'generate',state:'queued',submittedAt:Date.now(),accepted:true,owned:true,seedUpdated:true};
  s.setQueue({queue_running:[[0,'configured',{}, {},['14']]],queue_pending:[]});
  const restore=s.c.restore(); finish(Response.json({queue_running:[],queue_pending:[]})); await oldCheck; await restore;
  assert.equal(s.c.getJob().promptId,'configured'); assert.equal(s.c.getJob().state,'running');
});

test('submission captures operation target and draft before asynchronous workflow read', async t => {
  let finish;
  const s=setup(t,{getWorkflow:()=>new Promise(resolve=>{finish=resolve;})});
  const context={operation:'edit',targetResultId:'work-a',sourceVersionId:'v2',draft:{prompt:'edit',refs:[{id:'ref'}]}};
  const pending=s.c.generate(context);
  context.targetResultId='work-b';context.draft.refs[0].id='changed';
  finish({output:{14:{class_type:'QwenImage21Auto',inputs:{seed:100,steps:24}}},workflow:{}});
  await pending;
  const posted=s.calls.find(call=>call.path==='/prompt').body;
  const captured=posted.extra_data.extra_pnginfo.qwen_operation;
  assert.equal(captured.targetResultId,'work-a');assert.equal(captured.sourceVersionId,'v2');
  assert.equal(captured.draft.refs[0].id,'ref');assert.equal(captured.operation,'edit');
  assert.equal(captured.promptId,posted.prompt_id);assert.equal(captured.ownerId,'owner');
  s.emit('executed',{prompt_id:posted.prompt_id,node:'14',output:{qwen_result:[{id:'result'}]}});
  assert.deepEqual(s.results[0][2],captured);
});

test('restoring accepted job delivers original operation context without accepting seed again', async t => {
  const s=setup(t);
  const context={operation:'regenerate',targetResultId:'work',sourceVersionId:'v3',draft:{prompt:'saved',refs:[]}};
  s.node.properties.qwenWorkbench.activeJob={promptId:'saved-job',nodeId:'14',kind:'generate',state:'queued',owned:true,accepted:true,seedUpdated:true,context};
  s.setQueue({queue_running:[[0,'saved-job',{}, {},['14']]],queue_pending:[]});
  await s.c.restore();
  s.emit('executed',{prompt_id:'saved-job',node:'14',output:{qwen_result:[{id:'restored-output'}]}});
  assert.deepEqual(s.results[0][2],context);assert.equal(s.accepted.length,0);
});

test('repeated fixed seed submissions change execution token but preserve requested seed', async t => {
  const s=setup(t);
  await s.c.generate({operation:'regenerate',targetResultId:'work'});await flush();
  s.emit('execution_success',{prompt_id:s.c.getJob().promptId});await flush();
  await s.c.generate({operation:'regenerate',targetResultId:'work'});
  const requests=s.calls.filter(call=>call.path==='/prompt').map(call=>call.body);
  assert.equal(requests.length,2);
  assert.notEqual(requests[0].prompt['14'].inputs.execution_token,requests[1].prompt['14'].inputs.execution_token);
  for(const request of requests){assert.equal(request.prompt['14'].inputs.seed,100);assert.equal(request.prompt['14'].inputs.execution_token,request.prompt_id);}
  assert.equal(s.accepted.length,2);assert.equal(s.accepted.every(job=>job.snapshot.seed===100),true);
});
