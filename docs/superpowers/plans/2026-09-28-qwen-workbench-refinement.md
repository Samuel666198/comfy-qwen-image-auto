# Qwen 创作面板细节优化实施计划

> **For agentic workers:** 在当前会话按顺序执行各任务，任务均在已有模块内完成。步骤用 checkbox 跟踪。

**Goal:** 完成审阅设计中的提示词区、结果管理和查看器细节优化。

**Architecture:** 复用现有 DOM 编辑器、节点状态、SSE 流、管理器和查看器。前端承担字符估算与交互；优化补充要求作为独立字段交给 Ollama/Responses 后端；结果管理使用前端日期序号命名下载。

**Tech Stack:** ComfyUI 前端 JavaScript ES modules，Node.js `node:test`，Python `unittest` / aiohttp。

**Spec:** `docs/superpowers/specs/2026-09-28-qwen-workbench-refinement-design.md`

## Global Constraints

- 不改变 ComfyUI 核心、工作流节点连接与现有输入/输出契约。
- 透明背景仅以提示词约束实现，不新增 Alpha 后处理节点。
- 1024 tokens 到字符数的换算只是软提示，不截断提示词。
- 思考文本不显示；取消、错误或失败不得覆盖原提示词。
- 保留旧工作流兼容；ZIP 日期使用本机日期。

---

### Task 1: 提示词字符估算和透明背景

**Files:**
- Modify: `web/prompt-editor.mjs`
- Modify: `web/QwenImage21Auto.js`
- Test: `tests/prompt-expand.test.mjs` 或新增 `tests/prompt-editor.test.mjs`
- Test: `tests/generation-controller.test.mjs`（生成提交快照）

**Interfaces:**
- Prompt editor options adds `getTransparentBackground()` and `onToggleTransparentBackground(enabled)`.
- Prompt editor exposes `setTransparentBackground(enabled)` and renders character count in compact and expanded layouts.
- Workbench state uses boolean `transparentBackground`, default false.

- [x] 添加 count helper 测试：Unicode 标点/CJK 计数、英文字符分词估算、混合文案 1024 token 容量换算。
- [x] 实现计数器与 tooltip，并确保图片 chip 按其可见编号计数。
- [x] 实现工具栏透明背景图标，状态常亮、反馈、锁定和节点状态持久化。
- [x] 提交生成时仅在运行时 prompt 前附约束；编辑器内容与提示词快照不被篡改。
- [x] 运行相关 Node 测试。

### Task 2: 提示词优化补充要求和阶段动画

**Files:**
- Modify: `web/prompt-editor.mjs`
- Modify: `web/QwenImage21Auto.js`
- Modify: `prompt_optimizer.py`
- Test: `tests/prompt-optimizer.test.mjs`
- Test: `tests/test_prompt_optimizer.py`

**Interfaces:**
- `optimizePrompt({prompt, refs, instruction, ...providerSettings})` accepts optional `instruction` string.
- Prompt editor `onOptimize(instruction)` only fires after modal confirmation.
- SSE phase names remain `stage`, `route`, `delta`, `done`, `error`; stage `thinking` conveys state without exposing thought text.

- [x] 为补充指令传递和思考内容不泄露添加测试。
- [x] 在 Ollama、Responses 的用户输入里添加独立补充指令字段，同时保留现有 prompt 和图片内容。
- [x] 后端思考阶段只发阶段事件，首个最终文本 token 到达时发 rewriting 阶段和 delta；不得 emit thinking 内容。
- [x] 做可选补充要求悬浮框（确定开始、取消不请求）。
- [x] 增加计时器及简洁阶段动画；思考阶段只显示状态，首个 final delta 后显示流式提示词。
- [x] 运行 prompt optimizer 的 Node 和 Python 测试。

### Task 3: 图片管理与预览遮罩

**Files:**
- Modify: `web/result-manager.mjs`
- Modify: `web/result-preview.mjs`
- Test: `tests/result-manager.test.mjs`
- Test: `tests/result-state.test.mjs`

**Interfaces:**
- ZIP client filename format is `qwen_image_YYYY_MM_DD_NN.zip`, with local-date daily counter stored in `localStorage` and `_01` fallback.
- Result manager selection, sorting, and rename preserve the `.qm-grid` scrollTop.

- [x] 为批量勾选后保持滚动位置添加回归测试。
- [x] 修复重绘后网格 scrollTop 丢失；保证 set selection 和选中集合一致。
- [x] 生成日期序号名，只有下载已启动后才推进当天计数；存储失败回退 `_01`。
- [x] 将 busy mask 外扩约 2px，并受 preview frame 的 overflow 边界约束。
- [x] 运行 result-manager / result-state 测试。

### Task 4: 图标工具栏与图片查看器拖动

**Files:**
- Modify: `web/result-preview.mjs`
- Test: `tests/result-state.test.mjs`

**Interfaces:**
- Previous/next/compare/manager controls use icon buttons with title and accessible labels.
- Version-history entry displays current `Vn` and opens the existing history panel.
- Double-click preview image opens the existing image viewer.
- Viewer stage keeps pointer-capture pan behavior and suppresses native `dragstart` and text selection.

- [x] 为图标按钮及 Vn 文案创建 DOM 测试。
- [x] 为图片双击打开现有查看器创建测试。
- [x] 防止 stage / image 原生拖放与 selection；保留 pointer capture、wheel zoom、panning 和 compare slider。
- [x] 运行 result-state 测试。

### Task 5: 集成验证与交付说明

**Files:**
- Modify: `README.md`
- Modify: `HANDOFF.md`

- [x] 更新使用说明，覆盖透明通道、字数估算、补充优化要求、图片管理器和图标按钮。
- [x] 运行全部 JavaScript 测试：`node --test tests/*.test.mjs`。
- [x] 运行全部 Python 测试：`python -m unittest discover -s tests -p "test_*.py"`。
- [x] 运行修改模块的 `node --check`，Python `py_compile`。
- [x] 记录测试输出、服务重启要求和桌面端尚需手动确认项。
