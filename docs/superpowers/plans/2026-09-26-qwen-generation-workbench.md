# Qwen 创作面板下一轮更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已批准实施。下列为原始分步计划，完成状态以执行记录为准；混合验收项未全部实测的不整项勾选。

**Goal:** 交付包含悬浮参数、参考图输入、历史预览、定向生成/取消和RTX超分的单节点创作面板。

**Architecture:** 保留现有Python节点与输入/输出契约；将新交互按浮层、任务状态、结果预览拆成小型ES模块。生成与超分均复用ComfyUI任务队列，按prompt_id关联事件，结果文件持久化到output目录。

**Tech Stack:** Python、ComfyUI节点与HTTP/WebSocket API、原生JavaScript ES模块、现有DOM widget、Node内置测试、Python unittest、本地RTXVideoSuperResolution。

**Spec:** [已确认设计](../specs/2026-09-26-qwen-generation-workbench-design.md)

## 执行记录（2026-09-26）

- [x] Task 1～7 的功能模块、后端输出、队列与 RTX 集成完成，保留已有接口。
- [x] Task 8：自动回归检查 Node 35 项、Python 12 项通过；文档已更新。
- [x] 实际生图 18 步、1024×1024、seed100；递增后 101，RTX 不改变种子。
- [x] 实际 RTX 2 倍 ULTRA：2048×2048；保留原图和快照。
- [x] 双节点排队取消不影响另一运行任务，运行取消后解锁。
- [x] 保存重开、重新配置、重命名、下载、放大查看、合成拖放实测通过。
- [ ] 原生操作系统拖放、4K/高倍率显存实测；这两项不作为已验证声明。

验证命令中的 Python 使用 ComfyUI 的 `.venv/Scripts/python.exe`，因为测试依赖 torch。完整现场、备份和产物路径见根目录 HANDOFF.md。下方保留原实施检查项，不把尚未执行的全部浏览器组合验收标为通过。

## Global Constraints

- 用户已批准；功能实施完成。实际验证与剩余限制见下方执行记录。
- 不修改ComfyUI核心、不新增前端框架、不启动新的常驻服务。
- 保留输入字段与旧widgets_values顺序；新字段追加；image/model/latent/status输出顺序不变。
- 快速18步、均衡24步、精细40步、自定义1～200步；旧文件实际步数不变。
- 种子置于常用参数面板：数值输入加固定/随机/递增值/递减值，复用seed与control_after_generate，不另建重复字段。
- 1K/2K/4K对应1024²/2048²/4096²总像素预算。
- RTX倍率为1～4整数，默认2；档位LOW/MEDIUM/HIGH/ULTRA，默认ULTRA。
- 原图保留，最近10次成功生图保留历史引用；不自动删除磁盘文件。
- 严禁无prompt_id全局interrupt和清空全队列；取消只针对本节点发起的任务。
- 不改变负面词CFG规则、@图片身份规则、KV显式off与KV先于TE-speed的顺序。
- 当前目录无Git仓库；做文件备份并记录变更，不执行虚构的commit步骤。

## 文件职责

根目录：`ComfyUI\custom_nodes\comfy_qwen_image_auto`。以下路径均相对此目录。

| 文件 | 工作内容 |
|---|---|
| `nodes.py` | 新默认步数、追加RTX输入、保存原图与结果UI数据，保留原输出元组 |
| `__init__.py` | 注册内部RTX后处理节点；不添加独立HTTP GPU执行服务 |
| `result_nodes.py`（新） | 读取已保存原图、调用现有RTX节点、保存超分结果 |
| `web/QwenImage21Auto.js` | 布局编排、旧字段映射、交互锁、事件连接与资源清理 |
| `web/panel-state.mjs` | 预设与LoRA状态规则；复用既有比例和引用解析 |
| `web/prompt-editor.mjs` | 拖图区、缩略图入口、禁用状态和已有@标签兼容 |
| `web/parameter-popover.mjs`（新） | 常用/高级浮层定位、控件、键盘行为与关闭清理 |
| `web/generation-controller.mjs`（新） | 队列提交、定向取消、事件归属、恢复与预计时间 |
| `web/result-preview.mjs`（新） | 历史、重命名、大图、工具栏、生成动画与下载 |
| `tests/panel-state.test.mjs` | 扩展已有预设/参考图回归 |
| `tests/generation-controller.test.mjs`（新） | 任务状态、重复点击、取消竞态与时间估算 |
| `tests/result-state.test.mjs`（新） | 历史快照、版本、重命名与淘汰规则 |
| `tests/test_result_nodes.py`（新） | 文件路径边界、RTX参数校验、输出结构 |
| `README.md`、`HANDOFF.md` | 用户说明、实测结果、剩余限制与下一步 |

## 数据契约

新增Python可选输入追加于旧字段之后：`rtx_scale: INT(default=2,min=1,max=4,step=1)`、`rtx_quality: COMBO(default=ULTRA)`。仅作为超分设置保存，不影响原图采样。

```js
// 节点properties.qwenWorkbench；图片文件由ComfyUI /view读取。
const workbench = {
  version: 1,
  history: [],
  selectedResultId: null,
  activeJob: null,
};
// history中的每项
const result = {
  id: "UUID", title: "作品名称", createdAt: 0,
  original: { filename: "image.png", subfolder: "qwen_auto", type: "output", width: 0, height: 0 },
  upscaled: null, // 同original文件结构，另存scale、quality；新超分替换显示引用，保留磁盘文件
  selectedVersion: "original",
  snapshot: {}, // 本次实际prompt、参考图ID/文件、steps、cfg、seed、模型、LoRA、画幅等
};
// 活动任务
const job = {
  promptId: "UUID", nodeId: "14", kind: "generate", // 或upscale
  resultId: null, state: "submitting", submittedAt: 0, snapshot: {},
};
```

快照不可引用正在编辑的对象。服务端返回实际seed、尺寸和参数，前端以它们为准；不要使用生成结束后已自动递增的seed控件值。

## Task 1：现场备份、预设与兼容状态

**Files:** `nodes.py`、`web/panel-state.mjs`、`web/QwenImage21Auto.js`、`tests/panel-state.test.mjs`。

**Interfaces:** `resolveInferenceState({steps, mode, loras, event, version=1}) -> {steps, mode}`；event取load、steps-change、preset-select、lora-change。旧节点没有workbench.version时传version=0；新版传1，明确区分旧字段迁移与本轮保存的自定义模式。

- [ ] 读取本计划与设计；检查最新文件和用户未完成修改，备份受影响文件到`<WORKSPACE_TMP>\qwen-workbench-backup-20260926\`，记录文件清单。
- [ ] 先加入回归用例并确认新规则尚未满足：

```js
assert.deepEqual(resolveInferenceState({steps: 18, mode: "均衡", loras: [], event: "load", version:0}), {steps: 18, mode: "快速"});
assert.deepEqual(resolveInferenceState({steps: 24, mode: "自定义", loras: [], event: "load", version:1}), {steps: 24, mode: "自定义"});
assert.deepEqual(resolveInferenceState({steps: 24, mode: "均衡", loras: [{name:"a.safetensors",enabled:true,strength:1}], event:"lora-change"}), {steps:24, mode:"自定义"});
assert.equal(resolveInferenceState({steps:24,mode:"自定义",loras:[],event:"lora-change"}).mode,"自定义");
```

- [ ] 实现18/24/40映射、自定义输入与LoRA事件切换；新增节点默认24，旧实际steps不得重写。使用properties.qwenWorkbench.version识别新模式，避免新自定义24在重开后被改为均衡。
- [ ] 追加RTX输入与schemaWidgetNames，禁止插入旧字段中间。强度0/禁用/空行不触发LoRA自动切换。
- [ ] 运行`node --test tests/panel-state.test.mjs`，检查旧工作流位置式值恢复。

## Task 2：常用和高级悬浮面板

**Files:** `web/parameter-popover.mjs`、`web/QwenImage21Auto.js`。

**Interfaces:** `createParameterPopover({anchor, getValues, setValue, isLocked, kind}) -> {open, close, destroy}`；kind为common或advanced。setValue必须写入既有widget并触发其联动回调。

- [ ] 将现有参数widget作为唯一值源；浮层控件通过适配器读写，不维护第二套参数状态。

```js
function setWidgetValue(widget, value) {
  widget.value = value;
  widget.callback?.(value, app.canvas, node);
}
```

- [ ] 常用浮层实现比例、1K/2K/4K、18/24/40/自定义、种子数值与四种模式、负面词与RTX倍率/档位；自定义比例显示宽高，负面词自定义显示输入框。
- [ ] 种子模式映射固定→fixed、随机→randomize、递增值→increment、递减值→decrement，读写现有control_after_generate。输入遵循当前ComfyUI widget有效范围与整数精度；不得把超出JavaScript安全整数范围的文本静默舍入。工作流载入保留原数值与模式。
- [ ] 高级浮层迁移模型/CFG/采样器/调度器/重绘；种子不重复出现。隐藏旧展开区域，保持原字段序列化。明确自定义宽高优先于像素预算。
- [ ] 使用fixed定位、边缘避让、内部滚动、Esc/点击外部关闭、焦点返回；画布移动或缩放时重新定位或关闭，禁止浮层点击穿透到节点拖动。
- [ ] 浏览器检查窄窗口、不同画布缩放、输入中文、切换面板；开关浮层不改变节点高度，节点移除后无残留浮层或监听器。

## Task 3：参考图拖入提示词区

**Files:** `web/prompt-editor.mjs`、`web/QwenImage21Auto.js`、`tests/panel-state.test.mjs`。

**Interfaces:** 扩展编辑器返回对象：`setDisabled(boolean)`、`getDropElement()`；沿用现有refsPanel.items、sync、上传和normalizeRefs，不另建参考图数据源。

- [ ] 增加输入区命中、锁定拒绝和一次拖放只上传一次的回归场景。
- [ ] 缩略图移至输入框上方；保留编号、删除、排序、替换和@引用更新。拖入图片只追加引用，不插入图片二进制到contenteditable。
- [ ] 在有效区域捕获文件drop并立即阻止默认ComfyUI处理，然后复用上传；锁定时也阻止图片drop冒泡产生额外节点，但不上传。
- [ ] 验证拖入输入文字上、空白区、缩略图上各只新增一次引用；文字不丢失、无额外节点、区域外原有拖图行为保持。
- [ ] 用原生文件拖放和中文输入法验证；合成事件不能作为原生拖放验收的替代。

## Task 4：持久结果、参数快照与历史预览

**Files:** `nodes.py`、`web/result-preview.mjs`、`web/QwenImage21Auto.js`、`tests/result-state.test.mjs`。

**Interfaces:** `createResultPreview({getState, updateState, onUpscale}) -> {element, render, setJob, destroy}`；`appendResult(history,result,limit=10)`返回新数组。

- [ ] 测试不可变快照、最多10项、失败不新增、重命名不改文件地址，以及原图/超分版本选择。

```js
const next = appendResult(Array.from({length:10}, (_,i)=>({id:String(i)})), {id:"new"}, 10);
assert.equal(next.length,10);
assert.equal(next.at(-1).id,"new");
```

- [ ] 复用核心SaveImage保存到`output/qwen_auto/`并返回`{ui:{images, qwen_result}, result:(image, model, latent, status)}`；注册为可独立执行的输出节点。保留原输出语义，不借本轮修正无关latent问题。
- [ ] 补充非widget隐藏输入以接收完整prompt/extra_pnginfo/unique_id，使用不与现有prompt文本重名的参数名。生成记录由实际执行参数组成；只有保存成功才返回成功结果。
- [ ] 内置预览消费qwen_result，抑制该节点重复出现ComfyUI默认图片预览。其他节点不受影响。
- [ ] 实现完整图片预览、名称编辑、参数摘要/详情、历史箭头、缺失文件状态、下载当前版本及大图查看器。安全处理名称为文本，下载名过滤路径字符。
- [ ] 历史放node.properties；保存重开恢复，移除历史引用不删文件。确认复制节点不继承活动任务控制状态。

## Task 5：定向生成、取消与恢复

**Files:** `web/generation-controller.mjs`、`web/QwenImage21Auto.js`、`tests/generation-controller.test.mjs`。

**Interfaces:** `createGenerationController({node, api, getWorkflow, onState, onResult}) -> {generate, upscale, cancel, reconcile, destroy}`；`transitionJob(job,event)`作为纯状态转换函数导出用于测试。

- [ ] 先测试重复点击只提交一次、错误任务事件不解锁、取消等待后台确认、提交超时不重复提交、取消与完成竞态不丢结果。
- [ ] 使用当前前端graphToPrompt与seed生成前后生命周期；定向请求协议为：

```js
const body = {
  prompt_id: crypto.randomUUID(),
  prompt: apiWorkflow,
  client_id: clientId,
  partial_execution_targets: [String(node.id)],
  extra_data: {extra_pnginfo: {workflow: savedWorkflow}},
};
// POST /prompt；读取返回prompt_id与node_errors。
// 取消：POST /api/jobs/{promptId}/cancel {}，使用核心原子取消。
// 禁止回退旧的 queue + interrupt 方案（存在竞态）；随后查询 queue/history 确认。
```

- [ ] 种子生命周期必须统一：当前seed进入本次API快照，成功入队后调用现有种子更新机制准备下次值。固定不变、随机抽取、递增1、递减1，边界沿用核心规则。不得既调用核心生命周期又手动更新，导致双重递增。提交失败不更新；不明确的提交先按prompt_id核对再更新一次；已入队取消/执行失败不回退；超分不更新生图seed。
- [ ] 增加具体回归场景：seed=100固定提交后仍100；递增提交使用100、下次101；递减使用100、下次99；随机模式以可控随机源验证范围与单次调用，不要求随机值必定不同；提交失败保持100；重连确认同一prompt_id不重复递增；超分不改变seed。另检验上下边界行为与当前核心一致。

- [ ] 只监听匹配prompt_id的事件；progress若缺少prompt_id，必须先依据executing与当前执行节点确认归属。事件交错不能改变其他节点状态。
- [ ] 任务状态：idle → submitting → queued → running → completed/failed；queued/running → cancelling → cancelled或完成。网络不明确时进入reconciling并保留锁定，不以HTTP成功代表任务已取消。
- [ ] 锁定提示词、缩略图、浮层、LoRA、TE/KV、RTX与生成入口；生成按钮外的ComfyUI全局提交若包含本节点，也要识别事件和同步锁定。UI锁不声称能够阻止外部API修改。
- [ ] onConfigure、WebSocket重连时对照queue/history恢复；无任务且无结果时显示任务状态已丢失并允许用户明确恢复编辑，不能永久锁死。destroy只清理监听，不隐式取消后台任务。
- [ ] 双节点实测：A运行B排队，取消B不影响A；A完成边缘取消不得误停下一任务。若目标ComfyUI版本不支持定向取消，明确报不支持，禁止回退全局interrupt。

## Task 6：生成动画与预计时间

**Files:** `web/generation-controller.mjs`、`web/result-preview.mjs`、`tests/generation-controller.test.mjs`。

**Interfaces:** `estimateRemaining({steps, completedSteps, sampleElapsedMs}) -> number`（秒）；预览setJob接收stage、progress、estimatedSeconds、locked。

- [ ] 为初始18步54秒、24步72秒、40步120秒，及实际速度更新编写测试。

```js
assert.equal(estimateRemaining({steps:24,completedSteps:0,sampleElapsedMs:0}),72);
assert.equal(estimateRemaining({steps:24,completedSteps:6,sampleElapsedMs:24000}),72);
```

- [ ] 初始使用3秒/步；有实际采样进度后使用每步实测耗时的平滑值。采样开始时间不能从排队提交时间计算。
- [ ] 必要时后端用ComfyUI现有消息通道发送带任务归属的load/encode/sample/decode/save阶段，避免在同一个封装节点里错误推断阶段。
- [ ] 预览显示流动光影、步骤进度和“约剩余”；无结果时占位，有旧结果时保留历史。等待/加载/解码显示阶段文字，预计超时时调整估计。
- [ ] 遵循prefers-reduced-motion；完成、取消、失败、节点销毁时停止动画和计时器。浏览器后台恢复后时间按时间戳计算，不累积interval次数。

## Task 7：RTX独立超分任务

**Files:** `result_nodes.py`、`__init__.py`、`web/generation-controller.mjs`、`web/result-preview.mjs`、`tests/test_result_nodes.py`。

**Interfaces:** 内部输出节点`QwenImage21AutoUpscale`，输入`filename, subfolder, scale, quality, result_id`，输出IMAGE并返回`ui.qwen_upscale`；前端upscale(resultId,settings)构造仅包含该处理节点的队列任务。

- [ ] 测试倍率必须是1～4整数、质量枚举、路径不能逃逸`output/qwen_auto/`；用模拟RTX节点验证参数透传和成功/失败输出结构。
- [ ] 安全解析已保存原图并加载为IMAGE，按节点注册表获取现有RTXVideoSuperResolution，不写死外部模块路径、不另装替代模型。

```python
resize_type = {"resize_type": "scale by multiplier", "scale": scale}
# 已安装RTX节点的execute参数：images、resize_type、quality。
# 将其输出保存到output/qwen_auto/upscaled/，返回实际尺寸和result_id。
```

- [ ] 超分任务使用原图文件；不重新执行生图或依赖当前prompt。记录实际倍率、档位和结果尺寸。所选原图丢失或RTX未加载时，明确提示并保留历史。
- [ ] 使用与生图相同的队列/取消/锁定机制；超分不使用steps×3秒估算，显示处理阶段与耗时。
- [ ] 完成后更新对应result_id的超分版本；用户切换历史期间也不能写错结果。取消时不得把未确认成功的输出登记为超分成功。
- [ ] 用一张已有小图片实际执行2倍ULTRA，检查输出宽高和下载文件；确认采样器未再次运行。高分辨率失败必须可恢复，不自动降倍率或档位。

## Task 8：整体验收与交接

**Files:** 全部受影响模块、`README.md`、`HANDOFF.md`。

- [ ] 执行项目测试与语法检查：

```powershell
python -m unittest discover -s tests -p 'test_*.py'
node --test tests/panel-state.test.mjs tests/generation-controller.test.mjs tests/result-state.test.mjs
python -m py_compile nodes.py panel_config.py result_nodes.py
node --check web/QwenImage21Auto.js
node --check web/parameter-popover.mjs
node --check web/generation-controller.mjs
node --check web/result-preview.mjs
```

- [ ] 浏览器验收：常用/高级浮层、摘要更新、自定义步数、四种种子模式与本次/下次值、LoRA切换、中文输入、原生拖图、@引用、锁定入口、生成动画、历史/版本、重命名下载、放大查看、保存重开和节点复制。
- [ ] 旧工作流验收：原steps/CFG/seed/LoRA/引用ID不变，新增字段使用默认，旧12/18/40步不被迁移改值；KV禁用仍显式off，负面词不自动改CFG。
- [ ] 实际生图至少一张：核对真实seed、steps、尺寸与快照，检查只执行目标和必要上游，不执行无关输出；验证一次排队取消与一次运行取消。
- [ ] 实际RTX 2倍ULTRA一次，记录真实耗时、尺寸与结果。8GB显存下4K/高倍率若未实测，明确列为未验证，不宣称全档可运行。
- [ ] 核对全局队列入口仍可使用、模型注入端口和四个既有输出不变、超分不触发原节点下游；检查无重复预览/残留DOM/重复事件监听。
- [ ] 更新README和HANDOFF：已完成、测试命令结果、真实采样/超分结果、剩余限制、备份路径、重启/刷新步骤。对照本计划逐项勾选，仅在真实通过后标记完成。

## 回退与交付边界

恢复实施前备份的同名功能文件并移除本轮新增模块的注册/引用，再重启ComfyUI、刷新前端。结果图片保留，不做删除。历史properties可留存供新版恢复；旧版忽略新字段。实施不包含ComfyUI核心KV问题修复、任意第三方加速插件系统、批量张数/输出格式选择或自动清理历史文件。

## 计划自检

- [x] 覆盖用户六项新增要求与已确认取消按钮。
- [x] 区分原图生成、RTX后处理和预览放大；明确原输出口语义。
- [x] 明确旧步数迁移、参数快照、历史保存、任务归属与取消竞态。
- [x] 已只读核对本地RTX接口与ComfyUI定向提交/取消协议。
- [x] 功能代码已实施；实际结果已登记于执行记录和 HANDOFF。
