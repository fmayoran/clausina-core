"""Handler de descubrimiento de marca -> scripts/descubrir_marca_job.sh <id>.
Analiza la presencia digital pública (web + IG + búsqueda) para pre-cargar el alta de marca.
Corre antes de que la marca exista: no hay cápsula ni proyecto_id."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("descubrir_marca_job.sh", [p["descubrimiento_id"]])
