"""Dispatcher: detecta trabajo pendiente en Postgres y lo encola en Redis (single-shot por timer).

Multi-proceso y multi-marca. Para cada proceso "migrado" corre su detector (chequeo barato en la
base) y encola un job por ítem, con lock 'en vuelo' para no duplicar. El worker lo consume y corre
el job script correspondiente (claude -p, suscripción).

Gate por proceso: MIGRATED controla qué procesos maneja el dispatcher. Para rollback de uno solo,
sacalo de MIGRATED y reactivá su línea de cron (el dispatcher se lee del disco en cada tick).

PENDIENTE (backlog): reemplazar este poll por Postgres LISTEN/NOTIFY o push desde los productores.
"""
import sys

import jobqueue
from db import psql, heartbeat

# Procesos que maneja el dispatcher (los demás siguen en cron).
MIGRATED = {"correccion", "propuesta", "revision", "brief", "landing", "bibliotecario", "campania"}

# Cola de corrección: revisión rechazada, vigente de su pieza, no derivada a Fer.
COLA_CORR = (
    "contenido.revisiones r "
    "JOIN contenido.piezas pz ON pz.id=r.pieza_id AND pz.revision_vigente=r.id "
    "JOIN contenido.proyectos p ON p.id=pz.proyecto_id "
    "WHERE r.estado='rechazada' AND r.derivado_en IS NULL"
)


def log(msg):
    print(msg, flush=True)


def _lines(sql):
    out = psql(sql)
    return [ln for ln in out.splitlines() if ln.strip()]


def det_correccion():
    jobs = []
    for slug in _lines(f"SELECT DISTINCT p.slug FROM {COLA_CORR}"):
        revids = psql(f"SELECT string_agg(r.id::text, ', ') FROM {COLA_CORR} AND p.slug='{slug}'").strip()
        if revids:
            jobs.append({"tipo": "correccion", "proyecto_slug": slug,
                         "payload": {"revision_ids": revids}, "lock_key": f"correccion:{slug}"})
    return jobs


def det_propuesta():
    jobs = []
    for row in _lines("SELECT s.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.solicitudes_propuesta s "
                      "LEFT JOIN contenido.proyectos p ON p.id=s.proyecto_id "
                      "WHERE s.estado='pendiente' ORDER BY s.creado_en"):
        sid, slug = row.split('|', 1)
        jobs.append({"tipo": "propuesta", "proyecto_slug": slug,
                     "payload": {"solicitud_id": sid}, "lock_key": f"propuesta:{sid}"})
    return jobs


def det_revision():
    # Propuestas que Fer mandó a reescribir (loop "pedir nueva versión"): estado='revisar'.
    jobs = []
    for row in _lines("SELECT b.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.tg_briefs b "
                      "LEFT JOIN contenido.proyectos p ON p.id=b.proyecto_id "
                      "WHERE b.estado='revisar' ORDER BY b.creado_en"):
        bid, slug = row.split('|', 1)
        jobs.append({"tipo": "revision", "proyecto_slug": slug,
                     "payload": {"brief_id": bid}, "lock_key": f"revision:{bid}"})
    return jobs


def det_brief():
    jobs = []
    for row in _lines("SELECT b.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.tg_briefs b "
                      "LEFT JOIN contenido.proyectos p ON p.id=b.proyecto_id "
                      "WHERE b.estado='pendiente' ORDER BY b.creado_en"):
        bid, slug = row.split('|', 1)
        jobs.append({"tipo": "brief", "proyecto_slug": slug,
                     "payload": {"brief_id": bid}, "lock_key": f"brief:{bid}"})
    return jobs


def det_bibliotecario():
    # Recuperación: solicitudes 'procesando' atascadas (worker caído / job muerto) -> 'error'.
    # El job puede tardar hasta ~25 min (timeout de claude); 40 min es margen seguro.
    psql("UPDATE contenido.solicitudes_biblioteca SET estado='error', procesado_en=now() "
         "WHERE estado='procesando' AND creado_en < now() - interval '40 minutes'")
    # Solicitudes del bibliotecario (crear/editar assets de la biblioteca): estado='pendiente'.
    jobs = []
    for row in _lines("SELECT s.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.solicitudes_biblioteca s "
                      "LEFT JOIN contenido.proyectos p ON p.id=s.proyecto_id "
                      "WHERE s.estado='pendiente' ORDER BY s.creado_en"):
        sid, slug = row.split('|', 1)
        jobs.append({"tipo": "bibliotecario", "proyecto_slug": slug,
                     "payload": {"solicitud_id": sid}, "lock_key": f"bibliotecario:{sid}"})
    return jobs


def det_campania():
    # Recuperación: solicitudes 'procesando' atascadas (worker caído / job muerto) -> 'error'.
    psql("UPDATE contenido.solicitudes_campania SET estado='error', procesado_en=now() "
         "WHERE estado='procesando' AND creado_en < now() - interval '40 minutes'")
    # Pedidos de propuesta de campaña al creativo: estado='pendiente'.
    jobs = []
    for row in _lines("SELECT s.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.solicitudes_campania s "
                      "LEFT JOIN contenido.proyectos p ON p.id=s.proyecto_id "
                      "WHERE s.estado='pendiente' ORDER BY s.creado_en"):
        sid, slug = row.split('|', 1)
        jobs.append({"tipo": "campania", "proyecto_slug": slug,
                     "payload": {"solicitud_id": sid}, "lock_key": f"campania:{sid}"})
    return jobs


def det_landing():
    jobs = []
    for estado, accion in (("pendiente", "procesar"), ("aprobada", "aplicar")):
        for row in _lines(f"SELECT lc.id||'|'||p.slug FROM contenido.landing_cambios lc "
                          f"JOIN contenido.proyectos p ON p.id=lc.proyecto_id "
                          f"WHERE lc.estado='{estado}' ORDER BY lc.actualizado_en"):
            cid, slug = row.split('|', 1)
            jobs.append({"tipo": "landing", "proyecto_slug": slug,
                         "payload": {"cambio_id": cid, "accion": accion}, "lock_key": f"landing:{cid}"})
    return jobs  # landing no tiene proceso en la barra del panel -> sin heartbeat


DETECTORS = {
    "correccion": det_correccion,
    "propuesta": det_propuesta,
    "revision": det_revision,
    "brief": det_brief,
    "landing": det_landing,
    "bibliotecario": det_bibliotecario,
    "campania": det_campania,
}


def run():
    encolados = 0
    for tipo in ("correccion", "propuesta", "revision", "brief", "landing", "bibliotecario", "campania"):
        if tipo not in MIGRATED:
            continue
        try:
            for job in DETECTORS[tipo]():
                if jobqueue.acquire_inflight(job["lock_key"]):
                    jobqueue.enqueue(job)
                    encolados += 1
                    log(f"encolado {job['tipo']}/{job['proyecto_slug']} ({job['lock_key']})")
        except Exception as e:
            log(f"!! detector {tipo} falló: {e}")
    # Latido de salud del dispatcher (lo lee la barra de control de workers del panel).
    heartbeat("dispatcher", f"chequeo ok · {encolados} encolado(s)")


if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        log(f"!! error en dispatcher: {e}")
        sys.exit(1)
