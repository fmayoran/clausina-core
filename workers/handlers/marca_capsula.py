"""Handler de cápsula de marca -> scripts/marca_capsula_job.sh <accion> <slug>.
La cápsula es un artefacto derivado de la DB: scaffold al alta, archivar a la baja."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("marca_capsula_job.sh", [p.get("accion", "scaffold"), p["slug"]])
