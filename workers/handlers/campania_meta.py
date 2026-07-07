"""Handler de creación/activación de campañas en Meta -> scripts/pauta_publish_job.sh <accion> <id>.
Determinístico (no invoca al agente). Todo se crea PAUSADO; activar/pausar cambian el status."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("pauta_publish_job.sh", [p.get("accion", "crear"), p["campania_id"]])
