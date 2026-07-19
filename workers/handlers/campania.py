"""Handler de campañas -> scripts/campania_job.sh <slug> <solicitud_id>.
El creativo propone una campaña de pauta (no crea nada en Meta; deja un borrador para aprobar)."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("campania_job.sh", [job["negocio_slug"], p["solicitud_id"]])
