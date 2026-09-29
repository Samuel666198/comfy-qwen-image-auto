# Qwen 面板内联引用与负面词设计

已确认：`@` 参考图应成为可删除的行内标签；标签保存参考图稳定 ID，换序时编号更新，删图时显示失效并阻止生成。LoRA 选择列表悬浮于节点之外，支持搜索和键盘；取消选择不新增空行。负面词方案位于常用区，默认“不使用”。选择其他方案不自动改 CFG，也不提示 CFG 门槛。

兼容：旧 `prompt` 纯文本及 `<imageN>` 维持原样；新标签在 `prompt` 保存为 `[[qwen-ref:ID]]`，后端按 `refs_json` 当前顺序转换为 `<imageN>`。旧负面词方案名称保留。新预设依据官方示例做面向用途的建议，不宣称经 Qwen Image 2.1 实测优劣。

依据：[Qwen Image 2.1 文档](https://huggingface.co/docs/diffusers/main/api/pipelines/qwenimage21)、[Qwen 官方示例](https://github.com/QwenLM/Qwen-Image/blob/main/README.md)、本机 ComfyUI `comfy/text_encoders/qwen_image21.py` 中的 `<imageN>` 模板。
