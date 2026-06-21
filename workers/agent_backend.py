"""Seam de ejecución del agente (enchufable).

- headless (default, producción): ejecuta el job script bash que corre `claude -p --model sonnet`
  sobre la suscripción de Claude Code logueada en el host (/root/.claude). Costo de API = 0.
- api (futuro): generaría el prompt en Python y llamaría a la API (Opus 4.8) vía
  poc-multi-brand-agent/claude_client.py. Se activa con AGENT_BACKEND=api cuando haya volumen.

El job script encapsula el prompt y la lógica exacta de cada proceso, por lo que el backend
headless no re-deriva nada del comportamiento batch original.
"""
import os
import subprocess

from config import MOTOR, AGENT_BACKEND


def _job_script(tipo):
    return os.path.join(MOTOR, "scripts", f"{tipo}_job.sh")


def run(tipo, slug, payload):
    """Ejecuta un job. Devuelve (ok: bool, detalle: str)."""
    if AGENT_BACKEND == "api":
        raise NotImplementedError(
            "Backend 'api' aún no implementado para producción. "
            "Usar AGENT_BACKEND=headless (suscripción). Ver workers/README.md."
        )

    script = _job_script(tipo)
    if not os.path.exists(script):
        return False, f"no existe el job script {script}"

    revids = payload.get("revision_ids", "") if payload else ""
    env = dict(os.environ, HOME="/root")  # claude -p necesita /root/.claude
    proc = subprocess.run(
        ["bash", script, slug, revids],
        env=env,
        capture_output=True, text=True,
    )
    detalle = (proc.stdout or "")[-500:] + (proc.stderr or "")[-500:]
    return proc.returncode == 0, detalle.strip()
