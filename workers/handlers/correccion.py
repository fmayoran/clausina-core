"""Handler de corrección de rechazos -> scripts/correccion_job.sh <slug> <revision_ids>."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("correccion_job.sh", [job["proyecto_slug"], p.get("revision_ids", "")])
