import { normalizeAccelerators } from './panel-state.mjs?v=20260927-region-1';
import { mountOllamaSettings } from './ollama-settings.mjs?v=20260928-responses-1';

// Edit the canonical widget values, so the graph and generated prompt stay in sync.
export function createExtensionsPopover({ anchor, loraWidget, accelWidget, optimizer = null, isLocked = () => false }) {
  const doc = anchor.ownerDocument;
  const win = doc.defaultView;
  let panel = null;
  let picker = null;
  let frame = 0;
  let destroyed = false;
  let cleanupOptimizer = null;
  const expanded = new Set();
  const controlStyle = 'box-sizing:border-box;min-width:0;border:1px solid #514962;border-radius:7px;background:#292631;color:#eee9f6;padding:7px 9px;font:inherit;';
  const defaults = normalizeAccelerators('');
  const names = { te_speed: 'TE-speed', kv_cache: 'KV 缓存' };

  function button(text, callback, title = text) {
    const b = doc.createElement('button');
    b.type = 'button'; b.textContent = text; b.title = title;
    b.style.cssText = controlStyle + 'cursor:pointer;';
    b.onclick = () => { if (!isLocked()) callback(); };
    return b;
  }
  function closePicker() { picker?.remove(); picker = null; }
  function sync(widget) { widget.sync(); render(); }
  function toggle(item, widget) {
    const b = button(item.enabled !== false ? '启用' : '停用', () => { item.enabled = item.enabled === false; sync(widget); });
    b.setAttribute('aria-pressed', String(item.enabled !== false));
    if (item.enabled !== false) b.style.background = '#7256ad';
    return b;
  }
  function heading(text) {
    const h = doc.createElement('h3'); h.textContent = text;
    h.style.cssText = 'font:600 13px sans-serif;color:#c5b7e9;margin:16px 0 9px;padding-top:12px;border-top:1px solid #46404f;';
    panel.append(h);
  }
  function row() {
    const r = doc.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:7px;margin:7px 0;min-width:0;';
    panel.append(r); return r;
  }
  function pickLora(target, opener) {
    closePicker();
    picker = doc.createElement('div');
    picker.className = 'qwen-extension-lora-picker';
    picker.style.cssText = 'position:fixed;box-sizing:border-box;z-index:99991;background:#25222e;border:1px solid #a48bcc;border-radius:9px;padding:10px;box-shadow:0 12px 36px #000b;';
    const top = doc.createElement('div'); top.style.cssText = 'display:flex;gap:6px;';
    const search = doc.createElement('input'); search.type = 'search'; search.placeholder = '搜索 LoRA 文件';
    search.setAttribute('aria-label', '搜索 LoRA 文件'); search.style.cssText = controlStyle + 'flex:1;';
    top.append(search, button('×', () => { closePicker(); opener?.focus(); }, '关闭 LoRA 列表'));
    const list = doc.createElement('div'); list.style.cssText = 'max-height:min(260px,45vh);overflow:auto;margin-top:8px;';
    picker.append(top, list); doc.body.append(picker);
    for (const type of ['pointerdown', 'pointerup', 'click', 'wheel', 'keydown', 'keyup']) picker.addEventListener(type, event => event.stopPropagation());
    let selected = 0;
    let choices = [];
    function choose(name) {
      if (isLocked()) return;
      if (target && loraWidget.items.includes(target)) target.name = name;
      else if (!target) loraWidget.items.push({ name, strength: 1, enabled: true });
      closePicker(); sync(loraWidget);
    }
    function paint() {
      choices = loraWidget.loraList.filter(name => name.toLowerCase().includes(search.value.toLowerCase()));
      selected = Math.min(selected, Math.max(0, choices.length - 1)); list.replaceChildren();
      choices.forEach((name, i) => {
        const b = button(name, () => choose(name));
        b.style.cssText += `display:block;width:100%;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:3px 0;${i === selected ? 'background:#49346e;' : ''}`;
        list.append(b);
      });
      if (!choices.length) { const empty = doc.createElement('p'); empty.textContent = '没有匹配的 LoRA 文件'; list.append(empty); }
    }
    search.oninput = () => { selected = 0; paint(); };
    search.onkeydown = event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && choices.length) {
        event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length; paint(); list.children[selected]?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && choices[selected]) { event.preventDefault(); choose(choices[selected]); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); opener?.focus(); }
    };
    paint(); position(); search.focus();
  }
  function configField(item, key, title, options = null, numeric = false) {
    const label = doc.createElement('label');
    label.style.cssText = 'display:grid;grid-template-columns:130px minmax(0,1fr);gap:8px;align-items:center;margin:8px 0;';
    const text = doc.createElement('span'); text.textContent = title;
    const input = doc.createElement(options ? 'select' : 'input');
    input.style.cssText = controlStyle; input.setAttribute('aria-label', `${names[item.type]} ${title}`);
    if (options) for (const value of options) { const o = doc.createElement('option'); o.value = value; o.textContent = value; input.append(o); }
    if (numeric) { input.type = 'number'; input.min = '0'; input.max = '1'; input.step = '0.01'; }
    input.value = String(item.config[key] ?? defaults.find(d => d.type === item.type).config[key] ?? '');
    input.oninput = () => input.setCustomValidity('');
    input.onchange = () => {
      if (isLocked() || !accelWidget.items.includes(item)) return;
      const value = numeric ? Number(input.value) : input.value.trim();
      if (input.value.trim() === '' || (numeric && (!Number.isFinite(value) || value < 0 || value > 1)) || (options && !options.includes(value))) {
        input.setCustomValidity(numeric ? '请输入 0 至 1 的数值' : '请输入有效配置'); input.reportValidity(); return;
      }
      item.config[key] = value; accelWidget.sync();
    };
    label.append(text, input); panel.append(label);
  }
  function render() {
    if (!panel) return;
    cleanupOptimizer?.(); cleanupOptimizer = null;
    closePicker(); panel.replaceChildren();
    const top = row();
    const title = doc.createElement('strong'); title.textContent = '扩展'; title.style.flex = '1';
    top.append(title, button('关闭', close));
    heading('LoRA');
    for (const item of loraWidget.items) {
      const r = row();
      const name = button(item.name || '选择 LoRA', () => pickLora(item, name));
      name.style.cssText += 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;';
      const strength = doc.createElement('input'); strength.type = 'number'; strength.step = '0.05'; strength.value = String(item.strength);
      strength.title = 'LoRA 强度（可为负数）'; strength.setAttribute('aria-label', `${item.name} 强度`);
      strength.style.cssText = controlStyle + 'width:78px;';
      strength.oninput = () => strength.setCustomValidity('');
      strength.onchange = () => {
        if (isLocked() || !loraWidget.items.includes(item)) return;
        const value = Number(strength.value);
        if (strength.value.trim() === '' || !Number.isFinite(value)) { strength.setCustomValidity('请输入有效强度'); strength.reportValidity(); return; }
        item.strength = Math.round(value * 1000) / 1000; loraWidget.sync();
      };
      r.append(toggle(item, loraWidget), name, strength, button('×', () => { loraWidget.items = loraWidget.items.filter(one => one !== item); sync(loraWidget); }, '删除 LoRA'));
    }
    const add = button('＋ 添加 LoRA', () => pickLora(null, add)); panel.append(add);
    for (const type of ['te_speed', 'kv_cache']) {
      heading(type === 'te_speed' ? '推理加速' : '模型缓存');
      const item = accelWidget.items.find(one => one.type === type);
      if (!item) {
        panel.append(button(`＋ 添加 ${names[type]}`, () => {
          const base = defaults.find(one => one.type === type);
          accelWidget.items.push({ ...base, enabled: true, config: { ...base.config } }); sync(accelWidget);
        })); continue;
      }
      const r = row(); const name = doc.createElement('span'); name.textContent = names[type]; name.style.flex = '1';
      r.append(toggle(item, accelWidget), name,
        button(expanded.has(type) ? '收起设置' : '设置', () => { expanded.has(type) ? expanded.delete(type) : expanded.add(type); render(); }),
        button('×', () => { accelWidget.items = accelWidget.items.filter(one => one !== item); expanded.delete(type); sync(accelWidget); }, `删除 ${names[type]}`));
      if (expanded.has(type)) {
        if (type === 'te_speed') {
          configField(item, 'attention', 'Attention'); configField(item, 'step_cache', '步缓存');
          configField(item, 'reuse_threshold', '复用阈值', null, true); configField(item, 'predictor_error_limit', '预测误差上限', null, true);
        } else {
          configField(item, 'device', '缓存设备', ['auto', 'gpu', 'cpu', 'off']); configField(item, 'dtype', '缓存精度', ['default', 'int8', 'int4']);
        }
      }
    }
    if (optimizer) cleanupOptimizer = mountOllamaSettings(panel, { ...optimizer, isLocked });
    position();
  }
  function position() {
    if (!panel) return;
    const r = anchor.getBoundingClientRect();
    const width = Math.min(540, win.innerWidth - 16);
    panel.style.width = `${Math.max(240, width)}px`;
    panel.style.maxHeight = `${Math.max(100, win.innerHeight - 24)}px`;
    panel.style.left = `${Math.max(8, Math.min(r.left, win.innerWidth - width - 8))}px`;
    const height = panel.getBoundingClientRect().height;
    panel.style.top = `${Math.max(8, Math.min(r.top - height - 8 >= 8 ? r.top - height - 8 : r.bottom + 8, win.innerHeight - height - 8))}px`;
    if (picker) {
      const rect = panel.getBoundingClientRect();
      picker.style.width = `${Math.max(220, rect.width - 28)}px`;
      picker.style.left = `${rect.left + 14}px`;
      picker.style.top = `${Math.max(8, Math.min(rect.top + 65, win.innerHeight - picker.getBoundingClientRect().height - 8))}px`;
    }
  }
  function track() {
    if (!panel) return;
    if (isLocked() || !anchor.isConnected) { close(); return; }
    position(); frame = win.requestAnimationFrame(track);
  }
  function outside(event) { if (panel && !panel.contains(event.target) && !picker?.contains(event.target) && !anchor.contains(event.target)) close(); }
  function escape(event) { if (event.key === 'Escape' && panel) { event.preventDefault(); close(); anchor.focus(); } }
  function open() {
    if (destroyed || isLocked()) return;
    if (panel) { close(); return; }
    panel = doc.createElement('div'); panel.className = 'qwen-extensions-popover';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '扩展');
    panel.style.cssText = 'position:fixed;z-index:99990;box-sizing:border-box;padding:14px;background:#211f29;color:#eee9f6;border:1px solid #665479;border-radius:12px;box-shadow:0 18px 50px #000b;font:13px sans-serif;overflow:auto;';
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel', 'keyup']) panel.addEventListener(type, event => event.stopPropagation());
    panel.addEventListener('keydown', event => { escape(event); event.stopPropagation(); });
    doc.body.append(panel); anchor.setAttribute('aria-expanded', 'true'); render();
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('keydown', escape);
    track();
  }
  function close() {
    cleanupOptimizer?.(); cleanupOptimizer = null;
    closePicker(); if (frame) win.cancelAnimationFrame(frame); frame = 0;
    panel?.remove(); panel = null; anchor.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('keydown', escape);
  }
  function refresh() { if (isLocked()) close(); }
  function destroy() { close(); destroyed = true; }
  return { open, close, refresh, destroy };
}
