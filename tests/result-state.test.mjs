import test from 'node:test';
import {migrateHistory,currentVersion,selectVersion} from '../web/version-state.mjs';
import assert from 'node:assert/strict';
import { appendResult, applyUpscale, renameResult, selectResultVersion, safeDownloadName, createResultPreview, containImageRect } from '../web/result-preview.mjs';

const result = () => ({ id:'a', title:'作品', original:{filename:'a.png',width:1024,height:1024}, upscaled:null, selectedVersion:'original', snapshot:{steps:24,refs:[{id:'ref'}]} });
test('history preserves every result in generation order and never modifies inputs', () => {
  const previous=Array.from({length:10},(_,i)=>({id:String(i)})); const item=result();
  const next=appendResult(previous,item);
  assert.equal(next.length,11); assert.equal(next[0].id,'0'); assert.equal(next.at(-1).id,'a');
  item.snapshot.refs[0].id='changed'; assert.equal(next.at(-1).snapshot.refs[0].id,'ref');
  assert.equal(previous.length,10);
});
test('failed or absent result does not add history; duplicate success preserves edited record and order', () => {
  const history=[result()]; assert.deepEqual(appendResult(history,null),migrateHistory(history));
  assert.deepEqual(appendResult(history,{id:'b',error:'failed'}),migrateHistory(history));
  assert.equal(appendResult(history,result()).length,1);
  const edited = [{...result(),title:'renamed'}, {...result(),id:'b'}];
  assert.deepEqual(appendResult(edited,result()),migrateHistory(edited));
});
test('upscale targets result ID, detaches file data and preserves original', () => {
  const history=[result(),{...result(),id:'b'}]; const file={filename:'up.png',width:2048,height:2048,scale:2,quality:'ULTRA'};
  const next=applyUpscale(history,{resultId:'a',file}); file.filename='changed';
  assert.equal(currentVersion(next[0]).file.filename,'up.png'); assert.equal(next[0].versions[0].file.filename,'a.png');
  assert.equal(next[0].selectedVersionId,next[0].versions[1].id); assert.equal(next[1].upscaled,null);
  assert.equal(history[0].upscaled,null);
  assert.deepEqual(applyUpscale(history,{resultId:'missing',file}),migrateHistory(history));
  const repeated=applyUpscale(next,{resultId:'a',file:{filename:'up-again.png'}});
  assert.equal(repeated[0].versions[1].file.filename,'up.png');
  assert.equal(currentVersion(repeated[0]).file.filename,'up-again.png');
  assert.equal(applyUpscale(repeated,{resultId:'a',file:{filename:'up-again.png'}})[0].versions.length,3);
});
test('comparison bounds follow the actual contained portrait or landscape image', () => {
  assert.deepEqual(containImageRect(1200,600,400,800),{left:450,top:0,width:300,height:600});
  assert.deepEqual(containImageRect(600,1200,800,400),{left:0,top:450,width:600,height:300});
});
test('rename changes only display name; selected version requires an existing file', () => {
  const history=[result()]; const renamed=renameResult(history,'a',' 新名称 ');
  assert.equal(renamed[0].title,'新名称'); assert.equal(renamed[0].original.filename,'a.png');
  assert.equal(history[0].title,'作品');
  assert.equal(selectResultVersion(history,'a','upscaled')[0].selectedVersion,'original');
  const next=applyUpscale(history,{resultId:'a',file:{filename:'up.png'}});
  assert.equal(selectResultVersion(next,'a','original')[0].selectedVersion,'original');
});
test('download names cannot include filesystem separators or control characters', () => {
  assert.equal(safeDownloadName('../a\\b:*?\u0000','x.png'),'.._a_b____.png');
  assert.equal(safeDownloadName('','x.webp'),'作品.webp');
});

// Small DOM contract stub: checks state writes and event wiring, not browser layout.
class Element {
  constructor(tag) { this.tagName=tag; this.children=[]; this.attributes={}; this.style={}; this.hidden=false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) {this.children=[...children];}
  setAttribute(name,value) { this.attributes[name]=value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener() {}
  focus() { document.activeElement=this; }
  contains(target) { return this===target || this.children.some(child=>child.contains(target)); }
  querySelector(selector) { return this.find(e=>e.tagName===selector); }
  setPointerCapture() {}
  getBoundingClientRect() { return {left:20,width:400}; }
  remove() { this.removed=true; }
  find(predicate) { return predicate(this) ? this : this.children.map(child=>child.find(predicate)).find(Boolean); }
}
test('render is read-only; locked rename/upscale blocked, viewing history remains available, terminal job hides animation', () => {
  const savedDocument=globalThis.document;
  globalThis.document={createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){}};
  try {
    let state={history:[result(),{...result(),id:'b'}],selectedResultId:'unknown'};
    let locked=true, writes=0, calls=0;
    const preview=createResultPreview({getState:()=>state, updateState:patch=>{writes++;state={...state,...patch};},isLocked:()=>locked,onUpscale:()=>calls++});
    const before=JSON.stringify(state); preview.render(); assert.equal(JSON.stringify(state),before); assert.equal(writes,0);
    const title=preview.element.find(e=>e.tagName==='input'); title.value='forbidden'; title.onchange(); assert.equal(writes,0);
    const upscale=preview.element.find(e=>e.textContent==='RTX 超分'); upscale.onclick(); assert.equal(calls,0);
    preview.element.find(e=>e.attributes?.['aria-label']==='上一张').onclick(); assert.equal(state.selectedResultId,'a');
    locked=false; preview.render(); title.value='新名称'; title.onchange(); assert.equal(state.history[0].title,'新名称');
    upscale.onclick(); assert.equal(calls,1);
    const glow=preview.element.find(e=>e.className==='qr-glow');
    preview.setJob({state:'running',stage:'sampling',progress:{value:6,max:24},estimatedSeconds:72}); assert.equal(glow.hidden,false);
    assert.equal(preview.element.find(e=>e.className==='qr-busy-mask').hidden,false);
    assert.match(preview.element.find(e=>e.className==='qr-status').textContent,/6 \/ 24 步.*72 秒/);
    const source=preview.element.find(e=>e.tagName==='img').src;
    const status=preview.element.find(e=>e.className==='qr-status');
    for (const [stage,label] of Object.entries({loading:'加载模型',encoding:'编码提示词',sampling:'采样中',decoding:'解码图片',saving:'保存结果'})) {
      preview.setJob({state:'running',stage}); assert.equal(status.textContent,label);
    }
    preview.setJob({state:'completed',stage:'saving',progress:1,estimatedSeconds:0}); assert.equal(glow.hidden,true); assert.equal(status.textContent,'已完成'); assert.equal(preview.element.find(e=>e.tagName==='img').src,source);
    assert.equal(preview.element.find(e=>e.className==='qr-busy-mask').hidden,true);
    preview.setJob({state:'failed',stage:'sampling',message:'显存不足'}); assert.equal(status.textContent,'任务失败 · 显存不足'); assert.equal(glow.hidden,true);
    preview.setJob({state:'cancelling',stage:'sampling',progress:0.5,estimatedSeconds:20}); assert.equal(status.textContent,'正在取消');
    preview.setJob({state:'queued',estimatedSeconds:72}); assert.equal(status.textContent,'等待队列');
    let blurs=0; title.blur=()=>blurs++;
    title.onkeydown({key:'Enter',isComposing:true}); title.onkeydown({key:'Enter',keyCode:229}); assert.equal(blurs,0);
    title.onkeydown({key:'Enter',isComposing:false,preventDefault(){}}); assert.equal(blurs,1);
    preview.setJob(null); assert.equal(glow.hidden,true); preview.destroy(); assert.equal(preview.element.removed,true);
  } finally { globalThis.document=savedDocument; }
});

function withDOM(run) {
  const savedDocument=globalThis.document, savedWindow=globalThis.window;
  const listeners=new Map();
  globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag),addEventListener(type,fn){ if (!listeners.has(type)) listeners.set(type,new Set()); listeners.get(type).add(fn); },removeEventListener(type,fn){listeners.get(type)?.delete(fn);}};
  globalThis.window={confirm:()=>false};
  try { run(listeners); } finally { globalThis.document=savedDocument; globalThis.window=savedWindow; }
}
test('image menu is top-right, closes outside/Escape, and releases document listeners', () => withDOM(listeners=>{
  const preview=createResultPreview({getState:()=>({history:[result()]}),updateState(){}});
  const toggle=preview.element.find(e=>e.className==='qr-menu-toggle'), menu=preview.element.find(e=>e.className==='qr-toolbar');
  assert.equal(toggle.hidden,false); assert.equal(menu.hidden,true);
  toggle.onclick(); assert.equal(menu.hidden,false); assert.equal(toggle.attributes['aria-expanded'],'true');
  for (const fn of listeners.get('pointerdown')) fn({target:new Element('div')});
  assert.equal(menu.hidden,true);
  toggle.onclick(); for (const fn of listeners.get('keydown')) fn({key:'Escape',preventDefault(){},stopPropagation(){}});
  assert.equal(menu.hidden,true); assert.equal(document.activeElement,toggle);
  toggle.onclick(); preview.destroy(); assert.equal(listeners.get('keydown').size,0); assert.equal(listeners.get('pointerdown').size,0);
}));
test('result navigation uses accessible compact icon actions; double-click opens a non-native draggable viewer', () => withDOM(()=>{
  const preview=createResultPreview({getState:()=>({history:[result()]}),updateState(){}});
  for(const label of ['上一张','下一张','版本历史 · V1','对比','图片管理器']) assert.ok(preview.element.find(e=>e.attributes?.['aria-label']===label),label);
  const image=preview.element.find(e=>e.tagName==='img'); image.ondblclick();
  const viewer=document.body.find(e=>e.className==='qwen-result-viewer');
  const stage=viewer.find(e=>e.className==='qr-view-stage'), full=stage.find(e=>e.tagName==='img');
  assert.equal(full.draggable,false);
  let prevented=false;stage.onpointerdown({button:0,pointerId:1,clientX:10,clientY:20,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.match(full.style.transform,/translate\(/);
  let dragPrevented=false;stage.ondragstart({preventDefault(){dragPrevented=true;}});assert.equal(dragPrevented,true);
  preview.destroy();
}));
test('repeated upscale requires confirmation and preserves the captured result identity', () => withDOM(()=>{
  let item={...result(),upscaled:{filename:'up.png'},selectedVersion:'upscaled'}, locked=false;
  const calls=[];
  const preview=createResultPreview({getState:()=>({history:[item]}),updateState(){},isLocked:()=>locked,onUpscale:id=>calls.push(id)});
  const action=preview.element.find(e=>e.textContent==='RTX 超分');
  action.onclick(); assert.deepEqual(calls,[]);
  window.confirm=()=>{ item={...item,id:'b'}; preview.render(); return true; };
  action.onclick(); assert.deepEqual(calls,['a']);
  window.confirm=()=>{locked=true;return true;}; action.onclick(); assert.deepEqual(calls,['a']);
  preview.destroy();
}));
test('compare uses separate original/upscaled URLs and a keyboard range on a shared image box', () => withDOM(listeners=>{
  let state={history:[result()]};
  const preview=createResultPreview({getState:()=>state,updateState(){}});
  const compare=preview.element.find(e=>e.attributes?.['aria-label']==='对比'); assert.equal(compare.disabled,true);
  state={history:applyUpscale(state.history,{resultId:'a',file:{filename:'up.png'}})}; preview.render(); assert.equal(compare.disabled,false);
  compare.onclick();
  const overlay=document.body.find(e=>e.className==='qwen-result-viewer'), stage=overlay.find(e=>e.className==='qr-compare-stage');
  const before=stage.find(e=>e.alt==='V1'), after=stage.find(e=>e.alt==='V2');
  assert.match(before.src,/filename=a.png/); assert.match(after.src,/filename=up.png/);
  const slider=overlay.find(e=>e.type==='range'); assert.equal(slider.value,'50');
  slider.value='75'; slider.oninput(); assert.equal(before.style.clipPath,'inset(0 25% 0 0)');
  assert.equal(stage.find(e=>e.className==='qr-compare-divider').style.left,'75%');
  stage.onpointerdown({button:0,clientX:120,pointerId:1,preventDefault(){}}); assert.equal(slider.value,'25');
  stage.getBoundingClientRect=()=>({left:20,width:800}); stage.onpointermove({clientX:420}); assert.equal(slider.value,'50');
  before.naturalWidth=400; before.naturalHeight=800;
  stage.getBoundingClientRect=()=>({left:20,width:1200,height:600}); before.onload();
  const box=stage.find(e=>e.className==='qr-compare-image-box'); assert.equal(box.style.left,'450px'); assert.equal(box.style.width,'300px');
  stage.onpointermove({clientX:20}); assert.equal(slider.value,'0');
  stage.onpointermove({clientX:770}); assert.equal(slider.value,'100');
  stage.getBoundingClientRect=()=>({left:20,width:600,height:300}); before.onload(); assert.equal(box.style.width,'150px');
  for (const fn of listeners.get('keydown')) fn({key:'Escape',preventDefault(){},stopPropagation(){}});
  assert.equal(overlay.removed,true); assert.equal(listeners.get('keydown').size,0); preview.destroy();
}));

test('version history selects a previous version without loading prompt, and explicit load uses version identity', () => withDOM(()=>{
  let state={history:applyUpscale([result()],{resultId:'a',file:{filename:'up.png',width:2048,height:2048}}),selectedResultId:'a'};
  const edits=[],loads=[];
  const preview=createResultPreview({getState:()=>state,updateState:patch=>{state={...state,...patch};},onEdit:(...args)=>edits.push(args),onLoadVersion:(...args)=>loads.push(args)});
  preview.element.find(e=>e.textContent==='图片编辑').onclick(); assert.deepEqual(edits,[['a',state.history[0].selectedVersionId]]);
  preview.element.find(e=>e.textContent==='版本历史').onclick({type:'click'});
  const dialog=document.body.find(e=>e.className==='qwen-version-history');
  const first=dialog.find(e=>e.className==='qwen-version-card');
  first.find(e=>e.textContent==='切换至此版本').onclick();
  assert.equal(currentVersion(state.history[0]).number,1); assert.deepEqual(loads,[]);
  assert.equal(preview.element.find(e=>e.attributes?.['aria-label']==='对比').disabled,true);
  dialog.find(e=>e.textContent==='载入提示词与参数').onclick();
  assert.deepEqual(loads,[['a',state.history[0].versions[0].id]]);assert.equal(dialog.removed,true);
  preview.destroy();
}));

test('image manager keeps its state open while viewing a result or its version history', async () => {
  const savedDocument=globalThis.document, savedWindow=globalThis.window, savedLocation=globalThis.location, savedFetch=globalThis.fetch;
  globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){}};
  globalThis.window={confirm:()=>false};globalThis.location={href:'http://127.0.0.1:8000/'};
  globalThis.fetch=async()=>({ok:true,json:async()=>({files:[]})});
  try {
    const target={...result(),id:'b',title:'目标作品',original:{filename:'target.png',width:512,height:768}};
    let state={history:[result(),target],selectedResultId:'a'};
    const preview=createResultPreview({getState:()=>state,updateState:patch=>{state={...state,...patch};}});
    preview.element.find(e=>e.attributes?.['aria-label']==='图片管理器').onclick();
    const manager=document.body.find(e=>e.className==='qwen-manager');
    const grid=manager.find(e=>e.className==='qm-grid'),cards=grid.children.filter(e=>e.tagName==='label');
    cards[1].oncontextmenu({preventDefault(){},clientX:10,clientY:10});
    manager.find(e=>e.tagName==='button'&&e.textContent==='查看其他版本').onclick();
    const versions=document.body.find(e=>e.className==='qwen-version-history');
    assert.equal(versions.find(e=>e.tagName==='h3').textContent,'目标作品 · 版本历史');
    versions.find(e=>e.tagName==='button'&&e.textContent==='关闭 Esc').onclick();

    preview.element.find(e=>e.attributes?.['aria-label']==='图片管理器').onclick();
    const managerAgain=document.body.find(e=>e.className==='qwen-manager'),gridAgain=managerAgain.find(e=>e.className==='qm-grid');
    const targetCard=gridAgain.children.filter(e=>e.tagName==='label')[1];
    targetCard.oncontextmenu({preventDefault(){},clientX:10,clientY:10});
    managerAgain.find(e=>e.tagName==='button'&&e.textContent==='打开图片').onclick();
    assert.equal(state.selectedResultId,'a');
    const viewer=document.body.find(e=>e.className==='qwen-result-viewer');
    assert.match(viewer.find(e=>e.tagName==='img').src,/filename=target.png/);
    assert.ok(document.body.find(e=>e.className==='qwen-manager'));
    viewer.find(e=>e.textContent==='关闭 Esc').onclick();
    assert.ok(document.body.find(e=>e.className==='qwen-manager'));
    preview.destroy();
  } finally {
    globalThis.document=savedDocument;globalThis.window=savedWindow;globalThis.location=savedLocation;globalThis.fetch=savedFetch;
  }
});

test('preview only navigates unarchived and locally archived today, without repairing stale selection',()=>withDOM(()=>{
  const today=new Date(),archivedToday=new Date(today.getFullYear(),today.getMonth(),today.getDate(),10).getTime(),archivedYesterday=new Date(today.getFullYear(),today.getMonth(),today.getDate()-1,10).getTime();
  const records=[
    {...result(),id:'a',original:{filename:'unarchived.png'},archived:false},
    {...result(),id:'b',original:{filename:'today.png'},archived:true,archivedAt:archivedToday},
    {...result(),id:'c',original:{filename:'old.png'},archived:true,archivedAt:archivedYesterday},
  ];
  let state={history:records,selectedResultId:'c'},writes=0;
  const preview=createResultPreview({getState:()=>state,updateState:patch=>{state={...state,...patch};writes++;}});
  assert.match(preview.element.find(el=>el.tagName==='img').src,/today\.png/);
  assert.equal(preview.element.find(el=>el.tagName==='span'&&/^\d+ \/ \d+$/.test(el.textContent||'')).textContent,'2 / 2');
  assert.equal(state.selectedResultId,'c');assert.equal(writes,0);
  preview.destroy();
}));
