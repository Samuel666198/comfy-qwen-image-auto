import { migrateHistory, currentVersion } from './version-state.mjs?v=20260930-archive-date-1';

const operationNames = {generate:'生成',generation:'生成',regenerate:'重新生成',edit:'图片编辑',comments:'评论编辑',inpaint:'蒙版重绘',upscale:'RTX 超分'};
export function createVersionHistory({getItem,viewURL,onSelect,onLoadVersion,onDeleteOthers,isLocked=()=>false}) {
  let overlay = null, keydown = null, restoreFocus = null, busy = false;
  const make = (tag,text) => { const el=document.createElement(tag); if(text!=null)el.textContent=text; return el; };
  const close = () => { if(busy)return; overlay?.remove(); overlay=null; document.removeEventListener('keydown',keydown,true); if(restoreFocus?.isConnected)restoreFocus.focus(); };
  const button = (text,fn) => {const el=make('button',text);el.type='button';el.onclick=fn;return el;};
  function render() {
    if(!overlay)return;
    const raw=getItem();
    const item=raw ? migrateHistory([raw])[0] : null;
    if(!item){close();return;}
    const selected=currentVersion(item);
    overlay.replaceChildren();
    const style=make('style');style.textContent=`.qwen-version-history{position:fixed;inset:0;z-index:100002;background:#080b12cc;display:flex;align-items:center;justify-content:center;color:#e7e9f0;font:13px/1.5 system-ui}.qwen-version-history *{box-sizing:border-box}.qwen-version-history section{width:min(820px,92vw);max-height:85vh;background:#20232c;border:1px solid #45495b;border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px}.qwen-version-history header,.qwen-version-history footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.qwen-version-history h3{margin:0;flex:1}.qwen-version-history button{font:inherit;color:inherit;background:#292d3a;border:1px solid #484e62;border-radius:7px;padding:6px 10px;cursor:pointer}.qwen-version-history button:disabled{opacity:.4;cursor:default}.qwen-version-list{overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.qwen-version-card{padding:10px;border:1px solid #45495b;border-radius:9px;display:flex;flex-direction:column;gap:7px}.qwen-version-card[data-selected=true]{border-color:#a58ae5;background:#3b3056}.qwen-version-card img{width:100%;height:130px;object-fit:contain;background:#12151e;border-radius:6px}.qwen-version-card small{color:#b8bfce;overflow-wrap:anywhere}.qwen-version-history .danger{color:#ffaaaa;margin-left:auto}`;
    const panel=make('section'),header=make('header'),list=make('div'),footer=make('footer');list.className='qwen-version-list';
    const closeButton=button('关闭 Esc',close);closeButton.disabled=busy;
    header.append(make('h3',`${item.title || '作品'} · 版本历史`),closeButton);
    for(const version of item.versions || []) {
      const card=make('article');card.className='qwen-version-card';card.setAttribute('data-selected',String(version.id===selected?.id));
      const image=make('img');image.src=viewURL(version.file);image.alt=`V${version.number}`;image.loading='lazy';
      const source=item.versions.find(candidate=>candidate.id===version.sourceVersionId);
      const snapshot=version.snapshot || {},file=version.file || {};
      const sourceText=source ? ` · 来源 V${source.number}` : version.sourceVersionId ? ' · 来源版本已删除' : '';
      const details=make('details'),summary=make('summary','查看参数'),pre=make('pre',JSON.stringify(snapshot,null,2));pre.style.cssText='white-space:pre-wrap;max-height:180px;overflow:auto;font:11px monospace';details.append(summary,pre);
      const select=button(version.id===selected?.id ? '当前版本' : '切换至此版本',()=>{if(!busy){onSelect(item.id,version.id);render();}});select.disabled=busy || version.id===selected?.id;
      const load=button('载入提示词与参数',()=>{if(!isLocked()&&!busy){onLoadVersion?.(item.id,version.id);close();}});load.disabled=busy||isLocked();
      card.append(image,make('strong',`V${version.number} · ${operationNames[version.operation] || version.operation || '生成'}${sourceText}`),make('small',`${file.width || '?'} × ${file.height || '?'} · ${snapshot.steps == null ? '步数未记录' : `${snapshot.steps} 步`}`),make('small',version.createdAt ? new Date(version.createdAt).toLocaleString() : '时间未记录'),select,load,details);list.append(card);
    }
    const remove=button('删除其他版本',async()=>{if(busy||isLocked())return;busy=true;render();try{await onDeleteOthers?.(item.id);}finally{busy=false;render();}});remove.className='danger';remove.disabled=busy||isLocked()||(item.versions || []).length<2;
    footer.append(make('span',`按生成顺序排列 · 共 ${(item.versions || []).length} 个版本`),remove);panel.append(header,list,footer);overlay.append(style,panel);
  }
  function open(){if(overlay)return;restoreFocus=document.activeElement;overlay=make('div');overlay.className='qwen-version-history';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','图片版本历史');for(const type of ['pointerdown','click','dblclick','wheel','keydown'])overlay.addEventListener(type,e=>e.stopPropagation());overlay.onclick=e=>{if(e.target===overlay)close();};keydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab'){const buttons=[...overlay.querySelectorAll('button:not(:disabled)')];const first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',keydown,true);document.body.append(overlay);render();overlay.querySelector('button')?.focus();}
  return {open,render,close,destroy(){busy=false;close();}};
}
