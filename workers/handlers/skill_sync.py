"""Handler de sincronización de skills -> scripts/skills_sync.py <slug>.

Corre en el host porque el destino es ~/.claude/skills, que vive en el disco del host y no en
el contenedor del panel. La DB es la fuente de verdad; esto sólo escribe la copia derivada.
"""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("skills_sync_job.sh", [str(p.get("slug") or "")])
