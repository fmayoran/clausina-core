"""Handler de gráfica -> scripts/grafica_gen_job.sh <slug> <version_id>.
Diseña una versión de pieza gráfica (folleto/afiche/cartel): fondo IA si corresponde,
director de arte, y render a PDF de imprenta + PNG de preview."""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("grafica_gen_job.sh", [job.get("negocio_slug", ""), p["version_id"]])
