# Qwen 图片归档与提示词优化细节实施计划

> **For agentic workers:** 当前由主会话 inline 执行，按任务勾选；不暂存或提交文件。

**Goal:** 优化图片管理器的浮层/批量操作与回看体验；让预览和 `@` 候选正确遵循当天归档状态；统一提示词加权计数并把脚本计算的当前值传给优化模型。

**Architecture:** 继续使用工作流内 `qwenWorkbench.history` 保存归档状态，在每个作品上新增 `archivedAt`。新增纯计数/日期 helper，提示词框、优化请求和归档可见过滤共用确定性逻辑；图片管理器继续复用现有文件、查看器和版本清理接口。

**Tech Stack:** ComfyUI ES modules，Python aiohttp prompt optimizer，Node `node:test`，Python `unittest`。

**Approved scope:** 2026-09-29 图片管理器与提示词细节计划，经用户确认。

## Global Constraints

- 归档仍是工作流状态，不移动、重命名或删除图片。
- 旧归档缺少 `archivedAt` 时仅在管理器可见，不推断归档日期。
- 预览与新 `@` 候选仅显示未归档图片和本机今天归档的图片；既有引用不因归档被改写。
- 清理其他版本为永久磁盘删除；批量操作一次确认，逐作品保留当前选中版本，并保护共享文件。
- 提示词加权计数为软提醒：汉字 1，英文及数字字符各 0.25，空格与标点各 1，分母固定 680，不截断。
- 优化前脚本把当前加权数和上限传给模型；模型不自行估算 token、不输出计数；优化后只由提示词框已有计数器更新，不额外提醒。
- 用户当前工作区文件未暂存；保留此前改动，不暂存或提交。

---

### Task 1: 提示词加权计数与优化请求

**Files:**
- Modify: `web/prompt-editor.mjs`
- Modify: `web/QwenImage21Auto.js`
- Modify: `web/prompt-optimizer.mjs` only if a pure payload helper is needed
- Modify: `prompt_optimizer.py`
- Modify: `prompts/optimizer_t2i_core.txt`
- Modify: `prompts/optimizer_edit_core.txt`
- Test: `tests/prompt-expand.test.mjs`
- Test: add focused optimizer payload/template coverage in existing tests where available

**Contract:** Export a deterministic prompt length estimator returning `{weightedCount, limit:680}` (preserve a compatibility alias only if existing callers need it). Convert internal reference markers to the same visible `图片N` labels before scoring. Score Unicode CJK ideographs as 1; Latin letters and decimal digits as 0.25; whitespace and punctuation as 1; other standalone symbols as 1. Preserve quarter increments without forced integer rounding.

- [x] Add failing tests for the user examples: `一只猫` → `3/680`; `a cat` → `2/680`; `一只猫 a cat` → `6/680`; include punctuation, numeric characters, emoji, and reference markers.
- [x] Implement one pure scorer and update all counter display/title/color logic to fixed `weightedCount/680`; remove variable denominator and approximate token number from the UI.
- [x] Before optimizer submission, call the same scorer on the source prompt and include `{weighted_count, limit:680}` in the request payload for both Ollama and Responses API providers.
- [x] Dynamically append the shared system instruction for both text-to-image and image-edit requests using the script-computed source score; target 680 weighted units while preserving user constraints; do not count or report the score. No hard limit is applied.
- [x] On optimization completion, update the prompt and let its ordinary counter reflect the result; no separate length warning or truncation is added. Existing completion/unload feedback remains.
- [x] Run focused prompt-editor and optimizer tests.

### Task 2: Archive operation date and shared visibility rule

**Files:**
- Modify: `web/version-state.mjs`
- Modify: `web/QwenImage21Auto.js`
- Modify: `web/result-preview.mjs`
- Test: `tests/version-state.test.mjs`
- Test: `tests/result-state.test.mjs`
- Test: relevant reference mention tests

**Contract:** `setArchived(history, ids, {archived:true, group, archivedAt})` stamps a numeric epoch-millisecond local timestamp by default; unarchive clears it. A shared pure predicate returns true for unarchived records or archived records whose local `YYYY-MM-DD` equals the current local date. Missing `archivedAt` on legacy archived records returns false.

- [x] Add tests for timestamp stamp/clear, same-local-day visibility, cross-midnight visibility, legacy archives, and preview selection fallback without changing saved selection.
- [x] Implement the `archivedAt` state transition and shared local-day visibility predicate; migration never fabricates dates for legacy archives.
- [x] Filter result-preview navigation and position count through the shared predicate. A now-hidden saved selection renders the newest visible result without changing saved state.
- [x] Filter newly offered generated-image `@` candidates, edit and mask entry through the same predicate; existing prompt references remain intact.
- [x] Refresh preview, reference thumbnails, and an open `@` menu at local midnight and after focus/visibility return; clear timer/listeners when the node is removed.
- [x] Open manager images/version history above the manager without changing main preview selection; preserve manager state and browsing location.
- [x] Run focused archive state, preview, manager, and prompt tests.

### Task 3: Image manager toolbar, folder covers, and multi-select actions

**Files:**
- Modify: `web/result-manager.mjs`
- Modify: `web/result-preview.mjs`
- Test: `tests/result-manager.test.mjs`
- Test: `tests/result-state.test.mjs`

**Contract:** The top toolbar order is back, select-all toggle, sort, organize, clear other versions, unarchive, close. Icons use the existing purple-accent button style. Organizer popover is anchored to its button and flips inward near a viewport edge. Folder cover shows the most recently created existing version among folder works, falling back to work generation order when timestamps are absent.

- [x] Add DOM tests for organizer anchoring/edge alignment, toolbar order/icon labels, select-all toggle, newest archive-folder cover, and batch actions.
- [x] Render folder cover from the newest existing version timestamp; fall back to generation order when timestamps are missing. Folder thumbnails remain path/read-only.
- [x] Replace toolbar text actions with accessible purple-accent icon buttons; use one select-all/none toggle and a cycle sort control.
- [x] Anchor organizer popup to its button, flip at viewport edges, and close it on outside click or Escape.
- [x] Move unarchive to the toolbar and bulk-unarchive selected archived works.
- [x] Extend `deleteOtherVersions` to multiple result IDs. Confirm once, preserve each selected current version and every unaffected file, deduplicate shared paths, keep failed records, and report failures/shared skips.
- [x] Keep manager mounted with its location, selection and scroll position while the viewer or version history is open above it.
- [x] Run manager and preview tests.

### Task 4: Integration, cache versions, handoff, and verification

**Files:**
- Modify: all directly affected JS module query versions
- Modify: `HANDOFF.md`
- Test: `tests/*.test.mjs`, `tests/test_*.py`

- [x] Update cache query versions across the preview/manager/version-history/version-state and prompt-editor import chains.
- [x] Confirm both optimizer providers accept the script count and compose it into Chinese, output-only system prompts; no server prompt limit is applied.
- [x] Run `node --test tests/*.test.mjs`.
- [x] Run `<COMFYUI_ROOT>\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`.
- [x] Run `node --check` on every changed JS module and `py_compile` on the changed Python module.
- [x] Update `HANDOFF.md` with behavior, test results, legacy archive handling, and restart/refresh requirement.
- [x] Do not restart the user's ComfyUI service, delete production images, stage, or commit.
