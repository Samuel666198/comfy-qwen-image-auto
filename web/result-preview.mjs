import { createResultManager } from './result-manager.mjs?v=20261001-click-download-fix-1';
import { createVersionHistory } from './version-history.mjs?v=20260930-archive-date-1';
import { migrateHistory, currentVersion, previousVersion, selectVersion, addGeneratedResult, appendVersion, isAvailableReference } from './version-state.mjs?v=20260930-archive-date-1';

// State helpers deliberately have no DOM dependency; rendering never repairs saved state.
export function appendResult(history = [], result) {
  return addGeneratedResult(history, result);
}
export function applyUpscale(history = [], { resultId, file, sourceVersionId, snapshot } = {}) {
  const item = migrateHistory(history).find(item => item.id === resultId);
  const source = item?.versions.find(version => version.id === sourceVersionId) || currentVersion(item);
  return appendVersion(history, resultId, { file, snapshot: snapshot || { ...(source?.snapshot || {}), rtx_scale:file?.scale, rtx_quality:file?.quality }, operation:'upscale', sourceVersionId:source?.id });
}
export function renameResult(history, id, title) {
  const name = String(title ?? '').trim().slice(0, 160);
  return history.map(item => item.id === id && name ? { ...item, title: name } : item);
}
export function selectResultVersion(history, id, version) {
  const item=migrateHistory(history).find(item => item.id === id);
  const target = version === 'original' ? item?.versions[0]?.id : version === 'upscaled' ? item?.versions.filter(entry => entry.operation === 'upscale').at(-1)?.id : version;
  return selectVersion(history, id, target);
}
export function safeDownloadName(title, filename) {
  const extension = String(filename ?? '').match(/\.[a-z0-9]{1,8}$/i)?.[0] || '.png';
  const name = String(title || '作品').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 150) || '作品';
  return `${name}${extension}`;
}

export function containImageRect(width, height, imageWidth, imageHeight) {
  if (!(width > 0 && height > 0 && imageWidth > 0 && imageHeight > 0)) return { left:0, top:0, width:Math.max(0,width || 0), height:Math.max(0,height || 0) };
  const scale = Math.min(width/imageWidth, height/imageHeight);
  const renderedWidth = imageWidth*scale, renderedHeight = imageHeight*scale;
  return { left:(width-renderedWidth)/2, top:(height-renderedHeight)/2, width:renderedWidth, height:renderedHeight };
}

const styles = `
.qwen-result {color:#e7e9f0;font:12px/1.5 system-ui,sans-serif;min-width:0;position:relative}
.qwen-result *,.qwen-result-viewer *{box-sizing:border-box}
.qwen-result button,.qwen-result input,.qwen-result-viewer button {font:inherit;color:inherit;background:#252937;border:1px solid #42485b;border-radius:7px;padding:5px 9px}
.qwen-result button,.qwen-result-viewer button {cursor:pointer}
.qwen-result button:disabled {opacity:.4;cursor:default}
.qwen-result header,.qwen-result nav,.qwen-result .qr-toolbar {display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0}
.qwen-result input {flex:1;min-width:100px}
.qwen-result .qr-image {position:relative;min-height:210px;height:310px;background:#141722;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.qwen-result .qr-image img {width:100%;height:100%;object-fit:contain;display:block;cursor:zoom-in}
.qwen-result .qr-empty {padding:20px;color:#aab2c5;text-align:center}
.qwen-result .qr-menu-toggle {position:absolute;top:10px;right:10px;z-index:3;background:#161b27ed;font-size:20px;line-height:22px;min-width:36px}
.qwen-result .qr-toolbar {position:absolute;top:48px;right:10px;min-width:140px;display:flex;flex-direction:column;align-items:stretch;background:#161b27f5;padding:6px;border:1px solid #42485b;border-radius:8px;z-index:4;margin:0;box-shadow:0 8px 24px #0008}
.qwen-result .qr-toolbar button {text-align:left}
.qwen-result .qr-toolbar .qr-delete {color:#ffaaaa}
.qwen-result .qr-toolbar[hidden],.qwen-result [hidden]{display:none!important}
.qwen-result .qr-glow {position:absolute;inset:0;pointer-events:none;opacity:.45;background:linear-gradient(110deg,transparent 15%,#9a71ed66 38%,#5bcbd577 52%,transparent 78%);background-size:230% 100%;animation:qr-flow 3s ease-in-out infinite}
.qwen-result .qr-busy-mask {position:absolute;inset:-2px;background:#090d1b99;backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:5;overflow:hidden}
.qwen-result .qr-busy-content {position:relative;z-index:1;text-align:center;max-width:90%;padding:18px;color:#fff;text-shadow:0 1px 5px #000;white-space:pre-wrap}
.qwen-result .qr-spinner {display:block;width:32px;height:32px;margin:0 auto 14px;border:3px solid #ffffff30;border-top-color:#b795ff;border-radius:50%;animation:qr-spin 1s linear infinite}
.qwen-result .qr-status {padding:6px 0;color:#c9d6ff;white-space:pre-wrap}
.qwen-result .qr-meta {color:#aab2c5;overflow-wrap:anywhere}
.qwen-result pre {font:11px/1.5 monospace;max-height:180px;overflow:auto;white-space:pre-wrap;user-select:text}
.qwen-result button[aria-pressed=true] {border-color:#9a9ffc;background:#393653}
.qwen-result-viewer {position:fixed;inset:0;z-index:100000;background:#090c12f5;color:#fff;display:flex;flex-direction:column;font:14px system-ui}
.qwen-result-viewer .qr-view-controls {display:flex;align-items:center;justify-content:center;gap:10px;padding:12px;flex-wrap:wrap}
.qwen-result-viewer .qr-view-stage {flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab}
.qwen-result-viewer img {max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-select:none;-webkit-user-drag:none;pointer-events:none;transform-origin:center}
.qwen-result-viewer .qr-compare-stage {position:relative;flex:1;min-height:0;margin:0 16px 16px;overflow:hidden;touch-action:none;cursor:ew-resize}
.qwen-result-viewer .qr-compare-image-box {position:absolute;overflow:hidden}
.qwen-result-viewer .qr-compare-stage img {position:absolute;inset:0;width:100%;height:100%;max-width:none;max-height:none;object-fit:contain}
.qwen-result-viewer .qr-compare-divider {position:absolute;top:0;bottom:0;width:2px;background:#fff;transform:translateX(-50%);pointer-events:none;box-shadow:0 0 4px #000}
.qwen-result-viewer .qr-compare-divider::after {content:'↔';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);padding:8px 5px;border-radius:8px;background:#fff;color:#252937}
.qwen-result-viewer .qr-compare-label {position:absolute;top:10px;padding:4px 8px;background:#090c12bb;border-radius:5px;pointer-events:none}
.qwen-result-viewer .qr-compare-label-left {left:10px}
.qwen-result-viewer .qr-compare-label-right {right:10px}
.qwen-result-viewer input[type=range] {width:min(260px,40vw);accent-color:#9a71ed}
@keyframes qr-flow {0%,100%{background-position:100% 0}50%{background-position:0 0}}
@keyframes qr-spin {to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.qwen-result .qr-glow,.qwen-result .qr-spinner{animation:none;background-position:50% 0}}
`;

export function createResultPreview({ getState, updateState, onUpscale, onEdit, onLoadVersion, onFileBusyChange, isLocked = () => false, viewURL }) {
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (label, action) => {
    const element = make('button', '', label); element.type = 'button'; element.onclick = action; return element;
  };
  const svgPath = {
    previous:'<path d="m15 18-6-6 6-6"/>', next:'<path d="m9 18 6-6-6-6"/>',
    versions:'<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="8" cy="5" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="10" cy="19" r="2" fill="currentColor"/>',
    compare:'<path d="M4 5h16M4 19h16M12 3v18"/><path d="m9 9-3 3 3 3m6-6 3 3-3 3"/>',
    manager:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/>',
  };
  const iconButton = (label, icon, action, text='') => {
    const element = button(text, action); element.setAttribute('aria-label',label); element.title=label;
    element.innerHTML=`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPath[icon]}</svg>${text?`<span>${text}</span>`:''}`;
    element.style.cssText='display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:32px;'; return element;
  };
  const urlFor = viewURL || (file => `/view?${new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' })}`);
  const element = make('section', 'qwen-result');
  const style = make('style'); style.textContent = styles; element.append(style);
  const header = make('header');
  const title = make('input'); title.type = 'text'; title.maxLength = 160; title.setAttribute('aria-label', '作品名称');
  const position = make('span'); header.append(title, position);
  const frame = make('div', 'qr-image');
  const img = make('img'); img.alt = '生成结果'; img.draggable = false;
  const empty = make('div', 'qr-empty', '生成结果将在这里显示');
  const glow = make('div', 'qr-glow'); glow.hidden = true;
  const busyMask = make('div', 'qr-busy-mask'); busyMask.hidden = true;
  const busyContent = make('div', 'qr-busy-content'), busyText = make('div');
  busyContent.append(make('span', 'qr-spinner'), busyText); busyMask.append(glow, busyContent);
  const toolbar = make('div', 'qr-toolbar'); toolbar.hidden = true;
  const status = make('div', 'qr-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const meta = make('div', 'qr-meta');
  const details = make('details'); const summary = make('summary', '', '本次生成参数'); const parameters = make('pre'); details.append(summary, parameters);
  const nav = make('nav'); nav.setAttribute('aria-label', '结果历史');
  let current = null, currentFile = null, currentURL = '', job = null, destroyed = false, viewer = null, closeViewer = null, historyTargetResultId = null;
  const patchHistory = history => { updateState({ history }); render(); };
  const manager = createResultManager({ getState, updateState, isLocked, onBusyChange:onFileBusyChange, viewURL: urlFor, onChanged: () => { closeViewer?.(); render(); },
    onOpenImage: resultId => { const item=migrateHistory(getState().history || []).find(entry=>entry.id===resultId); if(item)openViewer(item); },
    onViewVersions: resultId => openHistory(resultId),
  });
  const versionHistory = createVersionHistory({
    getItem: () => (getState().history || []).find(item => item.id === (historyTargetResultId || current?.id)), viewURL:urlFor, isLocked,
    onSelect: (id,versionId) => patchHistory(selectVersion(getState().history,id,versionId)),
    onLoadVersion, onDeleteOthers: id => manager.deleteOtherVersions(id),
  });
  let menuOpen = false;
  const closeMenu = (restoreFocus = false) => {
    menuOpen = false; toolbar.hidden = true; menuToggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideMenu, true);
    document.removeEventListener('keydown', menuKeydown, true);
    if (restoreFocus) menuToggle.focus();
  };
  const outsideMenu = event => { if (!toolbar.contains(event.target) && !menuToggle.contains(event.target)) closeMenu(); };
  const menuKeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); } };
  const menuToggle = button('⋯', () => {
    if (menuOpen) { closeMenu(); return; }
    menuOpen = true; toolbar.hidden = false; menuToggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outsideMenu, true); document.addEventListener('keydown', menuKeydown, true);
    toolbar.querySelector('button')?.focus();
  });
  menuToggle.className = 'qr-menu-toggle'; menuToggle.setAttribute('aria-label', '图片操作'); menuToggle.setAttribute('aria-haspopup', 'true'); menuToggle.setAttribute('aria-expanded', 'false');
  const download = () => {
    closeMenu();
    if (!currentFile) return;
    const link = make('a'); link.href = urlFor(currentFile); link.download = safeDownloadName(current.title, currentFile.filename);
    document.body.append(link); link.click(); link.remove();
  };
  const openViewer = (targetItem = current) => {
    closeMenu();
    const targetVersion=currentVersion(targetItem), targetFile=targetVersion?.file;
    if (!targetFile || viewer) return;
    const previousFocus = document.activeElement;
    viewer = make('div', 'qwen-result-viewer'); viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true'); viewer.setAttribute('aria-label', targetItem?.title || '图片查看器');
    const controls = make('div', 'qr-view-controls'); const stage = make('div', 'qr-view-stage');
    const full = make('img'); full.src = urlFor(targetFile); full.alt = targetItem?.title || '生成结果'; full.draggable = false;
    let zoom = 1, x = 0, y = 0, drag = null;
    const zoomLabel = make('span');
    const transform = () => { full.style.transform = `translate(${x}px,${y}px) scale(${zoom})`; zoomLabel.textContent = `${Math.round(zoom * 100)}%`; };
    const resize = factor => { zoom = Math.min(8, Math.max(.1, zoom * factor)); transform(); };
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeViewer(); }
      if (event.key === 'Tab') {
        const buttons = [...controls.querySelectorAll('button')]; const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    closeViewer = () => { document.removeEventListener('keydown', keydown, true); viewer?.remove(); viewer = null; closeViewer = null; if (previousFocus?.isConnected) previousFocus.focus(); };
    const close = button('关闭 Esc', () => closeViewer());
    controls.append(button('缩小', () => resize(1/1.25)), zoomLabel, button('放大', () => resize(1.25)), button('适应窗口', () => { zoom=1; x=0; y=0; transform(); }), close);
    stage.onwheel = event => { event.preventDefault(); event.stopPropagation(); resize(event.deltaY < 0 ? 1.1 : 1/1.1); };
    stage.ondragstart = event => event.preventDefault(); full.ondragstart = event => event.preventDefault();
    stage.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); drag={x:event.clientX-x,y:event.clientY-y}; stage.setPointerCapture(event.pointerId); stage.style.cursor='grabbing'; };
    stage.onpointermove = event => { if (!drag) return; x=event.clientX-drag.x; y=event.clientY-drag.y; transform(); };
    stage.onpointerup = stage.onpointercancel = () => { drag=null; stage.style.cursor='grab'; };
    stage.append(full); viewer.append(controls, stage); document.body.append(viewer); document.addEventListener('keydown', keydown, true); transform(); close.focus();
  };
  const openCompare = () => {
    closeMenu();
    const beforeVersion = previousVersion(current), afterVersion = currentVersion(current);
    if (!beforeVersion?.file || !afterVersion?.file || viewer) return;
    const previousFocus = document.activeElement;
    viewer = make('div', 'qwen-result-viewer'); viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true'); viewer.setAttribute('aria-label', '图片版本对比');
    for (const event of ['pointerdown','click','dblclick','keydown','wheel']) viewer.addEventListener(event, e => e.stopPropagation());
    const controls = make('div', 'qr-view-controls'), stage = make('div', 'qr-compare-stage');
    const imageBox = make('div', 'qr-compare-image-box');
    const before = make('img'), after = make('img'), divider = make('div', 'qr-compare-divider');
    before.src = urlFor(beforeVersion.file); before.alt = `V${beforeVersion.number}`; after.src = urlFor(afterVersion.file); after.alt = `V${afterVersion.number}`;
    before.draggable = after.draggable = false;
    before.style.background = '#090c12';
    const loadStatus = make('span', '', ''); loadStatus.setAttribute('role', 'status');
    const imageError = () => { loadStatus.textContent = '图片文件无法读取，无法完成对比。'; before.hidden = after.hidden = divider.hidden = true; };
    before.onerror = after.onerror = imageError;
    const slider = make('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '0.1'; slider.value = '50'; slider.setAttribute('aria-label', '图片版本分界位置');
    const update = value => { const split = Math.min(100, Math.max(0, Number(value))); slider.value = String(split); before.style.clipPath = `inset(0 ${100-split}% 0 0)`; divider.style.left = `${split}%`; slider.setAttribute('aria-valuetext', `左侧 V${beforeVersion.number} ${Math.round(split)}%，右侧 V${afterVersion.number} ${Math.round(100-split)}%`); };
    slider.oninput = () => update(slider.value);
    let imageRect = {left:0, top:0, width:0, height:0};
    const originalSize = { width:beforeVersion.file.width, height:beforeVersion.file.height };
    const layout = () => {
      const rect = stage.getBoundingClientRect();
      imageRect = containImageRect(rect.width, rect.height, before.naturalWidth || originalSize.width, before.naturalHeight || originalSize.height);
      for (const key of ['left','top','width','height']) imageBox.style[key] = `${imageRect[key]}px`;
    };
    before.onload = after.onload = layout;
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null;
    observer?.observe(stage);
    window.addEventListener?.('resize', layout);
    let dragging = false;
    const moveDivider = event => { layout(); const rect = stage.getBoundingClientRect(); if (imageRect.width > 0) update((event.clientX-rect.left-imageRect.left)/imageRect.width*100); };
    stage.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); dragging=true; stage.setPointerCapture(event.pointerId); moveDivider(event); };
    stage.onpointermove = event => { if (dragging) moveDivider(event); };
    stage.onpointerup = stage.onpointercancel = () => { dragging=false; };
    const close = button('关闭 Esc', () => closeViewer());
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeViewer(); }
      if (event.key === 'Tab') {
        if (event.shiftKey && document.activeElement === slider) { event.preventDefault(); close.focus(); }
        else if (!event.shiftKey && document.activeElement === close) { event.preventDefault(); slider.focus(); }
      }
    };
    closeViewer = () => { observer?.disconnect(); window.removeEventListener?.('resize', layout); before.onload = after.onload = before.onerror = after.onerror = null; document.removeEventListener('keydown', keydown, true); viewer?.remove(); viewer=null; closeViewer=null; if (previousFocus?.isConnected) previousFocus.focus(); };
    controls.append(make('span', '', '拖动分界线对比'), slider, close, loadStatus);
    imageBox.append(after, before, divider, make('span', 'qr-compare-label qr-compare-label-left', `V${beforeVersion.number}`), make('span', 'qr-compare-label qr-compare-label-right', `V${afterVersion.number}`)); stage.append(imageBox);
    viewer.append(controls, stage); document.body.append(viewer); document.addEventListener('keydown', keydown, true); layout(); update(50); slider.focus();
  };
  const upscale = button('RTX 超分', () => {
    closeMenu();
    if (!current?.original || isLocked()) return;
    const resultId = current.id, versionId = currentVersion(current)?.id;
    if (currentVersion(current)?.operation === 'upscale' && !window.confirm('当前版本已经超分过，是否继续？将基于当前版本再次超分，并保存为新版本。')) return;
    if (!isLocked()) onUpscale?.(resultId,versionId);
  });
  const deleteButton = button('删除', () => { closeMenu(); if (current && !isLocked()) manager.deleteResults([current.id]); }); deleteButton.className = 'qr-delete';
  const editButton=button('图片编辑',()=>{closeMenu();if(current&&!isLocked())onEdit?.(current.id,currentVersion(current)?.id);});
  const openHistory=(resultId=current?.id)=>{closeMenu();if(resultId)historyTargetResultId=resultId;versionHistory.open();};
  toolbar.append(button('下载', download), button('大图查看', () => openViewer()), editButton, button('版本历史',()=>openHistory()), upscale, deleteButton);
  img.onclick = () => openViewer();
  img.ondblclick = () => openViewer();
  img.onerror = () => { img.hidden = true; empty.hidden = false; empty.textContent = '图片文件无法读取，请检查输出文件是否仍存在。'; };
  img.onload = () => { img.hidden = false; empty.hidden = true; };
  frame.append(img, empty, busyMask, menuToggle, toolbar);
  const move = delta => {
    const state = getState(); const history = migrateHistory(state.history || []).filter(item=>isAvailableReference(item)); const index = history.findIndex(item => item.id === current?.id);
    const item = history[index + delta]; if (item) { updateState({ selectedResultId: item.id }); render(); }
  };
  const previous = iconButton('上一张','previous', () => move(-1)); const next = iconButton('下一张','next', () => move(1));
  const versions = iconButton('版本历史','versions',()=>openHistory(),'V1');
  const compare = iconButton('对比','compare', openCompare);
  const managerButton = iconButton('图片管理器','manager', () => manager.open());
  nav.append(previous, next, versions, compare, managerButton);
  title.onchange = () => { if (current && !isLocked()) patchHistory(renameResult(getState().history, current.id, title.value)); else render(); };
  title.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); title.blur(); } };
  element.append(header, meta, details, frame, nav, status);
  element.style.overflow = 'auto';
  element.style.maxHeight = '100%';
  for (const event of ['pointerdown','click','dblclick','keydown','wheel']) element.addEventListener(event, e => e.stopPropagation());
  const renderJob = () => {
    const active = job && !['idle','completed','cancelled','failed'].includes(job.state);
    glow.hidden = !active;
    busyMask.hidden = !active;
    const stages = { submitting:'正在提交', queued:'等待队列', running:'正在生成', loading:'加载模型', encoding:'编码提示词', sampling:'采样中', decoding:'解码图片', saving:'保存结果', cancelling:'正在取消', reconciling:'正在核对任务', completed:'已完成', cancelled:'已取消', failed:'任务失败' };
    if (!job) { status.textContent = ''; busyText.textContent = ''; return; }
    const parts = [job.state === 'running' ? (stages[job.stage] || stages.running) : (stages[job.state] || '处理中')];
    if (job.message && job.state !== 'running' && job.message !== parts[0]) parts.push(String(job.message));
    const progress = job.progress;
    const sampling = job.state === 'running' && job.stage === 'sampling';
    if (sampling && progress && typeof progress === 'object' && Number.isFinite(progress.value) && Number.isFinite(progress.max)) parts.push(`${progress.value} / ${progress.max} 步`);
    else if (sampling && Number.isFinite(progress)) parts.push(`${Math.round(progress <= 1 ? progress * 100 : progress)}%`);
    if (sampling && Number.isFinite(job.estimatedSeconds)) parts.push(`约剩余 ${Math.max(0, Math.ceil(job.estimatedSeconds))} 秒`);
    if (active && Number.isFinite(job.elapsedSeconds)) parts.push(`已用 ${Math.max(0, Math.floor(job.elapsedSeconds))} 秒`);
    status.textContent = parts.join(' · ');
    busyText.textContent = status.textContent;
  };
  function render() {
    if (destroyed) return;
    const state = getState() || {}; const history = migrateHistory(state.history || []);
    const visibleHistory=history.filter(item=>isAvailableReference(item));
    current = visibleHistory.find(item => item.id === state.selectedResultId) || visibleHistory.at(-1) || null;
    currentFile = current?.selectedVersion === 'upscaled' && current.upscaled ? current.upscaled : current?.original;
    header.hidden = !current; nav.hidden = !current;
    frame.style.height = current ? '310px' : '210px';
    title.value = current?.title || ''; title.disabled = !current || isLocked();
    const index = visibleHistory.indexOf(current); position.textContent = current ? `${index+1} / ${visibleHistory.length}` : '0 / 0';
    previous.disabled = index <= 0; next.disabled = index < 0 || index >= visibleHistory.length-1;
    compare.disabled = !previousVersion(current);
    versions.disabled = !current; const versionLabel=current ? `V${currentVersion(current)?.number || 1}` : 'V1'; versions.innerHTML=`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPath.versions}</svg><span>${versionLabel}</span>`; versions.title=current?`版本历史 · ${versionLabel}`:'版本历史'; versions.setAttribute('aria-label',versions.title);
    upscale.disabled = !current?.original || isLocked(); editButton.disabled = !current || isLocked();
    deleteButton.disabled = !current || isLocked();
    details.hidden = !current; meta.hidden = !current;
    if (current) {
      const snapshot = current.snapshot || {};
      const size = currentFile?.width && currentFile?.height ? `${currentFile.width} × ${currentFile.height}` : '尺寸待确认';
      meta.textContent = [size, snapshot.steps != null ? `${snapshot.steps} 步` : '', snapshot.cfg != null ? `CFG ${snapshot.cfg}` : '', snapshot.seed != null ? `Seed ${snapshot.seed}` : '', currentFile?.scale ? `${currentFile.scale}× · ${currentFile.quality || ''}` : ''].filter(Boolean).join(' · ');
      parameters.textContent = JSON.stringify(snapshot, null, 2);
    }
    const nextURL = currentFile?.filename ? urlFor(currentFile) : '';
    if (nextURL !== currentURL) {
      currentURL = nextURL; closeMenu(); img.hidden = !nextURL; empty.hidden = !!nextURL;
      if (nextURL) img.src = nextURL; else { img.removeAttribute('src'); empty.textContent = '生成结果将在这里显示'; }
    }
    menuToggle.hidden = !nextURL;
    if (!nextURL) { img.hidden = true; empty.hidden = false; }
    renderJob();
    versionHistory.render();
  }
  function setJob(value) { job = value; render(); }
  function destroy() { destroyed = true; closeMenu(); manager.destroy(); versionHistory.destroy(); job = null; glow.hidden = true; closeViewer?.(); img.onload = img.onerror = null; element.remove(); }
  render();
  return { element, render, setJob, destroy };
}
