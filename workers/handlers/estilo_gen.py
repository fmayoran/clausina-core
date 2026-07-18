"""Handler de generación de estilo -> scripts/estilo_gen_job.sh <slug> <gen_id>.
El director de arte documenta el sistema de diseño desde el brief + lo publicado + IG."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("estilo_gen_job.sh", [job.get("proyecto_slug", ""), p["gen_id"]])
