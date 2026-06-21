"""Seam de ejecución del agente (enchufable).

- headless (default, producción): ejecuta el job script bash que corre `claude -p --model sonnet`
  sobre la suscripción de Claude Code logueada en el host (/root/.claude). Costo de API = 0.
- api (futuro): generaría el prompt en Python y llamaría a la API (Opus 4.8) vía
  poc-multi-brand-agent/claude_client.py. Se activa con AGENT_BACKEND=api cuando haya volumen.

Cada job script (scripts/<tipo>_job.sh) encapsula el prompt y la lógica exacta de cada proceso,
extraídos verbatim de los scripts batch originales, por lo que el backend headless no re-deriva
nada del comportamiento previo.
"""
import os
import subprocess

from config import MOTOR, AGENT_BACKEND


def run_script(script_name, args):
    """Ejecuta scripts/<script_name> con los args dados. Devuelve (ok: bool, detalle: str)."""
    if AGENT_BACKEND == "api":
        raise NotImplementedError(
            "Backend 'api' aún no implementado para producción. "
            "Usar AGENT_BACKEND=headless (suscripción). Ver workers/README.md."
        )

    script = os.path.join(MOTOR, "scripts", script_name)
    if not os.path.exists(script):
        return False, f"no existe el job script {script}"

    env = dict(os.environ, HOME="/root")  # claude -p necesita /root/.claude
    proc = subprocess.run(
        ["bash", script, *[str(a) for a in args]],
        env=env,
        capture_output=True, text=True,
    )
    detalle = ((proc.stdout or "")[-400:] + (proc.stderr or "")[-400:]).strip()
    return proc.returncode == 0, detalle
