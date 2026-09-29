export async function optimizerRequest(api, path, payload) {
  const response = await api.fetchApi(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  let data;
  try { data = await response.json(); } catch { throw new Error('优化接口不可用，请重启 ComfyUI 后重试'); }
  if (!response.ok) throw new Error((data.error || `请求失败 (${response.status})`) + (data.unload_error ? `；模型卸载失败：${data.unload_error}` : ''));
  return data;
}

export async function optimizerStreamRequest(api, path, payload, { onEvent = () => {}, signal } = {}) {
  const response = await api.fetchApi(path, {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'text/event-stream'},
    body:JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { data = {}; }
    throw new Error((data.error || `请求失败 (${response.status})`) + (data.unload_error ? `；模型卸载失败：${data.unload_error}` : ''));
  }
  if (!response.body?.getReader) throw new Error('当前 ComfyUI 客户端不支持流式读取，请更新后重试');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', completed = null;
  const dispatch = line => {
    if (!line.startsWith('data:')) return;
    let event;
    try { event = JSON.parse(line.slice(5).trim()); }
    catch { throw new Error('优化接口返回了无效事件'); }
    onEvent(event);
    if (event.type === 'error') {
      const error = new Error(event.error || '提示词优化失败');
      error.unloaded = event.unloaded;
      error.unload_error = event.unload_error;
      throw error;
    }
    if (event.type === 'done') completed = event;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream:!done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) for (const line of frame.split(/\r?\n/)) dispatch(line);
      if (done) break;
    }
    if (buffer.trim()) for (const line of buffer.split(/\r?\n/)) dispatch(line);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('已取消提示词优化', 'AbortError');
    throw error;
  } finally {
    if (signal?.aborted) void reader.cancel().catch(() => {});
  }
  if (!completed) throw new Error('优化流意外结束，原提示词已保留');
  if (completed.unload_error) completed.warning = `模型卸载失败：${completed.unload_error}`;
  return completed;
}

// Backward-compatible names for any integrations still using the original Ollama-only helpers.
export const ollamaRequest = optimizerRequest;
export const ollamaStreamRequest = optimizerStreamRequest;

export function toOptimizerPrompt(prompt, refs) {
  return String(prompt).replace(/\[\[qwen-ref:([^\]]+)\]\]/g, (_, id) => {
    const index = refs.findIndex(ref => ref.id === id);
    if (index < 0 || refs[index].missing) throw new Error('提示词包含已删除的参考图');
    return `<image${index + 1}>`;
  });
}

export function fromOptimizerPrompt(prompt, refs) {
  const value = String(prompt || '').trim();
  if (!value) throw new Error('模型未返回有效提示词，原文已保留');
  return value.replace(/<image\s*(\d+)>/gi, (_, number) => {
    const ref = refs[Number(number) - 1];
    if (!ref) throw new Error('模型返回了不存在的图片引用，原文已保留');
    return `[[qwen-ref:${ref.id}]]`;
  });
}
