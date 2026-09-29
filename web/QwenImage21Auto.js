import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
// Keep release dependencies together: Desktop intercepts hard-reload shortcuts.
import { isRefFileDrop, normalizeRefs, moveRef, normalizeLoras, presetForSteps, resolveInferenceState, normalizeAccelerators, aspectRatioFromPrompt, shouldApplyPromptRatio } from "./panel-state.mjs?v=20260927-region-4";
import { createPromptEditor, estimatePromptLength } from "./prompt-editor.mjs?v=20260930-weighted-count-2";
import { createParameterPopover } from "./parameter-popover.mjs?v=20260927-resolution-480-768-1";
import { createResultPreview, appendResult, applyUpscale } from "./result-preview.mjs?v=20260930-folder-context-1";
import { createGenerationController, isJobBusy } from "./generation-controller.mjs?v=20260929-refinement-1";

import { createExtensionsPopover } from "./extensions-popover.mjs?v=20260928-responses-1";
import { migrateHistory, currentVersion, addGeneratedResult, appendVersion, addPromptSnapshot, isAvailableReference } from './version-state.mjs?v=20260930-archive-date-1';
import { optimizerRequest, optimizerStreamRequest, toOptimizerPrompt, fromOptimizerPrompt } from './prompt-optimizer.mjs?v=20260928-responses-1';
import { openRegionEditor } from './region-editor.mjs?v=20260927-annotation-layers-1';
import { regionPrompt, regionForSubmission } from './region-state.mjs?v=20260927-annotation-layers-1';
import { createImageHoverPreview } from './image-hover.mjs?v=20260927-region-4';

// QwenImage21Auto 自绘布局:
//  - refs_json -> 参考图缩略图网格 widget (拖入/点击添加, 可删除/替换, 上限10)
//  - lora_json -> LoRA 动态行 widget (增/删/替换, 自绘下拉列表)
//  - lora_list -> 隐藏, 仅提供 LoRA 文件下拉选项
//  - show_advanced / aspect_ratio / negative_preset -> 联动折叠

const NODE_NAME = "QwenImage21Auto";
const instances = new Set();

const REF_MAX = 10;
const TILE = 64;
const GAP = 10;
const PAD = 8;
const HEADER = 18;
const RBASE = 26;   // lora 行高
const RGAP = 6;
const BTN = 26;

function refreshSize(node) {
  if (!node || !node.size) return;
  const fitVisibleContent = () => {
    const root=node.__qwenPreview?.element?.closest('.lg-node');
    const body=root?.querySelector('[data-testid^="node-body-"]');
    if (!root || !body || !root.offsetHeight) return false;
    const css=getComputedStyle(body), visible=[...body.children].filter(el=>getComputedStyle(el).display!=='none');
    // Vue adds its own title offset to node.size. Apply a measured delta instead
    // of assuming that graph-space height equals the DOM wrapper height.
    const natural=visible.reduce((sum,el)=>sum+el.offsetHeight,0)
      +parseFloat(css.paddingTop || 0)+parseFloat(css.paddingBottom || 0)
      +Math.max(0,visible.length-1)*(parseFloat(css.rowGap)||0);
    const declaredHeight=parseFloat(getComputedStyle(root).minHeight);
    const naturalTotal=natural+root.offsetHeight-body.offsetHeight;
    const excess=(Number.isFinite(declaredHeight)?declaredHeight:root.offsetHeight)-naturalTotal;
    if(Math.abs(excess)>1){node.setSize([node.size[0],Math.max(100,Math.ceil(node.size[1]-excess))]);node.graph?.setDirtyCanvas(true,true);}
    return true;
  };
  let sz = null;
  try { if(!fitVisibleContent()) sz = node.computeSize ? node.computeSize() : null; } catch (e) { /* noop */ }
  if (sz) {
    node.setSize([node.size[0] > 0 ? node.size[0] : 220, sz[1]]);
    node.graph?.setDirtyCanvas(true, true);
  }
  requestAnimationFrame(() => {
    for (const panel of node.__panelWidgets || []) panel.triggerDraw?.();
    fitVisibleContent();
  });
}

function getSafeName(name) {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1].replace(/[^\w.\- ]+/g, "_").slice(0, 90);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("img load fail"));
    img.src = src;
  });
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function drawCrop(ctx, img, x, y, w, h) {
  if (!img || !img.naturalWidth) return;
  const ir = img.naturalWidth / img.naturalHeight;
  const r = w / h;
  let sw, sh, sx, sy;
  if (ir > r) { sh = img.naturalHeight; sw = sh * r; sx = (img.naturalWidth - sw) / 2; sy = 0; }
  else { sw = img.naturalWidth; sh = sw / r; sx = 0; sy = (img.naturalHeight - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncate(ctx, text, maxW) {
  if (!text) return "";
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

function preparePanelDraw(ctx, width, height) {
  if (!ctx.canvas || ctx.canvas === app.canvas?.canvas) return width;
  const scale = app.canvas?.ds?.scale || 1;
  // Vue's legacy widget uses a separate canvas with a doubled backing size.
  // Give it the widget's CSS height and draw X in graph-space units.
  ctx.canvas.style.height = `${height + 2}px`;
  ctx.scale(scale, 1);
  return width / scale;
}

function viewURL(name, type) {
  const parts = name.split("/");
  const filename = parts[parts.length - 1];
  const subfolder = parts.slice(0, -1).join("/");
  const t = type || "input";
  let q = `filename=${encodeURIComponent(filename)}&type=${t}&subfolder=${encodeURIComponent(subfolder)}`;
  if (app.api_token) q += `&token=${app.api_token}`;
  const base = (api.api_base || "/").replace(/\/$/, "");
  return `${base}/view?${q}`;
}

async function uploadRefImage(file) {
  const fd = new FormData();
  fd.append("image", file, getSafeName(file.name));
  fd.append("type", "input");
  fd.append("overwrite", "false");
  const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`upload ${resp.status}`);
  let data = null;
  try { data = await resp.json(); } catch (e) { data = null; }
  const name = (data && (data.name || data.image)) || getSafeName(file.name);
  const type = (data && data.type) || "input";
  return { name: getSafeName(name), type: type === "temp" ? "input" : type };
}

async function addFileToRefs(file) {
  const { name, type } = await uploadRefImage(file);
  let img = null;
  try { img = await loadImage(await fileToDataURL(file)); } catch (e) { /* noop */ }
  return { name, type, img };
}

// Vue 旧式 widget 传入局部 pos；传统画布事件可回退到 canvas 坐标。
function nodeLocalXY(e, pos, node) {
  if (pos) {
    if (Array.isArray(pos)) return { x: pos[0], y: pos[1] };
    if (pos.x != null) return { x: pos.x, y: pos.y };
  }
  if (e && e.canvasX != null) return { x: e.canvasX - node.pos[0], y: e.canvasY - node.pos[1] };
  return { x: 0, y: 0 };
}

// ---------------------------------------------------------------- 参考图面板
function makeRefPanel(node) {
  const w = {
    name: "refs_json",
    type: "qwen_refs_panel",
    value: "[]",
    items: [],
    tY: 0,
    input: null,
    replaceIdx: -1,
    dragReady: -1,
  };
  w.serializeValue = () => w.value;
  w.serialize = () => JSON.stringify(w.items.map((it) => ({
    id: it.id,
    name: it.type && it.type !== "input" ? `${it.name} [${it.type}]` : it.name,
    ...(it.sourceResultId ? {sourceResultId:it.sourceResultId,sourceVersionId:it.sourceVersionId} : {}),
  })));
  w.sync = () => { w.value = w.serialize(); node.__promptEditor?.refreshChips(); refreshSize(node); };

  w.loadFromValue = async (str) => {
    w.items = normalizeRefs(str).slice(0, REF_MAX).map(item => ({...item}));
    w.sync();
    await Promise.all(w.items.map(async item => {
      try { item.img = await loadImage(viewURL(item.name, item.type)); item.missing=false; } catch { item.img = null;item.missing=true; }
      node.__promptEditor?.refreshChips();
      if (w.items.includes(item)) refreshSize(node);
    }));
  };

  const colsAt = (width) => Math.max(1, Math.floor((width - 2 * PAD) / (TILE + GAP)));
  w.computeSize = (width = w.drawWidth ?? node.size[0]) => {
    const cols = colsAt(width);
    const tiles = w.items.length + (w.items.length < REF_MAX ? 1 : 0);
    const rows = Math.max(1, Math.ceil(tiles / cols));
    return [width, PAD + HEADER + rows * TILE + (rows - 1) * GAP + PAD + 2];
  };

  const tileAt = (x, y) => {
    const cols = colsAt(w.drawWidth ?? node.size[0]);
    const rowStart = w.tY + PAD + HEADER;
    const r = Math.floor((y - rowStart) / (TILE + GAP));
    const c = Math.floor((x - PAD) / (TILE + GAP));
    if (r < 0 || c < 0 || c >= cols) return null;
    const index = r * cols + c;
    const left = PAD + c * (TILE + GAP);
    const top = rowStart + r * (TILE + GAP);
    if (x < left || x > left + TILE || y < top || y > top + TILE) return null;
    return { index, left, top, dx: x - left, dy: y - top };
  };
  w.hoverItem = local => { const tile=tileAt(local[0],local[1]);return tile && w.items[tile.index]; };

  const installSortEvents = (canvas) => {
    if (!canvas || canvas === app.canvas?.canvas || canvas.__qwenRefSortBound) return;
    canvas.__qwenRefSortBound = true;
    canvas.draggable = true;
    canvas.addEventListener("dragstart", (e) => {
      if (node.__qwenLocked || node.__uploadingRefs || w.dragReady < 0 || !w.items[w.dragReady]) { e.preventDefault(); return; }
      e.dataTransfer.setData("application/x-qwen-ref", w.items[w.dragReady].id);
      e.dataTransfer.effectAllowed = "move";
    });
    canvas.addEventListener("dragover", (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes("application/x-qwen-ref")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    canvas.addEventListener("drop", (e) => {
      const id = e.dataTransfer?.getData("application/x-qwen-ref");
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      if (node.__qwenLocked || node.__uploadingRefs) { w.dragReady = -1; return; }
      const from = w.items.findIndex((item) => item.id === id);
      const target = tileAt(e.offsetX, e.offsetY);
      if (from >= 0 && target) {
        w.items = moveRef(w.items, from, Math.min(target.index, w.items.length - 1));
        w.sync();
      }
      w.dragReady = -1;
    });
    canvas.addEventListener("dragend", () => { w.dragReady = -1; });
  };

  w.draw = (ctx, n, width, y, H) => {
    w.tY = y;
    w.domCanvas = ctx.canvas !== app.canvas?.canvas ? ctx.canvas : null;
    installSortEvents(w.domCanvas);
    ctx.save();
    width = preparePanelDraw(ctx, width, H);
    w.drawWidth = width;
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#8a8f9c";
    ctx.fillText(`参考图 (拖入/点击, 上限${REF_MAX}, 点图替换)  ${w.items.length}/${REF_MAX}`, PAD, y + HEADER - 4);
    const cols = colsAt(width);
    const rowStart = y + PAD + HEADER;
    let idx = 0;
    for (let r = 0; r * cols <= w.items.length; r++) {
      for (let c = 0; c < cols; c++) {
        const isAdd = idx === w.items.length;
        if (!isAdd && idx > w.items.length) break;
        const x = PAD + c * (TILE + GAP);
        const yy = rowStart + r * (TILE + GAP);
        if (isAdd) {
          if (w.items.length >= REF_MAX) break;
          ctx.strokeStyle = "#7c5cff"; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]);
          roundRect(ctx, x, yy, TILE, TILE, 8); ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = "#9c86ff"; ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x + TILE / 2 - 10, yy + TILE / 2); ctx.lineTo(x + TILE / 2 + 10, yy + TILE / 2);
          ctx.moveTo(x + TILE / 2, yy + TILE / 2 - 10); ctx.lineTo(x + TILE / 2, yy + TILE / 2 + 10);
          ctx.stroke();
        } else {
          const it = w.items[idx];
          ctx.fillStyle = "#2a2d37";
          roundRect(ctx, x, yy, TILE, TILE, 8); ctx.fill();
          if (it.img) {
            ctx.save(); roundRect(ctx, x, yy, TILE, TILE, 8); ctx.clip();
            drawCrop(ctx, it.img, x + 2, yy + 2, TILE - 4, TILE - 4);
            ctx.restore();
          }
          ctx.fillStyle = "rgba(20,20,26,0.85)";
          roundRect(ctx, x + TILE - 20, yy, 20, 20, 0); ctx.fill();
          ctx.fillStyle = "#e7e9ef"; ctx.font = "14px sans-serif";
          ctx.fillText("×", x + TILE - 14, yy + 15);
          ctx.fillStyle = "rgba(20,20,26,0.85)";
          roundRect(ctx, x, yy, 20, 20, 0); ctx.fill();
          ctx.fillStyle = "#e7e9ef"; ctx.font = "12px sans-serif";
          ctx.fillText("≡", x + 5, yy + 14);
          ctx.fillStyle = "rgba(20,20,26,0.85)";
          roundRect(ctx, x, yy + TILE - 18, TILE, 18, 0); ctx.fill();
          ctx.fillStyle = "#e7e9ef"; ctx.font = "12px sans-serif";
          ctx.fillText(idx + 1, x + TILE / 2 - 4, yy + TILE - 5);
          ctx.fillText("‹", x + 5, yy + TILE - 5);
          ctx.fillText("›", x + TILE - 12, yy + TILE - 5);
        }
        idx++;
      }
    }
    if (node.__dropHover) {
      const pRows = Math.max(1, Math.ceil(w.items.length / cols));
      const pH = PAD + HEADER + pRows * TILE + (pRows - 1) * GAP + PAD;
      ctx.fillStyle = "rgba(124,92,255,0.12)";
      roundRect(ctx, PAD, y + PAD, width - 2 * PAD, pH - PAD, 8); ctx.fill();
      ctx.strokeStyle = "#7c5cff"; ctx.lineWidth = 2;
      roundRect(ctx, PAD, y + PAD, width - 2 * PAD, pH - PAD, 8); ctx.stroke();
    }
    ctx.restore();
  };

  const openPicker = (replaceIdx) => {
    if (node.__qwenLocked || node.__uploadingRefs) return;
    w.replaceIdx = replaceIdx;
    if (!w.input) {
      w.input = document.createElement("input");
      w.input.type = "file";
      w.input.accept = "image/*";
      w.input.multiple = true;
      w.input.style.display = "none";
      document.body.appendChild(w.input);
      w.input.addEventListener("change", async () => {
        const files = Array.from(w.input.files || []);
        w.input.value = "";
        if (node.__qwenLocked || node.__uploadingRefs) return;
        node.__uploadingRefs = true; node.__qwenUpdateLock?.();
        for (const f of files) {
          if (!f.type.startsWith("image/")) continue;
          if (w.replaceIdx < 0 && w.items.length >= REF_MAX) break;
          let item;
          try { item = await addFileToRefs(f); }
          catch (e) { reportRefUploadError(e); continue; }
          if (node.__qwenLocked || !instances.has(node)) break;
          if (w.replaceIdx >= 0 && w.replaceIdx < w.items.length) {
            w.items[w.replaceIdx] = { ...item, id: w.items[w.replaceIdx].id };
            w.replaceIdx = -1;
          } else if (w.items.length < REF_MAX) {
            w.items.push({ ...item, id: crypto.randomUUID() });
          }
        }
        w.sync();
        node.__uploadingRefs = false; node.__qwenUpdateLock?.();
      });
    }
    w.input.click();
  };

  w.mouse = (e, pos) => {
    const P = nodeLocalXY(e, pos, node);
    if ((e.type === "pointerdown" || e.type === "mousedown") && e.button === 0) {
      const tile = tileAt(P.x, P.y);
      if (!tile) return false;
      const idx = tile.index;
      if (idx > w.items.length) return false;
      if (idx === w.items.length) {
        if (w.items.length < REF_MAX) openPicker(-1);
        return true;
      }
      if (tile.dx > TILE - 20 && tile.dy < 20) {
        w.items.splice(idx, 1); w.sync();
        return true;
      }
      if (tile.dx < 20 && tile.dy < 20) { w.dragReady = idx; return true; }
      if (tile.dy > TILE - 18 && tile.dx < 20) {
        w.items = moveRef(w.items, idx, idx - 1); w.sync(); return true;
      }
      if (tile.dy > TILE - 18 && tile.dx > TILE - 20) {
        w.items = moveRef(w.items, idx, idx + 1); w.sync(); return true;
      }
      openPicker(idx);  // 点缩略图替换
      return true;
    }
    return false;
  };
  return w;
}

// ---------------------------------------------------------------- LoRA 面板
function makeLoraPanel(node, loraList) {
  const w = {
    name: "lora_json",
    type: "qwen_lora_panel",
    value: "[]",
    items: [],            // [{name, strength, enabled}]
    loraList: (loraList || []).filter((x) => x && x !== "None"),
    tY: 0,
    pickerRow: -1,
    popup: null,
  };
  w.serializeValue = () => w.value;
  w.serialize = () => JSON.stringify(w.items.map((it) => ({ name: it.name, strength: it.strength, enabled: it.enabled })));
  w.sync = () => { w.value = w.serialize(); refreshSize(node); };
  w.loadFromValue = (str) => {
    w.items = normalizeLoras(str);
    w.sync();
  };

  w.computeSize = (width) => {
    const rows = w.items.length;
    return [width, PAD + HEADER + rows * (RBASE + RGAP) + (rows ? 2 : 6) + BTN + 2];
  };

  const closePicker = () => {
    if (w.outside) document.removeEventListener("pointerdown", w.outside, true);
    w.outside = null; w.popup?.remove(); w.popup = null; w.pickerRow = -1;
  };
  w.cleanup = closePicker;
  const openPicker = (row, anchorY, isNew = false) => {
    closePicker();
    if (!w.loraList.length) { app.ui?.dialog?.show?.("没有找到可用的 LoRA 文件。"); return; }
    w.pickerRow = row;
    const popup = document.createElement("div");
    popup.className = "qwen-lora-popup";
    popup.style.cssText = "position:fixed;z-index:100000;width:290px;max-height:300px;display:flex;flex-direction:column;padding:7px;background:#202127;border:1px solid #795ed0;border-radius:8px;box-shadow:0 12px 30px #000a;";
    const search = document.createElement("input");
    search.type = "search"; search.placeholder = "搜索 LoRA 文件";
    search.style.cssText = "width:100%;box-sizing:border-box;background:#2c2d36;color:#eef;border:1px solid #585466;border-radius:5px;padding:6px;outline:none;";
    const list = document.createElement("div");
    list.style.cssText = "overflow:auto;margin-top:5px;max-height:245px;";
    popup.append(search, list);
    document.body.appendChild(popup);
    w.popup = popup;
    let choices = [];
    let selected = 0;
    const render = () => {
      choices = w.loraList.filter((name) => name.toLowerCase().includes(search.value.toLowerCase()));
      selected = Math.min(selected, Math.max(0, choices.length - 1));
      list.replaceChildren();
      choices.forEach((name, index) => {
        const option = document.createElement("div");
        option.textContent = name;
        option.title = name;
        option.style.cssText = `padding:6px 7px;border-radius:5px;cursor:pointer;color:#eef;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${index === selected ? "background:#44356c;" : ""}`;
        option.addEventListener("mouseenter", () => {
          selected = index;
          for (const [i, child] of [...list.children].entries()) child.style.background = i === index ? "#44356c" : "transparent";
        });
        option.addEventListener("mousedown", (event) => { event.preventDefault(); choose(name); });
        list.appendChild(option);
      });
      if (!choices.length) { const empty = document.createElement("div"); empty.textContent = "没有匹配的 LoRA"; empty.style.cssText = "color:#999;padding:8px;"; list.appendChild(empty); }
    };
    const choose = (name) => {
      if (isNew) w.items.push({ name, strength: 1.0, enabled: true });
      else if (w.items[row]) w.items[row].name = name;
      closePicker(); w.sync();
    };
    search.addEventListener("input", () => { selected = 0; render(); });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); closePicker(); }
      else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && choices.length) { event.preventDefault(); selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length; render(); list.children[selected]?.scrollIntoView({ block: "nearest" }); }
      else if (event.key === "Enter" && choices[selected]) { event.preventDefault(); choose(choices[selected]); }
    });
    const outside = (event) => { if (!popup.contains(event.target)) { document.removeEventListener("pointerdown", outside, true); closePicker(); } };
    w.outside = outside;
    document.addEventListener("pointerdown", outside, true);
    const canvas = w.domCanvas;
    if (canvas?.isConnected) {
      const rect = canvas.getBoundingClientRect();
      const factor = rect.width / (w.drawWidth || rect.width);
      popup.style.left = `${Math.max(4, Math.min(rect.left + 35 * factor, window.innerWidth - 300))}px`;
      popup.style.top = `${Math.max(4, Math.min(rect.top + (anchorY - w.tY + RBASE) * factor, window.innerHeight - 310))}px`;
    } else {
      popup.style.left = `${Math.max(4, Math.min(window.innerWidth / 2 - 145, window.innerWidth - 300))}px`;
      popup.style.top = `${Math.max(4, window.innerHeight / 3)}px`;
    }
    render(); search.focus();
  };

  w.draw = (ctx, n, width, y, H) => {
    w.tY = y;
    w.domCanvas = ctx.canvas !== app.canvas?.canvas ? ctx.canvas : null;
    ctx.save();
    width = preparePanelDraw(ctx, width, H);
    w.drawWidth = width;
    ctx.clearRect(0, y, width, H);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#8a8f9c";
    ctx.fillText("LoRA 加速（＋加行 / 点行名选 / ×移除）  " + w.items.length, PAD, y + HEADER - 4);
    let rowY = y + PAD + HEADER;
    ctx.font = "13px sans-serif";
    for (let i = 0; i < w.items.length; i++) {
      const it = w.items[i];
      const nw = width - 2 * PAD - 56 - 24 - 36 - 3 * 6;
      ctx.fillStyle = "#2a2d37";
      roundRect(ctx, PAD + 36, rowY, nw, RBASE, 6); ctx.fill();
      roundRect(ctx, PAD + 36 + nw + 6, rowY, 56, RBASE, 6); ctx.fill();
      ctx.strokeStyle = "#3a3e4b"; ctx.lineWidth = 1;
      roundRect(ctx, PAD + 36, rowY, nw, RBASE, 6); ctx.stroke();
      ctx.fillStyle = it.enabled ? "#9c86ff" : "#777b87";
      ctx.fillText(it.enabled ? "●" : "○", PAD + 8, rowY + 17);
      ctx.fillStyle = it.enabled ? "#e7e9ef" : "#777b87";
      ctx.fillText(truncate(ctx, it.name || "选择 LoRA…", nw - 8), PAD + 42, rowY + 17);
      ctx.fillText(String(Math.round(it.strength * 100) / 100), PAD + 36 + nw + 12, rowY + 17);
      ctx.fillStyle = "#9aa0ae";
      ctx.fillText("×", width - PAD - 24 + 8, rowY + 17);
      rowY += RBASE + RGAP;
    }
    // ＋ 添加
    ctx.strokeStyle = "#7c5cff"; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]);
    roundRect(ctx, PAD, rowY, 130, BTN, 8); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9c86ff";
    ctx.fillText("＋ 添加LoRA", PAD + 10, rowY + 17);
    ctx.restore();
  };

  w.mouse = (e, pos) => {
    const P = nodeLocalXY(e, pos, node);
    if ((e.type !== "pointerdown" && e.type !== "mousedown") || e.button !== 0) return false;
    let rowY = w.tY + PAD + HEADER;
    for (let i = 0; i < w.items.length; i++) {
      const panelWidth = w.drawWidth ?? node.size[0];
      const nw = panelWidth - 2 * PAD - 56 - 24 - 36 - 3 * 6;
      const delX = panelWidth - PAD - 24;
      if (P.y >= rowY && P.y <= rowY + RBASE) {
        if (P.x >= PAD && P.x <= PAD + 32) {
          w.items[i].enabled = !w.items[i].enabled; w.sync(); return true;
        }
        if (P.x >= delX && P.x <= delX + 24) {
          w.items.splice(i, 1); closePicker(); w.sync();
          return true;
        }
        if (P.x >= PAD + 36 && P.x <= PAD + 36 + nw) {
          openPicker(i, rowY);
          return true;
        }
        if (P.x >= PAD + 36 + nw + 6 && P.x <= PAD + 36 + nw + 6 + 56) {
          const item = w.items[i];
          app.canvas.prompt("LoRA 强度 (可为负):", String(w.items[i].strength), (value) => {
            if (node.__qwenLocked || !w.items.includes(item)) return;
            const strength = Number(value);
            if (value !== "" && Number.isFinite(strength)) {
              item.strength = Math.round(strength * 1000) / 1000;
              w.sync();
            }
          }, e);
          return true;
        }
        return false;
      }
      rowY += RBASE + RGAP;
    }
    // ＋ 添加
    if (P.y >= rowY && P.y <= rowY + BTN && P.x >= PAD && P.x <= PAD + 130) {
      openPicker(w.items.length, rowY, true);
      return true;
    }
    return false;
  };
  return w;
}

// ---------------------------------------------------------------- 推理强度
function makeSectionHeader(name, title, number) {
  return {
    name, type: "qwen_section", value: "",
    computeSize: (width) => [width, 34],
    draw(ctx, n, width, y, H) {
      ctx.save(); width = preparePanelDraw(ctx, width, H);
      ctx.strokeStyle = "#4d505a"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD, y + 5); ctx.lineTo(width - PAD, y + 5); ctx.stroke();
      ctx.font = "bold 12px sans-serif"; ctx.fillStyle = "#b8a7f2";
      ctx.fillText(`${number}  ${title}`, PAD, y + 25);
      ctx.restore();
    },
  };
}

// ---------------------------------------------------------------- 推理加速与模型缓存
function makeAccelPanel(node, legacy) {
  const fields = {
    te_speed: ["attention", "step_cache", "reuse_threshold", "predictor_error_limit"],
    kv_cache: ["device", "dtype"],
  };
  const names = { te_speed: "TE-speed", kv_cache: "KV 缓存" };
  const groups = [
    { kind: "te_speed", title: "推理加速", add: "＋ 添加 TE-speed" },
    { kind: "kv_cache", title: "模型缓存", add: "＋ 启用 KV 缓存" },
  ];
  const w = { name: "accel_json", type: "qwen_accel_panel", value: "", items: [], expanded: new Set(), tY: 0 };
  w.serializeValue = () => w.value;
  w.serialize = () => JSON.stringify(w.items.map(({ type, enabled, config }) => ({ type, enabled, config })));
  w.sync = () => { w.value = w.serialize(); refreshSize(node); };
  w.loadFromValue = (raw) => { w.items = normalizeAccelerators(raw, legacy); w.sync(); };
  w.computeSize = (width) => [width, groups.reduce((sum, group) => {
    const item = w.items.find((one) => one.type === group.kind);
    return sum + 24 + 32 + (item && w.expanded.has(group.kind) ? fields[group.kind].length * 22 : 0);
  }, 0)];
  w.draw = (ctx, n, width, y, H) => {
    w.tY = y;
    ctx.save(); width = preparePanelDraw(ctx, width, H); w.drawWidth = width;
    ctx.font = "12px sans-serif"; ctx.fillStyle = "#8a8f9c";
    let row = y;
    for (const group of groups) {
      ctx.fillStyle = "#8a8f9c";
      ctx.fillText(group.title, PAD, row + 16);
      row += 24;
      const item = w.items.find((one) => one.type === group.kind);
      if (!item) {
        ctx.fillStyle = "#9c86ff";
        ctx.fillText(group.add, PAD + 8, row + 18);
        row += 32;
        continue;
      }
      ctx.fillStyle = item.enabled ? "#2c2a3b" : "#25262c";
      roundRect(ctx, PAD, row, width - 2 * PAD, 28, 6); ctx.fill();
      ctx.fillStyle = item.enabled ? "#9c86ff" : "#777b87"; ctx.fillText(item.enabled ? "●" : "○", PAD + 8, row + 18);
      ctx.fillStyle = item.enabled ? "#e7e9ef" : "#777b87"; ctx.fillText(names[item.type], PAD + 32, row + 18);
      ctx.fillText(w.expanded.has(item.type) ? "收起" : "设置", width - 80, row + 18);
      ctx.fillText("×", width - 22, row + 18);
      row += 32;
      if (w.expanded.has(item.type)) {
        for (const key of fields[item.type]) {
          ctx.fillStyle = "#a6aab4";
          ctx.fillText(`${key}: ${String(item.config[key] ?? "默认")}`, PAD + 26, row + 14);
          row += 22;
        }
      }
    }
    ctx.restore();
  };
  w.mouse = (e, pos) => {
    if (!(["pointerdown", "mousedown"].includes(e.type) && e.button === 0)) return false;
    const P = nodeLocalXY(e, pos, node);
    const width = w.drawWidth ?? node.size[0];
    let row = w.tY;
    for (const group of groups) {
      row += 24;
      const item = w.items.find((one) => one.type === group.kind);
      if (!item) {
        if (P.y >= row && P.y <= row + 32) {
          const defaults = normalizeAccelerators("", legacy).find((one) => one.type === group.kind);
          w.items.push({ ...defaults, enabled: true }); w.sync();
          return true;
        }
        row += 32;
        continue;
      }
      if (P.y >= row && P.y <= row + 28) {
        if (P.x >= width - 28) { w.items = w.items.filter((one) => one !== item); w.expanded.delete(item.type); w.sync(); }
        else if (P.x >= width - 86) { w.expanded.has(item.type) ? w.expanded.delete(item.type) : w.expanded.add(item.type); refreshSize(node); }
        else { item.enabled = !item.enabled; w.sync(); }
        return true;
      }
      row += 32;
      if (w.expanded.has(item.type)) {
        for (const key of fields[item.type]) {
          if (P.y >= row && P.y <= row + 22) {
            app.canvas.prompt(`${names[item.type]} · ${key}`, String(item.config[key] ?? ""), (value) => {
              if (node.__qwenLocked || !w.items.includes(item)) return;
              if (value == null || value === "") return;
              if (["reuse_threshold", "predictor_error_limit"].includes(key)) {
                const numeric = Number(value);
                if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) return;
                item.config[key] = numeric;
              } else if (key === "device") {
                if (!["auto", "gpu", "cpu", "off"].includes(value)) {
                  app.ui?.dialog?.show?.("缓存设备可选 auto、gpu、cpu、off。"); return;
                }
                item.config[key] = value;
              } else if (key === "dtype") {
                if (!["default", "int8", "int4"].includes(value)) {
                  app.ui?.dialog?.show?.("缓存精度可选 default、int8、int4。"); return;
                }
                item.config[key] = value;
              } else item.config[key] = value;
              w.sync();
            }, e);
            return true;
          }
          row += 22;
        }
      }
    }
    return false;
  };
  return w;
}

// ---------------------------------------------------------------- 拖放 (精确命中参考图面板)
let dropBound = false;
function reportRefUploadError(error) {
  console.error("[qwen] upload fail", error);
  app.ui?.dialog?.show?.("参考图上传失败，请检查文件格式与 ComfyUI 服务状态。");
}

function ensureDropHandlers() {
  if (dropBound) return;
  dropBound = true;
  const hover=createImageHoverPreview();let hoverKey=null;
  const hideHover=()=>{hoverKey=null;hover.hide();};
  document.addEventListener('pointermove',e=>{
    if(e.buttons || e.target?.tagName!=='CANVAS' || e.target?.closest?.('.qwen-region-modal'))return hideHover();
    const hit=nodeLocalFromEvent(e),panel=hit && (hit.panel || panelAtNode(hit.node,hit.local));
    const ref=panel===hit?.node.__refsPanel?panel.hoverItem?.(hit.local):null;
    if(!ref)return hideHover();
    const key=`${hit.node.id}:${ref.id}`;if(key===hoverKey)return;
    hoverKey=key;hover.show(viewURL(ref.name,ref.type),{left:e.clientX,top:e.clientY,right:e.clientX+12,bottom:e.clientY+12},ref.name);
  },{passive:true});
  document.addEventListener('pointerdown',hideHover,true);document.addEventListener('scroll',hideHover,true);window.addEventListener('blur',hideHover);
  document.addEventListener("dragover", (e) => {
    const hit = nodeLocalFromEvent(e);
    const panel = hit && (hit.panel || panelAtNode(hit.node, hit.local));
    const items = Array.from(e.dataTransfer?.items || []);
    const possibleFiles = items.length === 0 && Array.from(e.dataTransfer?.types || []).includes("Files");
    const ok = hit && (isRefFileDrop(panel, hit.node.__refsPanel, items) || (panel === hit.node.__refsPanel && possibleFiles));
    if (ok) {
      e.preventDefault();
      e.stopPropagation();
    }
    for (const node of instances) node.__dropHover = node === hit?.node && Boolean(ok);
    app.canvas.setDirty(true, true);
  }, { capture: true });
  document.addEventListener("dragleave", (e) => {
    const hit = nodeLocalFromEvent(e);
    if (hit) { hit.node.__dropHover = false; app.canvas.setDirty(true, true); }
  });
  document.addEventListener("drop", async (e) => {
    const hit = nodeLocalFromEvent(e);
    if (!hit) return;
    const panel = hit.panel || panelAtNode(hit.node, hit.local);
    const files = Array.from(e.dataTransfer?.files || []);
    if (!isRefFileDrop(panel, hit.node.__refsPanel, files)) return;
    e.preventDefault();
    e.stopPropagation();
    hit.node.__dropHover = false;
    if (hit.node.__qwenLocked || hit.node.__uploadingRefs) return;
    if (panel.items.length >= REF_MAX) {
      app.ui?.dialog?.show?.(`参考图最多 ${REF_MAX} 张。`);
      return;
    }
    hit.node.__uploadingRefs = true; hit.node.__qwenUpdateLock?.();
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      if (panel.items.length >= REF_MAX) break;
      try {
        const uploaded = await addFileToRefs(f);
        if (hit.node.__qwenLocked || !instances.has(hit.node)) break;
        panel.items.push({ ...uploaded, id: crypto.randomUUID() });
      }
      catch (err) { reportRefUploadError(err); }
    }
    panel.sync();
    hit.node.__uploadingRefs = false; hit.node.__qwenUpdateLock?.();
  }, { capture: true });
}

// ---------------------------------------------------------------- 事件路由
// 兼容传统画布事件路由；Vue 旧式 widget 另会直接调用 widget.mouse。
function bindPanelMouse(nodeType) {
  const KEYS = ["onMouseDown", "onMouseMove", "onMouseUp", "onDblClick", "onMouseWheel"];
  for (const key of KEYS) {
    const base = nodeType.prototype[key];
    nodeType.prototype[key] = function (e, pos, canvas) {
      let r = base ? base.apply(this, arguments) : undefined;
      for (const wd of this.__panelWidgets || []) {
        if (wd && !wd.hidden && wd.mouse && wd.mouse(e, pos)) { r = true; break; }
      }
      return r;
    };
  }
}

// 精确定位: 点击/拖放点落在 node 内哪个 panel widget 的绘制区域
function panelAtNode(node, local) {
  if (!node || !node.__panelWidgets) return null;
  const k = 8;  // 命中容差
  for (let i = node.__panelWidgets.length - 1; i >= 0; i--) {
    const wd = node.__panelWidgets[i];
    if (!wd || wd.hidden || typeof wd.tY !== "number" || !wd.computeSize) continue;
    const [w2, h2] = wd.computeSize(node.size[0]);
    if (local[0] >= -k && local[0] <= w2 + k && local[1] >= (wd.tY || 0) - k && local[1] <= (wd.tY || 0) + h2 + k) {
      return wd;
    }
  }
  return null;
}

function nodeLocalFromEvent(e) {
  if(e.target?.closest?.('.qwen-region-modal'))return null;
  for (const node of instances) {
    if (node.__promptEditor?.getDropElement?.().contains(e.target)) return { node, panel: node.__refsPanel, local: [0, 0] };
    const panel = node.__panelWidgets?.find((wd) => !wd.hidden && wd.domCanvas === e.target);
    if (panel) return { node, panel, local: [e.offsetX, e.offsetY] };
  }
  if(!app.canvas?.canvas || e.target!==app.canvas.canvas)return null;
  const rect = app.canvas.canvas.getBoundingClientRect();
  const p = app.canvas.ds.convertCanvasToOffset([e.clientX - rect.left, e.clientY - rect.top]);
  const g = app.canvas.graph;
  if (!g) return null;
  const node = g.getNodeOnPos(p[0], p[1]);
  if (!node || !instances.has(node)) return null;
  return { node, local: [p[0] - node.pos[0], p[1] - node.pos[1]] };
}

// ---------------------------------------------------------------- 初始化
function initNode(node) {
  if (node.__panelsLoaded) return;
  node.__panelsLoaded = true;
  node.__panelWidgets = [];
  const W = Object.fromEntries((node.widgets || []).map(w => [w.name, w]));
  const schemaWidgetNames = [
    "prompt", "negative_prompt", "unet_name", "clip_name", "vae_name",
    "aspect_ratio", "width", "height", "steps", "cfg", "seed",
    "control_after_generate", "denoise", "show_advanced", "negative_preset",
    "refs_json", "lora_json", "lora_list", "enable_te_speed", "te_attention",
    "te_step_cache", "te_reuse_threshold", "te_predictor_error_limit",
    "sampler_name", "scheduler", "resolution", "cache_device", "cache_dtype",
    "accel_json", "inference_preset", "rtx_scale", "rtx_quality", "region_json",
  ];
  node.properties ||= {};
  const previousState = node.properties.qwenWorkbench || {};
  const previousVersion = previousState.version || 0;
  const copied = previousState.ownerNodeId != null && String(previousState.ownerNodeId) !== String(node.id);
  const state = node.properties.qwenWorkbench = {
    version: 1, history: [], selectedResultId: null, activeJob: null, ...previousState,
    ownerId: copied ? crypto.randomUUID() : previousState.ownerId || crypto.randomUUID(),
    ownerNodeId: String(node.id),
  };
  state.version = 1;
  state.transparentBackground = Boolean(state.transparentBackground);
  state.history=migrateHistory(state.history);state.resultSchemaVersion=2;
  state.promptHistory=(state.promptHistory || []).slice(-50);
  if (copied) state.activeJob = null;
  // Also serialize local edits through ComfyUI's ordinary queue/export path.
  // Appended after legacy widgets; workbench state remains the source of truth.
  const regionWidget = W.region_json || node.addWidget('text', 'region_json', '', () => {}, {serialize:true});
  W.region_json = regionWidget;
  regionWidget.hidden = true;
  regionWidget.computeSize = () => [0, -4];
  regionWidget.serializeValue = () => state.editSession?.region ? JSON.stringify({...state.editSession.region,rawPrompt:String(W.prompt?.value || '')}) : '';
  let ready = false, common, advanced, extensions, controller, preview;
  const initialValues = Object.fromEntries(Object.entries(W).map(([name, widget]) => [name, widget.value]));
  const currentWidget = name => node.widgets.find(w => w.name === name) || W[name];
  const values = () => Object.fromEntries(schemaWidgetNames.map(name => [name, currentWidget(name)?.value]));
  const locked = () => Boolean(node.__qwenLocked || node.__uploadingRefs || node.__qwenFileBusy || node.__qwenOptimizing);
  let optimizerRevision=0, optimizerController=null, removed=false, regionDialog=null;
  const requestOllama=(path,payload)=>optimizerRequest(api,path,payload);
  const getOptimizerSettings=()=>state.optimizer || {provider:'ollama',ollama:{address:state.ollama?.address,model:state.ollama?.model,think:state.ollama?.think,temperature:state.ollama?.temperature,num_predict:state.ollama?.num_predict},responses:{model:'deepseek-flash',effort:'auto'}};
  async function optimizePrompt(instruction=''){
    if(locked())return;
    const settings=getOptimizerSettings(),provider=settings.provider || 'ollama';
    const model=provider==='responses'?settings.responses?.model:settings.ollama?.model;
    if(!model){editor.notify(provider==='responses'?'请在扩展中填写 Responses API 模型':'请在扩展中选择 Ollama 模型',3500);return;}
    const original=draft(),revision=++optimizerRevision;
    if(!original.prompt.trim()){editor.notify('请先输入提示词');return;}
    savePrompt(original);
    const abortController=new AbortController();optimizerController=abortController;
    node.__qwenOptimizing=true;node.__qwenUpdateLock?.();editor.setOptimizing(true);editor.notify('正在优化…',900000);
    let progressText='';
    const progressStatus=text=>editor.setOptimizeProgress(text,progressText,()=>{
      if(!abortController.signal.aborted){editor.setOptimizeProgress(provider==='ollama'?'正在取消并卸载模型…':'正在取消优化…',progressText,null);abortController.abort();}
    });
    progressStatus('正在判断提示词类型…');
    try{
      const block=original.region?.promptBlock;
      if(block && !original.prompt.includes(block))throw new Error('区域说明已修改，请先在区域编辑窗口确认，再优化补充文字');
      const editable=block?original.prompt.replace(block,'').trim():original.prompt;
      if(!editable)throw new Error('区域说明已固定，无需优化；可添加补充文字后再优化');
      const prompt=toOptimizerPrompt(editable,original.refs);
      const promptLength=estimatePromptLength(editable,original.refs);
      const requestBody=provider==='responses'
        ? {provider,model,effort:settings.responses?.effort || 'auto',prompt,refs:original.refs,instruction,prompt_length:{weighted_count:promptLength.weightedCount,limit:promptLength.limit}}
        : {provider,address:settings.ollama?.address,model,think:settings.ollama?.think ?? 'auto',temperature:settings.ollama?.temperature ?? 0.7,num_predict:settings.ollama?.num_predict ?? 2048,prompt,refs:original.refs,instruction,prompt_length:{weighted_count:promptLength.weightedCount,limit:promptLength.limit}};
      const result=await optimizerStreamRequest(api,'/qwen_auto/optimizer/optimize',requestBody,{signal:abortController.signal,onEvent:event=>{
        if(event.type==='stage')progressStatus(event.text || '正在优化…');
        else if(event.type==='route'){
          const labels=event.labels?.length?event.labels.join('、'):'通用提示词';
          progressStatus(`已识别：${labels} · 正在改写…`);
        }else if(event.type==='delta'){
          progressText=event.text || progressText;
          editor.setOptimizeProgress('正在流式改写提示词…',progressText,()=>{
            if(!abortController.signal.aborted){editor.setOptimizeProgress(provider==='ollama'?'正在取消并卸载模型…':'正在取消优化…',progressText,null);abortController.abort();}
          });
        }
      }});
      if(removed || revision!==optimizerRevision)return;
      const value=[fromOptimizerPrompt(result.prompt,original.refs),block].filter(Boolean).join('\n\n');
      W.prompt.value=value;editor.writeValue(value);lastPromptRatio=aspectRatioFromPrompt(value);
      changed();editor.notify(provider!=='ollama'?'已优化':result.unloaded?'已优化 · 模型已卸载':`已优化 · 卸载失败：${result.unload_error || '请检查 Ollama'}`,provider!=='ollama'||result.unloaded?2400:7000);
    }catch(error){if(!removed && revision===optimizerRevision)editor.notify(error.name==='AbortError'?'已取消提示词优化':error.message,6500);}
    finally{if(optimizerController===abortController)optimizerController=null;editor.setOptimizeProgress(null);node.__qwenOptimizing=false;if(!removed){editor.setOptimizing(false);if(revision!==optimizerRevision)editor.notify('工作流已恢复，未应用优化结果',3000);node.__qwenUpdateLock?.();}}
  }
  const draft=()=>({prompt:String(W.prompt?.value || ''),refs:normalizeRefs(refsWidget.serialize()),...(state.editSession?.region?{region:JSON.parse(JSON.stringify(state.editSession.region))}:{})});
  function savePrompt(value=draft()){state.promptHistory=addPromptSnapshot(state.promptHistory,value);node.graph?.setDirtyCanvas(true,true);}
  function restoreDraft(value){
    if(locked())return false;
    if(value.region){
      const r=value.region;
      if(!state.history.some(item=>item.id===r.targetResultId && item.versions.some(v=>v.id===r.sourceVersionId))){editor.notify('区域来源版本已删除，无法载入',3500);return false;}
      state.editSession={targetResultId:r.targetResultId,sourceVersionId:r.sourceVersionId,previousDraft:state.editSession?.previousDraft || draft(),region:JSON.parse(JSON.stringify(r))};
    }else if(state.editSession)state.editSession.region=null;
    void refsWidget.loadFromValue(JSON.stringify(value.refs || []));
    W.prompt.value=value.prompt || '';editor.writeValue(W.prompt.value);changed();return true;
  }
  function generatedRefs(){return state.history.filter(item=>isAvailableReference(item)).flatMap(item=>(item.versions || []).map(version=>({
    id:`generated:${item.id}:${version.id}`,name:[version.file.subfolder,version.file.filename].filter(Boolean).join('/'),type:'output',
    label:`${item.title} · V${version.number}`,sourceResultId:item.id,sourceVersionId:version.id,
  })));}
  function addGeneratedRef(ref){
    if(locked())return null;
    const existing=refsWidget.items.find(item=>item.name===ref.name && item.type===ref.type);
    if(existing)return existing;
    if(refsWidget.items.length>=REF_MAX){app.ui?.dialog?.show?.('最多引用10张图片，请先移除一张。');return null;}
    const item={...ref,id:crypto.randomUUID()};refsWidget.items.push(item);refsWidget.sync();
    void loadImage(viewURL(item.name,item.type)).then(img=>{item.img=img;item.missing=false;refsWidget.sync();}).catch(()=>{item.img=null;item.missing=true;refsWidget.sync();});return item;
  }
  function startEdit(resultId,versionId){
    if(locked())return;
    if(state.history.some(item=>item.id===resultId&&!isAvailableReference(item))){editor.notify('该作品已归档，请先取消归档再引用',3000);return;}
    const ref=generatedRefs().find(r=>r.sourceResultId===resultId && r.sourceVersionId===versionId);if(!ref)return;
    savePrompt();const previous=state.editSession?.previousDraft || draft();
    state.editSession={targetResultId:resultId,sourceVersionId:versionId,previousDraft:previous};
    refsWidget.items=[];addGeneratedRef(ref);W.prompt.value='';editor.writeValue('');changed();refreshSize(node);
  }
  let archiveDayTimer=null;
  const refreshArchiveCandidates=()=>{if(removed)return;preview?.render();refsWidget?.sync?.();editor?.refreshMentions?.();};
  const scheduleArchiveDayRefresh=()=>{
    clearTimeout(archiveDayTimer);
    const now=new Date(),next=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,0,1);
    archiveDayTimer=setTimeout(()=>{refreshArchiveCandidates();scheduleArchiveDayRefresh();},Math.max(1000,next.getTime()-now.getTime()));
  };
  const onVisibilityRefresh=()=>{if(!document.hidden)refreshArchiveCandidates();};
  document.addEventListener('visibilitychange',onVisibilityRefresh);
  window.addEventListener('focus',onVisibilityRefresh);
  scheduleArchiveDayRefresh();
  function activePreviewItem(){const visible=state.history.filter(item=>isAvailableReference(item));return visible.find(item=>item.id===state.selectedResultId)||visible.at(-1)||null;}
  function editSelected(){const item=activePreviewItem(),v=item&&currentVersion(item);if(item&&v)startEdit(item.id,v.id);}
  function openRegion(){
    if(locked())return;
    const item=activePreviewItem(),version=item&&currentVersion(item);
    if(!version){editor.notify('请先选择一张已生成图片');return;}
    if(!isAvailableReference(item)){editor.notify('该作品已归档，请先取消归档再进行蒙版重绘',3000);return;}
    const source={name:[version.file.subfolder,version.file.filename].filter(Boolean).join('/'),type:version.file.type || 'output'};
    const prior=state.editSession?.region;
    const initial=prior?.sourceVersionId===version.id && prior.mode==='mask' ? prior : null;
    regionDialog?.destroy();
    regionDialog=openRegionEditor({mode:'mask',sourceURL:viewURL(source.name,source.type),sourceLabel:`${item.title} · V${version.number}`,initial,isLocked:locked,
      onClose:()=>{regionDialog=null;},onConfirm:async data=>{
        if(locked())throw new Error('当前有任务进行中，请稍后重试');
        if(state.history.some(r=>r.id===item.id&&r.archived))throw new Error('该作品已归档，请先取消归档再进行蒙版重绘');
        if(!state.history.some(r=>r.id===item.id&&r.versions.some(v=>v.id===version.id)))throw new Error('来源版本已删除');
        const same=state.editSession?.targetResultId===item.id && state.editSession?.sourceVersionId===version.id;
        const previous=same ? (state.editSession?.previousDraft || draft()) : draft();
        const existing=same?refsWidget.items:[];
        if(existing.length>=10)throw new Error('区域编辑需要一张辅助图，参考图最多9张');
        const revision=optimizerRevision;
        node.__uploadingRefs=true;node.__qwenUpdateLock?.();
        let auxiliary,maskImage;
        try{
          auxiliary=await uploadRefImage(new File([data.auxiliary],`qwen_region_${crypto.randomUUID()}.png`,{type:'image/png'}));
          maskImage=await uploadRefImage(new File([data.mask],`qwen_mask_${crypto.randomUUID()}.png`,{type:'image/png'}));
        }
        finally{node.__uploadingRefs=false;node.__qwenUpdateLock?.();}
        if(removed || revision!==optimizerRevision)throw new Error('工作流已切换，区域编辑未应用');
        savePrompt();
        if(!same){refsWidget.items=[];addGeneratedRef(generatedRefs().find(r=>r.sourceVersionId===version.id&&r.sourceResultId===item.id));}
        const ref=refsWidget.items.find(r=>r.name===source.name&&r.type===source.type);
        if(!ref)throw new Error('来源参考图已移除，请重新进入图片编辑');
        if(refsWidget.items[0]!==ref)throw new Error('请将来源参考图移回第一张后重试');
        const {auxiliary:markedBlob,mask:maskBlob,...drawing}=data;
        const region={...drawing,source,auxiliary,maskImage,targetResultId:item.id,sourceVersionId:version.id};
        region.promptBlock=regionPrompt(region,ref.id);
        W.prompt.value=region.promptBlock;editor.writeValue(W.prompt.value);
        state.editSession={targetResultId:item.id,sourceVersionId:version.id,previousDraft:previous,region};
        refsWidget.sync();changed();refreshSize(node);editor.notify('已替换为局部修改说明');return true;
      }});
  }
  function loadVersion(resultId,versionId){
    if(locked())return;
    const snapshot=state.history.find(r=>r.id===resultId)?.versions.find(v=>v.id===versionId)?.snapshot;if(!snapshot)return;
    savePrompt();
    if(restoreDraft({prompt:snapshot.rawPrompt ?? snapshot.prompt ?? '',refs:snapshot.referenceSnapshot || normalizeRefs(snapshot.refs_json || snapshot.refs || []),region:snapshot.regionSnapshot || null})===false)return;
    for(const name of schemaWidgetNames){if(['prompt','refs_json','control_after_generate','show_advanced'].includes(name))continue;if(snapshot[name]!==undefined && W[name])W[name].value=snapshot[name];}
    loraWidget.loadFromValue(W.lora_json?.value || '[]');accelWidget.loadFromValue(W.accel_json?.value || '');applyMode('steps-change');changed();
  }
  function changed() {
    if (!ready) return;
    for(const ref of refsWidget.items){
      if(ref.sourceResultId && !state.history.some(item=>item.versions.some(v=>[v.file.subfolder,v.file.filename].filter(Boolean).join('/')===ref.name))){ref.missing=true;ref.img=null;}
    }
    editor.refreshChips();
    editor.setImageActionsEnabled?.(state.history.some(r=>r.id===state.selectedResultId));
    const v = values();
    const ratio = node.__refsPanel?.items.length ? '参考图画幅' : v.aspect_ratio === 'auto' ? '自动画幅' : v.aspect_ratio;
    const resolution = ({480:'480p',768:'768p',1024:'1K',2048:'2K',4096:'4K'})[v.resolution] || `${v.resolution}²`;
    const intensity = ({'快速':'低','均衡':'中','精细':'高','自定义':'自定义'})[v.inference_preset] || '自定义';
    parameterButton.textContent = `⚙ ${ratio} · ${resolution} · ${intensity}${intensity === '自定义' ? ` ${v.steps}步` : ''}`;
    common?.refresh(); advanced?.refresh();updateExtensions();
    const session=state.editSession,item=state.history.find(r=>r.id===session?.targetResultId),version=item?.versions.find(v=>v.id===session?.sourceVersionId);
    editBar.hidden=!session;editText.textContent=session?`正在编辑：${item?.title || '作品已删除'} · ${version?`V${version.number}`:'来源已删除'}（沿用参考图画幅）`:'';
    editWidget.hidden=!session;
    regenerateButton.disabled=locked() || !state.history.some(r=>r.id===state.selectedResultId);
    node.graph?.setDirtyCanvas(true, true);
  }
  function applyMode(event, version = 1) {
    const result = resolveInferenceState({steps:W.steps?.value,mode:W.inference_preset?.value,
      loras:node.__loraPanel?.items || [],event,version});
    if (W.steps) W.steps.value = result.steps;
    if (W.inference_preset) W.inference_preset.value = result.mode;
  }
  function setValue(name, value) {
    if (locked()) return;
    const widget = currentWidget(name);
    if (!widget) return;
    if (name === 'inference_preset' && value !== '自定义' && presetForSteps(W.steps?.value, node.__loraPanel?.items || []) === 'turbo-incompatible') {
      app.ui?.dialog?.show?.('已启用 Viggle Turbo LoRA，请使用自定义步数与对应采样参数。'); return;
    }
    widget.value = value;
    widget.callback?.(value, app.canvas, node);
    if (name === 'steps') applyMode('steps-change');
    if (name === 'inference_preset') applyMode('preset-select');
    changed();
  }
  for (const widget of Object.values(W)) widget.hidden = true;
  const install = (name, widget) => {
    const index = node.widgets.indexOf(W[name]);
    if (index >= 0) node.widgets.splice(index, 1, widget); else node.widgets.push(widget);
    node.__panelWidgets.push(widget);
    const mouse = widget.mouse;
    if (mouse) widget.mouse = (...args) => locked() || widget.hidden ? false : mouse(...args);
    return widget;
  };
  const refsWidget = install('refs_json', makeRefPanel(node));
  node.__refsPanel = refsWidget;
  const refsSync = refsWidget.sync;
  refsWidget.sync = () => { refsSync(); changed(); };
  let lastPromptRatio = aspectRatioFromPrompt(W.prompt?.value);
  if (W.aspect_ratio && shouldApplyPromptRatio(W.aspect_ratio.value, null, lastPromptRatio, true)) W.aspect_ratio.value = lastPromptRatio;
  const editor = createPromptEditor(node, W.prompt?.value || '', () => refsWidget.items, value => {
    W.prompt.value = value;
    const detected = aspectRatioFromPrompt(value);
    if (W.aspect_ratio && shouldApplyPromptRatio(W.aspect_ratio.value, lastPromptRatio, detected)) W.aspect_ratio.value = detected;
    lastPromptRatio = detected;
    changed();
  }, {getGeneratedRefs:generatedRefs,onAddGeneratedRef:addGeneratedRef,getPromptHistory:()=>state.promptHistory,onBeforeClear:()=>{savePrompt();if(state.editSession)state.editSession.region=null;},onOptimize:optimizePrompt,
    getTransparentBackground:()=>state.transparentBackground,onToggleTransparentBackground:enabled=>{state.transparentBackground=Boolean(enabled);node.graph?.setDirtyCanvas(true,true);},
    getReferenceURL:ref=>viewURL(ref.name,ref.type),onMask:openRegion,onEdit:editSelected,
    onLoadPromptSnapshot:id=>{const entry=state.promptHistory.find(item=>item.id===id);if(!entry || locked())return false;savePrompt();return restoreDraft(entry);},
    onDeletePromptSnapshot:id=>{if(!locked()){state.promptHistory=state.promptHistory.filter(item=>item.id!==id);node.graph?.setDirtyCanvas(true,true);}}});
  node.__promptEditor = editor;
  const loraWidget = install('lora_json', makeLoraPanel(node, W.lora_list?.options?.values || []));
  node.__loraPanel = loraWidget;
  const loraSync = loraWidget.sync;
  loraWidget.sync = () => { loraSync(); if (ready) applyMode('lora-change'); changed(); };
  const legacy = Object.fromEntries(['enable_te_speed','te_attention','te_step_cache','te_reuse_threshold','te_predictor_error_limit','cache_device','cache_dtype'].map(key=>[key,W[key]?.value]));
  const accelWidget = install('accel_json', makeAccelPanel(node, legacy));
  const buttonStyle = 'box-sizing:border-box;height:34px;max-height:34px;flex-shrink:0;border:1px solid #514b65;background:#292632;color:#eee8fb;border-radius:8px;padding:6px 10px;font:12px system-ui;cursor:pointer;';
  function makeButton(text) { const b=document.createElement('button');b.type='button';b.textContent=text;b.style.cssText=buttonStyle;return b; }
  function addDOM(name, element, min, max=min) {
    for (const type of ['pointerdown','pointerup','click','dblclick','wheel']) element.addEventListener(type,e=>e.stopPropagation());
    return node.addDOMWidget(name,'qwen_workbench',element,{serialize:false,getMinHeight:()=>typeof min==='function'?min():min,getMaxHeight:()=>typeof max==='function'?max():max});
  }
  const actionRow = document.createElement('div');
  const dragRail=document.createElement('div');dragRail.title='拖动面板';
  dragRail.style.cssText='height:14px;cursor:grab;display:grid;place-items:center;touch-action:none;';
  const grip=document.createElement('span');grip.style.cssText='width:32px;height:3px;background:#5d586b;border-radius:3px;';dragRail.append(grip);
  let panelDrag=null;
  dragRail.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();panelDrag={x:e.clientX,y:e.clientY,pos:[...node.pos]};dragRail.setPointerCapture(e.pointerId);};
  dragRail.onpointermove=e=>{if(!panelDrag)return;const scale=app.canvas?.ds?.scale || 1;node.pos=[panelDrag.pos[0]+(e.clientX-panelDrag.x)/scale,panelDrag.pos[1]+(e.clientY-panelDrag.y)/scale];node.graph?.setDirtyCanvas(true,true);};
  dragRail.onpointerup=dragRail.onpointercancel=()=>{panelDrag=null;node.graph?.change?.();};
  addDOM('qwen_drag',dragRail,14);
  actionRow.style.cssText='display:flex;align-items:center;gap:6px;padding:4px 8px;box-sizing:border-box;height:46px;max-height:46px;flex:0 0 46px;';
  const parameterButton=makeButton('⚙ 参数');parameterButton.style.flex='0 1 auto';parameterButton.style.maxWidth='55%';parameterButton.style.minWidth='0';parameterButton.style.textAlign='left';parameterButton.style.overflow='hidden';parameterButton.style.textOverflow='ellipsis';parameterButton.style.whiteSpace='nowrap';
  const generateButton=makeButton('生成');generateButton.style.background='#7256ad';generateButton.style.minWidth='82px';
  actionRow.append(parameterButton,generateButton);
  addDOM('qwen_actions',actionRow,46);
  const editBar=document.createElement('div');editBar.style.cssText='display:flex;align-items:center;gap:8px;color:#b9a3eb;font:11px system-ui;padding:0 8px;';
  const editText=document.createElement('span'),exitEdit=makeButton('退出编辑');exitEdit.style.cssText+='height:26px;max-height:26px;';
  editBar.append(editText,exitEdit);exitEdit.onclick=()=>{if(locked())return;savePrompt();const previous=state.editSession?.previousDraft;state.editSession=null;if(previous)restoreDraft(previous);changed();refreshSize(node);};
  const editWidget=addDOM('qwen_edit_status',editBar,()=>state.editSession?34:0);editWidget.hidden=!state.editSession;
  const advancedButton=makeButton('高级');advancedButton.style.flex='0 0 auto';
  const recoverButton=makeButton('恢复编辑');recoverButton.hidden=true;
  generateButton.style.marginLeft='auto';
  actionRow.insertBefore(advancedButton,generateButton);actionRow.append(recoverButton);
  const copyButton=makeButton('');copyButton.title='复制提示词';copyButton.setAttribute('aria-label','复制提示词');
  copyButton.style.cssText+='width:34px;padding:7px;display:grid;place-items:center;';
  copyButton.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
  copyButton.onclick=async()=>{
    const text=String(W.prompt?.value || '').replace(/\[\[qwen-ref:([^\]]+)\]\]/g,(marker,id)=>{const index=refsWidget.items.findIndex(item=>item.id===id);return index<0?marker:`@图片${index+1}`;});
    try{await navigator.clipboard.writeText(text);editor.notify('已复制');}
    catch{editor.notify('复制失败，请选中文字后复制',3500);}
  };
  actionRow.insertBefore(copyButton,generateButton);
  const regenerateButton=makeButton('');regenerateButton.title='使用当前提示词重新生成当前作品';regenerateButton.setAttribute('aria-label','重新生成');
  regenerateButton.style.cssText+='width:34px;padding:7px;';regenerateButton.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5L4 10M5 12a7 7 0 0 0 12 5l3-3"/></svg>';
  actionRow.insertBefore(regenerateButton,generateButton);
  regenerateButton.onclick=()=>void generate('regenerate');
  const popoverOptions={getValues:values,setValue,isLocked:locked,getCustomMode:name=>Boolean(state.customFields?.[name]),setCustomMode:(name,value)=>{state.customFields={...state.customFields,[name]:value};},getOptions:name=>{
    const options=currentWidget(name)?.options?.values;return typeof options==='function'?options():options || [];
  }};
  common=createParameterPopover({...popoverOptions,anchor:parameterButton,kind:'common'});
  advanced=createParameterPopover({...popoverOptions,anchor:advancedButton,kind:'advanced'});
  parameterButton.onclick=()=>{extensions?.close();advanced.close();common.open();};
  advancedButton.onclick=()=>{extensions?.close();common.close();advanced.open();};
  preview=createResultPreview({getState:()=>state,updateState:patch=>{Object.assign(state,patch);if(ready)changed();node.graph?.setDirtyCanvas(true,true);},isLocked:locked,onEdit:startEdit,onLoadVersion:loadVersion,
    onFileBusyChange:value=>{node.__qwenFileBusy=value;node.__qwenUpdateLock?.();},
    viewURL:file=>api.apiURL(`/view?${new URLSearchParams({filename:file.filename,subfolder:file.subfolder || '',type:file.type || 'output'})}`),
    onUpscale:(id,versionId)=>{
      const result=state.history.find(item=>item.id===id);
      const source=result?.versions.find(v=>v.id===versionId) || currentVersion(result);
      if(result && source && !locked()) void controller.upscale({...result,original:source.file},{scale:Number(W.rtx_scale?.value || 2),quality:W.rtx_quality?.value || 'ULTRA'},
        {operation:'upscale',targetResultId:id,sourceVersionId:source.id,sourceSnapshot:source.snapshot});
    }});
  node.__qwenPreview=preview;
  const contentSizeObserver=new ResizeObserver(()=>refreshSize(node));
  contentSizeObserver.observe(preview.element);
  addDOM('qwen_results',preview.element,()=>state.history.length ? 490 : 270,490);
  function updateJob(job) {
    const busy=isJobBusy(job);
    node.__qwenLocked=busy;
    const editingBusy=busy || Boolean(node.__qwenFileBusy || node.__qwenOptimizing);
    editor.setDisabled(editingBusy || node.__uploadingRefs);
    parameterButton.disabled=editingBusy;advancedButton.disabled=editingBusy;
    parameterButton.style.opacity=busy?'.5':'1';advancedButton.style.opacity=busy?'.5':'1';
    if(editingBusy){common.close();advanced.close();extensions?.close();loraWidget.cleanup?.();}
    const cancellable=busy && job.owned && job.accepted && !['submitting','cancelling'].includes(job.state);
    generateButton.textContent=job?.state==='cancelling'?'取消中…':job?.state==='submitting'?'提交中…':busy?(job.owned?'取消':'全局任务中'):'生成';
    generateButton.disabled=(busy && !cancellable) || Boolean(node.__uploadingRefs || node.__qwenFileBusy || node.__qwenOptimizing);
    recoverButton.hidden=!(job?.missing && job.state==='reconciling');
    preview.setJob(job ? {...job,estimatedSeconds:job.estimatedSeconds ?? (job.kind==='generate'?Number(job.snapshot?.steps || W.steps.value)*3:null)} : null);
    preview.render();changed();
  }
  function receive(kind, result, suppliedContext) {
    let context=result.workbenchContext || suppliedContext || {};
    if(kind==='generate' && !result.workbenchContext && !suppliedContext && result.snapshot?.region_json){
      // A global queue run has no controller context. Recover only its captured
      // region target, never the editor's possibly newer live selection.
      try {
        const region=JSON.parse(result.snapshot.region_json);
        const target=state.history.find(item=>item.id===region.targetResultId);
        if(['mask','comments'].includes(region.mode) && target?.versions.some(v=>v.id===region.sourceVersionId)){
          context={operation:region.mode==='mask'?'inpaint':'comments',targetResultId:target.id,sourceVersionId:region.sourceVersionId,
            draft:{prompt:region.rawPrompt ?? result.snapshot.prompt ?? '',refs:normalizeRefs(result.snapshot.refs_json || []),region}};
        }
      }catch(error){console.warn('[qwen] 无法恢复区域生成的版本关联',error);}
    }
    if(context.ownerId && context.ownerId!==state.ownerId)return;
    if(kind==='generate') {
      const snapshot={...result.snapshot,...(context.draft?{rawPrompt:context.draft.prompt,referenceSnapshot:context.draft.refs,regionSnapshot:context.draft.region || null}:{})};
      state.history=addGeneratedResult(state.history,{...result,snapshot},context);
      const target=context.targetResultId || result.id;if(state.history.some(item=>item.id===target))state.selectedResultId=target;
    } else {
      const item=state.history.find(r=>r.id===(context.targetResultId || result.resultId));
      const source=item?.versions.find(v=>v.id===context.sourceVersionId) || currentVersion(item);
      state.history=appendVersion(state.history,item?.id,{file:result.file,operation:'upscale',sourceVersionId:source?.id,
        snapshot:{...(context.sourceSnapshot || source?.snapshot),rtx_scale:result.file?.scale,rtx_quality:result.file?.quality}});
    }
    preview.render();changed();node.graph?.setDirtyCanvas(true,true);
    refreshSize(node);
  }
  node.__qwenReceive=receive;
  controller=createGenerationController({node,api,getWorkflow:()=>app.graphToPrompt(node.graph),onState:updateJob,onResult:receive,
    getSeedNext:()=>window.comfyAPI?.valueControl?.computeNextControlledValue?.(W.seed,W.control_after_generate?.value || 'fixed') ?? null,
    onAccepted:job=>{if(job.context?.draft)savePrompt(job.context.draft);if(job.seedNext != null && W.seed) W.seed.value=job.seedNext;changed();}});
  node.__qwenController=controller;
  node.__qwenUpdateLock=()=>updateJob(controller.getJob());
  async function generate(operation){
    if(locked())return;
    const session=state.editSession,selected=state.history.find(r=>r.id===state.selectedResultId);
    const targetResultId=operation==='regenerate'?selected?.id:session?.targetResultId;
    const sourceVersionId=operation==='regenerate'?currentVersion(selected)?.id:session?.sourceVersionId;
    if((operation==='regenerate' || session) && !state.history.some(r=>r.id===targetResultId)){app.ui?.dialog?.show?.('目标作品已删除，请退出编辑或选择其他作品。');return;}
    node.__uploadingRefs=true;node.__qwenUpdateLock?.();
    try{
      if(session && operation!=='regenerate' && !refsWidget.items.length)throw new Error('图片编辑至少需要一张参考图，请重新引用图片或退出编辑。');
      await Promise.all(refsWidget.items.map(async ref=>{const response=await fetch(viewURL(ref.name,ref.type),{method:'HEAD',cache:'no-store'});if(!response.ok)throw new Error(`参考图无法读取：${ref.name}`);}));
      const ids=new Set(refsWidget.items.map(ref=>ref.id));for(const match of String(W.prompt.value).matchAll(/\[\[qwen-ref:([^\]]+)\]\]/g))if(!ids.has(match[1]))throw new Error('提示词包含已失效的图片标签，请重新引用。');
      const region=session?.region;
      regionForSubmission(region,normalizeRefs(refsWidget.serialize()));
      if(region){
        if(!String(W.prompt.value).includes(region.promptBlock))throw new Error('区域说明已修改，请重新确认蒙版，以同步辅助图');
        const response=await fetch(viewURL(region.auxiliary.name,region.auxiliary.type),{method:'HEAD',cache:'no-store'});
        if(!response.ok)throw new Error('区域辅助图已丢失，请重新确认区域编辑');
        if(region.maskImage){const maskResponse=await fetch(viewURL(region.maskImage.name,region.maskImage.type),{method:'HEAD',cache:'no-store'});if(!maskResponse.ok)throw new Error('区域蒙版已丢失，请重新确认区域编辑');}
      }
      await controller.generate({operation:region?(region.mode==='mask'?'inpaint':'comments'):(operation || (session?'edit':'generate')),targetResultId:region?.targetResultId || targetResultId,sourceVersionId:region?.sourceVersionId || sourceVersionId,draft:draft(),region,transparentBackground:Boolean(state.transparentBackground)});
    }catch(error){app.ui?.dialog?.show?.(error.message);}finally{node.__uploadingRefs=false;node.__qwenUpdateLock?.();}
  }
  generateButton.onclick=()=>{if(isJobBusy(controller.getJob())) void controller.cancel();else void generate();};
  recoverButton.onclick=()=>controller.recoverEditing();
  const extensionButton=makeButton('扩展');extensionButton.style.flex='0 0 auto';
  actionRow.insertBefore(extensionButton,copyButton);
  function updateExtensions(){
    loraWidget.hidden=true;accelWidget.hidden=true;
    const activeLoras=loraWidget.items.filter(item=>item.enabled!==false&&item.name&&Number(item.strength)!==0).length;
    const extras=[];if(activeLoras)extras.push(`LoRA ${activeLoras}`);
    for(const item of accelWidget.items)if(item.enabled)extras.push(item.type==='te_speed'?'TE-speed':'KV');
    extensionButton.textContent='扩展';
    extensionButton.title=`扩展与缓存${extras.length?' · '+extras.join(' · '):''}`;
    extensionButton.disabled=locked();
  }
  extensions=createExtensionsPopover({anchor:extensionButton,loraWidget,accelWidget,isLocked:locked,optimizer:{getSettings:getOptimizerSettings,setSettings:value=>{state.optimizer={...value};node.graph?.setDirtyCanvas(true,true);},request:requestOllama,isLocked:locked}});
  extensionButton.onclick=()=>{if(locked())return;common.close();advanced.close();extensions.open();};
  const accelSync=accelWidget.sync;accelWidget.sync=()=>{accelSync();changed();};
  const preferred=['qwen_drag','qwen_results','refs_json','qwen_edit_status','qwen_prompt_editor','qwen_actions','lora_json','accel_json'];
  const rank=widget=>{const i=preferred.indexOf(widget.name);return i<0?preferred.length:i;};
  node.widgets.sort((a,b)=>rank(a)-rank(b));
  const previousSerialize=node.onSerialize;
  node.onSerialize=function(info){
    previousSerialize?.call(this,info);
    const map=new Map(this.widgets.map(widget=>[widget.name,widget]));
    info.widgets_values=schemaWidgetNames.filter(name=>map.has(name)).map(name=>{
      const widget=map.get(name);return typeof widget?.serializeValue==='function'?widget.serializeValue(this,0):widget?.value;
    });
  };
  const previousExecuted=node.onExecuted;
  node.onExecuted=function(output){
    for(const result of output?.qwen_result || [])receive('generate',result);
    for(const result of output?.qwen_upscale || [])receive('upscale',result);
    return previousExecuted?.call(this,output);
  };
  const previousRemoved=node.onRemoved;
  node.onRemoved=function(){
    removed=true;++optimizerRevision;optimizerController?.abort();regionDialog?.destroy();
    clearTimeout(archiveDayTimer);document.removeEventListener('visibilitychange',onVisibilityRefresh);window.removeEventListener('focus',onVisibilityRefresh);
    contentSizeObserver.disconnect();controller.destroy();preview.destroy();common.destroy();advanced.destroy();extensions?.destroy();editor.cleanup?.();loraWidget.cleanup?.();refsWidget.input?.remove();instances.delete(this);
    return previousRemoved?.apply(this,arguments);
  };
  node.__qwenRestore = info => {
    ++optimizerRevision;optimizerController?.abort();regionDialog?.destroy();
    for (const [index,name] of schemaWidgetNames.entries()) {
      const value = info.widgets_values_named?.[name] ?? info.widgets_values?.[index];
      if (value !== undefined && W[name]) W[name].value = value;
    }
    const restored = structuredClone(info.properties?.qwenWorkbench || {});
    const isCopy = restored.ownerNodeId != null && String(restored.ownerNodeId) !== String(node.id);
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state,{version:1,history:[],selectedResultId:null,activeJob:null},restored);
    state.history=migrateHistory(state.history);state.resultSchemaVersion=2;state.promptHistory=(state.promptHistory || []).slice(-50);
    state.ownerId = isCopy ? crypto.randomUUID() : restored.ownerId || crypto.randomUUID();
    state.ownerNodeId = String(node.id);
    if(isCopy) state.activeJob=null;
    node.properties.qwenWorkbench=state;
    refsWidget.loadFromValue(W.refs_json?.value || '[]');
    loraWidget.loadFromValue(W.lora_json?.value || '[]');
    accelWidget.loadFromValue(W.accel_json?.value || '');
    editor.writeValue(W.prompt?.value || '');
    lastPromptRatio=aspectRatioFromPrompt(W.prompt?.value);
    applyMode('load',restored.version || 0);state.version=1;
    controller.restore();preview.render();changed();refreshSize(node);
  };
  ensureDropHandlers();
  void refsWidget.loadFromValue(initialValues.refs_json || '[]');
  loraWidget.loadFromValue(initialValues.lora_json || '[]');
  accelWidget.loadFromValue(initialValues.accel_json || '');
  applyMode('load',previousVersion);
  ready=true;changed();preview.render();
  node.setSize([Math.max(node.size[0],460),node.size[1]]);refreshSize(node);
}

app.registerExtension({
  name: "Qwen.Image21Auto.Panels",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    // Keep schema slots and links intact; remove only their visible canvas presentation.
    nodeType.title_mode = globalThis.LiteGraph?.NO_TITLE ?? 1;
    nodeType.prototype.drawSlots = function () {};
    nodeType.prototype.widgets_start_y = 14;
    if (!document.getElementById('qwen-compact-node-style')) {
      const style=document.createElement('style');style.id='qwen-compact-node-style';
      style.textContent=`.lg-node:has(.qwen-result) .lg-node-header{height:12px;min-height:12px;padding:0;cursor:grab}
      .lg-node:has(.qwen-result) .lg-node-header>*{display:none!important}
      .lg-node:has(.qwen-result) .lg-node-header:after{content:'';display:block;width:32px;height:3px;background:#5d586b;border-radius:3px;margin:4px auto}
      .lg-node:has(.qwen-result) [data-testid^="node-body-"]>div:has(>.flex>.lg-slot){display:none!important}
      .lg-node:has(.qwen-result) .lg-node-widgets{align-content:start!important;flex:0 0 auto!important}
      .lg-node:has(.qwen-result) [data-testid="node-widget"]{align-self:start}`;
      document.head.append(style);
    }
    bindPanelMouse(nodeType);
    const origins = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = origins ? origins.apply(this, arguments) : undefined;
      instances.add(this);
      setTimeout(() => initNode(this), 0);
      return r;
    };
    const configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = configure?.apply(this, arguments);
      this.__qwenRestore?.(info);
      return result;
    };
  },
});
