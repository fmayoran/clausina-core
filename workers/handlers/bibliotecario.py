"""Handler del bibliotecario -> scripts/bibliotecario_job.sh <slug> <solicitud_id>."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("bibliotecario_job.sh", [job["negocio_slug"], p["solicitud_id"]])
