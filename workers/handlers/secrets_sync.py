"""Handler de regeneración de secretos derivados -> scripts/sync_secrets_job.sh <slug>.
Determinístico (sin agente): descifra en el host y repunta la credencial de n8n."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("sync_secrets_job.sh", [p.get("slug", "cortafuego")])
