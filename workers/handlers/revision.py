"""Handler de revisión de concepto de propuesta -> scripts/revision_job.sh <slug> <brief_id>."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("revision_job.sh", [job["proyecto_slug"], p["brief_id"]])
