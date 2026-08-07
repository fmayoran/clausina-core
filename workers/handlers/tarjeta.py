"""Handler de la tarjeta de reserva -> scripts/tarjeta_job.sh <reserva_id>.

Corre en el host porque hay que abrir un navegador para dibujarla: la imagen del panel es
Alpine y no trae chromium. El envío por WhatsApp lo hace el panel, que es quien tiene el token.
"""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("tarjeta_job.sh", [str(p["reserva_id"])])
