"""Dispatcher de corrección (piloto: solo Cortafuego).

Single-shot: chequeo barato -> si hay rechazos, deriva los revision_ids de Cortafuego y encola
un job en Redis (con lock 'en vuelo' para no duplicar). Lo corre un timer systemd (cf-dispatcher).

PENDIENTE (backlog): quitar el filtro slug='cortafuego' (todas las marcas) y reemplazar este
poll por Postgres LISTEN/NOTIFY o push directo desde los productores (panel/n8n/telegram).
"""
import json
import sys
import urllib.request

import jobqueue
from db import psql, heartbeat
from config import N

PILOTO_SLUG = "cortafuego"
TIPO = "correccion"

COLA = (
    "contenido.revisiones r "
    "JOIN contenido.piezas pz ON pz.id=r.pieza_id AND pz.revision_vigente=r.id "
    "JOIN contenido.proyectos p ON p.id=pz.proyecto_id "
    "WHERE r.estado='rechazada' AND r.derivado_en IS NULL"
)


def log(msg):
    print(msg, flush=True)


def chequeo_barato():
    """¿Hay rechazos pendientes? (no invoca al agente). Devuelve la cantidad."""
    try:
        with urllib.request.urlopen(f"{N}/webhook/cf-rechazos-pendientes", timeout=25) as r:
            return len(json.loads(r.read().decode() or "[]"))
    except Exception:
        return 0


def run():
    n = chequeo_barato()
    if n == 0:
        heartbeat(TIPO, "sin rechazos")
        log("sin rechazos")
        return

    # Revids de la marca del piloto (la base es la fuente de verdad; el webhook puede divergir).
    revids = psql(f"SELECT string_agg(r.id::text, ', ') FROM {COLA} AND p.slug='{PILOTO_SLUG}'")
    if not revids:
        log(f"rechazos={n} pero ninguno de {PILOTO_SLUG}; nada que encolar")
        return

    if not jobqueue.acquire_inflight(TIPO, PILOTO_SLUG):
        log(f"{PILOTO_SLUG} ya tiene un job de {TIPO} en vuelo; no reencolo")
        return

    jobqueue.enqueue({
        "tipo": TIPO,
        "proyecto_slug": PILOTO_SLUG,
        "payload": {"revision_ids": revids},
    })
    heartbeat(TIPO, f"{PILOTO_SLUG}: encolado ({n} pend.)")
    log(f"encolado {TIPO}/{PILOTO_SLUG} revids=[{revids}]")


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        log(f"!! error en dispatcher: {e}")
        sys.exit(1)
