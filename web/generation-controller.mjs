const BUSY = new Set(['submitting', 'queued', 'running', 'cancelling', 'reconciling']);
export const isJobBusy = (job) => BUSY.has(job?.state);
export function estimateRemaining({ steps, completedSteps = 0, sampleElapsedMs = 0 }) {
  const rate = completedSteps > 0 && sampleElapsedMs > 0 ? sampleElapsedMs / completedSteps / 1000 : 3;
  return Math.max(0, Math.ceil((steps - completedSteps) * rate));
}
export function transitionJob(job, event) {
  if (!job || (event.promptId && event.promptId !== job.promptId)) return job;
  if (!isJobBusy(job)) return job;
  if (job.state === 'cancelling' && ['queued', 'running'].includes(event.state)) return { ...job, ...event, state: 'cancelling' };
  return { ...job, ...event };
}
export function graphReferencesNode(prompt, targets, nodeId) {
  const seen = new Set();
  function visit(id) {
    id = String(id);
    if (id === String(nodeId)) return true;
    if (seen.has(id) || !prompt[id]) return false;
    seen.add(id);
    return Object.values(prompt[id].inputs || {}).some((value) => Array.isArray(value) && value.length === 2 &&
      typeof value[0] === 'string' && Number.isInteger(value[1]) && prompt[value[0]] && visit(value[0]));
  }
  return (targets || []).some(visit);
}

// No global interrupt, no GPU work on HTTP routes: every operation owns a queue ID.
export function createGenerationController({ node, api, getWorkflow, onState, onResult, onAccepted = () => {}, getSeedNext = () => null }) {
  const state = () => node.properties.qwenWorkbench;
  let job = state().activeJob || null;
  let disposed = false, checking = false, submitting = false, checkingPromise;
  let timer, reconcileTimer, currentExecution = null, cancelInFlight = null;
  const listeners = [];
  const delivered = new Set();
  function publish() {
    if (disposed) return;
    state().activeJob = isJobBusy(job) ? job : null;
    onState(job);
    node.graph?.setDirtyCanvas?.(true, true);
  }
  function change(event) { job = transitionJob(job, event); publish(); }
  function accept() {
    if (disposed || !job || job.accepted) return;
    job = { ...job, accepted: true };
    if (job.owned && job.kind === 'generate' && !job.seedUpdated) {
      job.seedUpdated = true;
      onAccepted(job);
    }
    publish();
  }
  async function request(path, body) {
    const response = await api.fetchApi(path, body === undefined ? { cache: 'no-store', signal: AbortSignal.timeout(20000) } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || data.error || `请求失败 (${response.status})`);
      error.status = response.status;
      error.rejected = response.status >= 400 && response.status < 500;
      throw error;
    }
    return data;
  }
  function matchesQueue(item) {
    const workflow = item?.[3]?.extra_pnginfo?.workflow;
    const owner = workflow?.nodes?.find((n) => String(n.id) === String(node.id))?.properties?.qwenWorkbench?.ownerId;
    return Boolean(owner && owner === state().ownerId && graphReferencesNode(item[2], item[4], node.id));
  }
  function receive(output, promptId = job?.promptId) {
    if (disposed) return;
    for (const [kind, results] of [['generate', output?.qwen_result], ['upscale', output?.qwen_upscale]]) {
      for (const result of results || []) {
        const key = `${promptId}:${kind}:${JSON.stringify(result)}`;
        if (delivered.has(key)) continue;
        delivered.add(key);
        if (delivered.size > 100) delivered.delete(delivered.values().next().value);
        onResult(kind, result, result.workbenchContext || (job?.promptId === promptId ? job.context : null));
      }
    }
  }
  async function reconcile() {
    if (disposed) return;
    if (checking) return checkingPromise;
    checking = true;
    checkingPromise = (async () => {
      let checkedId = job?.promptId;
      try {
        const observedId = job?.promptId;
        const wasBusy = isJobBusy(job);
        const queue = await request('/queue');
        // A queue response started for an older job must never adopt or mutate a newer submission.
        if (disposed || job?.promptId !== observedId || (wasBusy && !isJobBusy(job))) return;
        const running = queue.queue_running || [], pending = queue.queue_pending || [];
        if (!isJobBusy(job)) {
          const found = [...running, ...pending].find(matchesQueue);
          if (!found) return;
          job = { promptId: found[1], nodeId: String(node.id), kind: 'generate', state: 'queued', submittedAt: Date.now(),
            owned: false, accepted: true, context:structuredClone(found[3]?.extra_pnginfo?.qwen_operation || null),
            snapshot: structuredClone(found[2][String(node.id)]?.inputs || {}) };
        }
        const id = job.promptId;
        checkedId = id;
        const active = running.find((item) => item[1] === id);
        const queued = pending.find((item) => item[1] === id);
        if (active || queued) {
          accept();
          change({ state: job.cancelRequested ? 'cancelling' : active ? 'running' : 'queued' });
          if (job.cancelRequested && !job.cancelUnsupported) await dispatchCancel(id);
          return;
        }
        const history = await request(`/history/${encodeURIComponent(id)}`);
        if (disposed || job?.promptId !== id || !isJobBusy(job)) return;
        if (history[id]) {
          accept();
          for (const [key, output] of Object.entries(history[id].outputs || {})) {
            if (key === String(job.nodeId)) receive(output);
          }
          const status = history[id].status || {};
          const messages = status.messages || [];
          const error = messages.find(([type]) => type === 'execution_error')?.[1];
          const interrupted = messages.some(([type]) => type === 'execution_interrupted');
          change({ state: error ? 'failed' : interrupted ? 'cancelled' : status.completed ? 'completed' : 'failed',
            message: error?.exception_message || (interrupted ? '任务已取消' : status.completed ? '已完成' : '任务未完成') });
        } else if (!submitting && job.cancelRequested) change({ state: 'cancelled', message: '任务已取消' });
        else if (!submitting && Date.now() - job.submittedAt > 10000) {
          // An ambiguous network response is not proof of failure. Require an explicit recovery action.
          change({ state: 'reconciling', missing: true, message: '未找到任务记录，请重查或恢复编辑' });
        }
      } catch (error) {
        if (!disposed && job?.promptId === checkedId && isJobBusy(job)) change({ state: 'reconciling', message: '连接中断，正在核对任务状态' });
      } finally { checking = false; }
    })();
    return checkingPromise;
  }
  async function submit(kind, result, settings, context = {}) {
    if (disposed || isJobBusy(job)) return false;
    submitting = true;
    let requestStarted = false;
    const promptId = crypto.randomUUID();
    job = { promptId, nodeId: String(node.id), kind, resultId: result?.id || null, state: 'submitting',
      submittedAt: Date.now(), owned: true, accepted: false, seedUpdated: false, snapshot: {},
      context: {...JSON.parse(JSON.stringify(context)), operation:context.operation || kind, targetResultId:context.targetResultId || result?.id || null,
        ownerId:state().ownerId, nodeId:String(node.id), promptId} };
    publish();
    try {
      let output, workflow;
      if (kind === 'generate') {
        ({ output, workflow } = await getWorkflow());
        if (disposed || job?.promptId !== promptId) return false;
        if (!output[String(node.id)]) throw Object.assign(new Error('当前节点无法执行，请检查节点模式与输入连接'), { rejected: true });
        job.snapshot = structuredClone(output[String(node.id)].inputs);
        output[String(node.id)].inputs.execution_token = promptId;
        if (job.context.transparentBackground && typeof output[String(node.id)].inputs.prompt === 'string') {
          const prefix = '这是一张带有 Alpha 通道的 RGBA 图像，主体之外的背景透明。';
          output[String(node.id)].inputs.prompt = `${prefix}\n${output[String(node.id)].inputs.prompt}`;
        }
        if (job.context.region) output[String(node.id)].inputs.region_json = JSON.stringify(job.context.region);
        job.seedNext = getSeedNext();
      } else {
        output = { [String(node.id)]: { class_type: 'QwenImage21AutoUpscale', inputs: {
          filename: result.original.filename, subfolder: result.original.subfolder,
          result_id: result.id, scale: settings.scale, quality: settings.quality, execution_token:promptId,
        } } };
        workflow = {};
      }
      if (disposed) return false;
      publish();
      requestStarted = true;
      const response = await request('/prompt', { prompt_id: promptId, prompt: output, client_id: api.clientId || '',
        partial_execution_targets: [String(node.id)], extra_data: { extra_pnginfo: { workflow, qwen_operation:job.context } } });
      if (response.prompt_id && response.prompt_id !== promptId) throw new Error('服务端返回了不同任务编号，请核对队列');
      if (disposed) return true;
      if (job?.promptId !== promptId) return true;
      accept();
      if (job.state === 'submitting') change({ state: 'queued', message: '等待执行' });
      return true;
    } catch (error) {
      if (disposed || job?.promptId !== promptId) return false;
      if (error.rejected || !requestStarted) change({ state: 'failed', message: error.message });
      else change({ state: 'reconciling', message: '提交结果待确认，正在查询队列' });
      return false;
    } finally { if (job?.promptId === promptId) submitting = false; if (isJobBusy(job)) void reconcile(); }
  }
  async function dispatchCancel(id) {
    if (disposed || job?.promptId !== id || !job.owned || job.cancelUnsupported || cancelInFlight === id) return;
    cancelInFlight = id;
    try {
      // This endpoint checks and interrupts under the queue mutex. Legacy /interrupt
      // checks a snapshot outside that mutex and can accidentally interrupt a successor.
      await request(`/api/jobs/${encodeURIComponent(id)}/cancel`, {});
      // cancelled:false is a no-op, not terminal proof; queue/history decide completion.
    } catch (error) {
      if (job?.promptId === id) {
        const unsupported = [404, 405].includes(error.status);
        change({ state: 'reconciling', cancelUnsupported: unsupported,
          message: unsupported ? '服务端不支持安全定向取消；不会使用全局中断，请等待任务结束' : `取消状态待确认：${error.message}` });
      }
    } finally { if (cancelInFlight === id) cancelInFlight = null; }
  }
  async function cancel() {
    if (disposed || !isJobBusy(job) || !job.owned || !job.accepted || ['submitting', 'cancelling'].includes(job.state)) return;
    const id = job.promptId;
    change({ state: 'cancelling', cancelRequested: true, message: '正在取消，请等待后台停止' });
    await dispatchCancel(id);
    await reconcile();
  }
  function listen(type, callback) {
    const listener = (event) => { if (!disposed) callback(type === 'executing' ? event.detail : event.detail || {}); };
    api.addEventListener(type, listener); listeners.push([type, listener]);
  }
  listen('execution_start', (data) => {
    currentExecution = { promptId: data.prompt_id, nodeId: null };
    if (job?.promptId === data.prompt_id) { accept(); change({ state: 'running' }); }
    else void reconcile();
  });
  listen('executing', (data) => {
    // Recent ComfyUI dispatches node ID as detail and exposes runningNodeId; older versions send an object.
    const nodeId = data && typeof data === 'object' ? data.node : data;
    const id = data && typeof data === 'object' ? data.prompt_id : currentExecution?.promptId;
    currentExecution = { promptId: id, nodeId: nodeId == null ? null : String(nodeId) };
  });
  listen('qwen_stage', (data) => {
    if (data.prompt_id !== job?.promptId || String(data.node) !== String(job.nodeId)) return;
    accept();
    change({ state: 'running', stage: data.stage, ...(data.stage === 'sampling' ? { sampleStartedAt: Date.now(), progress: 0 } : {}) });
  });
  listen('progress', (data) => {
    if (!isJobBusy(job)) return;
    if (data.prompt_id ? data.prompt_id !== job.promptId : currentExecution?.promptId !== job.promptId) return;
    if (data.node ? String(data.node) !== String(job.nodeId) : currentExecution?.nodeId !== String(job.nodeId)) return;
    if (job.kind !== 'generate') return;
    const start = job.sampleStartedAt || Date.now();
    const completed = Math.max(0, Number(data.value) || 0), total = Number(data.max) || Number(job.snapshot.steps) || 24;
    change({ state: 'running', stage: 'sampling', sampleStartedAt: start, completedSteps: completed,
      totalSteps: total, progress: completed / total,
      estimatedSeconds: estimateRemaining({ steps: total, completedSteps: completed, sampleElapsedMs: Date.now() - start }) });
  });
  listen('executed', (data) => {
    if (data.prompt_id !== job?.promptId || String(data.node) !== String(job.nodeId)) return;
    accept(); receive(data.output);
  });
  for (const [type, target] of [['execution_success','completed'], ['execution_error','failed'], ['execution_interrupted','cancelled']]) {
    listen(type, (data) => {
      if (data.prompt_id !== job?.promptId) return;
      accept(); change({ state: target, message: data.exception_message || ({completed:'已完成',failed:'执行失败',cancelled:'任务已取消'})[target] });
      // Cached outputs have no executed event; history remains the source of truth.
      if (target === 'completed') void request(`/history/${encodeURIComponent(job.promptId)}`).then((history) => {
        for (const [key, output] of Object.entries(history[data.prompt_id]?.outputs || {})) if (key === String(node.id)) receive(output, data.prompt_id);
      }).catch(() => {});
    });
  }
  listen('promptQueued', () => { void reconcile(); });
  listen('reconnected', () => { void reconcile(); });
  timer = setInterval(() => {
    if (isJobBusy(job)) {
      job.elapsedSeconds = Math.floor((Date.now() - job.submittedAt) / 1000);
      publish();
    }
  }, 1000);
  // Keep queue/history polling independent from the one-second display refresh.
  reconcileTimer = setInterval(() => { if (isJobBusy(job)) void reconcile(); }, 2500);
  publish();
  if (isJobBusy(job)) void reconcile();
  return {
    generate: context => submit('generate',null,null,context), upscale: (result, settings, context) => submit('upscale', result, settings,context), cancel, reconcile,
    async restore() {
      if (disposed) return;
      job = state().activeJob || null;
      submitting = false;
      currentExecution = null;
      delivered.clear();
      publish();
      // Finish any old lookup before starting one for the configured properties.
      // reconcile's promptId fences prevent the old response from changing this job.
      const restoredId = job?.promptId;
      if (checkingPromise && checking) await checkingPromise;
      if (!disposed && job?.promptId === restoredId && isJobBusy(job)) await reconcile();
    },
    getJob: () => job,
    recoverEditing() { if (job?.missing && job.state === 'reconciling') change({ state: 'failed', message: '已恢复编辑；未重新提交任务' }); },
    destroy() { disposed = true; clearInterval(timer); clearInterval(reconcileTimer); for (const [type, listener] of listeners) api.removeEventListener(type, listener); },
  };
}
