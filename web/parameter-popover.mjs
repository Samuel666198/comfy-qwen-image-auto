// Values always come from the node's existing widgets through the adapter.
export function createParameterPopover({ anchor, getValues, setValue, isLocked = () => false, kind = "common", getOptions = () => [], getCustomMode = () => false, setCustomMode = () => {} }) {
  let panel = null;
  let frame = 0;
  let previousRect = "";
  let destroyed = false;
  const doc = anchor.ownerDocument;
  const win = doc.defaultView;
  const fields = new Map();
  const style = "box-sizing:border-box;width:100%;min-width:0;border:1px solid #4b465e;border-radius:6px;background:#242330;color:#eeeaf6;padding:7px;font:inherit;";
  function note(text) {
    const el = doc.createElement("p"); el.textContent = text;
    el.style.cssText = "font-size:11px;color:#aaa4ba;margin:5px 0 10px;line-height:1.5;";
    panel.append(el); return el;
  }
  function commit(name, value, input) {
    if (isLocked()) { refresh(); return; }
    input?.setCustomValidity?.("");
    setValue(name, value);
    refresh();
  }
  function field(name, title, options, range) {
    const label = doc.createElement("label");
    label.style.cssText = "display:grid;grid-template-columns:94px minmax(0,1fr);align-items:center;gap:10px;margin:8px 0;";
    const text = doc.createElement("span"); text.textContent = title;
    const input = doc.createElement(options ? "select" : name === "negative_prompt" ? "textarea" : "input");
    input.style.cssText = style; input.dataset.field = name;
    if (options) {
      for (const option of options) {
        const [value, title] = Array.isArray(option) ? option : [option, option];
        const el = doc.createElement("option"); el.value = String(value); el.textContent = String(title); input.append(el);
      }
    } else if (range) {
      input.type = name === "seed" ? "text" : "number";
      input.inputMode = range.step === 1 ? "numeric" : "decimal";
      input.min = String(range.min); input.max = String(range.max); input.step = String(range.step);
    } else { input.rows = 3; }
    const entry = { label, input, dirty: false, apply: null };
    entry.apply = () => {
      if (!entry.dirty) return true;
      if (isLocked()) return false;
      let value = input.value;
      if (range) {
        value = Number(value);
        const invalid = input.value.trim() === "" || !Number.isFinite(value) || value < range.min || value > range.max || (range.step >= 1 && !Number.isSafeInteger(value)) || (range.step === 32 && value % 32 !== 0);
        if (invalid) {
          input.setCustomValidity(name === "seed" ? "请输入 0 至 9007199254740991 的安全整数；已有种子不会被改写。" : `请输入 ${range.min} 至 ${range.max} 范围内的${range.step === 32 ? "32 的整数倍" : range.step === 1 ? "整数" : "数值"}`);
          input.reportValidity(); return false;
        }
      } else if (name === "resolution") value = Number(value);
      entry.dirty = false;
      commit(name, value, input);
      return true;
    };
    input.addEventListener("change", () => {
      // A native blur may emit change after close() already committed the edit.
      if (!entry.dirty && String(getValues()[name] ?? "") === input.value) return;
      entry.dirty = true; entry.apply();
    });
    input.addEventListener("input", () => { entry.dirty = true; input.setCustomValidity(""); });
    label.append(text, input); panel.append(label); fields.set(name, entry);
  }
  function divider() {
    const line=doc.createElement('hr');line.style.cssText='border:0;border-top:1px solid #3d3948;margin:13px 0;';panel.append(line);
  }
  function tiles(name, title, choices, custom=null) {
    const group=doc.createElement('div'), heading=doc.createElement('div'), row=doc.createElement('div');
    group.style.cssText='margin:10px 0;';heading.textContent=title;heading.style.cssText='color:#bcb6c8;margin-bottom:7px;';
    row.setAttribute('role','group');row.setAttribute('aria-label',title);
    row.style.cssText=`display:grid;grid-template-columns:repeat(${name==='aspect_ratio'?5:name==='negative_preset'?3:choices.length+(custom?1:0)},minmax(0,1fr));gap:7px;`;
    const base='min-width:0;height:35px;border:1px solid #4b465e;border-radius:6px;color:#e9e3f0;font:inherit;cursor:pointer;padding:4px;background:#292631;';
    const buttons=[];
    function paint(b,active){b.style.cssText=base+(active?'background:#7256ad;border-color:#a48bcc;color:white;':'');b.setAttribute('aria-pressed',String(active));b.disabled=isLocked();}
    for(const option of choices){
      const [value,text]=Array.isArray(option)?option:[option,option];const b=doc.createElement('button');b.type='button';b.textContent=text;b.dataset.field=name;b.dataset.value=String(value);
      b.onclick=()=>{if(!isLocked()){setCustomMode(name,false);commit(name,value);}};buttons.push({b,value});row.append(b);
    }
    const entry={update(){const v=getValues();for(const {b,value} of buttons)paint(b,String(v[name])===String(value)&&!(name==='rtx_scale'&&getCustomMode(name)));}};
    fields.set(`tiles:${name}`,entry);
    if(custom){
      const slot=doc.createElement('div'),b=doc.createElement('button'),input=doc.createElement('input');slot.style.minWidth='0';b.type='button';b.textContent='自定义';b.setAttribute('aria-label',`${title}自定义`);
      input.type='text';input.inputMode=custom.integer?'numeric':'decimal';input.setAttribute('aria-label',`${title}自定义数值`);input.dataset.field=custom.name;input.style.cssText=style+'height:35px;';input.hidden=true;
      let editing=false;
      const edit={input,dirty:false,update(){},apply(){
        if(!editing)return true;if(isLocked())return false;const value=Number(input.value);
        if(!input.value.trim()||!Number.isFinite(value)||value<custom.min||value>custom.max||(custom.integer&&!Number.isSafeInteger(value))){input.setCustomValidity(`请输入 ${custom.min} 至 ${custom.max} 的${custom.integer?'整数':'数值'}`);input.reportValidity();return false;}
        editing=false;edit.dirty=false;input.hidden=true;b.hidden=false;setCustomMode(name,true);setValue(custom.name,value);if(name==='inference_preset')setValue(name,'自定义');refresh();return true;
      }};
      fields.set(`edit:${name}`,edit);
      b.onclick=()=>{if(isLocked())return;editing=true;edit.dirty=true;b.hidden=true;input.hidden=false;input.value=String(getValues()[custom.name]??custom.min);input.setCustomValidity('');input.focus();input.select();};
      input.oninput=()=>input.setCustomValidity('');input.onblur=()=>{if(editing&&!edit.apply())input.focus();};
      input.onkeydown=e=>{if(e.isComposing)return;if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(edit.apply())b.focus();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();editing=false;edit.dirty=false;input.hidden=true;b.hidden=false;b.focus();}};
      const update=entry.update;entry.update=()=>{update();const v=getValues();const active=name==='inference_preset'?v[name]==='自定义':name==='rtx_scale'?getCustomMode(name)||!choices.some(c=>Number(Array.isArray(c)?c[0]:c)===Number(v[name])):getCustomMode(name);paint(b,active);b.style.width='100%';b.title=`${v[custom.name]}${custom.suffix||''}`;input.disabled=isLocked();};
      slot.append(b,input);row.append(slot);
    }
    group.append(heading,row);panel.append(group);
  }
  const options = (name, fallback = []) => {
    const found = getOptions(name); return Array.isArray(found) && found.length ? found : fallback;
  };
  function build() {
    panel = doc.createElement("section");
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", kind === "common" ? "常用参数" : "高级设置");
    panel.style.cssText = "position:fixed;z-index:100100;width:520px;max-width:calc(100vw - 16px);overflow:auto;overscroll-behavior:contain;padding:13px 15px;border:1px solid #62577a;border-radius:12px;background:#1b1a24;color:#eae5f1;box-shadow:0 16px 48px #0009;font:12px/1.5 sans-serif;";
    const header = doc.createElement("div"); header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-weight:600;font-size:14px;";
    const title = doc.createElement("span"); title.textContent = kind === "common" ? "常用参数" : "高级设置";
    const closeButton = doc.createElement("button"); closeButton.textContent = "×"; closeButton.setAttribute("aria-label", "关闭参数");
    closeButton.style.cssText = "border:0;background:transparent;color:#ddd;font-size:20px;cursor:pointer;";
    closeButton.addEventListener("click", () => close()); header.append(title, closeButton); panel.append(header);
    if (kind === "common") {
      tiles("aspect_ratio", "画幅", options("aspect_ratio", ["auto","1:1","4:3","3:4","16:9","9:16","3:2","2:3","21:9"]).filter(v=>v!=="custom").map(v=>[v,v==='auto'?'自动':v]));
      tiles("resolution", "分辨率", [[480,"480p"],[768,"768p"],[1024,"1K"],[2048,"2K"],[4096,"4K"]]);
      note("480p / 768p / 1K / 2K / 4K 表示方形等效总像素预算，实际宽高由画幅决定。");
      divider();
      tiles("inference_preset", "推理强度", [["快速","低"],["均衡","中"],["精细","高"]], {name:'steps',min:1,max:200,integer:true,suffix:' 步'});
      divider();
      tiles("control_after_generate", "种子", [["fixed","固定"],["randomize","随机"],["increment","递增"],["decrement","递减"]], {name:'seed',min:0,max:Number.MAX_SAFE_INTEGER,integer:true});
      divider();
      tiles("negative_preset", "排除内容", options("negative_preset", ["不使用","自定义"]));
      field("negative_prompt", "排除内容");
      divider();
      tiles("rtx_scale", "RTX 倍率", [[1.5,"1.5×"],[2,"2×"],[4,"4×"]], {name:'rtx_scale',min:1,max:4,suffix:'×'});
      tiles("rtx_quality", "RTX 档位", ["LOW","MEDIUM","HIGH","ULTRA"]);
      note("超分输出为 RGB，不保留透明通道；原图保持不变。");
    } else {
      field("unet_name", "扩散模型", options("unet_name"));
      field("clip_name", "文本编码器", options("clip_name"));
      field("vae_name", "VAE", options("vae_name"));
      field("cfg", "提示词引导", null, {min:0,max:20,step:0.05});
      field("sampler_name", "采样器", options("sampler_name"));
      field("scheduler", "调度器", options("scheduler"));
      field("denoise", "重绘强度", null, {min:0,max:1,step:0.05});
    }
    for (const type of ["pointerdown", "pointerup", "click", "dblclick", "wheel"]) panel.addEventListener(type, e => e.stopPropagation());
    // Stop at the panel, before document-level canvas shortcut listeners run.
    panel.addEventListener("keydown", keyboard);
    for (const type of ["keyup", "keypress"]) panel.addEventListener(type, e => e.stopPropagation());
    doc.body.append(panel); refresh();
  }
  function position() {
    if (!panel) return;
    const rect = anchor.getBoundingClientRect();
    panel.style.maxHeight = `${Math.max(80, win.innerHeight - 16)}px`;
    const width = panel.offsetWidth, height = panel.offsetHeight;
    const below = rect.bottom + 7;
    const top = below + height <= win.innerHeight - 8 ? below : Math.max(8, rect.top - height - 7);
    panel.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - width - 8))}px`;
    panel.style.top = `${Math.min(top, Math.max(8, win.innerHeight - height - 8))}px`;
  }
  function watchAnchor() {
    if (!panel) return;
    if (!anchor.isConnected) { close(false, true); return; }
    if (isLocked()) { close(true, true); return; }
    const r = anchor.getBoundingClientRect();
    const key = [r.x,r.y,r.width,r.height,win.innerWidth,win.innerHeight].join();
    if (key !== previousRect) { position(); previousRect = key; }
    frame = win.requestAnimationFrame(watchAnchor);
  }
  function refresh() {
    if (!panel) return;
    const values = getValues();
    for (const [name,entry] of fields) {
      if(entry.update){entry.update();continue;}
      const {input,label,dirty}=entry;
      if (!input) continue;
      input.disabled = Boolean(isLocked());
      const value = values[name] ?? ({rtx_scale:2,rtx_quality:"ULTRA"})[name] ?? "";
      if (input.tagName === "SELECT" && !Array.from(input.options).some(o => o.value === String(value))) {
        const option = doc.createElement("option"); option.value = String(value); option.textContent = String(value); input.append(option);
      }
      if (!dirty && doc.activeElement !== input) input.value = String(value);
      label.hidden = (["width","height"].includes(name) && values.aspect_ratio !== "custom") || (name === "steps" && values.inference_preset !== "自定义") || (name === "negative_prompt" && values.negative_preset !== "自定义");
      // The inline grid layout otherwise overrides the browser's [hidden] rule.
      label.style.display = label.hidden ? "none" : "grid";
    }
    position();
  }
  function outside(event) {
    if (!panel?.contains(event.target) && !anchor.contains(event.target) && !close(false)) {
      // Keep invalid edits visible and prevent the outside click from stealing focus.
      event.preventDefault(); event.stopPropagation();
    }
  }
  function keyboard(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (panel?.contains(event.target)) event.stopPropagation();
  }
  function open() {
    if (destroyed || isLocked()) return;
    if (panel) { close(); return; }
    build(); anchor.setAttribute("aria-expanded", "true");
    doc.addEventListener("pointerdown", outside, true); doc.addEventListener("keydown", keyboard);
    panel.querySelector("select, input, textarea, button")?.focus(); watchAnchor();
  }
  function close(returnFocus = true, force = false) {
    if (!panel) return true;
    if (!force) {
      for (const entry of fields.values()) {
        if (entry.dirty && !entry.apply()) { entry.input.focus(); return false; }
      }
      if (panel.contains(doc.activeElement)) doc.activeElement.blur();
    }
    win.cancelAnimationFrame(frame); frame = 0;
    doc.removeEventListener("pointerdown", outside, true); doc.removeEventListener("keydown", keyboard);
    panel.remove(); panel = null; fields.clear(); previousRect = "";
    anchor.setAttribute("aria-expanded", "false");
    if (returnFocus && anchor.isConnected) anchor.focus({preventScroll:true});
    return true;
  }
  function destroy() { close(false, true); destroyed = true; }
  return { open, close, destroy, refresh };
}
