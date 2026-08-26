"""Handler de destilación de aprendizaje -> scripts/aprendizaje_job.sh <slug> <req_id>.
Lee las correcciones de Fer y propone reglas para el brief. NO escribe en el brief: propone."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("aprendizaje_job.sh", [job.get("negocio_slug") or "", p["req_id"]])
