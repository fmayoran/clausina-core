"""Handler del contexto de marca -> scripts/contexto_sync_job.sh <slug>.

Corre en el host porque escribe en la cápsula del negocio (marcas/<slug>/contexto/), que vive
en el disco del host. La base es la fuente de verdad; esto sólo rehace las copias derivadas.
"""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("contexto_sync_job.sh", [str(p.get("slug") or "")])
