# Qwen Image 2.1 面板下一轮更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户审阅本计划后再开始功能代码修改。

**Goal:** 修正参考图拖入时重复创建图片节点，并把参考图顺序、可禁用组件和推理强度预设整合为简洁且兼容旧工作流的单节点界面。

**Architecture:** 保留 `QwenImage21Auto` 的单节点后端和现有模型链路。前端用小型纯状态模块处理参考图顺序、LoRA 状态和预设；后端用独立纯解析模块处理新旧 JSON。交互仍在现有 Vue legacy widget 中绘制，新增参数只作兼容与状态保存，不重建整套 UI。

**Tech Stack:** ComfyUI 前端 1.53.6、JavaScript ES modules、Python 3.12、Node 24 内置 `node:test`、Python 内置 `unittest`。当前 ComfyUI venv 没有 pytest；本目录不是 Git 仓库，执行阶段不得假称有提交记录。

**Spec:** [2026-09-25-qwen-panel-update-design.md](../specs/2026-09-25-qwen-panel-update-design.md)

**执行记录（2026-09-25）：** 核心代码和兼容性修改已完成；Node/Python 测试及独立端口 UI 保存重开通过。下方复选框保留原计划文本，不代表逐项验收结论。原生文件拖入、实际模型采样及 TE-speed 生效仍未验证，详见项目根目录 `HANDOFF.md`。

## Global Constraints

- 保留现有 `prompt`、`refs_json`、`lora_json`、`enable_te_speed` 和模型注入端口的旧工作流含义。
- 本轮只支持 TE-speed 与 Qwen KV 缓存两类加速卡片，每类最多一张；执行顺序仍为 LoRA → TE-speed → KV 缓存。
- 参考图最多 10 张；`refs_json` 数组顺序决定 `image_1`…`image_10`。`@` 联想/富文本编辑属于后续独立更新。
- 基础模型预设的首版步数为快速 12、均衡 18、精细 40；Turbo LoRA 活跃时不得套用这三档。
- 不额外安装测试依赖，不改 ComfyUI 核心文件，不运行模型生成来替代交互验证。
- 开始实施前，把将改的文件复制到 `<WORKSPACE_TMP>\qwen-panel-update-backup\` 并记录 SHA-256；该目录不能放入 `custom_nodes`，避免插件重复加载。

## File Map

- 修改 `web/QwenImage21Auto.js`：拖放事件、缩略图排序、LoRA/加速卡片、折叠布局与预设控件。
- 新建 `web/panel-state.mjs`：纯函数 `isRefFileDrop`、`normalizeRefs`、`moveRef`、`normalizeLoras`、`presetForSteps` 和加速卡片校验；不得访问 DOM 或 ComfyUI 全局对象。
- 修改 `nodes.py`：增加可选输入、使用纯解析结果、跳过禁用组件并保留旧字段回退。
- 新建 `panel_config.py`：`parse_lora_rows`、`resolve_accelerators` 等纯 Python 兼容解析函数。
- 新建 `tests/panel-state.test.mjs` 与 `tests/test_panel_config.py`：行为回归，不镜像渲染代码。
- 更新 `README.md`、`HANDOFF.md`：最终交互、兼容约束、实际验证和剩余限制。

---

### Task 1: 阻止参考图拖入后生成额外节点

**Files:** 修改 `web/QwenImage21Auto.js:471-501`；新建 `web/panel-state.mjs` 和 `tests/panel-state.test.mjs` 中的事件路由用例。

**Interfaces:** 输入为浏览器 `DragEvent` 和当前参考图 panel 的 canvas；输出为仅在面板内且含图片文件时同步接管的事件，上传仍异步进行。

- [ ] 用两个监听器的模拟测试复现：ComfyUI 的 document 冒泡监听会在扩展后调用时看到 `defaultPrevented=false`，从而创建图片节点。
- [ ] 把参考图 `dragover` 与 `drop` 的命中判断移到 document 捕获阶段。`dragover` 用 `dataTransfer.items` 判断图片类型（此时 `files` 可能为空），`drop` 用 `dataTransfer.files` 核实文件；确认目标与可用槽位后立即 `preventDefault()`、`stopPropagation()`，然后才开始 `await` 上传。面板外和非图片 drop 不拦截。

```js
export function isRefFileDrop(panel, refPanel, files) {
  return panel === refPanel &&
    files.some((file) => file.type.startsWith("image/"));
}
document.addEventListener("drop", onRefDrop, { capture: true });
// onRefDrop: 先从 DOM/画布坐标得到 panel；命中后同步消费事件，再异步 upload。
```

- [ ] 测试先失败再通过：面板内事件 `defaultPrevented=true`、ComfyUI 模拟监听未创建节点；面板外、LoRA 面板及非图片仍交给原处理器。
- [ ] 在真实页面分别拖入图片到参考图区域和空白画布；前者仅新增一张缩略图，后者保留 ComfyUI 原行为。记录节点数与 `refs_json`，上传失败显示界面错误且不写入假条目。

### Task 2: 参考图稳定身份与排序

**Files:** 新建 `web/panel-state.mjs`；修改 `web/QwenImage21Auto.js:142-295`；测试 `tests/panel-state.test.mjs`。

**Interfaces:** `normalizeRefs(raw, newId)` 返回 `[{id,name,type}]`；`moveRef(items, from, to)` 返回新数组。后端仍读取 `name`，不依赖 `id`。

- [ ] 先写测试：旧字符串与 `{name}` 读取后有唯一 ID；新 `{id,name}` 保留 ID；排序只换数组位置；替换图片保留目标 ID；删除仅移除目标项；10 张上限不变。

```js
let nextId = 0;
const old = normalizeRefs('[{"name":"a.png"},{"name":"b.png"}]', () => `ref-${++nextId}`);
const moved = moveRef(old, 0, 1);
assert.equal(moved[1].id, old[0].id);
assert.deepEqual(moved.map((item) => item.name), ["b.png", "a.png"]);
```

- [ ] 在参考图缩略图显示 ①–⑩ 和明确的拖动把手；把手负责排序，点击图片仍替换，× 仍删除。排序过程中不触发文件选择器或外部文件上传。提供可点的左/右移动按钮作为不方便拖动时的替代操作。
- [ ] `refs_json` 保存 `{id,name}`，兼容已有的 `name [type]` 标注；节点重新加载后顺序和 ID 不变。未来 `@` 引用以 ID 为基础，本任务不更改 prompt。
- [ ] 运行 Node 测试并在真实页面做 3 张图的排序、替换、删除、保存/重开验证；核对后端图片槽位顺序。

### Task 3: LoRA 单行禁用与强度 0

**Files:** 新建 `panel_config.py`；修改 `nodes.py:294-312`、`web/QwenImage21Auto.js:299-469`；测试 `tests/test_panel_config.py` 和 `tests/panel-state.test.mjs`。

**Interfaces:** `parse_lora_rows(raw)` 返回含 `name:str`、`strength:float`、`enabled:bool` 的行；旧行没有 `enabled` 时返回 `true`。前端 `normalizeLoras(raw)` 同样默认启用。

- [ ] 先写 Python/Node 回归：旧 JSON 仍启用；`enabled:false` 保留名字与强度并跳过加载；强度 `0` 保持 `0`；非法数值不导致整个节点崩溃。

```python
rows = parse_lora_rows('[{"name":"a.safetensors","strength":0,"enabled":false}]')
assert rows[0]["strength"] == 0.0
assert rows[0]["enabled"] is False
```

- [ ] 前端行增加启用开关；禁用变灰但文件和强度可保留，删除才移除。`lora_json` 序列化新增 `enabled`。
- [ ] 后端先检查 `enabled` 再加载 LoRA；把 `float(value or 1.0)` 改为能保留 0 的显式解析，并在 status 中区分“已禁用”和“加载失败”。
- [ ] 测试脚本和真实页面：开关往返、0 强度、删除、保存/重开均一致。

### Task 4: TE-speed 与 KV 缓存卡片

**Files:** 修改 `nodes.py:175-232,314-337`、`web/QwenImage21Auto.js`；扩展 `panel_config.py`；测试两个测试文件。

**Interfaces:** 新可选 `accel_json` 默认 `""`；空字符串沿用旧 `enable_te_speed` / `cache_device` 等输入。非空 JSON 为 `[{type:"te_speed"|"kv_cache",enabled:boolean,config:{...}}]`，每种最多一个。

- [ ] 先写旧工作流回退、卡片禁用、移除、未知类型、重复类型、TE-speed 未安装的测试。未知/重复项跳过并记录 status，不执行意外节点。

```python
cards = resolve_accelerators('', enable_te_speed=True,
                             cache_device='cpu', cache_dtype='int8')
assert [card['type'] for card in cards] == ['te_speed', 'kv_cache']
```

- [ ] 前端显示“＋ 添加组件”，候选只有尚未添加的 TE-speed / KV 缓存；每卡可启用、禁用、展开设置、移除。禁用保留配置；移除后仍可重新添加。旧工作流按旧字段生成初始卡片。
- [ ] 后端解析新卡片后按固定顺序应用；TE-speed 未安装或调用失败写入 status，界面不得把“请求启用”误写为“已生效”。KV 卡片禁用/移除时跳过其执行。
- [ ] 在真实页面验证卡片操作和 `accel_json` 重开；不因组件是否安装而改变卡片数据。

### Task 5: 推理强度预设与紧凑布局

**Files:** 修改 `nodes.py:208-248`、`web/QwenImage21Auto.js:505-614`；扩展 `web/panel-state.mjs` 和 Node 测试；更新 `README.md`。

**Interfaces:** `presetForSteps(steps, activeLoras)` 返回 `"快速"|"均衡"|"精细"|"自定义"|"turbo-incompatible"`。可选 `inference_preset` 只保存 UI 选择，实际执行参数仍是已有 `steps` 等字段。

- [ ] 先写测试：12/18/40 映射三档；手动改为其他步数显示自定义；旧工作流步骤值不被重写；禁用 Turbo LoRA 不触发限制，启用已识别的 Viggle Turbo 时禁止套普通三档并显示专用采样提示。
- [ ] 默认布局按设计文档排序。提示词、参考图、画幅/尺寸、推理强度、LoRA、加速组件常显；模型、种子、CFG、降噪、负面词、采样器和缓存细节折叠，摘要显示非默认值与外部模型输入。
- [ ] `inference_preset` 仅保存选择；点击档位设置 `steps` 为 12/18/40，不改 CFG、采样器或降噪。手动改步数后标记自定义；改其他独立高级参数只更新摘要。加载旧工作流时依据现有步数显示档位，不自动改数值。
- [ ] 有参考图时主界面显示“跟随参考图”；无参考图时显示文生图比例与尺寸。自定义宽高和自定义负面词保留现有条件显示逻辑。
- [ ] 页面验证常见节点缩放比例、展开/收起、条件字段、预设切换和重开；三档实际图像与耗时如果未跑，文案只描述参数倾向并在交接记录未验收。

### Task 6: 集成验收与交接

**Files:** 更新 `README.md`、`HANDOFF.md`；必要时修正上述测试文件。

- [ ] 使用 Node 24 执行 `node --test tests/panel-state.test.mjs`；使用 ComfyUI Python 3.12 执行 `python -m unittest discover -s tests -p 'test_*.py'`，不安装 pytest。用 `node --input-type=module --check` 检查扩展 JS 语法。
- [ ] 新开 ComfyUI 页面加载最新脚本，核对无 LegacyWidget 初始化错误；测试参考图拖入后没有额外图片节点、排序与 `refs_json`，LoRA 禁用/0 强度，TE/KV 卡片状态，预设切换与折叠。
- [ ] 保存一份测试工作流并重新打开，核对旧工作流和新工作流数据。测试图片只用新建的无敏感样本；清理前核对确切路径和哈希，若自动审批阻止则保留并在交接中写明。
- [ ] 更新文档为实际结果，逐项标出通过、未验证与失败；将备份位置、回退操作和实际新增文件写进 `HANDOFF.md`。本目录非 Git 仓库，不执行或声称 Git commit。

## 停止点与回退

每个 Task 完成后保留可运行节点；若新 schema 导致旧工作流丢值，停止后续任务，先修兼容。若必须回退，用开始时备份的原文件按路径恢复，删除本轮新建的模块/测试前先确认它们确由本轮创建，并重开页面验证原面板。真正的模型出图和 Turbo 专用 sigma 链路不属于本轮完成声明。
