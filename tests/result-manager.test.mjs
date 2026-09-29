import test from 'node:test';
import assert from 'node:assert/strict';
import { createResultManager, sortResults } from '../web/result-manager.mjs';

const record = (id, title=id, createdAt=0) => ({ id, title, createdAt, original:{filename:`${id}.png`,subfolder:'qwen_auto',width:896,height:1184}, snapshot:{steps:24} });
class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.style={};this.attributes={};this.scrollTop=0;}
  append(...children){this.children.push(...children);for(const child of children)child.parentNode=this;}
  replaceChildren(...children){this.children=[...children];for(const child of children)child.parentNode=this;}
  setAttribute(name,value){this.attributes[name]=value;}
  addEventListener(){}
  contains(node){return node===this||this.children.some(child=>child.contains?.(node));}
  focus(){document.activeElement=this;}
  remove(){this.removed=true;if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);}
  click(){this.clicked=true;this.onclick?.();}
  getBoundingClientRect(){return this.className==='qm-organize-wrap'?{left:900,right:936,bottom:760}: {left:10,right:200,bottom:40};}
  find(predicate){return predicate(this)?this:this.children.map(child=>child.find(predicate)).find(Boolean);}
  querySelector(selector){return this.find(el=>selector.startsWith('.')?el.className===selector.slice(1):el.tagName===selector);}
}
async function environment(run){
  const keys=['document','window','location','fetch','localStorage','setTimeout'];
  const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
  const requests=[],alerts=[],confirmations=[],downloads=[],storage=new Map(),documentListeners=new Map();
  globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))};
  globalThis.setTimeout=callback=>{callback();return 0;};
  globalThis.document={body:new Element('body'),createElement:tag=>{const element=new Element(tag);if(tag==='a')downloads.push(element);return element;},addEventListener(type,listener){if(!documentListeners.has(type))documentListeners.set(type,new Set());documentListeners.get(type).add(listener);},removeEventListener(type,listener){documentListeners.get(type)?.delete(listener);}};
  globalThis.location={href:'http://localhost:8000/prefix/'};
  globalThis.window={confirm:text=>{confirmations.push(text);return true;},prompt:()=>null,alert:text=>alerts.push(text)};
  globalThis.fetch=async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>url.endsWith('/metadata')?{files:JSON.parse(options.body).files.map((file,index)=>({index,file,size:1024,mtime:Date.parse('2026-09-29')}))}:{results:JSON.parse(options.body).results.map(item=>({id:item.id,ok:true}))},blob:async()=>new Blob(['zip'])};};
  try {await run({requests,alerts,confirmations,downloads,storage,dispatchDocument:(type,event)=>{for(const listener of documentListeners.get(type)||[])listener(event);}});} finally {for(const key of keys){if(saved[key]===undefined)delete globalThis[key];else globalThis[key]=saved[key];}}
}
function fixture(history, selectedResultId=history[0]?.id, options={}){
  let state={history,selectedResultId}, writes=0, changes=0;
  const manager=createResultManager({getState:()=>state,updateState:patch=>{state={...state,...patch};writes++;},onChanged:()=>changes++,...options});
  return {manager,get state(){return state;},get writes(){return writes;},get changes(){return changes;},patch(patch){state={...state,...patch};}};
}

test('sorting is a view and leaves generation sequence unchanged',()=>{
  const history=[record('a','作品10',300),record('b','作品2',100),record('c','作品1',200)];
  assert.deepEqual(sortResults(history).map(x=>x.id),['a','b','c']);
  assert.deepEqual(sortResults(history,'name').map(x=>x.id),['c','b','a']);
  assert.deepEqual(sortResults(history,'name-desc').map(x=>x.id),['a','b','c']);
  assert.deepEqual(sortResults(history,'time').map(x=>x.id),['b','c','a']);
  assert.deepEqual(sortResults(history,'time-desc').map(x=>x.id),['a','c','b']);
  assert.deepEqual(history.map(x=>x.id),['a','b','c']);
});
test('cancelling permanent deletion sends no request or state write',()=>environment(async({requests})=>{
  const f=fixture([record('a')]);let warning='';window.confirm=text=>{warning=text;return false;};
  await f.manager.deleteResults(['a']);
  assert.match(warning,/永久删除.*全部.*版本文件.*无法撤销/);
  assert.equal(requests.length,0);assert.equal(f.writes,0);assert.equal(f.state.history.length,1);f.manager.destroy();
}));
test('partial deletion removes successful records only, retains failures and reports them',()=>environment(async({requests,alerts})=>{
  const a={...record('a'),upscaled:{filename:'up.png'},upscaleHistory:[{filename:'old-up.png'}]};
  const f=fixture([a,record('b','失败作品'),record('c')],'a',{viewURL:file=>`/prefix/view?filename=${file.filename}`});
  const originalFetch=fetch;
  globalThis.fetch=async(...args)=>{await originalFetch(...args);return {ok:true,json:async()=>({results:[{id:'a',ok:true},{id:'b',ok:false,error:'文件被占用'}]})};};
  await f.manager.deleteResults(['a','b']);
  assert.equal(requests[0].url,'http://localhost:8000/prefix/qwen_auto/results/delete');
  assert.equal(requests[0].method,'POST');
  assert.deepEqual(JSON.parse(requests[0].body).results[0].upscaleHistory,a.upscaleHistory);
  assert.deepEqual(f.state.history.map(x=>x.id),['b','c']);assert.equal(f.state.selectedResultId,'b');
  assert.equal(f.changes,1);assert.match(alerts[0],/失败作品.*文件被占用/);f.manager.destroy();
}));
test('deleting the selected result chooses its neighbour, last result chooses previous, empty clears selection',()=>environment(async()=>{
  const f=fixture([record('a'),record('b'),record('c')],'b');
  await f.manager.deleteResults(['b']);assert.equal(f.state.selectedResultId,'c');
  await f.manager.deleteResults(['c']);assert.equal(f.state.selectedResultId,'a');
  await f.manager.deleteResults(['a']);assert.equal(f.state.selectedResultId,null);assert.deepEqual(f.state.history,[]);f.manager.destroy();
}));
test('in-flight deletion uses captured records and preserves a newly selected surviving result',()=>environment(async({requests})=>{
  const f=fixture([record('a'),record('b'),record('c')],'a');
  let resolve;
  globalThis.fetch=async(url,options)=>{requests.push({url,...options});return new Promise(done=>{resolve=done;});};
  const pending=f.manager.deleteResults(['a']);
  f.patch({selectedResultId:'c',history:[...f.state.history,record('d')]});
  await f.manager.deleteResults(['b']);assert.equal(requests.length,1);
  resolve({ok:true,json:async()=>({results:[{id:'a',ok:true}]})});await pending;
  assert.deepEqual(JSON.parse(requests[0].body).results.map(x=>x.id),['a']);
  assert.deepEqual(f.state.history.map(x=>x.id),['b','c','d']);assert.equal(f.state.selectedResultId,'c');f.manager.destroy();
}));
test('HTTP and network failures preserve all history and release busy state for retry',()=>environment(async({alerts})=>{
  const f=fixture([record('a')]);const before=structuredClone(f.state);let count=0;
  globalThis.fetch=async()=>{count++;if(count===1)return {ok:false,status:409,json:async()=>({error:'文件正在使用'})};throw new Error('连接中断');};
  await f.manager.deleteResults(['a']);assert.deepEqual(f.state,before);assert.equal(f.writes,0);assert.match(alerts[0],/文件正在使用/);
  await f.manager.deleteResults(['a']);assert.equal(count,2);assert.deepEqual(f.state,before);assert.match(alerts[1],/连接中断/);f.manager.destroy();
}));
test('locked deletion and lock acquired during confirmation block requests',()=>environment(async({requests,confirmations})=>{
  let locked=true;const f=fixture([record('a')],'a',{isLocked:()=>locked});
  await f.manager.deleteResults(['a']);assert.equal(confirmations.length,0);assert.equal(requests.length,0);
  locked=false;window.confirm=()=>{locked=true;return true;};
  await f.manager.deleteResults(['a']);assert.equal(requests.length,0);assert.equal(f.writes,0);f.manager.destroy();
}));
test('management defaults to generation order, sorting does not persist history, and locked action buttons are disabled',()=>environment(async()=>{
  const f=fixture([record('a','作品2'),record('b','作品1')],'a',{isLocked:()=>true});f.manager.open();
  const overlay=document.body.find(el=>el.className==='qwen-manager');
  const grid=()=>overlay.find(el=>el.className==='qm-grid');
  assert.deepEqual(grid().children.map(card=>card.find(el=>el.type==='text').value),['作品2','作品1']);
  overlay.find(el=>el.attributes['aria-label']?.startsWith('排序：')).click();
  assert.deepEqual(grid().children.map(card=>card.find(el=>el.type==='text').value),['作品1','作品2']);assert.equal(f.writes,0);
  overlay.find(el=>el.attributes['aria-label']==='全选').onclick();
  assert.equal(overlay.find(el=>el.textContent==='删除所选').disabled,true);assert.equal(overlay.find(el=>el.textContent==='打包下载 ZIP').disabled,true);
  f.manager.destroy();assert.equal(overlay.removed,true);
}));
test('toolbar actions are icon-only and ordered; select-all toggles and organizer stays anchored',()=>environment(async()=>{
  window.innerWidth=1000;window.innerHeight=800;
  const f=fixture([record('a'),record('b')]);f.manager.open();const overlay=managerView();
  const head=overlay.find(el=>el.tagName==='header');
  const toolbarLabels=head.children.flatMap(el=>el.className==='qm-organize-wrap'?[el.find(child=>child.tagName==='button').attributes['aria-label']]:el.tagName==='button'?[el.attributes['aria-label']]:[]);
  assert.deepEqual(toolbarLabels,['全选','排序：生成顺序（点击切换）','智能整理','清除所选作品的其他版本','取消所选作品归档','关闭图片管理器']);
  const select=head.find(el=>el.attributes['aria-label']==='全选');select.click();
  assert.equal(managerView().find(el=>el.attributes['aria-label']==='取消全选').tagName,'button');
  managerView().find(el=>el.attributes['aria-label']==='取消全选').click();
  assert.equal(managerView().find(el=>el.attributes['aria-label']==='全选').tagName,'button');
  managerView().find(el=>el.attributes['aria-label']==='智能整理').click();
  const popup=managerView().find(el=>el.className==='qm-chooser');
  assert.equal(popup.parentNode.className,'qm-organize-wrap');assert.equal(popup.style.right,'0');assert.equal(popup.style.bottom,'calc(100% + 6px)');
  f.manager.destroy();
}));
test('selecting an image preserves the manager scroll position and selection state',()=>environment(async()=>{
  const f=fixture(Array.from({length:8},(_,i)=>record(`image-${i}`)));f.manager.open();
  let overlay=document.body.find(el=>el.className==='qwen-manager'),grid=overlay.find(el=>el.className==='qm-grid');
  grid.scrollTop=240;
  const checkbox=grid.find(el=>el.type==='checkbox');checkbox.checked=true;checkbox.onchange();
  overlay=document.body.find(el=>el.className==='qwen-manager');grid=overlay.find(el=>el.className==='qm-grid');
  assert.equal(grid.scrollTop,240);
  assert.ok(grid.find(el=>el.type==='checkbox').checked);
  f.manager.destroy();
}));
test('ZIP downloads receive a local-date name and increment the daily suffix',()=>environment(async({downloads})=>{
  const f=fixture([record('a'),record('b')]);f.manager.open();
  document.body.find(el=>el.className==='qwen-manager').find(el=>el.attributes['aria-label']==='全选').onclick();
  const trigger=async()=>{
    const manager=document.body.find(el=>el.className==='qwen-manager');manager.find(el=>el.textContent==='打包下载 ZIP').onclick();
    await new Promise(resolve=>setImmediate(resolve));
  };
  await trigger();await trigger();
  const today=`${new Date().getFullYear()}_${String(new Date().getMonth()+1).padStart(2,'0')}_${String(new Date().getDate()).padStart(2,'0')}`;
  assert.equal(downloads[0].download,`qwen_image_${today}_01.zip`);
  assert.equal(downloads[1].download,`qwen_image_${today}_02.zip`);
  f.manager.destroy();
}));

test('inline rename updates only the selected title and preserves order and files',()=>environment(async()=>{
  const f=fixture([record('a','旧名称'),record('b','其他')]);f.manager.open();
  const overlay=document.body.find(el=>el.className==='qwen-manager');
  const name=overlay.find(el=>el.type==='text');const original=structuredClone(f.state.history[0].original);
  name.value=' 新名称 ';name.onchange();
  assert.deepEqual(f.state.history.map(r=>r.title),['新名称','其他']);
  assert.deepEqual(f.state.history[0].original,original);
  const blank=overlay.find(el=>el.type==='text');blank.value=' ';blank.onchange();
  assert.equal(f.state.history[0].title,'新名称');f.manager.destroy();
}));

function versionedRecord(){
  return {...record('a'),versions:[1,2,3].map(number=>({id:`v${number}`,number,file:{filename:`v${number}.png`,subfolder:'qwen_auto',type:'output'},snapshot:{steps:24}})),selectedVersionId:'v2',nextVersionNumber:7};
}
test('cancelling delete other versions makes no request and reports retained version',()=>environment(async({requests})=>{
  const f=fixture([versionedRecord()]);let warning;
  window.confirm=text=>{warning=text;return false;};
  await f.manager.deleteOtherVersions('a');
  assert.match(warning,/保留 V2[\s\S]*删除 2 个版本[\s\S]*无法撤销/);
  assert.equal(requests.length,0);assert.equal(f.writes,0);f.manager.destroy();
}));
test('delete other versions protects retained and other work files and keeps high water mark',()=>environment(async({requests})=>{
  const a=versionedRecord();const other={...record('b'),versions:[{...a.versions[0],id:'shared'}],selectedVersionId:'shared',nextVersionNumber:2};
  const f=fixture([a,other]);await f.manager.deleteOtherVersions('a');
  const body=JSON.parse(requests[0].body);
  assert.deepEqual(body.results.map(item=>item.id),['v1','v3']);
  assert.equal(body.results.every(item=>item.versions.length===1),true);
  assert.deepEqual(body.keep_files.map(file=>file.filename).sort(),['v1.png','v2.png']);
  assert.deepEqual(f.state.history[0].versions.map(version=>version.id),['v2']);
  assert.equal(f.state.history[0].selectedVersionId,'v2');
  assert.equal(f.state.history[0].nextVersionNumber,7);
  assert.equal(f.state.history[1].versions[0].file.filename,'v1.png');f.manager.destroy();
}));
test('delete other versions retains failures and reports them without renumbering',()=>environment(async({alerts})=>{
  const f=fixture([versionedRecord()]);
  globalThis.fetch=async()=>({ok:true,json:async()=>({results:[{id:'v1',ok:true},{id:'v3',ok:false,error:'locked'}]})});
  await f.manager.deleteOtherVersions('a');
  assert.deepEqual(f.state.history[0].versions.map(version=>version.number),[2,3]);
  assert.equal(f.state.history[0].selectedVersionId,'v2');assert.equal(f.state.history[0].nextVersionNumber,7);
  assert.match(alerts[0],/locked/);assert.equal(f.changes,1);f.manager.destroy();
}));
test('version history cleanup reports protected shared files when the manager is closed',()=>environment(async({alerts})=>{
  const f=fixture([versionedRecord()]);
  globalThis.fetch=async()=>({ok:true,json:async()=>({results:[{id:'v1',ok:true,skipped:[{filename:'shared.png'}]},{id:'v3',ok:true,skipped:[]}]})});
  await f.manager.deleteOtherVersions('a');
  assert.match(alerts[0],/已清理 2 个版本记录；1 个共享文件保留在磁盘/);
  assert.deepEqual(f.state.history[0].versions.map(version=>version.id),['v2']);f.manager.destroy();
}));
test('delete other versions respects locks acquired during confirmation',()=>environment(async({requests})=>{
  let locked=false;const f=fixture([versionedRecord()],'a',{isLocked:()=>locked});
  window.confirm=()=>{locked=true;return true;};
  await f.manager.deleteOtherVersions('a');assert.equal(requests.length,0);assert.equal(f.writes,0);f.manager.destroy();
}));

test('file requests hold the shared node lock until completion, including failure',()=>environment(async()=>{
  let resolve,locked=false;const states=[];
  const f=fixture([record('a')],'a',{isLocked:()=>locked,onBusyChange:value=>{locked=value;states.push(value);}});
  globalThis.fetch=()=>new Promise(done=>{resolve=done;});
  const pending=f.manager.deleteResults(['a']);assert.equal(locked,true);
  resolve({ok:false,status:500,json:async()=>({error:'测试失败'})});await pending;
  assert.equal(locked,false);assert.deepEqual(states,[true,false]);assert.equal(f.state.history.length,1);f.manager.destroy();
}));

const managerView=()=>document.body.find(el=>el.className==='qwen-manager');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('organizer archives unarchived works by date and month, then navigates and restores them',()=>environment(async()=>{
  const dated={...record('a'),createdAt:Date.parse('2026-09-28'),original:{...record('a').original,filename:'2026_09_28_a.png'}};
  const monthly={...record('b'),createdAt:Date.parse('2026-08-01'),original:{...record('b').original,subfolder:'qwen_auto/2026_08'}};
  const f=fixture([dated,monthly]);f.manager.open();await flush();
  managerView().find(el=>el.attributes['aria-label']==='智能整理').click();
  managerView().find(el=>el.textContent==='图片整理').click();
  assert.equal(f.state.history.every(item=>item.archived),true);
  assert.equal(f.state.history[0].archiveGroup,'2026_09_28');
  const folder=managerView().find(el=>el.tagName==='button' && el.attributes['aria-label']?.startsWith('2026_09_28'));assert.ok(folder);folder.click();
  const firstCard=managerView().find(el=>el.tagName==='label');firstCard.find(el=>el.type==='checkbox').onchange?.();firstCard.find(el=>el.type==='checkbox').checked=true;firstCard.find(el=>el.type==='checkbox').onchange();
  managerView().find(el=>el.attributes['aria-label']==='取消所选作品归档').click();
  assert.equal(f.state.history[0].archived,false);assert.equal(f.state.history[0].archiveGroup,null);
  managerView().find(el=>el.attributes['aria-label']==='返回上级')?.click();
  managerView().find(el=>el.tagName==='button' && el.attributes['aria-label']?.startsWith('2026_08_01')).click();
  const secondCard=managerView().find(el=>el.tagName==='label');secondCard.find(el=>el.type==='checkbox').checked=true;secondCard.find(el=>el.type==='checkbox').onchange();
  managerView().find(el=>el.attributes['aria-label']==='取消所选作品归档').click();
  managerView().find(el=>el.attributes['aria-label']==='返回上级')?.click();
  managerView().find(el=>el.attributes['aria-label']==='智能整理').click();
  managerView().find(el=>el.textContent==='文件夹整理').click();
  assert.equal(f.state.history[0].archiveGroup,'2026_09');
  assert.equal(f.state.history[1].archiveGroup,'2026_08');
  const month=managerView().find(el=>el.tagName==='button' && el.attributes['aria-label']?.startsWith('2026_08'));assert.ok(month);month.click();
  assert.ok(managerView().find(el=>el.tagName==='button' && el.attributes['aria-label']?.startsWith('qwen_auto/2026_08')));
  const writes=f.writes;managerView().find(el=>el.attributes['aria-label']==='智能整理').click();managerView().find(el=>el.textContent==='文件夹整理').click();assert.equal(f.writes,writes);
  f.manager.destroy();
}));
test('metadata totals deduplicate all versions and show current file, folder and unknown sizes',()=>environment(async({requests})=>{
  const a=versionedRecord();a.archived=true;a.archiveGroup='2026_09_29';
  const b={...record('b'),versions:[{id:'shared',number:1,file:a.versions[0].file}],selectedVersionId:'shared'};
  const f=fixture([a,b]);
  globalThis.fetch=async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>({files:[{index:2,error:'missing'},{index:1,size:1048576,mtime:0},{index:0,size:1024,mtime:0}]})};};
  f.manager.open();await flush();
  const request=JSON.parse(requests[0].body);assert.equal(request.files.length,3);
  assert.match(managerView().find(el=>el.tagName==='strong').textContent,/1\.00 MB/);
  assert.match(managerView().find(el=>el.tagName==='strong').textContent,/部分未知/);
  assert.match(managerView().find(el=>el.attributes['aria-label']?.startsWith('2026_09_29') && el.tagName==='button').attributes['aria-label'],/1\.00 MB/);
  managerView().find(el=>el.attributes['aria-label']?.startsWith('2026_09_29') && el.tagName==='button').click();
  assert.ok(managerView().find(el=>el.tagName==='small' && el.textContent?.includes('1.00 MB')));
  assert.ok(managerView().find(el=>el.textContent==='另有 2 个版本'));
  f.manager.destroy();
}));
test('archive folders use the newest existing version as their cover image',()=>environment(async()=>{
  const base={...record('a'),archived:true,archiveGroup:'2026_09_29',versions:[
    {id:'a1',number:1,createdAt:100,file:{filename:'old.png',subfolder:'qwen_auto',type:'output'}},
    {id:'a2',number:2,createdAt:300,file:{filename:'newest.png',subfolder:'qwen_auto',type:'output'}},
  ],selectedVersionId:'a1'};
  const f=fixture([base,{...record('b', 'b', 200),archived:true,archiveGroup:'2026_09_29'}]);
  globalThis.fetch=async(url,options)=>({ok:true,json:async()=>({files:JSON.parse(options.body).files.map((_,index)=>({index,size:2048,mtime:index}))})});
  f.manager.open();await flush();const folder=managerView().find(el=>el.className==='qm-folder');
  assert.match(folder.find(el=>el.className==='qm-folder-cover').src,/filename=newest\.png/);
  assert.equal(folder.children[0].className,'qm-folder-media');
  assert.equal(folder.children[1].className,'qm-folder-info');
  assert.equal(folder.find(el=>el.className==='qm-folder-title').textContent,'2026_09_29');
  assert.match(folder.find(el=>el.tagName==='small').textContent,/2 项 · 6\.00 KB/);
  f.manager.destroy();
}));
test('archive folder context menu renames the logical folder without changing its contents',()=>environment(async()=>{
  const f=fixture([{...record('a'),archived:true,archiveGroup:'2026_09_29'},{...record('b'),archived:true,archiveGroup:'2026_09_29'}]);
  window.prompt=(_message,current)=>`${current}_精选`;
  f.manager.open();await flush();const folder=managerView().find(el=>el.className==='qm-folder');
  folder.oncontextmenu({preventDefault(){},clientX:20,clientY:30});
  managerView().find(el=>el.textContent==='重命名文件夹').click();
  assert.deepEqual(f.state.history.map(item=>item.archiveGroup),['2026_09_29_精选','2026_09_29_精选']);
  assert.equal(f.state.history.length,2);f.manager.destroy();
}));
test('folder context menu confirms clearing other versions and closes on outside click',()=>environment(async({requests,confirmations,dispatchDocument})=>{
  const item={...versionedRecord(),archived:true,archiveGroup:'2026_09_29'};const f=fixture([item]);
  f.manager.open();await flush();let folder=managerView().find(el=>el.className==='qm-folder');
  folder.oncontextmenu({preventDefault(){},clientX:20,clientY:30});
  assert.ok(managerView().find(el=>el.textContent==='清除文件夹内其他版本'));
  dispatchDocument('pointerdown',{target:managerView().find(el=>el.tagName==='header')});
  assert.equal(managerView().find(el=>el.className==='qm-context'),undefined);
  folder=managerView().find(el=>el.className==='qm-folder');folder.oncontextmenu({preventDefault(){},clientX:20,clientY:30});
  managerView().find(el=>el.textContent==='清除文件夹内其他版本').click();await flush();
  assert.match(confirmations[0],/将永久删除 2 个版本文件/);
  const deletion=requests.find(request=>request.url.endsWith('/delete'));
  assert.deepEqual(JSON.parse(deletion.body).results.map(version=>version.id),['v1','v3']);
  assert.deepEqual(f.state.history[0].versions.map(version=>version.id),['v2']);f.manager.destroy();
}));
test('metadata request failure leaves images and organizer available',()=>environment(async()=>{
  const f=fixture([record('a')]);globalThis.fetch=async()=>{throw new Error('offline');};
  f.manager.open();await flush();
  assert.ok(managerView().find(el=>el.tagName==='label'));
  assert.match(managerView().find(el=>el.attributes.role==='status').textContent,/offline/);
  managerView().find(el=>el.attributes['aria-label']==='智能整理').click();
  assert.ok(managerView().find(el=>el.textContent==='图片整理'));f.manager.destroy();
}));
test('image context actions keep manager mounted during open/view and offer archive restoration',()=>environment(async()=>{
  const calls=[];const a={...versionedRecord(),archived:true,archiveGroup:'2026_09_29'};
  const f=fixture([a],'a',{onOpenImage:id=>calls.push(['open',id,!!managerView()]),onViewVersions:id=>calls.push(['versions',id,!!managerView()])});
  f.manager.open();managerView().find(el=>el.attributes['aria-label']?.startsWith('2026_09_29') && el.tagName==='button').click();
  const card=managerView().find(el=>el.tagName==='label');card.oncontextmenu({preventDefault(){},clientX:10,clientY:20});
  managerView().find(el=>el.textContent==='打开图片').click();assert.deepEqual(calls[0],['open','a',true]);
  managerView().find(el=>el.tagName==='label').oncontextmenu({preventDefault(){},clientX:10,clientY:20});
  managerView().find(el=>el.textContent==='查看其他版本').click();assert.deepEqual(calls[1],['versions','a',true]);
  f.manager.destroy();
}));
test('batch clear preserves each selected current version and cancellation leaves files unchanged',()=>environment(async({requests})=>{
  const a={...versionedRecord(),archived:true,archiveGroup:'2026_09_29'};
  const b={...versionedRecord(),id:'b',title:'b',archived:true,archiveGroup:'2026_09_29',versions:[1,2,3].map(number=>({id:`b-v${number}`,number,file:{filename:`b-v${number}.png`,subfolder:'qwen_auto',type:'output'},snapshot:{steps:24}})),selectedVersionId:'b-v2'};
  const f=fixture([a,b]);f.manager.open();managerView().find(el=>el.attributes['aria-label']?.startsWith('2026_09_29') && el.tagName==='button').click();
  const clear=()=>managerView().find(el=>el.attributes['aria-label']==='清除所选作品的其他版本');
  assert.equal(clear().disabled,true);
  // Trigger the checkbox as a browser would.
  const check=managerView().find(el=>el.tagName==='label').find(el=>el.type==='checkbox');check.checked=true;check.onchange();
  assert.equal(clear().disabled,false);
  const checks=managerView().find(el=>el.className==='qm-grid').children.filter(el=>el.tagName==='label').map(el=>el.find(child=>child.type==='checkbox'));
  checks[1].checked=true;checks[1].onchange();assert.equal(clear().disabled,false);
  window.confirm=()=>false;clear().click();await flush();assert.equal(requests.filter(r=>r.url.endsWith('/delete')).length,0);
  window.confirm=()=>true;clear().click();await flush();
  const deletion=requests.find(r=>r.url.endsWith('/delete'));assert.deepEqual(JSON.parse(deletion.body).results.map(x=>x.id),['v1','v3','b-v1','b-v3']);
  assert.deepEqual(f.state.history[0].versions.map(v=>v.id),['v2']);assert.deepEqual(f.state.history[1].versions.map(v=>v.id),['b-v2']);f.manager.destroy();
}));
