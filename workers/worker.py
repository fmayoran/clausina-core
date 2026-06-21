"""Worker: consume jobs de la cola Redis y los despacha al handler por `tipo`.

Reemplaza el poll por cron de los procesos batch. Daemon de larga vida (systemd: cf-worker).
Escala horizontalmente: levantar N réplicas comparte la misma cola (BLPOP reparte).
"""
import sys
import traceback

import jobqueue
from db import heartbeat
from handlers import correccion

# Registry de handlers por tipo de job. Agregar acá cada proceso nuevo (briefs, propuestas, landings).
HANDLERS = {
    "correccion": correccion.handle,
}


def log(msg):
    print(msg, flush=True)


def process(job):
    tipo = job.get("tipo")
    slug = job.get("proyecto_slug", "?")
    handler = HANDLERS.get(tipo)
    if not handler:
        log(f"job desconocido tipo={tipo} -> descartado")
        return
    log(f"-> {tipo} / {slug}")
    try:
        ok, detalle = handler(job)
        log(f"<- {tipo} / {slug} ok={ok} :: {detalle[:200]}")
        heartbeat(tipo, f"{slug}: {'ok' if ok else 'error'}")
    except Exception as e:
        log(f"!! error procesando {tipo}/{slug}: {e}")
        traceback.print_exc()
        heartbeat(tipo, f"{slug}: excepción {e}")
    finally:
        # Libera el lock 'en vuelo' para que el dispatcher pueda reencolar si quedó trabajo.
        jobqueue.release_inflight(tipo, slug)


def run():
    log("worker iniciado, esperando jobs...")
    while True:
        try:
            job = jobqueue.dequeue(timeout=10)
            if job is None:
                continue
            process(job)
        except KeyboardInterrupt:
            log("worker detenido")
            sys.exit(0)
        except Exception as e:
            log(f"!! error en el loop del worker: {e}")
            traceback.print_exc()


if __name__ == "__main__":
    run()
