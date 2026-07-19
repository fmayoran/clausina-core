"""Handler de generación del manual de marca -> scripts/manual_gen_job.sh <slug> <gen_id>.
Convierte el estilo_md en un HTML autocontenido + PDF, guardados en el media store."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("manual_gen_job.sh", [job.get("negocio_slug", ""), p["gen_id"]])
