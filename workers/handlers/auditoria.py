"""Handler de la auditoría integral -> scripts/auditoria_job.sh <slug> <req_id>.

Mide la web contra el sitio vivo y el Instagram contra la serie que ya tiene la plataforma, los
compara con el benchmark y recién ahí le pide al creativo las recomendaciones.
"""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("auditoria_job.sh",
                                    [job.get("negocio_slug", ""), str(p["req_id"])])
