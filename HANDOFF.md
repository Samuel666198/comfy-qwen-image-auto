# HANDOFF — Qwen Image 2.1 面板更新

## 2026-09-30 归档管理器与提示词计权细节

- **状态**：实现及自动化验证已完成；需重启/刷新 ComfyUI 后做实际界面验收。
- **归档可见性**：每次新归档写入本机时间戳；预览、导航、新 `@` 候选、图片编辑和蒙版重绘统一显示未归档作品及本地当天归档作品。跨过本地午夜后自动刷新候选；旧记录缺少时间戳时仍只在管理器中可见，不会推定日期。既有提示词引用保持不变；旧归档要重新可用需先取消归档再归档。
- **管理器**：顶栏改为图标按钮，单键切换全选/取消全选，排序通过按钮循环选择生成顺序、名称及时间升降序；整理弹窗锚定按钮并在边缘翻转。批量解除归档与批量清理其他版本按每个作品保留当前选中版本。归档文件夹封面使用可读取的最新版本。右键打开图片/版本历史时管理器保持打开并保留位置与选择。
- **提示词计权**：计数器改为固定 `加权数/680` 软提示：汉字 1，拉丁字母与数字 0.25，空白、标点及其他符号各 1；引用标签按可见“图片N”计数，不截断。优化前用同一个前端函数计数，并将源提示词加权数及 680 目标传给 Ollama / Responses；后端动态提示模型尽量简洁、不自行计算或输出计数。不会额外弹出超限提示，提示词框计数器继续显示结果；优化成功反馈和 Ollama 卸载状态反馈保留。
- **范围**：管理和统计仅包括当前节点工作流 `qwenWorkbench.history` 记载的作品，不扫描整个 ComfyUI 输出目录。批量清理是永久文件操作，会保护共享文件并在执行前二次确认。
- **验证**：全量 `node --test tests/*.test.mjs` 105 项通过；ComfyUI venv 的 Python unittest 59 项通过，1 项因 Windows 符号链接限制跳过；改动 JS `node --check` 与 `prompt_optimizer.py` `py_compile` 通过。
- **现场/Git**：分支 `feat/qwen-image-archive-manager`；仓库初始化时没有基线提交，项目文件仍未暂存或提交。未删除用户图片；未重启或刷新 ComfyUI 服务。
- **下一步**：重启 ComfyUI 并刷新浏览器/桌面客户端，验证同日/隔日归档筛选、管理器悬浮层和批量操作。实际图片删除仅用临时测试图片验收。

## 工作台细节完善（2026-09-29）

- 已按确认的方案实现提示词 x/y 软计数（目标 1024 tokens，按当前中英文字符比例粗略换算，引用按可见的“图片N”标签计数，不截断）、透明通道按钮及仅对本次运行 prompt 前置透明背景约束。
- 提示词优化增加可选补充要求悬浮窗；补充要求、原提示词及参考图同时送至 Ollama / Responses。两条流式链路仅报告思考阶段，不传出思考内容；首个最终文本到达后显示改写内容，含耗时状态。
- 图片管理器勾选/排序/重命名后保留滚动位置，ZIP 使用本地日期和递增编号 `qwen_image_YYYY_MM_DD_NN.zip`；生成遮罩外扩 2px。
- 图片底栏改为上一张/下一张、对比、Vn 版本和“图片管理器”图标入口；图片双击打开原查看器。查看器拖动屏蔽原生 dragstart 和文本选择，仍使用 pointer capture。
- 验证：`node --test tests/*.test.mjs` 88 项通过；ComfyUI venv 下 `python -m unittest discover -s tests -p 'test_*.py'` 53 项通过、1 项跳过；修改的 JS `node --check` 与 `prompt_optimizer.py` `py_compile` 通过。
- 前端导入查询版本已更新为 `20260929-refinement-1`。需要重启 ComfyUI 服务并重新载入桌面端页面。当前没有在目标桌面端做截图级人工验证；实际透明效果取决于模型，不代表 Alpha 后处理。
- 计划与设计：`docs/superpowers/plans/2026-09-28-qwen-workbench-refinement.md`、`docs/superpowers/specs/2026-09-28-qwen-workbench-refinement-design.md`。该目录没有 Git 元数据，不能提供 Git diff/提交。

## Responses API 与中文提示词模板（2026-09-28）

- 扩展内可切换 Ollama / 通用 Responses API；API 默认 `https://api.deepseek.com` 与 `deepseek-flash`，支持 GET `/models` 刷新和手动填写模型 ID、按模型参数选择推理强度。
- API 密钥与服务地址保存在 ComfyUI 本机 user 目录的 `qwen_image_auto_prompt_optimizer.json`，不写进工作流。API 基础地址只从本机配置读取，避免导入的工作流把保存的 Bearer 密钥重定向到其他主机；远程 HTTPS、本机回环 HTTP，拒绝 HTTP 重定向。
- Responses 最终编辑请求按引用顺序携带 `input_image` data URL 与 `input_text`，使用 SSE 增量预览。模型元数据明确无图像输入能力时拒绝；元数据缺失时尝试请求，API 明确拒绝则报错，不静默丢图。路由分类阶段只收到文本与图像数量。
- 活动中的 router/core/module 模板全部改成中文，输出语言跟随原提示词。官方 PE 英文模板保留为上游溯源副本，不直接由通用模型链路加载。参考规则包括自然语言描述、保留明确约束、编辑改动/保留分离与多图编号对应。
- 验证：Responses 后端模拟覆盖有序图片+提示词、推理强度、明确无视觉能力拒绝与 URL 校验；Ollama 测试保留通过。Node 全量测试、ComfyUI 桌面端/API 实际密钥调用尚需在服务重启后验证。
- 本轮编辑文件：`prompt_optimizer.py`、`web/ollama-settings.mjs`、`web/prompt-optimizer.mjs`、`web/QwenImage21Auto.js`、活动提示词模板、`README.md`、`prompts/SOURCES.md`、`tests/test_prompt_optimizer.py`。需重启 ComfyUI 后端并刷新桌面端前端模块。

## 局部编辑改版（2026-09-27）

- 用户后续要求进一步压缩模板：提示词框不加局部修改标签，只保留方位/颜色句子与用户原文，例如“在图片右上角的紫色标注区域：去除这段文字”；不再附带引用说明、通用引导或保持区域要求。前端缓存版本20260927-region-4。
- 用户确认只保留蒙版编辑入口，移除图片评论入口。蒙版编辑器三类工具：紫色高不透明度“涂抹”绘制实际蒙版；红/绿/蓝/黄“画笔”只绘视觉标注；彩色“矩形框”视觉上空心，框内进入实际蒙版。橡皮擦用于擦紫色蒙版，支持撤销/重做、清空、笔刷大小和羽化。彩色标注可逐条编辑文字。
- region-editor 输出两份图：原图叠加标注颜色的 auxiliary 供模型视觉定位；独立黑白 maskImage 供最终合成。后端继续按既有路径和尺寸校验、恢复原图尺寸、保持蒙版外像素与alpha。旧版黑白辅助图仍兼容；旧评论版本历史保留读取兼容，但UI不再创建评论编辑。
- 提示词完全改为本次局部修改标签块，确认时不带入普通旧提示词；旧提示词先保存历史快照。mask范围依据实际alpha像素框和编辑图中心线自动生成四角/上方/下方/左侧/右侧/中央描述，不写像素原点。各彩色标注按颜色/方位生成“在图片右上角蓝色标注区域：…”句子。用户可在蒙版界面编辑紫色涂抹说明和每条标注说明。
- 改动 web/region-editor.mjs、region-state.mjs、prompt-editor.mjs、QwenImage21Auto.js、region_edit.py；补充 README 和替代初版计划状态。前端模块缓存版本20260927-region-2。实施前副本：<WORKSPACE_TMP>/qwen-region-revision-backup-20260927。
- JS模块语法检查及Python AST解析通过；本轮未运行自动测试或GPU/界面集成验证。下一步在隔离服务确认评论图标已移除、彩色辅助图与独立蒙版上传、象限提示词、任务及版本恢复、蒙版外像素保护；随后重启常用ComfyUI并分别验证网页与桌面客户端。

## 上一版交付：评论、蒙版与缩略图（2026-09-27）

- 最终验证：Node 81项全通过；Python 46项中45通过、1因Windows符号链接权限跳过。全局运行通过末尾隐藏region_json widget序列化；新页面graphToPrompt实测携带两条评论及完全一致的rawPrompt，回传按捕获的来源版本追加。节点内生成仍使用冻结controller context。前端模块版本20260927-region-1。
- 临时验证节点已移除、两个测试页已关闭；隔离8001队列为空后停止本轮PID34192，常用8000未操作。保存的QwenRegionVerification.json及验证图片保留。桌面客户端仍需用户重启后验证。
- 批准计划 docs/superpowers/plans/2026-09-27-region-editing.md 实施。工具栏为蒙版/评论/图片编辑/优化/清空/历史/放大，扩展移至高级和复制之间。@候选36px缩略图、名称省略、版本号单独保留；候选/标签/参考图canvas共享悬停大图，200ms延迟、窗口边缘限制。
- 新 region-editor.mjs 原图像素坐标点选/框选、编号评论编辑/删除；蒙版画笔/橡皮擦/矩形、撤销重做、清空、大小、羽化。drawings矢量笔划存工作流，不存base64历史。确认上传辅助PNG，取消不改草稿，重复确认替换区域段，手改区域段覆盖需确认。
- 新 region-state.mjs 绑定来源版本/参考图ID。区域数据进入editSession、提示词快照及生成regionSnapshot；恢复检查来源仍存在。优化保留区域说明块，只优化其他补充文字；区域段损坏拒绝提交，避免图文位置不一致。辅助图不混入用户编号，来源必须第一张，用户参考图最多9张。
- 后端 region_edit.py + nodes.py 可选forceInput region_json末尾追加。原图+辅助图视觉引导，强制来源latent画幅；评论输出及蒙版输出恢复原图尺寸。蒙版RGB/RGBA合成，范围外逐像素保留，内部采用生成alpha；RGB生成按opaque处理。前后端羽化半径均feather/2。路径/尺寸/数量/空蒙版严格校验。修复注解文件名[output]缺少type时推导目录类型，显式冲突仍拒绝。
- 代码审查修复：区域aux HEAD期间保持上传锁；restoreDraft失败不继续套参数；浮窗拖放不落到底层画布；controller按已冻结job.context.region提交；onConfirm false保持浮窗；拖拽释放补最后坐标；边缘编号偏移加引线和实际位置十字；receive立即刷新图标可用状态。
- 实际隔离8001浏览器：点位(53,62)、框选(93,108,159,166)两条评论确认，原图引用稳定。蒙版矩形撤销重做正确，确认替换评论段无重复；@候选和参考图区hover真实加载256图。提示词历史载入恢复评论对象/来源及refs；保存回读QwenRegionVerification.json保留3版本/两评论/蒙版快照。
- 实际GPU1步/256²：V1旧测试苹果来源 → V2 inpaint → V3 comments；测试仅确认流程不代表画质。蒙版输出qwen_auto/qwen_image_2026_09_27_00009_.png，源qwen_auto/qwen_image_2026_09_26_00002_.png均RGBA256²；61708蒙版外像素完全一致，3828选区像素变化。蒙版input/qwen_region_6f3bf816-e967-4320-b76d-70dc91785e8e.png；评论input/qwen_region_ed30fa4c-69cd-43ee-8ee8-95f2f5ab6abf.png。
- 测试工作流 <WORKSPACE_TMP>/qwen-comfy-verification-user/default/workflows/QwenRegionVerification.json。常用8000未重启，本轮后端需用户重启再刷新。桌面端未直接验证。内部辅助PNG暂保留input，删除作品仅既有output作品版本，不自动删除辅助文件。

## 最新交付：Ollama 提示词工具（2026-09-27）

- 已批准方案已实施：右上角优化/清空/历史/放大。清空先存快照且保留参考图；清空与复制短暂反馈。优化原文入历史，成功只回填提示词，不改画幅、不生成；失败保留原文。
- 扩展新增 Ollama 设置：默认本机11434，实际已安装且支持生成的本地模型，按能力显示思考选项，更多参数温度/输出上限128..8192；state.ollama随工作流保存，无模型下载。
- 新 prompt_optimizer.py 注册 models/optimize POST 路由，本机回环地址/拒绝重定向，过滤嵌入与远程模型，参考图按input/output/temp安全解析原顺序传入。官方system prompt按有无参考图选edit/t2i，输出只取rewritten_prompt。来源及原许可证/NOTICE保存在prompts目录，分发前查看其使用限制。
- keep_alive=0，成功/推理失败/解析失败均finally显式卸载本次模型，独立返回unloaded/unload_error。后端全局优化锁拒绝并发；前端节点任务锁防重复/覆盖，工作流恢复或节点移除使旧结果失效。恢复后提示未应用旧结果。
- 本地Qwen3-VL关闭思考会把答案JSON放在thinking字段：仅content为空、think=false且thinking整个是有效答案JSON时提取rewritten_prompt，不采用自由推理文本。
- 验证：Node72通过；Python37项36通过、1Windows符号链接权限skip。新增后端9项包括能力/引用顺序与output路径/失败卸载/并发拒绝/严格答案兼容。真实qwen3-vl:4b自动思考和关闭思考2048输出均成功，卸载后/api/ps models=[]。未实测真实多图优化，图像传输顺序由测试覆盖。
- 实际浏览器新节点验证图标顺序、清空快照与反馈；使用延迟响应桩验证优化中锁定、结果回填、保留16:9、历史保存、完成反馈；复制用clipboard桩检查内容/反馈，不读取用户剪贴板。临时节点已移除、测试页已关闭。真实Ollama后端调用和前端交互分别验证，未从桌面端完成联调。
- 主8000未重启，新接口需重启ComfyUI后刷新。前端import版本20260926-ollama-1。备份<WORKSPACE_TMP>/qwen-ollama-backup-20260926（主JS、editor、extensions、__init__）。方案docs/superpowers/plans/2026-09-26-ollama-prompt-tools.md。

## 最新交付：图片版本、引用与提示词快照（2026-09-26）

- 已批准计划 docs/superpowers/plans/2026-09-26-versioned-workbench.md 已实施。当前节点范围：@候选分参考图/已生成作品版本，选择固定版本并同步上方缩略图，同文件复用；保留10图上限。引用缺失时拒绝生成。
- 新version-state.mjs为纯状态：history仍为作品数组，versions为真源，selectedVersionId/nextVersionNumber；兼容original/snapshot投影为当前版本。旧原图/历次超分迁移，幂等、不动磁盘；未知时间不伪造。Vue properties可能为代理，采用JSON工作流格式复制，不能structuredClone代理。
- 普通生成新作品；底部图标重新生成追加版本；菜单图片编辑保存草稿、清空提示词/引用、自动加入当前版本、显示编辑目标；退出恢复原草稿并保存未提交文字。编辑成功后来源不偷偷更新。任务context固定operation/targetResultId/sourceVersionId/ownerId/promptId/draft，后端回传，双通知由版本ID/文件去重；取消/种子原协议保持。
- 新version-history.mjs：Vn顺序、来源/操作/参数/时间、选择和显式载入提示词参数；对比前一个仍存在版本。单张/ZIP只导出当前版本。删除作品全部版本；删除其他版本确认后逐项删除，失败保留，高水位不重置，其他保留版本共用文件由keep_files保护。
- prompt-editor与prompt-history增加图标历史浮窗，载入/复制/删除；快照保存文本和引用，最近50条、连续相同组合去重、空白不存。接受提交/覆盖草稿前保存，淘汰文字不删图。
- nodes.py/QwenImage21AutoUpscale末尾追加forceInput execution_token，仅控制器显式提交写入随机promptId，确保固定种子重新执行而不清全局缓存；不更改采样逻辑。后端缺失参考图由静默跳过改为明确报错。
- 验证：Node69全通过；Python28项中27通过、1因Windows符号链接创建权限跳过（reparse模拟覆盖）；语法通过。隔离8001实际GPU：256²/1步/固定seed321，V1生成约12秒，V2同参数重生新文件，V3图片编辑；选回V2再RTX2 ULTRA生成V4 512²，seed不变，V3保留。该低步数测试仅验证流程，不代表画质。
- 实际UI：@选择V1产生第二个稳定标签并加载两张缩略图；版本浮窗V1..V4；对比加载V4和V3；历史载入恢复refs而steps不改；保存磁盘工作流再读configure保留4版本、next=5、2引用。真实API ZIP只有当前V4一张512²图片。永久删除仅临时目录自动测试，未删用户/测试GPU作品。桌面端未直接测。
- 隔离工作流 <WORKSPACE_TMP>/qwen-comfy-verification-user/default/workflows/QwenVersionVerification.json；测试作品id abbca516-1a36-4e6a-85c6-3ba8310dee3b，原文件qwen_auto/qwen_image_2026_09_26_00002_.png到00004_.png，超分qwen_auto/upscaled/68c522f5-850b-4e71-a31b-4e852e2f4109_00001_.png。
- 末次审查修复删除/生成并发：管理文件请求通过onBusyChange接入节点统一锁，期间禁止生成、重新生成、编辑和超分；失败/完成释放。延迟失败回归通过。
- 本轮新增后端输入/返回context与文件处理，必须重启常用ComfyUI再刷新前端。常用8000未由本轮重启。前端import版本20260926-versions-3。根模块修改前备份<WORKSPACE_TMP>/qwen-versions-backup-20260926；之前整套备份也保留。代码回滚不能恢复永久删除文件；无限版本增加工作流JSON大小。

## 高度回归修复（2026-09-26）

refreshSize不再在Vue节点生成完成时直接采用core computeSize的预留高度。按实际可见body子项高度、padding/gap及Vue声明min-height计算节点高度差；ResizeObserver监听预览内容变化，节点销毁时disconnect。画布模式或DOM尚未出现时仍用旧计算兜底。保留宽度。
实测独立测试节点：空状态root591/node561；生成结果root810/node780；底部间距均4px。先手动拉高1000再触发第二次__qwenReceive生成完成，恢复root810/node780，无大空白。未启动GPU，使用同一生成完成回调验证；语法检查通过。仅前端刷新生效。

## 最新交付：紧凑布局、复制提示词、管理重命名（2026-09-26）

- 根因：Vue节点widget网格随节点高度分配额外空间，动作行flex默认拉伸按钮。设置grid align-content:start/flex不增长，动作行46px、按钮34px定高居中，保留节点自主调整尺寸。
- 底部SVG复制图标复制当前提示词，稳定引用marker转换为当前@图片编号；无文字按钮，title/aria说明，失败明确提示。
- 批量管理每张图名称直接输入；回车/blur保存、Esc撤销，空名称拒绝，锁定不能改。复用历史title，保持文件关联、顺序，同步预览/下载名，不物理重命名文件。
- 验证：结果及管理19项通过（新增重命名回归）；主JS语法通过。真实网页新节点拉高1200后按钮仍34px、grid start；复制处理以clipboard.writeText桩捕获到预期提示词。未实际读取用户剪贴板，桌面端未直接测。
- 前端版本20260926-compact-1，仅本轮改动刷新即可；上一轮文件管理后端仍需服务重启才能生效。

## 最新交付：批量管理、永久删除与扩展浮窗（2026-09-26）

- 用户批准：默认生成顺序，删除直接删磁盘；只操作 output/qwen_auto 图片，参考图不涉及。菜单单删/管理多删均确认；成功移除记录并选择相邻项，失败保留记录并报告。原图、当前及本版起记录的历次超分一起删除。此前已丢失关联的旧超分无法追溯。
- 新 result_files.py 注册 delete/download POST 路由；路径验证拒绝越界/符号链接/Windows reparse。ZIP临时磁盘打包后分块返回，名称冲突自动后缀。前端通过与view相同API前缀调用。
- 新 result-manager.mjs：当前节点完整历史不再截断10项；懒加载缩略图、名称、尺寸、步数；默认生成顺序，名称/时间升降序只影响管理展示；多选/全选、永久删除、原图/超分图/两者ZIP。
- 预览生成时图片模糊暗遮罩+动画+状态；对比线使用contain后图片实际框，窗口resize重算。顶部标题/接口展示隐藏但schema和已有连线保留；新增拖动条。
- 用户补充已实现：扩展按钮打开独立悬浮窗（extensions-popover.mjs），原LoRA/accel widget永久隐藏，复用items/sync；不再向下展开。参数/高级/扩展互斥，运行关闭浮窗。
- 验证：Node49项全通过；Python文件API测试7通过、1跳过（Windows缺少创建符号链接权限，reparse模拟已通过）；语法检查通过。真实网页确认顶部隐藏、接口仍34输入/4输出、拖动条存在、扩展浮窗/原组件hidden、管理窗缩略图真实加载1024像素及名字/尺寸/步数。文件删除和ZIP通过临时目录+aiohttp测试server实测，无真实作品删除；未重跑GPU，桌面端未直接测。
- 本轮有后端新路由，需要重启ComfyUI服务再刷新前端。常用8000未由本轮重启；该运行进程没有新路由。前端版本20260926-manager-1。计划 docs/superpowers/plans/2026-09-26-result-management.md。

## 最新交付：提示词放大、图片菜单与对比（2026-09-26）

- 提示词 widget 固定160px，输入区120px、超出滚动；放大浮层移动同一编辑器DOM，保持文字与引用身份。完成/Esc/外部关闭；锁定/销毁清理；浮层内仍可通过已有拖图捕获路径添加引用。
- 图片右上角 ⋯ 菜单替代底部工具条。重复RTX先 window.confirm，取消不调用、确认后再次检查锁定并使用捕获的结果ID。新增对比按钮，缺少超分图时禁用；两张真实图片共享完整容器，clip-path裁切原图，竖线拖动与键盘range可调，Esc关闭。
- 参数/高级/扩展/生成同排；扩展按钮切换原组件区，并用title保留启用摘要。折叠组件不参与鼠标/拖放命中。
- 修改 web/QwenImage21Auto.js、web/prompt-editor.mjs、web/result-preview.mjs；扩展 tests/result-state.test.mjs，新增 tests/prompt-expand.test.mjs。模块版本20260926-preview-2；备份 <WORKSPACE_TMP>\qwen-preview-controls-backup-20260926。
- 验证：Node40项测试通过，三个前端模块语法检查通过。网页长文本35行实测 clientHeight119/scrollHeight720，浮层完成后内容同步。已有猫图菜单实际位于右上角；重复超分弹出确认且未确认不提交。对比实际加载1024原图与2048超分图，拖动50%到64.4%，两图容器宽高相同，Esc关闭。
- 此轮没有重跑生图或超分，没有修改后端。测试预览的超分回调为计数桩，不占GPU；确认继续分支由自动测试覆盖。桌面端本轮交互尚未直接实测。前端需刷新；旧后端变更是否已重启请沿用此前说明。

## 默认作品命名（2026-09-26）

新结果展示名及下载名采用 qwen_image_yyyy_mm_dd_01，当地日期、每天从01递增，超过99正常延长。复用核心 SaveImage 按 output/qwen_auto 中同日期文件计数，服务重启后继续；底层文件保留核心五位序号及尾下划线。旧历史名称和手工重命名不变，RTX不消耗新的生图序号。Python14项测试通过。需重启后端生效。

## 最新交付：平铺参数与折叠布局（2026-09-26）

- 用户已确认草图并授权实施。520px 参数浮层、紫色选中按钮、画幅无自定义入口、步数/种子/倍率原位自定义输入与悬停数值已实现。旧 custom 画幅配置仍保持，不静默改值。
- 参数摘要/高级/生成同排；扩展与缓存默认折叠，有启用摘要；状态持久化。customFields 使用整体替换，避免前端嵌套属性首次赋值后丢失。
- RTX 两处输入均改 FLOAT 1～4、step .01；倍率按钮 1.5/2/4/自定义。已有 RGB 转换保留，RGBA 原图不改写。官方接口已本地核对，输出尺寸按8像素对齐。
- 验证：Node35、Python13通过；语法检查通过。网页原位步数32、种子12345、倍率1.5及自定义2.37验证；自定义倍率2（与预设同值）的选择状态与种子12345序列化后仍保留；折叠/展开与配置恢复通过。
- 独立8001实际 RTX：RGBA64×64 -> 1.5× ULTRA -> RGB96×96，约0.95秒，原图RGBA保留。任务 b67a3db6-8ef6-4e18-9470-e8c577805948。输出 output/qwen_auto/upscaled/cb681bcd-64ae-40ac-80e9-07c2963384c2_00001_.png。
- 备份 <WORKSPACE_TMP>\qwen-tiled-panel-backup-20260926。入口模块版本参数20260926-tiled-2。常用8000未重启，必须重启才能加载FLOAT定义；桌面端最终显示仍待用户确认，不将网页实测等同桌面端恢复。

## 桌面端面板未加载排查（2026-09-26，待用户复验）

- 用户确认网页正常、桌面客户端显示原始参数；服务启动日志中本节点后端导入成功。尚未取得桌面端 JavaScript 错误，不能宣称根因已确认。
- 只读检查已安装 Comfy Desktop 代码：Ctrl+R / Ctrl+Shift+R / F5 均经 before-input-event 调用普通 loadURL；未执行忽略缓存重载，因此此前的快捷键操作未排除缓存。
- 面板入口的 5 个本地模块 import 添加统一版本参数 `20260926-workbench-2`，防止跨版本模块混用。语法检查通过，5 个带版本请求均 HTTP 200 且 MIME 为 text/javascript。
- 下一步：桌面端保存工作流后重新加载，确认自定义面板。如果仍失败，继续查该客户端的扩展禁用状态及实际脚本异常；不要改动模型配置或认定问题已解决。

## 最新交付：一体创作面板（2026-09-26，已实施）

本节为当前状态；下方旧记录保留为历史，不代表当前参数或验证情况。

- 已实现参数/高级悬浮面板、18/24/40/自定义步数、有效 LoRA 切自定义、种子四模式、输入区拖图、结果历史/命名/下载/放大、定向生成/取消/锁定、阶段动画与估时、独立 RTX 超分。
- 模块：`web/parameter-popover.mjs`、`web/generation-controller.mjs`、`web/result-preview.mjs`、`result_nodes.py`；集成在 `web/QwenImage21Auto.js`、`nodes.py`、`__init__.py`。原始四输出及旧输入位置保留；RTX 字段追加，历史和任务关联放 properties。
- 取消协议修正：使用核心 `/api/jobs/{id}/cancel` 的原子取消。检查后再调用 `/interrupt` 存在竞态，因此不使用旧计划的两次请求方案。不支持原子接口时提示，不回退全局中断。
- 最终自动检查：Node 35 项、ComfyUI 自带 venv Python unittest 12 项通过。Python 测试需用 `<COMFYUI_ROOT>\.venv\Scripts\python.exe`，全局 Python 缺少 torch。
- 独立 8001 服务实际 GPU：18 步、seed=100、1024×1024，约 34.70 秒；TE-speed 生效，KV 关闭。递增模式的下一种子为 101。RTX 2 倍 ULTRA 得到 2048×2048，约 1.63 秒，原图保留、种子仍 101。
- 实测 A 运行/B 排队：取消 B 未停止 A，再取消 A 恢复编辑且保留旧结果；提交后的种子不回退。重命名「窗边橘猫」、下载、放大/缩放/Esc、保存重开、同节点重新配置通过。浏览器合成拖图进入输入区：默认事件被阻止、节点数不增加、引用新增一张且原提示词保留。
- 测试工作流：`<WORKSPACE_TMP>\qwen-comfy-verification-user\default\workflows\QwenWorkbenchVerification.json`。原图 `output/qwen_auto/fe05a34b-ad24-414b-9bc9-54a7ad8d8d22_00001_.png`，超分 `output/qwen_auto/upscaled/25f29a1a-6c6c-4a05-a277-1e9b2b419816_00001_.png`。
- 限制：操作系统原生文件拖放未实测；4K/高倍率显存未实测；断连等异常路径主要由自动测试验证。KV 核心问题未修补，重新启用仍可能触发。
- 备份：`<WORKSPACE_TMP>\qwen-workbench-backup-20260926\comfy_qwen_image_auto`。目录无 Git。恢复备份时需同步去掉新增模块注册/引用，结果图片保留。
- 下一步：重启用户常用 8000 服务并新开/强制刷新页面，再手动确认原生拖图。常用服务未由本轮重启；独立 8001 测试服务和测试页已关闭，常用 8000 服务仍响应且队列为空。

更新日期：2026-09-25。上一轮范围见 `docs/superpowers/specs/2026-09-25-qwen-panel-update-design.md`；本轮范围见 `docs/superpowers/specs/2026-09-25-qwen-inline-references-design.md` 与 `docs/superpowers/plans/2026-09-25-qwen-inline-references.md`。

## 本次修正：KV 缓存与 TE-speed 分离

- 用户报错发生于 Qwen 2.1 核心 `PoseBranchCache.select`：缓存槽 key 形状不同时，`self.slots.remove(s)` 会比较字典内张量并抛出尺寸不匹配。出错工作流的 KV 卡片已停用，但原实现只是跳过 `QwenImage21Cache`，模型默认 Prefix KV 缓存仍在运行。ComfyUI 上游已记录同一问题：`Comfy-Org/ComfyUI#16511`。
- 当前节点把「停用 / 移除 KV」解析为 `device=off` 并明确写入模型选项；启用时保留设备与量化设置。先应用 KV 设置，后应用 TE-speed，与后者 README 的连接顺序一致。界面分为「推理加速」和「模型缓存」，不再把 KV 叫作加速组件。
- 旧工作流 `accel_json` 空值仍沿用旧 KV 参数；已有非空配置中的停用卡片会真正关闭缓存。相关测试：Python 5 项、Node 8 项通过，前端语法和 Python 编译检查通过。未运行实际 GPU 采样；本次 Python 后端改动需要重启 ComfyUI，前端需刷新。
- 这属于插件侧规避，不修改 ComfyUI 核心。若重新启用 KV 且触发不同形状缓存槽，上游 `#16511` 在核心修复前仍可能复现。关闭 KV 会增加耗时。

## 最新补充：分组、画幅和总像素预算

- 常用设置划为「创作内容 / 画面设置 / 排除内容 / 扩展组件 / 技术参数」，每组有分割线；展开技术参数后另分模型与采样。
- 提示词内仅有一个受支持的明确比例时自动选择画幅；多个不同的比例或不受支持比例造成歧义时不自动切换。用户手动改选后，同一提示词比例不反复覆盖手动值；工作流加载时已有非 auto 画幅保持原值。
- 1K/2K/4K 对应 `resolution=1024/2048/4096`，含义为正方形等效总像素预算（约 1/4/16 百万像素），画幅决定宽高。文生图非正方形尺寸改为按平方根计算并取 32 倍数；这改变了旧工作流在非正方形画幅时的输出尺寸。参考图编辑的画幅仍沿用首张参考图；`custom` 宽高继续优先决定输出。
- 新布局与比例识别属于前端更新；像素预算计算涉及 `nodes.py`，常用 8000 服务需要重启后才会应用。4K 实际模型生成和显存可行性未验证。
- 验证：Node 测试 8 项、Python 测试 4 项通过；前端语法和 Python 编译检查通过。独立 8001 服务中检查了分组与分割线，输入 `3:4` 后画幅自动切换；选择 2K 写入 `resolution=2048`，保存重开后仍保留手动改选的 `16:9` 和 2K。另以已有提示词「前缀 后缀」输入 `3:4`，原文字保留且画幅切换；手动改为 `16:9` 后继续输入及追加第二个比例，手动值均保留。测试页已关闭，独立服务在验证后停止。
- 本次修改前文件备份：`<WORKSPACE_TMP>\qwen-panel-layout-backup-20260925\`。未执行实际采样，未验证 4K 在本机 8GB 显存环境的可行性。

## 本轮已完成

- `prompt` 保留旧输入与位置式序列化；行内编辑器使用 `[[qwen-ref:ID]]` 保存参考图身份。输入 `@` 可选择参考图并生成含缩略图的标签；参考图换序时标签编号刷新，删图时显示失效。后端编码前转为当前顺序的 `<imageN>`；缺图、失效或前面的图无法读取时明确报错，避免错指。
- LoRA 文件选择改为节点外悬浮列表，支持搜索、方向键、回车、Esc 和点击外部关闭。取消添加不会留下空行。原有启用开关、强度和删除保持。
- 负面词方案移到常用区，默认「不使用」；新增文字排版、商品展示，调整通用低质量和人像增强的措辞，保留旧方案名。选择方案不自动调整 CFG，也不显示 CFG 门槛提示。
- 固定旧工作流 `widgets_values` 的原字段顺序；隐藏原始 prompt 文本框，仅显示行内编辑器，解决双层文字重叠。

## 本轮验证

- Node 内置测试 7 项、Python `unittest` 3 项通过；Python 编译与前端模块语法检查通过。
- 独立 8001 服务的节点定义返回默认「不使用」与全部 6 个方案。载入旧 `QwenPanelRegression.json` 后参数恢复正确；浏览器输入 `@` 后选图，保存并重新加载图数据，标签标记和旧参数仍在。换序后标签显示图片2，删图显示「图片已删除」。
- LoRA 浮层搜索 Viggle 文件并选中成功；按 Esc 取消后行数仍为 0。以上 UI 验证使用隔离测试页与既有测试图片，未运行实际模型采样。
- 本轮备份在 `<WORKSPACE_TMP>\qwen-panel-next-backup\`。常用 8000 服务的 Python 代码仍需重启才能载入本轮预设与引用解析；浏览器须打开新页或做强制刷新以取得新版前端模块。

## 已完成

- 参考图的文件 `drop` 在 document 捕获阶段同步阻止默认处理，然后异步上传。页面合成图片 drop 后仅增加缩略图，图节点数保持 1；面板外事件未被本扩展接管。
- 参考图保存 `{id,name}`，排序后 ID 跟随图片移动；界面可拖把手或点箭头换位，仍可替换和删除。`refs_json` 数组顺序仍对应后端 `image_1`…`image_10`。
- LoRA 行新增启用状态；禁用时后端跳过加载，强度 0 不再被改为 1。
- TE-speed 和 KV 缓存改为可独立停用、移除、添加的卡片。`accel_json` 为空时回退旧参数；新卡片按 LoRA → TE-speed → KV 缓存执行。TE-speed 未安装或调用失败、KV 参数无效或调用失败会写入 `status`。
- 推理强度快速/均衡/精细分别设步数 12/18/40；不改 CFG、采样器、降噪。活跃 Viggle Turbo LoRA 时阻止普通预设，提示专用采样参数。常用控件前置，高级设置折叠。
- 修正布局排序带来的 ComfyUI 位置式 `widgets_values` 兼容问题：新字段置于原字段之后，前端序列化按后端原输入顺序输出。

## 实际验证

- Node 内置测试 6 项通过；Python `unittest` 2 项通过；`nodes.py` / `panel_config.py` 编译检查和前端模块语法检查通过。
- 当前 8000 服务页面上：测试图片文件选择与合成图片 drop 成功；drop 的 `defaultPrevented=true`，节点数 1→1，参考图 1→2；点击箭头及拖动把手后顺序与 ID 正确移动。LoRA 加行、选文件、停用开关和强度 0 更新 JSON；活跃 Viggle Turbo 时普通预设被阻止，步数未改变。
- 独立 8001 测试服务加载了新版节点定义：TE-speed 停用、KV 移除与重新添加成功；快速预设写入 12 步。新格式序列化后重开仍保持 12 步和停用状态；模拟缺少新增字段的旧工作流后，旧步数和旧加速参数正常恢复。高级设置可展开，旧加速字段不再与卡片重复显示。
- 在独立测试用户目录保存 `<WORKSPACE_TMP>\qwen-comfy-verification-user\default\workflows\QwenPanelRegression.json`，重新加载页面后节点数、参考图 ID、快速 12 步和卡片配置仍在。
- 未跑实际模型采样、耗时/画质对比、原生操作系统文件拖入，也未验证 TE-speed 实际执行；目前未安装该组件。合成浏览器 drop 验证了事件路径，但不能代替原生拖放全部细节。

## 文件与现场

- 修改：`nodes.py`、`web/QwenImage21Auto.js`、`README.md`、`HANDOFF.md`。
- 新增：`panel_config.py`、`web/panel-state.mjs`、`tests/panel-state.test.mjs`、`tests/test_panel_config.py`。
- 原始文件备份在 `<WORKSPACE_TMP>\qwen-panel-update-backup\`；回退时按同名文件恢复，去掉本轮新增模块，并重启服务。此目录不是 Git 仓库，没有提交。
- 用户当前 8000 服务仍运行旧后端定义；要在常用服务看到加速卡片，需重启该服务并新开页面。独立 8001 测试服务已停止，测试工作流保留在隔离用户目录。
- 独立验证用的辅助图片仍保留在本地 ComfyUI 输入目录，不属于仓库交付内容。

## 后续首步

重启常用 ComfyUI 服务，新开页面；用操作系统实际拖入图片并检查仅有缩略图，再按本地模型环境测试生成、负面词 CFG 以及 TE-speed 效果。
