import { migrateHistory, currentVersion, versionFiles, projectItem, fileKey, setArchived, organizeByDate, groupFoldersByMonth, otherVersionCount } from './version-state.mjs?v=20260930-archive-date-1';
export function sortResults(history, mode = 'generation') {
  const list = [...history];
  if (mode.startsWith('name')) list.sort((a,b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh', {numeric:true}));
  if (mode.startsWith('time')) list.sort((a,b) => (a.createdAt || 0)-(b.createdAt || 0));
  return mode.endsWith('desc') ? list.reverse() : list;
}

export function createResultManager({getState,updateState,isLocked=()=>false,viewURL,onChanged,onBusyChange=()=>{},onOpenImage,onViewVersions}) {
  let overlay=null, busy=false, selected=new Set(), mode='generation', message='', keyHandler, outsideChooser;
  let folder=null, subfolder=null, chooser=false, context=null, metadataByFile=new Map(), metadataRequest=0;
  const setBusy=value=>{busy=value;onBusyChange(value);};
  const make=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;return el;};
  const url=file=>viewURL ? viewURL(file) : `/view?${new URLSearchParams({filename:file.filename,subfolder:file.subfolder || '',type:'output'})}`;
  // Follow the same server prefix as /view (including desktop/reverse-proxy deployments).
  const endpoint=action=>{const target=new URL(url({filename:'_',subfolder:'qwen_auto'}),location.href);target.pathname=target.pathname.replace(/\/view$/,`/qwen_auto/results/${action}`);target.search='';return target.href;};
  const request=async(action,payload)=>{const response=await fetch(endpoint(action),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(!response.ok){let error;try{error=(await response.json()).error;}catch{}throw new Error(error || `请求失败 (${response.status})，请确认服务已重启`);}return response;};
  const close=()=>{if(busy)return;metadataRequest++;overlay?.remove();overlay=null;document.removeEventListener('keydown',keyHandler,true);document.removeEventListener('pointerdown',outsideChooser,true);outsideChooser=null;};
  const uniqueFiles=items=>{const files=new Map();for(const item of items)for(const file of versionFiles(item)){const key=fileKey(file);if(key&&!files.has(key))files.set(key,file);}return [...files.values()];};
  const bytes=items=>{let total=0,unknown=false;for(const file of uniqueFiles(items)){const entry=metadataByFile.get(fileKey(file));if(Number.isFinite(entry?.size)&&entry.size>=0)total+=entry.size;else unknown=true;}return {total,unknown};};
  const formatBytes=value=>{const units=['B','KB','MB','GB'];let unit=0,size=value;while(size>=1024&&unit<units.length-1){size/=1024;unit++;}return unit===0?`${size} B`:`${size.toFixed(2)} ${units[unit]}`;};
  const sizeLabel=items=>{const value=bytes(items);return `${formatBytes(value.total)}${value.unknown?' · 部分未知':''}`;};
  const representativeFolder=item=>{const versions=migrateHistory([item])[0]?.versions || [];return (versions.find(version=>version.operation==='generate') || versions[0])?.file?.subfolder || '';};
  const folderCover=items=>{
    const candidates=items.flatMap((item,index)=>migrateHistory([item])[0]?.versions.map((version,versionIndex)=>({file:version.file,createdAt:new Date(version.createdAt??item.createdAt??0).getTime(),mtime:metadataByFile.get(fileKey(version.file))?.mtime,index,versionIndex}))||[])
      .filter(entry=>entry.file&&metadataByFile.has(fileKey(entry.file)));
    candidates.sort((a,b)=>(b.createdAt||b.mtime||0)-(a.createdAt||a.mtime||0)||b.index-a.index||b.versionIndex-a.versionIndex);
    return candidates[0]?.file || currentVersion(migrateHistory(items).at(-1))?.file || null;
  };
  async function loadMetadata(){
    const files=uniqueFiles(getState().history || []), sequence=++metadataRequest;
    metadataByFile=new Map();if(!files.length){render();return;}
    try{
      const data=await(await request('metadata',{files})).json();
      if(sequence!==metadataRequest)return;
      for(const entry of data.files || []){
        const file=files[entry.index];
        if(file&&Number.isFinite(entry.size)&&entry.size>=0)metadataByFile.set(fileKey(file),{size:entry.size,mtime:entry.mtime});
      }
    }catch(error){if(sequence===metadataRequest)message=`文件大小读取失败：${error.message}`;}
    if(sequence===metadataRequest)render();
  }
  const archive=(ids,archived,group=null)=>{if(busy||isLocked()||!ids.length)return;updateState({history:setArchived(getState().history || [],ids,{archived,group})});selected=new Set([...selected].filter(id=>!ids.includes(id)));context=null;onChanged?.();render();};
  const renameArchiveFolder=group=>{if(busy||isLocked()||typeof window.prompt!=='function')return;const answer=window.prompt('重命名归档文件夹',group);if(answer==null)return;const name=answer.trim().slice(0,160);if(!name){window.alert('文件夹名称不能为空');return;}if(name===group)return;if((getState().history||[]).some(item=>item.archived&&item.archiveGroup===name)){window.alert('已存在同名归档文件夹');return;}updateState({history:(getState().history||[]).map(item=>item.archived&&item.archiveGroup===group?{...item,archiveGroup:name}:item)});onChanged?.();context=null;render();};
  const organize=kind=>{chooser=false;if(busy||isLocked())return;const history=(getState().history || []).filter(item=>!item.archived);const organized=kind==='date'?organizeByDate(history,metadataByFile):groupFoldersByMonth(history,metadataByFile);let next=getState().history || [];for(const group of organized.groups){const ids=group.resultIds.filter(id=>history.some(item=>item.id===id));next=setArchived(next,ids,{archived:true,group:group.key ?? group.id});}if(organized.groups.some(group=>group.resultIds.length)){updateState({history:next});onChanged?.();}folder=null;subfolder=null;selected.clear();render();};
  function referenceWarning(){return '\n删除后引用这些图片的提示词可能失效；只能检查当前节点，其他工作流的引用无法检测。';}
  async function deleteResults(ids) {
    if(busy || isLocked())return;
    const records=(getState().history || []).filter(item=>ids.includes(item.id));
    if(!records.length || !window.confirm(`将永久删除 ${records.length} 项作品的全部 ${migrateHistory(records).reduce((n,r)=>n+r.versions.length,0)} 个版本文件，无法撤销。是否继续？${referenceWarning()}`))return;
    if(isLocked())return;
    setBusy(true);message='正在删除…';render();
    try {
      const keep_files=(getState().history || []).filter(r=>!ids.includes(r.id)).flatMap(versionFiles);
      const data=await (await request('delete',{results:records,keep_files})).json();
      const removed=new Set(data.results.filter(item=>item.ok).map(item=>item.id));
      const state=getState(), old=state.history || [], index=old.findIndex(item=>item.id===state.selectedResultId);
      const history=old.filter(item=>!removed.has(item.id));
      updateState({history,selectedResultId:removed.has(state.selectedResultId) ? history[Math.min(Math.max(index,0),history.length-1)]?.id || null : state.selectedResultId});
      removed.forEach(id=>selected.delete(id));onChanged?.();
      const errors=data.results.filter(item=>!item.ok);
      const skipped=data.results.reduce((count,item)=>count+(item.skipped?.length || 0),0);
      message=errors.length ? errors.map(item=>`${old.find(r=>r.id===item.id)?.title || item.id}：${item.error}`).join('\n') : `已永久删除 ${removed.size} 项作品${skipped?`；${skipped} 个共享文件保留在磁盘`:''}`;
      if(!overlay && errors.length)window.alert(message);
    } catch(error){message=error.message;if(!overlay)window.alert(message);}
    finally{setBusy(false);render();}
  }
  async function deleteOtherVersions(resultIds){
    if(busy || isLocked())return;
    const ids=new Set(Array.isArray(resultIds)?resultIds:[resultIds]);
    const history=migrateHistory(getState().history),targets=history.filter(item=>ids.has(item.id)).map(item=>({item,keep:currentVersion(item),others:item.versions.filter(v=>v.id!==currentVersion(item)?.id)})).filter(target=>target.keep&&target.others.length);
    const others=targets.flatMap(({item,others})=>others.map(version=>({workId:item.id,version,key:fileKey(version.file)})));
    if(!others.length)return;
    const summary=targets.map(({item,keep,others})=>`${item.title || item.id}：保留 V${keep.number}，删除 ${others.length} 个版本`).join('\n');
    if(!window.confirm(`${summary}\n将永久删除 ${others.length} 个版本文件，无法撤销。是否确认？${referenceWarning()}`) || isLocked())return;
    setBusy(true);message='正在删除其他版本…';render();
    try{
      const deleting=new Set(targets.map(({item})=>item.id));
      const keep_files=history.filter(r=>!deleting.has(r.id)).flatMap(versionFiles).concat(targets.map(({keep})=>keep.file));
      const filesToDelete=[...new Map(others.map(entry=>[entry.key,entry])).values()];
      const response=await(await request('delete',{results:filesToDelete.map(({version})=>({id:version.id,versions:[version]})),keep_files})).json();
      const outcomes=new Map((response.results||[]).map(result=>[result.id,result]));
      const deletedKeys=new Set(filesToDelete.filter(({version})=>outcomes.get(version.id)?.ok).map(({key})=>key));
      const deleted=new Set(others.filter(entry=>deletedKeys.has(entry.key)).map(({version})=>version.id));
      updateState({history:migrateHistory(getState().history).map(item=>{
        const target=targets.find(entry=>entry.item.id===item.id);if(!target)return item;
        return projectItem({...item,versions:item.versions.filter(version=>!deleted.has(version.id)),selectedVersionId:target.keep.id});
      })});
      onChanged?.();const errors=[...outcomes.values()].filter(result=>!result.ok),skipped=[...outcomes.values()].reduce((count,result)=>count+(result.skipped?.length||0),0);message=errors.length?errors.map(r=>`版本文件删除失败：${r.error}`).join('\n'):`已清理 ${deleted.size} 个版本记录${skipped?`；${skipped} 个共享文件保留在磁盘`:''}`;
      if(!overlay || errors.length)window.alert(message);
    }catch(error){message=error.message;window.alert(message);}finally{setBusy(false);render();}
  }
  async function download(version) {
    if(busy || isLocked() || !selected.size)return;
    setBusy(true);message='正在打包…';render();
    try {
      const response=await request('download',{results:(getState().history || []).filter(r=>selected.has(r.id)),version:'current'});
      const blob=await response.blob(), href=URL.createObjectURL(blob), link=make('a');
      const now=new Date(), date=`${now.getFullYear()}_${String(now.getMonth()+1).padStart(2,'0')}_${String(now.getDate()).padStart(2,'0')}`;
      const key=`qwen-image-manager-zip-${date}`;let serial=1,storageAvailable=true,previous=0;
      try{previous=Number(localStorage.getItem(key)||0);if(!Number.isInteger(previous)||previous<0)previous=0;serial=previous+1;localStorage.setItem(key,String(previous));}catch{storageAvailable=false;serial=1;}
      link.download=`qwen_image_${date}_${String(serial).padStart(2,'0')}.zip`;document.body.append(link);link.click();
      if(storageAvailable)try{localStorage.setItem(key,String(serial));}catch{}
      link.remove();setTimeout(()=>URL.revokeObjectURL(href),60000);message='压缩包已开始下载';
    }catch(error){message=error.message;}finally{setBusy(false);render();}
  }
  function render() {
    if(!overlay)return;
    document.removeEventListener('pointerdown',outsideChooser,true);outsideChooser=null;
    const previousScroll=overlay.querySelector('.qm-grid')?.scrollTop || 0;
    overlay.replaceChildren();
    const style=make('style');style.textContent=`.qwen-manager{position:fixed;inset:0;z-index:99990;background:#000a;display:grid;place-items:center;color:#eee;font:14px system-ui}.qwen-manager *{box-sizing:border-box}.qwen-manager article{width:min(1100px,94vw);height:min(780px,90vh);background:#20212a;border:1px solid #555;border-radius:14px;display:flex;flex-direction:column;padding:18px;gap:14px}.qwen-manager header,.qwen-manager footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.qwen-manager button,.qwen-manager select{background:#30313e;color:#eee;border:1px solid #545468;border-radius:7px;padding:8px;cursor:pointer}.qwen-manager button:disabled,.qwen-manager select:disabled{opacity:.4;cursor:default}.qwen-manager .qm-icon{width:36px;height:36px;padding:7px;color:#bd9bff;border-color:#66538a;display:grid;place-items:center}.qwen-manager .qm-icon svg{width:18px;height:18px}.qwen-manager .qm-grid{overflow:auto;flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;align-content:start}.qwen-manager label{border:1px solid #444;border-radius:9px;padding:10px;cursor:pointer;min-width:0}.qwen-manager label:has(input:checked){border-color:#a285ed;background:#3a3153}.qwen-manager img{width:100%;height:150px;object-fit:contain;display:block;background:#15161d}.qwen-manager p{margin:5px 0;overflow-wrap:anywhere}.qwen-manager small{color:#bbc0d0}.qwen-manager input{accent-color:#9365dc}.qwen-manager .qm-message{white-space:pre-wrap;max-height:90px;overflow:auto}.qwen-manager .qm-close{margin-left:auto}.qwen-manager .qm-folder{padding:10px!important;text-align:left;display:flex;flex-direction:column;align-items:stretch;gap:8px;min-width:0;min-height:0;font-size:14px;transition:border-color .15s,background .15s}.qwen-manager .qm-folder:hover{border-color:#a285ed;background:#292735}.qwen-manager .qm-folder-media{height:160px;display:grid;place-items:center;overflow:hidden;border-radius:5px;background:#15161d;color:#bd9bff}.qwen-manager .qm-folder-media svg{width:42px;height:42px}.qwen-manager .qm-folder-cover{width:100%;height:100%;object-fit:contain;border-radius:5px}.qwen-manager .qm-folder-info{display:grid;gap:4px;min-width:0}.qwen-manager .qm-folder-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.qwen-manager .qm-folder-info small{color:#989cab}.qwen-manager .qm-organize-wrap{position:relative}.qwen-manager .qm-chooser,.qwen-manager .qm-context{position:absolute;background:#30313e;border:1px solid #777;border-radius:8px;padding:8px;display:flex;gap:6px;z-index:1;box-shadow:0 8px 24px #0008}.qwen-manager .qm-chooser{top:calc(100% + 6px);left:0}.qwen-manager .qm-context{flex-direction:column}.qwen-manager .qm-other{color:#989cab;font-size:12px}`;
    overlay.append(style);const panel=make('article');panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','图片管理器');overlay.append(panel);
    const icons={back:'<path d="m15 18-6-6 6-6M20 12H9"/>',select:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',cancel:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m9 9 6 6m0-6-6 6"/>',sort:'<path d="M8 7h12M8 12h8M8 17h4M4 5v14m0 0-2-2m2 2 2-2"/>',organize:'<path d="M4 5h16M4 12h10M4 19h6M18 10v8m-4-4h8"/>',clear:'<path d="M3 6h18M8 6V4h8v2m-11 0 1 14h12l1-14M10 10v6m4-6v6"/>',restore:'<path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-2"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>'};
    const button=(text,fn)=>{const el=make('button',text);el.type='button';el.onclick=fn;el.disabled=busy;return el;};
    const iconButton=(label,key,fn)=>{const el=button('',fn);el.className='qm-icon';el.title=label;el.setAttribute('aria-label',label);el.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[key]}</svg>`;return el;};
    const history=getState().history || [], archived=history.filter(item=>item.archived), unarchived=history.filter(item=>!item.archived);
    const groups=new Map();for(const item of archived){const key=item.archiveGroup || '未分类归档';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
    if(folder&&!groups.has(folder)){folder=null;subfolder=null;}
    const folderItems=folder?groups.get(folder):[], subfolders=folder&&/^\d{4}_\d{2}$/.test(folder)?[...new Set(folderItems.map(representativeFolder).filter(Boolean))]:[];
    if(subfolder&&!subfolders.includes(subfolder))subfolder=null;
    const visible=folder?(subfolder?folderItems.filter(item=>representativeFolder(item)===subfolder):subfolders.length?[]:folderItems):unarchived;
    const head=make('header'), count=make('strong',`图片管理器 · ${history.length} 项 · 已选 ${selected.size} 项 · 总占用 ${sizeLabel(history)}`);
    const sort=make('select');sort.setAttribute('aria-label','图片排序');for(const [value,label] of [['generation','生成顺序'],['name','名称 ↑'],['name-desc','名称 ↓'],['time','时间 ↑'],['time-desc','时间 ↓']]){const o=make('option',label);o.value=value;sort.append(o);}sort.value=mode;sort.disabled=busy;sort.onchange=()=>{mode=sort.value;render();};
    head.append(count);
    if(folder)head.append(iconButton('返回上级','back',()=>{if(subfolder)subfolder=null;else folder=null;selected.clear();context=null;render();}));
    const allSelected=visible.length>0&&visible.every(item=>selected.has(item.id));
    head.append(iconButton(allSelected?'取消全选':'全选',allSelected?'cancel':'select',()=>{selected=allSelected?new Set():new Set(visible.map(item=>item.id));render();}));
    const sortModes=['generation','name','name-desc','time','time-desc'],sortLabels={'generation':'生成顺序','name':'名称升序','name-desc':'名称降序','time':'时间升序','time-desc':'时间降序'};
    head.append(iconButton(`排序：${sortLabels[mode]||'生成顺序'}（点击切换）`,'sort',()=>{mode=sortModes[(sortModes.indexOf(mode)+1)%sortModes.length];render();}));
    const organizerWrap=make('span');organizerWrap.className='qm-organize-wrap';const organizer=iconButton('智能整理','organize',()=>{chooser=!chooser;context=null;render();});organizer.disabled=busy||isLocked();organizerWrap.append(organizer);head.append(organizerWrap);
    const selectedTargets=visible.filter(item=>selected.has(item.id));const hasOthers=selectedTargets.some(item=>otherVersionCount(migrateHistory([item])[0])>0);
    const clear=iconButton('清除所选作品的其他版本','clear',()=>void deleteOtherVersions(selectedTargets.map(item=>item.id)));clear.disabled=busy||isLocked()||!hasOthers;head.append(clear);
    const hasArchived=selectedTargets.some(item=>item.archived);const restore=iconButton('取消所选作品归档','restore',()=>archive(selectedTargets.filter(item=>item.archived).map(item=>item.id),false));restore.disabled=busy||isLocked()||!hasArchived;head.append(restore);
    const closeButton=iconButton('关闭图片管理器','close',close);closeButton.className='qm-icon qm-close';closeButton.title='关闭 Esc';head.append(closeButton);
    const grid=make('div');grid.className='qm-grid';
    const folderButton=(label,items,open,{archiveGroup:group=null,canRename=false}={})=>{const entry=button('',open);entry.className='qm-folder';entry.title=label;entry.setAttribute('aria-label',`${label}，${items.length} 项，占用 ${sizeLabel(items)}`);entry.oncontextmenu=event=>{event.preventDefault();context={type:'folder',label,group,canRename,ids:items.map(item=>item.id),x:event.clientX,y:event.clientY};chooser=false;render();};const media=make('div');media.className='qm-folder-media';const coverFile=folderCover(items);if(coverFile){const cover=make('img');cover.className='qm-folder-cover';cover.alt=`${label}缩略图`;cover.src=url(coverFile);media.append(cover);}else{const icon=make('span');icon.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><path d="M3 9h18"/></svg>';media.append(icon);}const info=make('span');info.className='qm-folder-info';info.append(make('span',label));info.children[0].className='qm-folder-title';info.append(make('small',`${items.length} 项 · ${sizeLabel(items)}`));entry.append(media,info);return entry;};
    if(!folder)for(const [key,items] of [...groups].sort(([a],[b])=>a.localeCompare(b)))grid.append(folderButton(key,items,()=>{folder=key;subfolder=null;selected.clear();context=null;render();},{archiveGroup:key,canRename:true}));
    if(folder&&!subfolder)for(const name of subfolders){const items=folderItems.filter(item=>representativeFolder(item)===name);grid.append(folderButton(name,items,()=>{subfolder=name;selected.clear();render();}));}
    for(const item of sortResults(visible,mode)){
      const card=make('label'), check=make('input');check.type='checkbox';check.checked=selected.has(item.id);check.disabled=busy;check.setAttribute('aria-label',item.title || '未命名作品');check.onchange=()=>{check.checked?selected.add(item.id):selected.delete(item.id);render();};
      const version=currentVersion(migrateHistory([item])[0]),file=version?.file;
      card.oncontextmenu=event=>{event.preventDefault();context={id:item.id,x:event.clientX,y:event.clientY};chooser=false;render();};
      const picture=make('img');picture.loading='lazy';picture.alt=item.title || '作品';if(file)picture.src=url(file);
      const name=make('input');name.type='text';name.value=item.title || '';name.maxLength=160;name.setAttribute('aria-label',`重命名 ${item.title || '未命名作品'}`);name.title='编辑名称，回车或移出输入框保存';name.disabled=busy || isLocked();
      name.style.cssText='width:100%;min-width:0;margin:7px 0;padding:5px;background:#292a36;color:#eee;border:1px solid #555268;border-radius:5px;font:inherit;';
      name.onclick=e=>e.stopPropagation();
      name.onchange=()=>{const title=name.value.trim().slice(0,160);if(busy || isLocked() || !title){name.value=item.title || '';return;}updateState({history:(getState().history || []).map(r=>r.id===item.id?{...r,title}:r)});onChanged?.();render();};
      name.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();name.blur();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();name.value=item.title || '';name.blur();}};
      card.append(check,picture,name,make('small',`${file?.width || '?'} × ${file?.height || '?'} · ${version?.snapshot?.steps ?? '?'} 步 · ${file?sizeLabel([{...item,versions:[version]}]):'大小未知'}`),make('p',`当前 V${version?.number || 1}`));
      const other=otherVersionCount(migrateHistory([item])[0]);if(other){const note=make('small',`另有 ${other} 个版本`);note.className='qm-other';card.append(note);}
      grid.append(card);
    }
    const foot=make('footer'), version=make('span','仅导出各作品当前版本');
    const del=button('删除所选',()=>void deleteResults([...selected]));del.style.color='#ff9b9b';del.disabled=busy || isLocked() || !selected.size;
    const zip=button('打包下载 ZIP',()=>void download(version.value));zip.disabled=busy || isLocked() || !selected.size;foot.append(version,del,zip);
    const info=make('div',message);info.className='qm-message';info.setAttribute('role','status');panel.append(head,grid,foot,info);grid.scrollTop=previousScroll;
    const dismissOutside=popup=>{outsideChooser=event=>{if(!popup.contains?.(event.target)){chooser=false;context=null;popup.remove();document.removeEventListener('pointerdown',outsideChooser,true);outsideChooser=null;}};document.addEventListener('pointerdown',outsideChooser,true);};
    if(chooser){const menu=make('div');menu.className='qm-chooser';menu.append(button('图片整理',()=>organize('date')),button('文件夹整理',()=>organize('folder')));organizerWrap.append(menu);const rect=organizerWrap.getBoundingClientRect?.();if(rect&&Number.isFinite(window.innerWidth)&&rect.left+(menu.offsetWidth||200)>window.innerWidth-8){menu.style.left='auto';menu.style.right='0';}if(rect&&Number.isFinite(window.innerHeight)&&rect.bottom+(menu.offsetHeight||48)>window.innerHeight-8){menu.style.top='auto';menu.style.bottom='calc(100% + 6px)';}dismissOutside(menu);}
    if(context?.type==='folder'){const menu=make('div');menu.className='qm-context';menu.style.left=`${context.x}px`;menu.style.top=`${context.y}px`;const items=history.filter(item=>context.ids.includes(item.id));if(context.canRename)menu.append(button('重命名文件夹',()=>{const group=context.group;context=null;render();renameArchiveFolder(group);}));const hasOthers=items.some(item=>otherVersionCount(migrateHistory([item])[0])>0);const clearFolder=button('清除文件夹内其他版本',()=>{const ids=items.map(item=>item.id);context=null;void deleteOtherVersions(ids);});clearFolder.disabled=busy||isLocked()||!hasOthers;menu.append(clearFolder);panel.append(menu);dismissOutside(menu);}
    else if(context){const item=history.find(record=>record.id===context.id);if(item){const menu=make('div');menu.className='qm-context';menu.style.left=`${context.x}px`;menu.style.top=`${context.y}px`;
      menu.append(button('打开图片',()=>{const id=item.id;context=null;render();onOpenImage?.(id);}),button('查看其他版本',()=>{const id=item.id;context=null;render();onViewVersions?.(id);}),button('清除其他版本',()=>{context=null;void deleteOtherVersions([item.id]);}));
      if(item.archived)menu.append(button('取消归档',()=>archive([item.id],false)));panel.append(menu);dismissOutside(menu);}}
  }
  function open(){if(overlay)return;selected=new Set();message='';mode='generation';folder=null;subfolder=null;chooser=false;context=null;overlay=make('div');overlay.className='qwen-manager';for(const type of ['pointerdown','click','dblclick','wheel','keydown'])overlay.addEventListener(type,e=>e.stopPropagation());keyHandler=e=>{if(e.key==='Escape' && e.target?.type!=='text'){e.preventDefault();e.stopPropagation();if(chooser){chooser=false;render();}else close();}if(e.key==='Tab'){const all=[...overlay.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled)')];if(!all.length)return;if(e.shiftKey&&document.activeElement===all[0]){e.preventDefault();all.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===all.at(-1)){e.preventDefault();all[0].focus();}}};document.addEventListener('keydown',keyHandler,true);document.body.append(overlay);render();void loadMetadata();overlay.querySelector('button')?.focus();}
  return {open,deleteResults,deleteOtherVersions,destroy(){busy=false;close();}};
}
