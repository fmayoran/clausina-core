import json
import os
import re

import anthropic

# Modelo por defecto: el más capaz de la familia Claude.
DEFAULT_MODEL = "claude-opus-4-8"


def _extraer_json(texto):
    """Intenta parsear el texto como JSON; si viene envuelto en ```json ... ```
    lo limpia primero. Devuelve None si no es JSON válido."""
    limpio = texto.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", limpio, re.DOTALL)
    if fence:
        limpio = fence.group(1).strip()
    try:
        return json.loads(limpio)
    except (ValueError, TypeError):
        return None


class ClaudeClient:
    def __init__(self, api_key=None, model=DEFAULT_MODEL):
        # El SDK toma ANTHROPIC_API_KEY del entorno por defecto; aceptamos
        # también CLAUDE_API_KEY por compatibilidad con la config previa del PoC.
        key = api_key or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_API_KEY")
        self.client = anthropic.Anthropic(api_key=key) if key else anthropic.Anthropic()
        self.model = model

    def generate(self, prompt, max_tokens=2000):
        response = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            thinking={"type": "adaptive"},
            messages=[{"role": "user", "content": prompt}],
        )

        if response.stop_reason == "refusal":
            return {
                "model": response.model,
                "stop_reason": response.stop_reason,
                "output": None,
                "raw_text": "",
                "error": "El modelo rechazó la solicitud por motivos de seguridad.",
            }

        texto = "".join(b.text for b in response.content if b.type == "text").strip()

        return {
            "model": response.model,
            "stop_reason": response.stop_reason,
            "output": _extraer_json(texto),
            "raw_text": texto,
            "usage": {
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
            },
        }
