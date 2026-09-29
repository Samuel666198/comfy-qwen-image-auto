export function isRefFileDrop(panel, refPanel, files) {
  return Boolean(panel && panel === refPanel && files.some((file) => file.type?.startsWith("image/")));
}

export function normalizeRefs(raw, newId = () => crypto.randomUUID()) {
  let source;
  try { source = typeof raw === "string" ? JSON.parse(raw || "[]") : raw; }
  catch { source = []; }
  if (!Array.isArray(source)) return [];
  const seen = new Set();
  return source.map((entry) => {
    let name = typeof entry === "string" ? entry : String(entry?.name ?? "");
    let type = typeof entry === "object" && entry?.type ? entry.type : "input";
    const annotated = /^(.*?)\s*\[(input|output|temp)\]\s*$/.exec(name);
    if (annotated) { name = annotated[1]; type = annotated[2]; }
    if (!name) return null;
    let id = typeof entry === "object" && typeof entry?.id === "string" ? entry.id : "";
    if (!id || seen.has(id)) id = newId();
    seen.add(id);
    const source = typeof entry === 'object' ? entry : {};
    return { id, name, type, ...(source.sourceResultId ? {sourceResultId:source.sourceResultId,sourceVersionId:source.sourceVersionId} : {}) };
  }).filter(Boolean);
}

export function moveRef(items, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) ||
      from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return [...items];
  const result = [...items];
  result.splice(to, 0, result.splice(from, 1)[0]);
  return result;
}

const SUPPORTED_RATIOS = new Set(["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"]);

export function aspectRatioFromPrompt(prompt) {
  const found = new Set();
  const normalized = String(prompt || "").replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
  // Include unsupported ratios in the ambiguity check. A prompt asking for
  // both 3:4 and 2:1 must never silently pick the supported one.
  for (const match of normalized.matchAll(/(?<!\d)(\d{1,2})\s*[:：/／]\s*(\d{1,2})(?!\d)/g)) {
    found.add(`${Number(match[1])}:${Number(match[2])}`);
  }
  return found.size === 1 && SUPPORTED_RATIOS.has([...found][0]) ? [...found][0] : null;
}

export function shouldApplyPromptRatio(currentAspect, previousDetected, nextDetected, initial = false) {
  if (!nextDetected) return false;
  if (initial) return currentAspect === "auto";
  return nextDetected !== previousDetected;
}

export function normalizeLoras(raw) {
  let source;
  try { source = typeof raw === "string" ? JSON.parse(raw || "[]") : raw; }
  catch { source = []; }
  if (!Array.isArray(source)) return [];
  return source.filter((item) => item && typeof item === "object").map((item) => {
    const strength = Number(item.strength ?? item.lora_strength ?? 1);
    return {
      name: String(item.name ?? item.lora_name ?? "").trim(),
      strength: Number.isFinite(strength) ? strength : 1,
      enabled: item.enabled !== false,
    };
  });
}

const PRESET_STEPS = { 快速: 18, 均衡: 24, 精细: 40 };

function activeLoras(raw) {
  return normalizeLoras(raw).filter((item) => item.enabled && item.strength !== 0 && item.name && item.name !== "None");
}

export function hasActiveLora(loras = []) {
  return activeLoras(loras).length > 0;
}

export function presetForSteps(steps, loras = []) {
  if (activeLoras(loras).some((item) => /viggle.*turbo|turbo.*viggle/i.test(item.name))) return "turbo-incompatible";
  return Object.keys(PRESET_STEPS).find((mode) => PRESET_STEPS[mode] === Number(steps)) || "自定义";
}

export function resolveInferenceState({ steps, mode, loras = [], event = "load", version = 1 }) {
  if (event === "preset-select") return { steps: PRESET_STEPS[mode] ?? steps, mode: PRESET_STEPS[mode] ? mode : "自定义" };
  if (event === "steps-change" || hasActiveLora(loras)) return { steps, mode: "自定义" };
  if (event === "load") return { steps, mode: version >= 1 && mode === "自定义" ? mode : presetForSteps(steps) };
  return { steps, mode };
}

export function normalizeAccelerators(raw, legacy = {}) {
  let source;
  try { source = typeof raw === "string" && raw !== "" ? JSON.parse(raw) : raw; }
  catch { source = null; }
  if (!Array.isArray(source)) {
    source = [
      { type: "te_speed", enabled: legacy.enable_te_speed !== false, config: {
        attention: legacy.te_attention ?? "kitchen_int8", step_cache: legacy.te_step_cache ?? "te_predictor",
        reuse_threshold: legacy.te_reuse_threshold ?? 0.06, predictor_error_limit: legacy.te_predictor_error_limit ?? 0.08,
      } },
      { type: "kv_cache", enabled: true, config: { device: legacy.cache_device ?? "cpu", dtype: legacy.cache_dtype ?? "int8" } },
    ];
  }
  const seen = new Set();
  return source.filter((item) => {
    if (!item || !["te_speed", "kv_cache"].includes(item.type) || seen.has(item.type)) return false;
    seen.add(item.type); return true;
  }).map((item) => ({ type: item.type, enabled: item.enabled !== false, config: { ...(item.config || {}) } }));
}
