import test from "node:test";
import assert from "node:assert/strict";
import { isRefFileDrop, normalizeRefs, moveRef, normalizeLoras, normalizeAccelerators, presetForSteps, resolveInferenceState, hasActiveLora, aspectRatioFromPrompt, shouldApplyPromptRatio } from "../web/panel-state.mjs";
import { promptParts } from "../web/prompt-editor.mjs";

test("saved inline references preserve stable IDs between text fragments", () => {
  assert.deepEqual(promptParts("甲 [[qwen-ref:one]] 乙 [[qwen-ref:two]]"), [
    { text: "甲 " }, { id: "one" }, { text: " 乙 " }, { id: "two" },
  ]);
  assert.deepEqual(promptParts("旧 <image1>"), [{ text: "旧 <image1>" }]);
});

test("one explicit supported ratio auto selects; ambiguity and unsupported values preserve selection", () => {
  assert.equal(aspectRatioFromPrompt("做一张 3：4 竖版海报"), "3:4");
  assert.equal(aspectRatioFromPrompt("16 / 9 广告图"), "16:9");
  assert.equal(aspectRatioFromPrompt("３：４ 构图"), "3:4");
  assert.equal(aspectRatioFromPrompt("3:4，换个说法仍是 3:4"), "3:4");
  assert.equal(aspectRatioFromPrompt("画面 3:4，另备 1:1"), null);
  assert.equal(aspectRatioFromPrompt("画面 3:4 或 2:1"), null);
  assert.equal(aspectRatioFromPrompt("随意构图"), null);
  assert.equal(shouldApplyPromptRatio("auto", null, "3:4", true), true);
  assert.equal(shouldApplyPromptRatio("16:9", null, "3:4", true), false);
  assert.equal(shouldApplyPromptRatio("16:9", "3:4", "3:4"), false);
  assert.equal(shouldApplyPromptRatio("16:9", "3:4", "1:1"), true);
});

test("only image files on the reference panel are claimed", () => {
  const refs = {};
  const lora = {};
  assert.equal(isRefFileDrop(refs, refs, [{ type: "image/png" }]), true);
  assert.equal(isRefFileDrop(lora, refs, [{ type: "image/png" }]), false);
  assert.equal(isRefFileDrop(null, refs, [{ type: "image/png" }]), false);
  assert.equal(isRefFileDrop(refs, refs, [{ type: "application/json" }]), false);
  assert.equal(isRefFileDrop(refs, refs, []), false);
});

test("LoRA state preserves zero strength and old rows default to enabled", () => {
  assert.deepEqual(normalizeLoras('[{"name":"a","strength":0},{"name":"b","strength":2,"enabled":false}]'), [
    { name: "a", strength: 0, enabled: true }, { name: "b", strength: 2, enabled: false },
  ]);
});

test("base model presets exclude active Viggle Turbo and preserve custom steps", () => {
  assert.deepEqual([18, 24, 40, 23].map((steps) => presetForSteps(steps)), ["快速", "均衡", "精细", "自定义"]);
  assert.equal(presetForSteps(18, [{ name: "Viggle-Turbo.safetensors", enabled: true }]), "turbo-incompatible");
  assert.equal(presetForSteps(18, [{ name: "Viggle-Turbo.safetensors", enabled: false }]), "快速");
});

test("accelerator defaults and card state allow disable or remove", () => {
  const old = normalizeAccelerators("", { enable_te_speed: false, cache_device: "cpu" });
  assert.deepEqual(old.map((item) => [item.type, item.enabled]), [["te_speed", false], ["kv_cache", true]]);
  const newer = normalizeAccelerators('[{"type":"kv_cache","enabled":false},{"type":"kv_cache"},{"type":"unknown"}]');
  assert.deepEqual(newer.map((item) => [item.type, item.enabled]), [["kv_cache", false]]);
});

test("old references gain stable unique identities and preserve annotated type", () => {
  let nextId = 0;
  const refs = normalizeRefs('["a.png",{"name":"b.png [output]"},{"id":"keep","name":"c.png"},{"id":"keep","name":"d.png"}]', () => `ref-${++nextId}`);
  assert.deepEqual(refs.map((item) => item.name), ["a.png", "b.png", "c.png", "d.png"]);
  assert.deepEqual(refs.map((item) => item.type), ["input", "output", "input", "input"]);
  assert.equal(refs[2].id, "keep");
  assert.equal(new Set(refs.map((item) => item.id)).size, 4);
});

test("moving a reference changes order without changing its identity", () => {
  let nextId = 0;
  const original = normalizeRefs('[{"name":"a.png"},{"name":"b.png"},{"name":"c.png"}]', () => `ref-${++nextId}`);
  const moved = moveRef(original, 0, 2);
  assert.deepEqual(moved.map((item) => item.name), ["b.png", "c.png", "a.png"]);
  assert.equal(moved[2].id, original[0].id);
  assert.deepEqual(original.map((item) => item.name), ["a.png", "b.png", "c.png"]);
});

test("inference migration preserves old values and explicit new custom mode", () => {
  assert.deepEqual(resolveInferenceState({steps:18,mode:"均衡",loras:[],event:"load",version:0}), {steps:18,mode:"快速"});
  assert.deepEqual(resolveInferenceState({steps:24,mode:"自定义",loras:[],event:"load",version:1}), {steps:24,mode:"自定义"});
  assert.deepEqual(resolveInferenceState({steps:12,mode:"快速",loras:[],event:"load",version:0}), {steps:12,mode:"自定义"});
  assert.deepEqual(resolveInferenceState({steps:31,mode:"快速",event:"preset-select"}), {steps:18,mode:"快速"});
  assert.deepEqual(resolveInferenceState({steps:24,mode:"快速",event:"steps-change"}), {steps:24,mode:"自定义"});
});

test("active LoRA switches to custom without changing steps or switching back", () => {
  const loras = [{name:"a.safetensors",enabled:true,strength:1}];
  assert.deepEqual(resolveInferenceState({steps:24,mode:"均衡",loras,event:"lora-change"}), {steps:24,mode:"自定义"});
  assert.equal(resolveInferenceState({steps:24,mode:"自定义",loras:[],event:"lora-change"}).mode,"自定义");
  for (const item of [{name:"",strength:1},{name:"a",strength:0},{name:"a",enabled:false}]) {
    assert.equal(hasActiveLora([item]), false);
    assert.equal(resolveInferenceState({steps:24,mode:"均衡",loras:[item],event:"lora-change"}).mode,"均衡");
  }
  assert.equal(hasActiveLora(loras), true);
  assert.equal(presetForSteps(24,[{name:"Viggle-Turbo",strength:0}]),"均衡");
});
