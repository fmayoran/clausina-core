"""Handler de corrección de rechazos. Delega en el backend, que corre el job script
verbatim (scripts/correccion_job.sh) para una marca y sus revision_ids."""
import agent_backend

TIPO = "correccion"


def handle(job):
    slug = job["proyecto_slug"]
    payload = job.get("payload") or {}
    ok, detalle = agent_backend.run(TIPO, slug, payload)
    return ok, detalle
