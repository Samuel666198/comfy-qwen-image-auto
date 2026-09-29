import { readableSnapshotPrompt, mentionCandidates, resolveMentionReference } from "./prompt-history.mjs?v=20260927-region-1";
import { createImageHoverPreview } from "./image-hover.mjs?v=20260927-region-1";

const MARKER = /\[\[qwen-ref:([^\]]+)\]\]/g;

export function estimatePromptLength(value, refs = []) {
  let visible = String(value || '').replace(MARKER, (_marker, id) => {
    const index = refs.findIndex(ref => ref.id === id);
    return index < 0 ? '图片已删除' : `图片${index + 1}`;
  });
  let weightedCount = 0;
  for (const char of visible) {
    if (/\p{Script=Han}/u.test(char)) weightedCount += 1;
    else if (/[\p{Script=Latin}\p{Decimal_Number}]/u.test(char)) weightedCount += 0.25;
    else weightedCount += 1;
  }
  return { weightedCount, limit: 680 };
}

export function promptParts(value) {
  const parts = [];
  let start = 0;
  for (const match of String(value || "").matchAll(MARKER)) {
    if (match.index > start) parts.push({ text: value.slice(start, match.index) });
    parts.push({ id: match[1] });
    start = match.index + match[0].length;
  }
  if (start < String(value || "").length) parts.push({ text: value.slice(start) });
  return parts;
}

export function createPromptEditor(node, initialValue, getRefs, onChange, options = {}) {
  const hoverPreview = createImageHoverPreview();
  const referenceURL = ref => ref?.missing ? '' : (options.getReferenceURL?.(ref) || ref?.img?.src || '');
  const root = document.createElement("div");
  root.className = "qwen-prompt-root";
  root.style.cssText = "padding:4px 8px 8px;height:160px;box-sizing:border-box;";
  const label = document.createElement("div");
  label.textContent = "画面描述 · 输入 @ 引用参考图";
  label.style.cssText = "color:#9aa0ae;font-size:12px;height:24px;display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;";
  const expand = document.createElement("button");
  expand.type = "button";
  expand.textContent = "⤢";
  expand.title = "放大编辑提示词";
  expand.setAttribute("aria-label", "放大编辑提示词");
  expand.style.cssText = "border:0;border-radius:4px;background:transparent;color:#c9c2ef;font-size:19px;cursor:pointer;padding:0 5px;";
  const actions = document.createElement("span");
  actions.style.cssText = "display:flex;align-items:center;gap:5px;";
  const history = document.createElement("button");
  history.type = "button";
  history.title = "提示词历史";
  history.setAttribute("aria-label", "提示词历史");
  history.style.cssText = expand.style.cssText;
  history.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 11a9 9 0 1 1 2.7 7M3 4v7h7M12 7v5l3 2"/></svg>';
  const clear = document.createElement('button');
  const optimize = document.createElement('button');
  const transparent = document.createElement('button');
  for (const [button, title, path] of [
    [clear, '清空提示词', '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'],
    [optimize, '一键优化提示词', '<path d="m4 20 12-12 4 4L8 24M15 2v4M13 4h4M5 4v6M2 7h6M20 17v5M18 19h4"/>'],
    [transparent, '透明通道：关闭', '<path d="M3 3h18v18H3zM3 9h18M9 3v18M15 3v18M3 15h18"/>'],
  ]) {
    button.type='button';button.title=title;button.setAttribute('aria-label',title);button.style.cssText=expand.style.cssText;
    button.innerHTML=`<svg width="17" height="17" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${path}</svg>`;
    button.addEventListener('mousedown',event=>event.preventDefault());
  }
  const imageActions = [
    ['蒙版重绘', 'onMask', '<path d="M4 16 15 5l4 4L8 20H4v-4ZM13 7l4 4M13 20h8"/>'],
    ['图片编辑', 'onEdit', '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m4 17 5-5 4 4 4-6 4 6M8 7h.01"/>'],
  ].map(([title, callback, path]) => {
    const button = document.createElement('button');
    button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
    button.style.cssText = expand.style.cssText; button.disabled = true;
    button.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${path}</svg>`;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (!disabled && imageActionsEnabled && !composing) { close(); options[callback]?.(); }
    });
    return button;
  });
  actions.append(...imageActions, optimize, clear, history, transparent, expand);
  label.appendChild(actions);
  const editor = document.createElement("div");
  editor.className = "qwen-prompt-editor";
  editor.contentEditable = "true";
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "画面描述，输入 @ 引用参考图");
  editor.setAttribute("aria-multiline", "true");
  editor.style.cssText = "height:120px;min-height:0;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;padding:9px 10px 24px;border-radius:7px;background:#202127;border:1px solid #454854;color:#eceef4;font:13px/1.5 sans-serif;outline:none;";
  root.append(label, editor);
  const counter = document.createElement('span');
  counter.setAttribute('aria-live', 'polite');
  counter.style.cssText = 'position:absolute;right:14px;bottom:11px;text-align:right;color:#8f93a0;font:10px/14px sans-serif;pointer-events:none;';
  counter.title = '加权字数软提示：汉字 1，英文和数字 0.25，空格及标点 1；不截断内容。';
  root.appendChild(counter);
  const popup = document.createElement("div");
  popup.className = "qwen-mention-popup";
  popup.style.cssText = "position:fixed;z-index:100000;min-width:210px;max-width:340px;max-height:220px;overflow:auto;background:#202127;border:1px solid #6f58cb;border-radius:8px;box-shadow:0 12px 28px #0009;padding:4px;display:none;";
  document.body.appendChild(popup);
  let matchState = null;
  let selected = 0;
  let composing = false;
  let widget;
  let disabled = false;
  let imageActionsEnabled = false;
  let hasText = Boolean(String(initialValue || '').trim());
  let initialized = false;
  let overlay = null;
  let dialog = null;
  let optimizeDialog = null;
  let historyOverlay = null;
  let optimizeProgress = null;
  let feedbackTimer;
  let optimizerAnimation;
  let optimizeStartedAt = 0;
  let optimizeTimer = null;
  let optimizeStatus = '';
  const feedback=document.createElement('span');
  feedback.setAttribute('role','status');feedback.style.cssText='position:absolute;right:8px;top:26px;z-index:2;background:#393047;color:#f4edff;border-radius:6px;padding:4px 8px;font:12px sans-serif;pointer-events:none;';
  root.style.position='relative';
  function notify(message, duration=1600) {
    clearTimeout(feedbackTimer);feedback.textContent=message;root.appendChild(feedback);
    feedbackTimer=setTimeout(()=>feedback.remove(),duration);
  }
  function setOptimizeProgress(status, preview = '', onCancel = null) {
    if (!status) { clearInterval(optimizeTimer); optimizeTimer = null; optimizeProgress?.remove(); optimizeProgress = null; return; }
    const wasVisible = Boolean(optimizeProgress);
    if (!optimizeProgress) {
      optimizeProgress = document.createElement('div');
      optimizeProgress.setAttribute('role', 'status');
      optimizeProgress.setAttribute('aria-live', 'polite');
      optimizeProgress.style.cssText = 'position:absolute;inset:27px 8px 8px;z-index:5;display:flex;flex-direction:column;gap:7px;box-sizing:border-box;padding:10px;border:1px solid #67588a;border-radius:8px;background:#202127f5;box-shadow:0 8px 28px #0008;color:#eceaf2;font:12px/1.45 sans-serif;';
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:8px;flex:none;';
      const spinner = document.createElement('span'); spinner.dataset.role='spinner';
      spinner.style.cssText='width:13px;height:13px;flex:none;border:2px solid #ffffff30;border-top-color:#b795ff;border-radius:50%;animation:qwen-opt-spin .9s linear infinite;';
      const spinnerStyle=document.createElement('style');spinnerStyle.textContent='@keyframes qwen-opt-spin{to{transform:rotate(360deg)}}';
      const label = document.createElement('span'); label.dataset.role = 'label'; label.style.cssText = 'flex:1;min-width:0;color:#c8b9f0;';
      const elapsed = document.createElement('span'); elapsed.dataset.role = 'elapsed'; elapsed.style.cssText = 'color:#aaa3b7;white-space:nowrap;';
      const cancel = document.createElement('button'); cancel.type='button'; cancel.textContent='取消';
      cancel.style.cssText='border:1px solid #575063;border-radius:6px;padding:4px 9px;background:#302d37;color:#eee;cursor:pointer;';
      header.append(spinnerStyle,spinner,label, elapsed, cancel);
      const content = document.createElement('div'); content.dataset.role='preview';
      content.style.cssText='flex:1;min-height:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;color:#dfdce8;background:#17181d;border-radius:5px;padding:8px;';
      content.textContent='等待改写内容…';
      optimizeProgress.append(header, content); root.appendChild(optimizeProgress);
    }
    optimizeProgress.querySelector('[data-role="label"]').textContent = status;
    if (!wasVisible) { optimizeStartedAt = Date.now(); optimizeStatus = status; }
    const elapsed = optimizeProgress.querySelector('[data-role="elapsed"]');
    const updateElapsed = () => { if (elapsed) elapsed.textContent = `${Math.floor((Date.now() - optimizeStartedAt) / 1000)} 秒`; };
    updateElapsed();
    if (!optimizeTimer) optimizeTimer = setInterval(updateElapsed, 1000);
    const content = optimizeProgress.querySelector('[data-role="preview"]');
    content.textContent = preview || (status.includes('判断') ? '正在分析提示词类型…' : '正在准备输出…');
    const spinner = optimizeProgress.querySelector('[data-role="spinner"]'); if (spinner) spinner.hidden = Boolean(preview);
    content.scrollTop = content.scrollHeight;
    const cancel = optimizeProgress.querySelector('button');
    cancel.disabled = !onCancel;
    cancel.style.opacity = onCancel ? '1' : '.6';
    cancel.onclick = event => { event.stopPropagation(); onCancel?.(); };
  }
  clear.addEventListener('click',event=>{
    event.stopPropagation();if(disabled || composing)return;
    options.onBeforeClear?.();writeValue('');sync();close();notify('已清空');editor.focus();
  });
  optimize.addEventListener('click',async event=>{
    event.stopPropagation();if(disabled || composing)return;
    if(!readValue().trim()){notify('请先输入提示词');return;}
    openOptimizeDialog();
  });
  transparent.addEventListener('click', event => {
    event.stopPropagation(); if (disabled || composing) return;
    const enabled = !Boolean(options.getTransparentBackground?.());
    options.onToggleTransparentBackground?.(enabled);
    widget.setTransparentBackground(enabled);
    notify(enabled ? '透明通道提示已开启' : '透明通道提示已关闭');
  });
  const compactStyle = editor.style.cssText;

  function closeHistory() { historyOverlay?.remove(); historyOverlay = null; }
  function openOptimizeDialog() {
    if (disabled || composing || optimizeProgress || optimizeDialog) return;
    close();
    const overlay = document.createElement('div');
    optimizeDialog = overlay;
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100020;background:#0009;display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;';
    const panel = document.createElement('div'); panel.setAttribute('role','dialog'); panel.setAttribute('aria-modal','true'); panel.setAttribute('aria-label','提示词优化');
    panel.style.cssText = 'width:min(520px,100%);padding:16px;background:#22232b;color:#eee;border:1px solid #595364;border-radius:10px;box-shadow:0 16px 50px #0009;font:13px/1.5 sans-serif;';
    const heading = document.createElement('div'); heading.textContent='提示词优化'; heading.style.cssText='font-size:14px;font-weight:600;margin-bottom:8px;';
    const hint = document.createElement('div'); hint.textContent='可以补充优化方向；当前提示词和参考图片会一并发送给优化模型。'; hint.style.cssText='color:#aaa3b7;margin-bottom:10px;';
    const input = document.createElement('textarea'); input.setAttribute('aria-label','补充优化要求'); input.placeholder='选填，例如：保持主体不变，重点加强光影细节';
    input.style.cssText='display:block;width:100%;height:100px;box-sizing:border-box;resize:vertical;padding:9px;border-radius:7px;border:1px solid #454854;background:#17181d;color:#eee;font:13px/1.5 sans-serif;';
    const buttons = document.createElement('div'); buttons.style.cssText='display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';
    const cancel = document.createElement('button'); cancel.type='button'; cancel.textContent='取消';
    const confirm = document.createElement('button'); confirm.type='button'; confirm.textContent='开始优化';
    for (const button of [cancel,confirm]) button.style.cssText='border:1px solid #62597a;border-radius:6px;padding:6px 12px;background:#302d37;color:#eee;cursor:pointer;';
    confirm.style.background='#7050bd';
    const dismiss = () => { overlay.remove(); if (optimizeDialog === overlay) optimizeDialog = null; };
    cancel.onclick = dismiss; confirm.onclick = () => { const instruction=input.value.trim(); dismiss(); void options.onOptimize?.(instruction); };
    overlay.addEventListener('pointerdown', event=>{event.stopPropagation();if(event.target===overlay)dismiss();});
    overlay.addEventListener('keydown', event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();dismiss();} if(event.key==='Tab'){event.preventDefault();(event.shiftKey?cancel:confirm).focus();}});
    buttons.append(cancel,confirm); panel.append(heading,hint,input,buttons); overlay.appendChild(panel); document.body.appendChild(overlay); input.focus();
  }
  function openHistory() {
    if (disabled || composing) return;
    close(); closeHistory();
    historyOverlay = document.createElement("div");
    historyOverlay.className = "qwen-prompt-history-overlay";
    historyOverlay.style.cssText = "position:fixed;inset:0;z-index:100010;background:#0008;display:flex;align-items:center;justify-content:center;padding:24px;";
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", "提示词历史");
    panel.style.cssText = "width:min(680px,100%);max-height:80vh;overflow:auto;padding:18px;background:#22232b;color:#eee;border:1px solid #595364;border-radius:12px;font:13px/1.5 sans-serif;";
    const heading = document.createElement("div");
    heading.textContent = "提示词历史 · 最近 50 条";
    heading.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;";
    const button = (text, action) => {
      const el = document.createElement("button"); el.type = "button"; el.textContent = text;
      el.style.cssText = "border:1px solid #555063;background:#2c2938;color:#eee;padding:5px 10px;border-radius:6px;cursor:pointer;";
      el.addEventListener("click", action); return el;
    };
    const done = button("关闭", closeHistory); heading.appendChild(done); panel.appendChild(heading);
    const snapshots = options.getPromptHistory?.() || [];
    if (!snapshots.length) { const empty = document.createElement("p"); empty.textContent = "暂无提示词历史"; panel.appendChild(empty); }
    for (const snapshot of [...snapshots].reverse()) {
      const row = document.createElement("div"); row.style.cssText = "border-top:1px solid #45414d;padding:12px 0;";
      const date = document.createElement("div");
      const time = new Date(snapshot.createdAt);
      date.textContent = Number.isNaN(time.getTime()) ? "历史提示词" : time.toLocaleString();
      date.style.cssText = "color:#a8a3b4;font-size:12px;";
      const text = document.createElement("div"); text.textContent = readableSnapshotPrompt(snapshot);
      text.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;max-height:150px;overflow:auto;margin:6px 0;";
      const buttons = document.createElement("div"); buttons.style.cssText = "display:flex;gap:8px;";
      const status = document.createElement("span"); status.setAttribute("role", "status");
      buttons.append(button("载入", async () => {
        try { if (await options.onLoadPromptSnapshot?.(snapshot.id) !== false) closeHistory(); }
        catch (error) { status.textContent = error.message || "载入失败"; }
      }), button("复制", async () => {
        try { await navigator.clipboard.writeText(readableSnapshotPrompt(snapshot)); status.textContent = "已复制"; }
        catch { status.textContent = "复制失败，请选中文本复制"; }
      }), button("删除", async () => {
        try { if (await options.onDeletePromptSnapshot?.(snapshot.id) !== false && historyOverlay) openHistory(); }
        catch (error) { status.textContent = error.message || "删除失败"; }
      }), status);
      row.append(date, text, buttons); panel.appendChild(row);
    }
    historyOverlay.appendChild(panel); document.body.appendChild(historyOverlay);
    historyOverlay.addEventListener("pointerdown", event => { event.stopPropagation(); if (event.target === historyOverlay) closeHistory(); });
    historyOverlay.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); closeHistory(); history.focus(); }
      if (event.key === "Tab") {
        const controls = [...panel.querySelectorAll("button")];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    done.focus();
  }
  history.addEventListener("mousedown", event => event.preventDefault());
  history.addEventListener("click", event => { event.stopPropagation(); openHistory(); });

  function captureSelection() {
    const selection = window.getSelection();
    return selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0).cloneRange() : null;
  }
  function restoreSelection(range, scrollTop) {
    editor.focus({ preventScroll: true });
    if (range) {
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
    }
    editor.scrollTop = scrollTop;
  }
  function closeExpanded({ focus = true, force = false } = {}) {
    if (!overlay || (composing && !force)) return;
    const range = captureSelection();
    const scrollTop = editor.scrollTop;
    close();
    root.appendChild(editor);
    root.appendChild(counter);
    counter.style.cssText = 'align-self:flex-end;text-align:right;color:#8f93a0;font:10px/14px sans-serif;pointer-events:none;';
    editor.style.cssText = compactStyle;
    overlay.remove(); overlay = null; dialog = null;
    counter.style.cssText = 'position:absolute;right:14px;bottom:11px;text-align:right;color:#8f93a0;font:10px/14px sans-serif;pointer-events:none;';
    expand.setAttribute("aria-expanded", "false");
    if (focus && !disabled) restoreSelection(range, scrollTop);
  }
  function openExpanded() {
    if (disabled || overlay || composing) return;
    const range = captureSelection();
    const scrollTop = editor.scrollTop;
    close();
    overlay = document.createElement("div");
    overlay.className = "qwen-prompt-overlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:99990;background:#0008;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;";
    dialog = document.createElement("div");
    dialog.className = "qwen-prompt-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "编辑提示词");
    dialog.style.cssText = "width:min(760px,100%);height:min(560px,calc(100vh - 48px));display:flex;flex-direction:column;gap:12px;padding:18px;box-sizing:border-box;border-radius:12px;background:#22232b;border:1px solid #595364;box-shadow:0 20px 60px #0008;color:#eee;";
    const heading = document.createElement("div");
    heading.textContent = "画面描述 · 输入 @ 引用参考图";
    heading.style.cssText = "display:flex;align-items:center;justify-content:space-between;font:14px sans-serif;";
    const done = document.createElement("button");
    done.type = "button"; done.textContent = "完成";
    done.style.cssText = "background:#7050bd;color:white;border:1px solid #9472df;border-radius:6px;padding:6px 14px;cursor:pointer;";
    done.addEventListener("click", () => closeExpanded());
    heading.appendChild(done);
    editor.style.cssText = `${compactStyle}height:auto;flex:1;font-size:15px;`;
    dialog.append(heading, editor, counter); overlay.appendChild(dialog); document.body.appendChild(overlay);
    overlay.addEventListener("pointerdown", (event) => {
      if (event.target === overlay) { event.preventDefault(); closeExpanded(); }
      event.stopPropagation();
    });
    overlay.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape" && !event.isComposing && !composing) { event.preventDefault(); closeExpanded(); }
      if (event.key === "Tab") { event.preventDefault(); editor.focus(); }
    });
    expand.setAttribute("aria-expanded", "true");
    restoreSelection(range, scrollTop);
  }
  expand.setAttribute("aria-expanded", "false");
  expand.addEventListener("mousedown", (event) => event.preventDefault());
  expand.addEventListener("click", (event) => { event.stopPropagation(); openExpanded(); });

  function chip(id) {
    const span = document.createElement("span");
    span.contentEditable = "false";
    span.dataset.qwenRefId = id;
    span.addEventListener('mouseenter', () => {
      const ref = getRefs().find(item => item.id === id);
      hoverPreview.show(referenceURL(ref), span.getBoundingClientRect(), ref?.name || '');
    });
    span.addEventListener('mouseleave', hoverPreview.hide);
    span.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;margin:0 2px;background:#423568;border:1px solid #8265d5;border-radius:5px;color:#f2eefe;vertical-align:middle;cursor:default;user-select:all;";
    return span;
  }
  function refreshChips() {
    const refs = getRefs();
    for (const span of editor.querySelectorAll("[data-qwen-ref-id]")) {
      const ref = refs.find((item) => item.id === span.dataset.qwenRefId);
      span.replaceChildren();
      if (ref && !ref.missing) {
        if (referenceURL(ref)) {
          const img = document.createElement("img");
          img.src = referenceURL(ref);
          img.alt = "";
          img.style.cssText = "width:20px;height:20px;object-fit:cover;border-radius:3px;";
          span.appendChild(img);
        }
        span.appendChild(document.createTextNode(`图片${refs.indexOf(ref) + 1}`));
        span.title = ref.name;
        span.style.borderColor = "#8265d5";
      } else {
        span.textContent = "图片已删除";
        span.title = "该参考图已删除，请移除标签或重新选择";
        span.style.borderColor = "#e77b83";
      }
    }
    if (initialized) updateCounter();
  }
  function readValue() {
    let result = "";
    function visit(parent) {
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) result += child.textContent;
        else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.dataset.qwenRefId) result += `[[qwen-ref:${child.dataset.qwenRefId}]]`;
          else if (child.tagName === "BR") result += "\n";
          else { if (child !== editor && result && !result.endsWith("\n")) result += "\n"; visit(child); }
        }
      }
    }
    visit(editor);
    return result.replace(/\u00a0/g, " ");
  }
  function writeValue(value) {
    hasText=Boolean(String(value || '').trim());optimize.disabled=disabled || !hasText;
    const fragment = document.createDocumentFragment();
    for (const part of promptParts(String(value || ""))) {
      if (part.id) fragment.appendChild(chip(part.id));
      else fragment.appendChild(document.createTextNode(part.text));
    }
    editor.replaceChildren(fragment);
    refreshChips();
    updateCounter(String(value || ''));
  }
  function updateCounter(value = readValue()) {
    const estimate = estimatePromptLength(value, getRefs());
    const count = Math.round(estimate.weightedCount);
    counter.textContent = `${count}/${estimate.limit}`;
    counter.style.color = estimate.weightedCount > estimate.limit ? '#e7a0a0' : '#8f93a0';
    counter.title = '加权字数软提示：汉字 1，英文和数字 0.25，空格及标点 1；不截断内容。';
  }
  function sync() { const value=readValue();hasText=Boolean(value.trim());optimize.disabled=disabled || !hasText;updateCounter();onChange(value); node.graph?.setDirtyCanvas(true, true); }
  function close() { popup.style.display = "none"; matchState = null; hoverPreview.hide(); }
  function insert(ref) {
    if (!matchState) return;
    const { textNode, start, end } = matchState;
    if (!textNode.isConnected) return close();
    ref = resolveMentionReference(ref, options.onAddGeneratedRef);
    if (!ref) return close();
    const after = textNode.splitText(end);
    textNode.textContent = textNode.textContent.slice(0, start);
    const span = chip(ref.id);
    after.parentNode.insertBefore(span, after);
    const spacer = document.createTextNode(" ");
    after.parentNode.insertBefore(spacer, after);
    refreshChips();
    updateCounter();
    const range = document.createRange();
    range.setStart(spacer, 1); range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    editor.focus(); sync(); close();
  }
  function updatePopup() {
    if (composing || document.activeElement !== editor) return close();
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return close();
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return close();
    const text = range.startContainer.textContent.slice(0, range.startOffset);
    const found = /@([^@\s]{0,30})$/.exec(text);
    if (!found) return close();
    const query = found[1].toLowerCase();
    const refs = mentionCandidates(getRefs(), options.getGeneratedRefs?.() || [], query);
    if (!refs.length) return close();
    matchState = { textNode: range.startContainer, start: range.startOffset - found[0].length, end: range.startOffset, refs };
    selected = Math.min(selected, refs.length - 1);
    hoverPreview.hide();
    popup.replaceChildren();
    let group = null;
    refs.forEach((ref, i) => {
      if (ref.mentionGroup !== group) {
        group = ref.mentionGroup;
        const heading = document.createElement("div"); heading.textContent = group;
        heading.style.cssText = "font-size:11px;color:#aaa3b7;padding:5px 8px;";
        popup.appendChild(heading);
      }
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:center;gap:8px;min-width:0;padding:6px 8px;border-radius:5px;cursor:pointer;color:#eef;${i === selected ? "background:#46376e;" : ""}`;
      row.title = ref.mentionLabel;
      const thumbnail = document.createElement('img'); thumbnail.alt = '';
      thumbnail.style.cssText = 'width:36px;height:36px;flex:0 0 36px;object-fit:cover;border-radius:4px;background:#17181e;';
      const url = referenceURL(ref);
      if (url) thumbnail.src = url;
      thumbnail.addEventListener('error', () => { thumbnail.style.visibility = 'hidden'; });
      const name = document.createElement('span');
      const version = ref.generated ? /\s*·\s*(V\d+)\s*$/.exec(ref.mentionLabel) : null;
      name.textContent = version ? ref.mentionLabel.slice(0, version.index) : ref.mentionLabel;
      name.style.cssText = 'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      row.append(thumbnail, name);
      if (version) {
        const badge = document.createElement('span'); badge.textContent = version[1];
        badge.style.cssText = 'flex:none;color:#bbb1d6;font-size:12px;'; row.appendChild(badge);
      }
      row.addEventListener('mouseenter', () => hoverPreview.show(url, row.getBoundingClientRect(), ref.mentionLabel));
      row.addEventListener('mouseleave', hoverPreview.hide);
      row.addEventListener("mousedown", (event) => { event.preventDefault(); insert(ref); });
      popup.appendChild(row);
    });
    const rect = range.getBoundingClientRect();
    popup.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 350))}px`;
    popup.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - 230)}px`;
    popup.style.display = "block";
  }
  editor.addEventListener("compositionstart", () => { composing = true; close(); });
  editor.addEventListener("compositionend", () => { composing = false; sync(); updatePopup(); });
  editor.addEventListener("input", () => { sync(); updatePopup(); });
  editor.addEventListener("keyup", (event) => { event.stopPropagation(); updatePopup(); });
  editor.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (composing || event.isComposing) return;
    if (event.key === "Tab" && overlay) { event.preventDefault(); dialog.querySelector("button").focus(); return; }
    if (popup.style.display !== "block") {
      if (event.key === "Escape" && overlay) { event.preventDefault(); closeExpanded(); }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + matchState.refs.length) % matchState.refs.length; updatePopup();
    } else if (event.key === "Enter") { event.preventDefault(); insert(matchState.refs[selected]); }
  });
  editor.addEventListener("paste", (event) => {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData?.getData("text/plain") || "");
  });
  editor.addEventListener("blur", () => setTimeout(close, 100));
  widget = node.addDOMWidget("qwen_prompt_editor", "qwen_prompt", root, {
    serialize: false, getMinHeight: () => 160, getMaxHeight: () => 160,
  });
  widget.readValue = readValue;
  widget.writeValue = writeValue;
  widget.refreshChips = refreshChips;
  widget.refreshMentions = () => { if (popup.style.display === 'block') updatePopup(); };
  widget.notify = notify;
  widget.setImageActionsEnabled = value => {
    imageActionsEnabled = Boolean(value);
    for (const button of imageActions) button.disabled = disabled || !imageActionsEnabled;
  };
  widget.setOptimizing = value => {
    optimizerAnimation?.cancel();
    if(value)optimizerAnimation=optimize.animate?.([{opacity:1},{opacity:.25},{opacity:1}],{duration:1000,iterations:Infinity});
    optimize.title=value?'正在优化…':'一键优化提示词';
  };
  widget.setOptimizeProgress = setOptimizeProgress;
  widget.setTransparentBackground = value => {
    const enabled = Boolean(value);
    transparent.setAttribute('aria-pressed', String(enabled));
    transparent.title = enabled ? '透明通道：开启' : '透明通道：关闭';
    transparent.style.color = enabled ? '#d3c4ff' : '#c9c2ef';
    transparent.style.background = enabled ? '#493a70' : 'transparent';
  };
  widget.getDropElement = () => dialog || root;
  widget.setDisabled = (value) => {
    disabled = Boolean(value);
    editor.contentEditable = disabled ? "false" : "true";
    editor.setAttribute("aria-disabled", String(disabled));
    expand.disabled = disabled;
    history.disabled = disabled;
    transparent.disabled = disabled;
    clear.disabled = disabled;optimize.disabled = disabled || !hasText;
    for (const button of imageActions) button.disabled = disabled || !imageActionsEnabled;
    if (disabled) { close(); closeHistory(); closeExpanded({ focus: false, force: true }); optimizeDialog?.remove(); optimizeDialog=null; composing = false; }
    root.style.opacity = disabled ? "0.6" : "1";
  };
  widget.cleanup = () => { hoverPreview.destroy();optimizerAnimation?.cancel();clearInterval(optimizeTimer);optimizeTimer=null;optimizeProgress?.remove();optimizeProgress=null;optimizeDialog?.remove();optimizeDialog=null;clearTimeout(feedbackTimer);feedback.remove();closeHistory(); closeExpanded({ focus: false, force: true }); popup.remove(); };
  writeValue(initialValue);
  initialized = true;
  widget.setTransparentBackground(options.getTransparentBackground?.());
  return widget;
}
