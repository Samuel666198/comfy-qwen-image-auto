# Qwen Image 2.1 提示词改写模板

以下两份是 2026-09-26 获取并保留的上游官方 PE system prompt 原文副本，用于溯源，不由本插件的通用 Ollama / Responses API 优化链路直接加载：

- `qwen_2_1_t2i.txt`: https://huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I/blob/main/system_prompt.txt
- `qwen_2_1_edit.txt`: https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I/blob/main/system_prompt.txt
- Usage and output contract: https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/README.md

这两份模板面向各自专用微调 PE 模型。官方文生图模板要求英文长段落，编辑模板会按输入语言处理；将其直接用于其他通用模型不保证相同效果。本插件保持上游副本不变，实际执行使用下方的中文精简模板，并令输出语言跟随用户输入。

## On-demand local Ollama templates

`optimizer_router.txt`、`optimizer_t2i_core.txt`、`optimizer_edit_core.txt` 和 `modules/` 下的模板均为中文本地适配规则，不是上游原文。路由器只选择最多三个可选模块而不改写请求；后端按文生图或编辑任务加载对应核心模板与被选模块。多张参考图会在代码中强制加入 `reference_composition`。路由结果受固定模块白名单校验；无效结果回退为仅使用任务核心模板。

Ollama 和 Responses API 都把流式增量转为 server-sent events 预览；只有完整且有效的 JSON 结果才替换用户提示词，取消或报错会丢弃临时预览。Ollama 路由阶段只收提示词和参考图数量，最终视觉模型请求按当前引用顺序接收实际图片及提示词；Responses API 遵循同一约定，并在模型明确声明不支持图片时拒绝编辑优化。API 模型列表不提供下载模型的能力，因此界面只刷新列表，列表端点不可用时允许手动输入模型 ID。

Responses API 密钥保存在 ComfyUI 本机 `user/qwen_image_auto_prompt_optimizer.json`，密钥不保存在工作流或客户端插件状态中。API 请求通过本地服务端代理发出，使用 Bearer 鉴权；重定向被拒绝，远程地址必须为 HTTPS，本机兼容服务可使用回环 HTTP。

The upstream repository declares `qwen-research` (research/evaluation, non-commercial). Its original license and required attribution are retained in `QWEN_RESEARCH_LICENSE.txt` and `NOTICE.txt`. Commercial use requires the upstream commercial permission described in that license.
