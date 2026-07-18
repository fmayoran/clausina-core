"""Worker: consume jobs de la cola Redis y los despacha al handler por `tipo`.

Reemplaza el poll por cron de los procesos batch. Daemon de larga vida (systemd: cf-worker).
Escala horizontalmente: levantar N réplicas comparte la misma cola (BLPOP reparte).
El heartbeat a contenido.batch_runs lo hace cada job script (con el nombre de proceso correcto).
"""
import sys
import traceback

import jobqueue
from db import heartbeat
from handlers import correccion, propuesta, revision, brief, landing, bibliotecario, campania, campania_meta, pauta_sync, secrets_sync, marca_capsula, descubrimiento, estilo_gen, manual_gen

# Registry de handlers por tipo de job.
HANDLERS = {
    "correccion": correccion.handle,
    "propuesta": propuesta.handle,
    "revision": revision.handle,
    "brief": brief.handle,
    "landing": landing.handle,
    "bibliotecario": bibliotecario.handle,
    "campania": campania.handle,
    "campania_meta": campania_meta.handle,
    "pauta_sync": pauta_sync.handle,
    "secrets_sync": secrets_sync.handle,
    "marca_capsula": marca_capsula.handle,
    "descubrimiento": descubrimiento.handle,
    "estilo_gen": estilo_gen.handle,
    "manual_gen": manual_gen.handle,
}


def log(msg):
    print(msg, flush=True)


def process(job):
    tipo = job.get("tipo")
    slug = job.get("proyecto_slug", "?")
    lock_key = job.get("lock_key")
    handler = HANDLERS.get(tipo)
    if not handler:
        log(f"job desconocido tipo={tipo} -> descartado")
        return
    log(f"-> {tipo} / {slug}")
    try:
        ok, detalle = handler(job)
        log(f"<- {tipo} / {slug} ok={ok} :: {(detalle or '')[:200]}")
    except Exception as e:
        log(f"!! error procesando {tipo}/{slug}: {e}")
        traceback.print_exc()
    finally:
        # Libera el lock 'en vuelo' para que el dispatcher pueda reencolar si quedó trabajo.
        if lock_key:
            jobqueue.release_inflight(lock_key)


def run():
    log("worker iniciado, esperando jobs...")
    heartbeat("worker", "en espera")
    while True:
        try:
            job = jobqueue.dequeue(timeout=10)
            if job is None:
                heartbeat("worker", "en espera")   # latido de salud (cada ~10s) cuando está libre
                continue
            heartbeat("worker", f"procesando {job.get('tipo')}/{job.get('proyecto_slug')}")
            process(job)
            heartbeat("worker", "en espera")
        except KeyboardInterrupt:
            log("worker detenido")
            sys.exit(0)
        except Exception as e:
            log(f"!! error en el loop del worker: {e}")
            traceback.print_exc()


if __name__ == "__main__":
    run()
