const DEFAULTS = {
  provider: 'ollama',
  ollama: { address: 'http://127.0.0.1:11434', model: '', think: 'auto', temperature: 0.7, num_predict: 2048 },
  responses: { model: 'deepseek-flash', effort: 'auto' },
};

export function normalizeOptimizerSettings(raw = {}) {
  const defined = value => Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined));
  // Migrate the previous flat Ollama-only workflow settings without dropping them.
  if (!raw.ollama && !raw.responses) {
    const { provider, ...legacy } = raw;
    return { ...DEFAULTS, provider: provider || DEFAULTS.provider,
      ollama: { ...DEFAULTS.ollama, ...defined(legacy) }, responses: { ...DEFAULTS.responses } };
  }
  return { ...DEFAULTS, ...defined(raw),
    ollama: { ...DEFAULTS.ollama, ...defined(raw.ollama) },
    responses: { ...DEFAULTS.responses, ...defined(raw.responses) },
  };
}

// Settings other than the API key live in the workflow; the secret is kept by the local server.
export function mountOllamaSettings(container, { getSettings, setSettings, request, isLocked = () => false }) {
  const doc = container.ownerDocument;
  const style = 'box-sizing:border-box;min-width:0;border:1px solid #514962;border-radius:7px;background:#292631;color:#eee9f6;padding:7px 9px;font:inherit;';
  let alive = true, sequence = 0, loading = false, models = [], apiConfig = { base_url: 'https://api.deepseek.com', has_api_key: false };
  const settings = () => normalizeOptimizerSettings(getSettings());
  function save(next) { if (alive && !isLocked()) setSettings(normalizeOptimizerSettings(next)); }
  function updateSection(section, patch) { const value = settings(); value[section] = { ...value[section], ...patch }; save(value); }
  function field(title, control) {
    const label = doc.createElement('label');
    label.style.cssText = 'display:grid;grid-template-columns:90px minmax(0,1fr);align-items:center;gap:8px;margin:8px 0;';
    const text = doc.createElement('span'); text.textContent = title;
    label.append(text, control); control.setAttribute('aria-label', `提示词优化 ${title}`);
    return label;
  }
  function option(select, value, text) {
    const item = doc.createElement('option'); item.value = value; item.textContent = text; select.append(item);
  }
  const heading = doc.createElement('div'); heading.style.cssText = 'display:flex;align-items:center;gap:8px;margin:16px 0 9px;padding-top:12px;border-top:1px solid #46404f;';
  const title = doc.createElement('strong'); title.textContent = '提示词优化'; title.style.cssText = 'font:600 13px sans-serif;color:#c5b7e9;';
  const provider = doc.createElement('select'); provider.style.cssText = style + 'padding:4px 7px;';
  option(provider, 'ollama', 'Ollama'); option(provider, 'responses', 'Responses API'); heading.append(title, provider);

  const address = doc.createElement('input'); address.type = 'url'; address.value = settings().ollama.address; address.style.cssText = style;
  address.placeholder = 'http://127.0.0.1:11434';
  const ollamaModel = doc.createElement('select'); ollamaModel.style.cssText = style + 'width:100%;';
  const ollamaRefresh = doc.createElement('button'); ollamaRefresh.type = 'button'; ollamaRefresh.textContent = '刷新'; ollamaRefresh.title = '刷新 Ollama 已安装模型'; ollamaRefresh.style.cssText = style + 'cursor:pointer;';
  const ollamaModelRow = doc.createElement('div'); ollamaModelRow.style.cssText = 'display:flex;gap:7px;min-width:0;'; ollamaModelRow.append(ollamaModel, ollamaRefresh);
  const thinking = doc.createElement('select'); thinking.style.cssText = style;
  const thinkingRow = field('思考', thinking);
  const ollamaSection = doc.createElement('div');
  ollamaSection.append(field('服务地址', address), field('模型', ollamaModelRow), thinkingRow);
  const detail = doc.createElement('details'); detail.style.cssText = 'margin:10px 0;';
  const summary = doc.createElement('summary'); summary.textContent = '更多参数'; summary.style.cursor = 'pointer'; detail.append(summary);
  function numberField(key, titleText, min, max, step) {
    const input = doc.createElement('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(settings().ollama[key]); input.style.cssText = style;
    input.oninput = () => input.setCustomValidity('');
    input.onchange = () => {
      if (isLocked()) return;
      const value = Number(input.value);
      if (!input.value.trim() || !Number.isFinite(value) || value < min || value > max || (step === 1 && !Number.isInteger(value))) {
        input.setCustomValidity(`请输入 ${min} 至 ${max} 的${step === 1 ? '整数' : '数值'}`); input.reportValidity(); return;
      }
      updateSection('ollama', { [key]: value });
    };
    detail.append(field(titleText, input));
  }
  numberField('temperature', '温度', 0, 2, 0.1);
  numberField('num_predict', '输出上限', 128, 8192, 1);

  const apiBase = doc.createElement('input'); apiBase.type = 'url'; apiBase.value = apiConfig.base_url; apiBase.placeholder = 'https://api.deepseek.com'; apiBase.style.cssText = style;
  const apiKey = doc.createElement('input'); apiKey.type = 'password'; apiKey.autocomplete = 'new-password'; apiKey.placeholder = '粘贴 API 密钥（只保存在本机）'; apiKey.style.cssText = style;
  const apiKeyRow = doc.createElement('div'); apiKeyRow.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;';
  const saveKey = doc.createElement('button'); saveKey.type = 'button'; saveKey.textContent = '保存'; saveKey.style.cssText = style + 'cursor:pointer;';
  const clearKey = doc.createElement('button'); clearKey.type = 'button'; clearKey.textContent = '清除'; clearKey.style.cssText = style + 'cursor:pointer;';
  apiKeyRow.append(apiKey, saveKey, clearKey);
  const apiModelId = `qwen-responses-models-${Math.random().toString(36).slice(2)}`;
  const apiModelsList = doc.createElement('datalist'); apiModelsList.id = apiModelId;
  const apiModel = doc.createElement('input'); apiModel.type = 'text'; apiModel.setAttribute('list', apiModelId); apiModel.placeholder = 'deepseek-flash'; apiModel.style.cssText = style;
  const apiModelRefresh = doc.createElement('button'); apiModelRefresh.type = 'button'; apiModelRefresh.textContent = '刷新模型'; apiModelRefresh.title = '从 Responses API 获取可用模型'; apiModelRefresh.style.cssText = style + 'cursor:pointer;';
  const apiModelRow = doc.createElement('div'); apiModelRow.style.cssText = 'display:flex;gap:7px;min-width:0;'; apiModelRow.append(apiModel, apiModelRefresh);
  const effort = doc.createElement('select'); effort.style.cssText = style;
  const effortRow = field('推理强度', effort);
  const apiHint = doc.createElement('div'); apiHint.style.cssText = 'font-size:11px;color:#a89fb7;line-height:1.5;margin-top:4px;';
  const apiSection = doc.createElement('div'); apiSection.hidden = true;
  apiSection.append(field('服务地址', apiBase), field('API 密钥', apiKeyRow), field('模型', apiModelRow), effortRow, apiHint);
  const status = doc.createElement('div'); status.setAttribute('role', 'status'); status.style.cssText = 'font-size:12px;color:#b8aecd;line-height:1.5;overflow-wrap:anywhere;margin-top:7px;';
  const note = doc.createElement('p'); note.textContent = '按参考图自动区分生图 / 编辑模板，模板中文，输出语言跟随提示词。Ollama 完成后自动卸载模型。';
  note.style.cssText = 'font-size:12px;color:#a89fb7;line-height:1.6;margin:8px 0 0;';
  container.append(heading, ollamaSection, detail, apiSection, status, note);

  function renderThinking() {
    const selected = models.find(item => (item.id || item.name) === settings().ollama.model);
    const supported = selected?.capabilities?.includes('thinking');
    thinkingRow.hidden = !supported; thinkingRow.style.display = supported ? 'grid' : 'none'; thinking.replaceChildren();
    option(thinking, 'auto', '模型默认');
    const titles = { low: '低', medium: '中', high: '高' };
    for (const value of selected?.thinking?.values || []) option(thinking, JSON.stringify(value), typeof value === 'boolean' ? (value ? '开启' : '关闭') : titles[value] || String(value));
    const values = Array.from(thinking.options, item => item.value), current = settings().ollama.think === 'auto' ? 'auto' : JSON.stringify(settings().ollama.think);
    thinking.value = values.includes(current) ? current : 'auto';
  }
  function renderModels() {
    const current = settings().ollama.model; ollamaModel.replaceChildren();
    option(ollamaModel, '', models.length ? '选择已安装模型' : '暂无可用模型');
    for (const item of models) option(ollamaModel, item.name, item.name);
    if (current && !models.some(item => item.name === current)) option(ollamaModel, current, `${current}（未获取到）`);
    ollamaModel.value = current; ollamaModel.disabled = loading || isLocked(); ollamaRefresh.disabled = loading || isLocked(); renderThinking();
    const selected = models.find(item => item.id === settings().responses.model);
    effort.replaceChildren(); option(effort, 'auto', '模型默认');
    const declared = selected?.effort?.supported_levels;
    const levels = Array.isArray(declared) && declared.length
      ? new Set(['none', ...declared, ...(declared.includes('high') ? ['medium'] : [])])
      : new Set(['none', 'low', 'medium', 'high', 'max']);
    const labels = { none: '关闭', low: '低', medium: '中', high: '高', max: '最高' };
    for (const value of ['none', 'low', 'medium', 'high', 'max']) if (levels.has(value)) option(effort, value, labels[value]);
    const currentEffort = settings().responses.effort; effort.value = Array.from(effort.options).some(item => item.value === currentEffort) ? currentEffort : 'auto';
    apiModel.value = settings().responses.model;
  }
  function renderProvider() {
    const value = settings(), apiMode = value.provider === 'responses';
    provider.value = apiMode ? 'responses' : 'ollama'; provider.disabled = isLocked();
    ollamaSection.hidden = apiMode; detail.hidden = apiMode; apiSection.hidden = !apiMode;
    apiBase.value = apiConfig.base_url; apiKey.placeholder = apiConfig.has_api_key ? '已保存密钥；输入新密钥可替换' : '粘贴 API 密钥（只保存在本机）';
    apiHint.textContent = apiConfig.has_api_key ? '密钥已保存在 ComfyUI 本机用户目录，不会写入工作流。模型图像能力：' + imageCapability() : '先保存 API 密钥。API 模型只刷新列表，不会下载模型；也可手动填写模型 ID。';
    apiModelRefresh.disabled = loading || isLocked() || !apiConfig.has_api_key;
    apiModel.disabled = isLocked(); effort.disabled = isLocked(); apiBase.disabled = isLocked(); apiKey.disabled = isLocked();
    saveKey.disabled = isLocked(); clearKey.disabled = isLocked() || !apiConfig.has_api_key;
  }
  function imageCapability() {
    const selected = models.find(item => item.id === settings().responses.model);
    const value = selected?.input_modalities;
    return Array.isArray(value) ? (value.includes('image') ? '支持图片' : '不支持图片') : '未声明（将尝试发送，若不支持会报错）';
  }
  async function loadApiConfig() {
    try { apiConfig = await request('/qwen_auto/optimizer/api-config', { action: 'get' }); }
    catch (error) { status.textContent = `读取本机 API 设置失败：${error?.message || '未知错误'}`; }
    if (alive) {
      renderProvider();
      if (settings().provider === 'responses' && apiConfig.has_api_key) void fetchModels();
    }
  }
  async function fetchModels() {
    if (!alive || isLocked()) return;
    const id = ++sequence, apiMode = settings().provider === 'responses';
    loading = true; status.textContent = apiMode ? '正在获取 Responses API 模型…' : '正在获取 Ollama 已安装模型…'; renderModels(); renderProvider();
    try {
      const data = apiMode
        ? await request('/qwen_auto/responses/models', {})
        : await request('/qwen_auto/ollama/models', { address: settings().ollama.address });
      if (!alive || id !== sequence) return;
      models = Array.isArray(data.models) ? data.models.filter(item => typeof (item?.name || item?.id) === 'string') : [];
      if (apiMode) {
        apiModelsList.replaceChildren();
        for (const item of models) { const row = doc.createElement('option'); row.value = item.id; row.label = item.name || item.id; apiModelsList.append(row); }
        status.textContent = models.length ? `已找到 ${models.length} 个 API 模型` : '模型列表为空，可直接输入服务支持的模型 ID。';
      } else status.textContent = models.length ? `已找到 ${models.length} 个本地模型` : '未找到模型，请先在 Ollama 中拉取模型后刷新。';
    } catch (error) {
      if (!alive || id !== sequence) return;
      models = [];
      status.textContent = apiMode ? `获取失败：${error?.message || '无法获取模型列表'}；仍可手动填写模型 ID。` : `获取失败：${error?.message || '无法连接 Ollama'}`;
    } finally {
      if (alive && id === sequence) { loading = false; renderModels(); renderProvider(); }
    }
  }
  provider.onchange = () => { if (isLocked()) return; const value = settings(); value.provider = provider.value; save(value); models = []; renderProvider(); void fetchModels(); };
  address.onchange = () => {
    if (isLocked()) return; const value = address.value.trim() || 'http://127.0.0.1:11434'; address.value = value;
    updateSection('ollama', { address: value }); models = []; void fetchModels();
  };
  ollamaModel.onchange = () => { if (!isLocked()) { updateSection('ollama', { model: ollamaModel.value, think: 'auto' }); renderThinking(); } };
  thinking.onchange = () => updateSection('ollama', { think: thinking.value === 'auto' ? 'auto' : JSON.parse(thinking.value) });
  apiModel.onchange = () => updateSection('responses', { model: apiModel.value.trim() || 'deepseek-flash' });
  effort.onchange = () => updateSection('responses', { effort: effort.value });
  apiBase.onchange = async () => {
    if (isLocked()) return;
    try {
      apiConfig = await request('/qwen_auto/optimizer/api-config', { action: 'save', base_url: apiBase.value.trim() });
      models = []; status.textContent = 'API 服务地址已保存在本机设置'; renderProvider();
    } catch (error) { status.textContent = `保存失败：${error?.message || 'API 地址无效'}`; apiBase.value = apiConfig.base_url; }
  };
  saveKey.onclick = async () => {
    if (isLocked() || !apiKey.value.trim()) { status.textContent = '请输入 API 密钥'; return; }
    try {
      apiConfig = await request('/qwen_auto/optimizer/api-config', { action: 'save', base_url: apiBase.value.trim(), api_key: apiKey.value });
      apiKey.value = ''; status.textContent = '密钥已安全保存在本机设置'; models = []; renderProvider();
      if (settings().provider === 'responses') void fetchModels();
    } catch (error) { status.textContent = `保存失败：${error?.message || '无法保存密钥'}`; }
  };
  clearKey.onclick = async () => {
    if (isLocked()) return;
    try { apiConfig = await request('/qwen_auto/optimizer/api-config', { action: 'clear_key' }); models = []; status.textContent = '本机 API 密钥已清除'; renderProvider(); }
    catch (error) { status.textContent = `清除失败：${error?.message || '无法清除密钥'}`; }
  };
  ollamaRefresh.onclick = apiModelRefresh.onclick = fetchModels;
  void loadApiConfig();
  renderModels(); renderProvider();
  if (settings().provider !== 'responses') fetchModels();
  return () => { alive = false; sequence++; };
}
