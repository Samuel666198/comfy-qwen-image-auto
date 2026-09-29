from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

from .result_nodes import QwenImage21AutoUpscale
from .result_files import register_routes
from .prompt_optimizer import register_routes as register_optimizer_routes

register_routes()
register_optimizer_routes()

NODE_CLASS_MAPPINGS["QwenImage21AutoUpscale"] = QwenImage21AutoUpscale
NODE_DISPLAY_NAME_MAPPINGS["QwenImage21AutoUpscale"] = "Qwen RTX 独立超分"

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
