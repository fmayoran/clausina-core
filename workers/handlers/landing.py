"""Handler de cambios de landing -> scripts/landing_job.sh <slug> <cambio_id> <accion>.
accion: 'procesar' (pendiente -> draft/preview) | 'aplicar' (aprobada -> producción)."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("landing_job.sh", [job["negocio_slug"], p["cambio_id"], p["accion"]])
