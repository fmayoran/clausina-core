"""Handler del chat de una pieza -> scripts/pieza_chat_job.sh <slug> <mensaje_id>.
Responde UN mensaje. El hilo entero se relee de la base en cada turno: es lo que da continuidad."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("pieza_chat_job.sh", [job.get("negocio_slug") or "", p["mensaje_id"]])
