"""Handler del refresco de pauta on-demand -> scripts/pauta_sync_job.sh (determinístico, sin agente)."""
import agent_backend


def handle(job):
    return agent_backend.run_script("pauta_sync_job.sh", [])
