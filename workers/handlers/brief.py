"""Handler de briefs por voz -> scripts/brief_job.sh <slug> <brief_id>."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("brief_job.sh", [job["negocio_slug"], p["brief_id"]])
