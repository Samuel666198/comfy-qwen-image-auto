# 图片管理器智能归档实施计划

> **For agentic workers:** 按本计划逐项实施，步骤使用 checkbox 跟踪。当前由主线程 inline 执行，不暂存或提交文件。

**Goal:** 为当前节点图片管理器加入虚拟日期/月份归档、归档引用过滤、版本信息与清理、文件体积统计。

**Architecture:** 继续使用 `qwenWorkbench.history` 作为作品与版本真源。前端保存可序列化的归档状态并构建虚拟文件夹；后端新增安全的批量 stat 接口，永久删除仍走现有安全文件删除路由。既有图像文件和工作流路径保持原样。

**Tech Stack:** ComfyUI 自定义节点 ES modules，Node.js `node:test`，Python `unittest` / aiohttp。

**Spec:** `docs/superpowers/specs/2026-09-29-qwen-image-archive-manager-design.md`

## Global Constraints

- 仅管理当前节点 `qwenWorkbench.history` 可识别的作品版本。
- 归档为虚拟分组，不移动、不改名图片文件。
- 归档作品不再出现在新的 `@` 候选里；已经存在的引用不自动改写。
- 清理只保留当前作品的当前选中版本，不影响其他作品；删除前二次确认。
- 删除其他版本需要保护共享文件，并报告失败或跳过的文件。
- 大小统计对规范化路径去重；缺失文件不阻断管理器。
- 兼容旧工作流：缺少归档字段时视为未归档。

---

### Task 1: 归档状态及纯分组规则

**Files:**
- Modify: `web/version-state.mjs`
- Test: `tests/version-state.test.mjs`

**Interfaces:**
- `setArchived(history, resultIds, { archived, group })` 返回新的 history，不改输入；默认兼容缺失归档字段。
- `organizeByDate(history, metadataByFile)` 返回 `{groups:[{key,label,resultIds}], ungroupedResultIds}`，以作品文件名日期、最早有效的作品/版本 `createdAt`、后端文件修改时间依次确定 `yyyy_mm_dd`。
- `groupFoldersByMonth(history, metadataByFile)` 返回相同结构，每个 group 另带 `subfolders`；以作品最早的 `generate` 版本（缺失时最早版本）的 `subfolder` 作为作品目录，优先从目录名读取有效月份，再回退到作品日期；版本分布在其他目录不重复归组。日期未知的项目留在未分组区。
- `metadataByFile` 是以导出的 `fileKey(file)` 为键、值为 `{size,mtime}` 的 `Map`。
- `otherVersionCount(item)` 返回当前作品除当前选择外仍存在的版本数。

- [x] 为旧记录默认未归档、日期文件名优先级、createdAt 回退、重复整理幂等、月份文件夹聚合和其他版本数编写失败测试。
- [x] 运行 `node --test tests/version-state.test.mjs` 确认新测试先失败。
- [x] 实现纯状态变换与日期分组辅助函数，不读取 DOM 或磁盘。
- [x] 再运行 `node --test tests/version-state.test.mjs`（12 项通过）。

### Task 2: 安全文件大小元数据 API

**Files:**
- Modify: `result_files.py`
- Test: `tests/test_result_files.py`

**Interfaces:**
- 新增 `file_metadata(files)`，限制最多 10000 个文件描述符，逐个调用现有 `resolve_file`；返回成功文件的首个输入 `index`、规范化 descriptor、`size` 字节数和 `mtime` 毫秒时间戳，失败项返回 `index` 和安全错误。不返回本地绝对路径。
- 新增 `POST /qwen_auto/results/metadata`，JSON 输入 `{ "files": [descriptor, ...] }`，JSON 输出 `{ "files": [{ "index": integer, "file": descriptor, "size": integer, "mtime": integer }] }`；错误项 `{ "index": integer, "error": string }`；整体输入无效时返回 HTTP 400。

- [x] 测试当前输出图片返回准确字节数、重复路径只统计一次、缺失文件逐项报错、拒绝 input/越界/符号链接路径、空列表及超限请求拒绝。
- [x] 运行测试确认新测试先失败；发现仓库没有 `tests` 包标记后改用脚本/`unittest discover` 运行。
- [x] 实现批量元数据函数与路由；使用 `asyncio.to_thread` 执行磁盘 stat。
- [x] Python 聚焦测试 19 项通过，1 项因 Windows 符号链接权限跳过。

### Task 3: 管理器虚拟文件夹、大小及版本菜单

**Files:**
- Modify: `web/result-manager.mjs`
- Modify: `web/result-preview.mjs`
- Test: `tests/result-manager.test.mjs`

**Interfaces:**
- `createResultManager` 复用已有 `getState/updateState/viewURL`，管理器开启时批量读取唯一 `versionFiles` 元数据。
- 顶部增加“智能整理”浮层选项；视图支持未归档作品、`yyyy_mm_dd` 虚拟归档文件夹、`yyyy_mm` 文件夹分组及返回上级。
- 在管理器记录上保存 `archived` / `archiveGroup`；提供从归档区解除归档的入口。
- 卡片显示当前 `Vn` 和灰字“另有 N 个版本”（仅 N > 0 时显示）。
- 右键菜单提供“打开图片”“查看其他版本”“一键清除其他版本”；查看复用现有版本选择 UI 回调，不新建查看器。
- 文件管理视图标题显示唯一文件总字节数；单图和文件夹显示汇总大小，使用 B/KB/MB/GB 格式化。
- 文件夹顶部清理按钮仅在恰好选中一项作品时启用，并绑定该作品的当前选中版本；确认框列出作品、保留版本、删除数量、永久删除与外部引用限制。

- [x] 使用现有 DOM 测试环境覆盖浮层入口、归档分组与解除、体积格式化、卡片版本数、右键菜单版本查看回调。
- [x] 覆盖清理取消不发请求、确认只对同作品的其他版本发请求、同文件夹作品不受影响、共享文件通过 `keep_files` 保护、失败版本保留记录。
- [x] 运行 `node --test tests/result-manager.test.mjs` 确认新行为测试先失败。
- [x] 实现管理器 UI 与事件接线；保持已有滚动位置、选择、重命名和 ZIP 功能。
- [x] 再运行 `node --test tests/result-manager.test.mjs`（22 项通过，包含历史窗口共享文件提示）。

### Task 4: 引用过滤、集成验证与交接

**Files:**
- Modify: `web/QwenImage21Auto.js`
- Modify: `HANDOFF.md`
- Test: `tests/result-manager.test.mjs`, `tests/version-state.test.mjs`, `tests/test_result_files.py`

- [x] 给 `generatedRefs()` 过滤归档作品版本，已有 refs 标签保持原身份。
- [x] 将结果预览现有版本选择入口作为管理器回调；支持从管理器选择作品打开该窗口，并加入跨模块集成回归测试。
- [x] 更新所有受影响 JS import 的缓存版本号，避免 ComfyUI 桌面端模块混载。
- [x] 全量 Node 测试：101 项通过。
- [x] Python unittest discover：59 项通过，1 项因 Windows 符号链接权限跳过。
- [x] 改动 JS `node --check` 和 `git diff --check` 通过；Python 源语法由 Python 测试导入覆盖。
- [x] 独立集成复审 APPROVED；更新 HANDOFF 记录归档路径不变、已删除文件的外部引用风险、测试结果、服务需重启/刷新及未实测项。

## 交付边界

不运行生产图片清理，不扫描或移动整个输出目录，不暂存或提交。永久删除行为只用临时测试图片验证。实施结束后汇总变更、测试、服务刷新要求与未验证项。
