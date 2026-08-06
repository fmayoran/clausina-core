"""Handler de notas de voz -> scripts/voz_job.sh <id_mensaje>.

Corre en el host porque whisper.cpp está compilado contra glibc y el panel es Alpine.
El audio se baja, se transcribe y se descarta: no se guarda el archivo.
"""
import agent_backend


def handle(job):
    p = job.get("payload") or {}
    return agent_backend.run_script("voz_job.sh", [str(p["mensaje_id"])])
