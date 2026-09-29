# Qwen Inline References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让参考图 `@` 成为跟随原图的行内标签，改进 LoRA 选择和负面词方案。

**Architecture:** 保留现有节点输入及 `widgets_values` 顺序。前端将内联标签序列化到 `prompt`，后端仅在编码前按参考图 ID 解析；LoRA 列表用挂载到 `document.body` 的浮层；预设继续由后端定义，前端只负责可见性和 CFG 提示。

**Tech Stack:** ComfyUI 1.53.6、原生 JavaScript ES modules、Python 3.12、Node 内置测试及 `unittest`。

**Spec:** [设计说明](../specs/2026-09-25-qwen-inline-references-design.md)

## Global Constraints

- 不改变节点名、已有输入名及旧工作流的序列化位置。
- 参考图标签持有 ID；重排只更新显示编号，删除后不能错误指向其他图。
- 默认负面词方案为“不使用”；更换方案不自动调整 CFG。
- 不改 ComfyUI 核心，不新增依赖；本目录不是 Git 仓库。

## File Map

- `web/QwenImage21Auto.js`：编辑器、LoRA 浮层、布局及提示。
- `web/panel-state.mjs`：引用标记的纯状态函数。
- `panel_config.py`：后端解析引用标记。
- `nodes.py`：负面词预设和编码前引用转换。
- `tests/*`：标记顺序、失效、预设兼容的回归检查。
- `README.md`、`HANDOFF.md`：使用方式及验证结果。

### Task 1: 参考图标记合同

- [x] 写重排、删除、旧文本兼容测试。
- [x] 实现前后端标记解析，并在图片载入失败时阻止错误引用。
- [x] 运行相关 Node 与 Python 测试。

### Task 2: 行内标签编辑器

- [x] 保留 `prompt` 原输入及保存顺序，用 DOM 编辑器显示可删除标签和缩略图。
- [x] 输入 `@` 时列出参考图；选取、重排、删除、保存重开均刷新标签。
- [x] 在浏览器验证输入、选择、删除、重排和保存重开。

### Task 3: LoRA 悬浮选择

- [x] 把列表移出节点画布，增加搜索、键盘和外部点击关闭。
- [x] 验证取消不产生空 LoRA 行、选择后仍可禁用/调整强度/删除。

### Task 4: 负面词与交付

- [x] 默认设为“不使用”，补充用途预设，保留旧名称，方案放常用区。
- [x] CFG 为 1 时显示未生效提示，不自动修改数值。
- [x] 运行最小必要检查和独立服务工作流验证；更新 README/HANDOFF。
