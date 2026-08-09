"""Handler de la propuesta de campaña -> scripts/campania_propuesta_job.sh <slug> <propuesta_id>.

El creativo lee el contexto del negocio y propone las acciones. No crea nada: deja sugerencias
para que una persona acepte de a una.
"""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("campania_propuesta_job.sh",
                                    [job.get("negocio_slug", ""), str(p["propuesta_id"])])
