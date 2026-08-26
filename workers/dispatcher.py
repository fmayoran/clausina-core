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
MIGRATED = {"correccion", "propuesta", "revision", "brief", "landing", "bibliotecario", "campania", "campania_meta", "pauta_sync", "secrets_sync", "skill_sync", "contexto_sync", "campania_propuesta", "auditoria", "marca_capsula", "descubrimiento", "voz", "tarjeta", "marca_gen", "grafica", "aprendizaje"}

# Cola de corrección: revisión rechazada, vigente de su pieza, no derivada a Fer.
COLA_CORR = (
    "contenido.revisiones r "
    "JOIN contenido.piezas pz ON pz.id=r.pieza_id AND pz.revision_vigente=r.id "
    "JOIN contenido.negocios p ON p.id=pz.negocio_id "
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
            jobs.append({"tipo": "correccion", "negocio_slug": slug,
                         "payload": {"revision_ids": revids}, "lock_key": f"correccion:{slug}"})
    return jobs


def det_propuesta():
    jobs = []
    for row in _lines("SELECT s.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.solicitudes_propuesta s "
                      "LEFT JOIN contenido.negocios p ON p.id=s.negocio_id "
                      "WHERE s.estado='pendiente' ORDER BY s.creado_en"):
        sid, slug = row.split('|', 1)
        jobs.append({"tipo": "propuesta", "negocio_slug": slug,
                     "payload": {"solicitud_id": sid}, "lock_key": f"propuesta:{sid}"})
    return jobs


def det_revision():
    # Propuestas que Fer mandó a reescribir (loop "pedir nueva versión"): estado='revisar'.
    jobs = []
    for row in _lines("SELECT b.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.tg_briefs b "
                      "LEFT JOIN contenido.negocios p ON p.id=b.negocio_id "
                      "WHERE b.estado='revisar' ORDER BY b.creado_en"):
        bid, slug = row.split('|', 1)
        jobs.append({"tipo": "revision", "negocio_slug": slug,
                     "payload": {"brief_id": bid}, "lock_key": f"revision:{bid}"})
    return jobs


def det_brief():
    jobs = []
    for row in _lines("SELECT b.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.tg_briefs b "
                      "LEFT JOIN contenido.negocios p ON p.id=b.negocio_id "
                      "WHERE b.estado='pendiente' ORDER BY b.creado_en"):
        bid, slug = row.split('|', 1)
        jobs.append({"tipo": "brief", "negocio_slug": slug,
                     "payload": {"brief_id": bid}, "lock_key": f"brief:{bid}"})
    return jobs


def det_bibliotecario():
    # Recuperación: solicitudes 'procesando' atascadas (worker caído / job muerto) -> 'error'.
    # El job puede tardar hasta ~25 min (timeout de claude); 40 min es margen seguro.
    #
    # El reloj corre desde `iniciado_en` —cuándo ARRANCÓ— y no desde `creado_en`. Con creado_en,
    # reintentar un pedido viejo lo mataba al minuto siguiente de arrancar, y un pedido que había
    # esperado en cola moría apenas empezaba. Mismo criterio en todos los detectores de abajo.
    psql("UPDATE contenido.solicitudes_biblioteca SET estado='error', procesado_en=now() "
         "WHERE estado='procesando' AND COALESCE(iniciado_en, creado_en) < now() - interval '40 minutes'")
    # Solicitudes del bibliotecario (crear/editar assets de la biblioteca): estado='pendiente'.
    jobs = []
    for row in _lines("SELECT s.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.solicitudes_biblioteca s "
                      "LEFT JOIN contenido.negocios p ON p.id=s.negocio_id "
                      "WHERE s.estado='pendiente' ORDER BY s.creado_en"):
        sid, slug = row.split('|', 1)
        jobs.append({"tipo": "bibliotecario", "negocio_slug": slug,
                     "payload": {"solicitud_id": sid}, "lock_key": f"bibliotecario:{sid}"})
    return jobs


def det_campania():
    # Recuperación: solicitudes 'procesando' atascadas (worker caído / job muerto) -> 'error'.
    psql("UPDATE contenido.solicitudes_campania SET estado='error', procesado_en=now() "
         "WHERE estado='procesando' AND COALESCE(iniciado_en, creado_en) < now() - interval '40 minutes'")
    # Pedidos de propuesta de campaña al creativo: estado='pendiente'.
    jobs = []
    for row in _lines("SELECT s.id||'|'||COALESCE(p.slug,'cortafuego') "
                      "FROM contenido.solicitudes_campania s "
                      "LEFT JOIN contenido.negocios p ON p.id=s.negocio_id "
                      "WHERE s.estado='pendiente' ORDER BY s.creado_en"):
        sid, slug = row.split('|', 1)
        jobs.append({"tipo": "campania", "negocio_slug": slug,
                     "payload": {"solicitud_id": sid}, "lock_key": f"campania:{sid}"})
    return jobs


def det_voz():
    # Notas de voz de WhatsApp sin transcribir. La marca de "pedida" la pone el propio script al
    # arrancar: si se marcara acá y el job fallara, el audio quedaría sin transcribir para siempre.
    jobs = []
    for row in _lines("SELECT m.id||'|'||n.slug FROM contenido.whatsapp_mensaje m "
                      "JOIN contenido.negocios n ON n.id=m.negocio_id "
                      "WHERE m.tipo='audio' AND m.texto IS NULL "
                      "AND m.media_id IS NOT NULL AND NOT m.transcripcion_pedida "
                      "ORDER BY m.creado_en LIMIT 20"):
        mid, slug = row.split('|', 1)
        if mid:
            jobs.append({"tipo": "voz", "negocio_slug": slug,
                         "payload": {"mensaje_id": mid}, "lock_key": f"voz:{mid}"})
    return jobs


def det_tarjeta():
    # La tarjeta de una reserva recién tomada. Ventana corta a propósito: si el pedido quedó
    # colgado media hora, la persona ya cerró el chat y mandarle la imagen ahí es peor que no
    # mandarla. Vencidos quedan como error, no reintentando para siempre.
    psql("UPDATE contenido.tarjeta_req SET estado='error', error='no se alcanzó a dibujar', "
         "hecho_en=now() WHERE estado='pendiente' AND pedido_en < now() - interval '30 minutes'")
    jobs = []
    for row in _lines("SELECT t.reserva_id||'|'||n.slug FROM contenido.tarjeta_req t "
                      "JOIN contenido.negocios n ON n.id=t.negocio_id "
                      "WHERE t.estado='pendiente' ORDER BY t.pedido_en LIMIT 10"):
        rid, slug = row.split('|', 1)
        if rid:
            jobs.append({"tipo": "tarjeta", "negocio_slug": slug,
                         "payload": {"reserva_id": rid}, "lock_key": f"tarjeta:{rid}"})
    return jobs


def det_aprendizaje():
    # Destilación de lo que Fer corrigió: pedidos pendientes.
    jobs = []
    for row in _lines("SELECT r.id||'|'||COALESCE(p.slug,'') FROM contenido.aprendizaje_req r "
                      "LEFT JOIN contenido.negocios p ON p.id=r.negocio_id "
                      "WHERE r.estado='pendiente' ORDER BY r.creado_en"):
        rid, slug = row.split('|', 1)
        if rid and slug:
            jobs.append({"tipo": "aprendizaje", "negocio_slug": slug,
                         "payload": {"req_id": rid}, "lock_key": f"aprendizaje:{slug}"})
    return jobs


def det_skill_sync():
    # La DB manda y el archivo .md es la copia derivada: cuando alguien guarda un skill en el
    # panel, hay que reescribir ~/.claude/skills/<slug>/SKILL.md. El panel corre en un contenedor
    # y no puede escribir en el disco del host, así que deja el pedido y esto lo levanta.
    jobs = []
    for row in _lines("SELECT DISTINCT slug FROM contenido.skill_sync_req WHERE NOT procesado"):
        slug = row.strip()
        if slug:
            jobs.append({"tipo": "skill_sync", "negocio_slug": "",
                         "payload": {"slug": slug}, "lock_key": f"skill_sync:{slug}"})
    if jobs:
        psql("UPDATE contenido.skill_sync_req SET procesado=true WHERE NOT procesado")
    return jobs


def det_campania_propuesta():
    # El creativo propone las acciones de una campaña. Recuperación primero: el reloj corre desde
    # que arrancó, no desde que se pidió (ver iniciado_en).
    psql("UPDATE contenido.campania_propuesta SET estado='error', "
         "error='Se quedó colgado. Probá de nuevo.', procesado_en=now() "
         "WHERE estado='procesando' AND COALESCE(iniciado_en, creado_en) < now() - interval '40 minutes'")
    jobs = []
    for row in _lines("SELECT p.id||'|'||COALESCE(n.slug,'') FROM contenido.campania_propuesta p "
                      "JOIN contenido.campania c ON c.id=p.campania_id "
                      "JOIN contenido.negocios n ON n.id=c.negocio_id "
                      "WHERE p.estado='pendiente' ORDER BY p.creado_en"):
        pid, slug = row.split('|', 1)
        if pid and slug:
            jobs.append({"tipo": "campania_propuesta", "negocio_slug": slug,
                         "payload": {"propuesta_id": pid}, "lock_key": f"campania_propuesta:{pid}"})
    return jobs


def det_auditoria():
    # Auditoría integral de presencia digital. Recuperación primero: el reloj corre desde que
    # arrancó, no desde que se pidió (ver iniciado_en).
    psql("UPDATE contenido.auditoria_req SET estado='error', "
         "error='Se quedó colgada. Probá de nuevo.', procesado_en=now() "
         "WHERE estado='procesando' AND COALESCE(iniciado_en, creado_en) < now() - interval '40 minutes'")
    jobs = []
    for row in _lines("SELECT a.id||'|'||COALESCE(n.slug,'') FROM contenido.auditoria_req a "
                      "JOIN contenido.negocios n ON n.id=a.negocio_id "
                      "WHERE a.estado='pendiente' ORDER BY a.creado_en"):
        rid, slug = row.split('|', 1)
        if rid and slug:
            jobs.append({"tipo": "auditoria", "negocio_slug": slug,
                         "payload": {"req_id": rid}, "lock_key": f"auditoria:{rid}"})
    return jobs


def det_contexto_sync():
    # El contexto que lee el creativo (CONTEXTO_MARCA / ESTILO / REFERENCIAS) se regenera cuando
    # cambia la Identidad del negocio. Antes sólo se rehacía al correr un job del creativo, así
    # que editar en el panel no lo actualizaba y el agente trabajaba con una versión vieja.
    jobs = []
    for row in _lines("SELECT DISTINCT slug FROM contenido.contexto_sync_req WHERE NOT procesado"):
        slug = row.strip()
        if slug:
            jobs.append({"tipo": "contexto_sync", "negocio_slug": slug,
                         "payload": {"slug": slug}, "lock_key": f"contexto_sync:{slug}"})
    if jobs:
        psql("UPDATE contenido.contexto_sync_req SET procesado=true WHERE NOT procesado")
    return jobs


def det_marca_capsula():
    # La cápsula deriva de la DB: aplicar pedidos de scaffold/archivar (un job por pedido).
    jobs = []
    for row in _lines("SELECT slug||'|'||accion FROM contenido.negocio_capsula_req WHERE NOT procesado ORDER BY pedido_en"):
        slug, accion = row.split('|', 1)
        if slug:
            jobs.append({"tipo": "marca_capsula", "negocio_slug": slug,
                         "payload": {"slug": slug, "accion": accion}, "lock_key": f"marca_capsula:{slug}"})
    if jobs:
        psql("UPDATE contenido.negocio_capsula_req SET procesado=true WHERE NOT procesado")
    return jobs


def det_descubrimiento():
    # Análisis de presencia digital para el wizard de alta. Corre antes de que la marca exista:
    # la marca todavía no tiene slug propio en proyectos -> el job es agnóstico (no usa cápsula).
    psql("UPDATE contenido.negocio_descubrimiento SET estado='error', "
         "error='El análisis se quedó colgado. Probá de nuevo o cargá los datos a mano.', procesado_en=now() "
         "WHERE estado='procesando' AND COALESCE(iniciado_en, creado_en) < now() - interval '20 minutes'")
    jobs = []
    for did in _lines("SELECT id FROM contenido.negocio_descubrimiento WHERE estado='pendiente' ORDER BY creado_en"):
        did = did.strip()
        jobs.append({"tipo": "descubrimiento", "negocio_slug": "clausina",
                     "payload": {"descubrimiento_id": did}, "lock_key": f"descubrimiento:{did}"})
    return jobs


def det_marca_gen():
    # Generación de estilo y manual de marca por el creativo. Un job por pedido pendiente.
    # Recuperación de colgados: el manual/estilo puede tardar (claude -p); 40 min es margen seguro.
    psql("UPDATE contenido.negocio_gen SET estado='error', "
         "error='Se quedó colgado. Probá de nuevo.', procesado_en=now() "
         "WHERE estado='procesando' AND COALESCE(iniciado_en, creado_en) < now() - interval '40 minutes'")
    jobs = []
    for row in _lines("SELECT g.id||'|'||g.tipo||'|'||COALESCE(p.slug,'') "
                      "FROM contenido.negocio_gen g JOIN contenido.negocios p ON p.id=g.negocio_id "
                      "WHERE g.estado='pendiente' ORDER BY g.creado_en"):
        gid, tipo, slug = row.split('|', 2)
        if slug:
            jobs.append({"tipo": tipo + "_gen", "negocio_slug": slug,
                         "payload": {"gen_id": gid}, "lock_key": f"{tipo}_gen:{gid}"})
    return jobs


def det_grafica():
    # Diseño de piezas gráficas (folletos, afiches, vía pública). Una versión por pedido.
    psql("UPDATE contenido.grafica_version SET estado='error', "
         "error='Se quedó colgado. Probá de nuevo.', procesado_en=now() "
         "WHERE estado='procesando' AND COALESCE(iniciado_en, creado_en) < now() - interval '40 minutes'")
    jobs = []
    for row in _lines("SELECT v.id||'|'||COALESCE(n.slug,'') FROM contenido.grafica_version v "
                      "JOIN contenido.grafica g ON g.id=v.grafica_id "
                      "JOIN contenido.negocios n ON n.id=g.negocio_id "
                      "WHERE v.estado='pendiente' ORDER BY v.creado_en"):
        vid, slug = row.split('|', 1)
        if slug:
            jobs.append({"tipo": "grafica", "negocio_slug": slug,
                         "payload": {"version_id": vid}, "lock_key": f"grafica:{vid}"})
    return jobs


def det_secrets_sync():
    # La DB es la fuente de verdad: cuando cambia un token en el perfil, regeneramos los
    # secretos derivados (hoy: credencial de IG en n8n). Un job por marca pedida.
    jobs = []
    for row in _lines("SELECT DISTINCT slug FROM contenido.secrets_sync_req WHERE NOT procesado"):
        slug = row.strip()
        if slug:
            jobs.append({"tipo": "secrets_sync", "negocio_slug": slug,
                         "payload": {"slug": slug}, "lock_key": f"secrets_sync:{slug}"})
    if jobs:
        psql("UPDATE contenido.secrets_sync_req SET procesado=true WHERE NOT procesado")
    return jobs


def det_pauta_sync():
    # Refresco de pauta on-demand (botón "Actualizar ahora"): si hay pedidos sin procesar,
    # los marca y encola UN sync (el script sincroniza todas las marcas configuradas).
    pend = psql("SELECT count(*) FROM contenido.pauta_sync_req WHERE NOT procesado").strip()
    if not pend or pend == '0':
        return []
    psql("UPDATE contenido.pauta_sync_req SET procesado=true WHERE NOT procesado")
    return [{"tipo": "pauta_sync", "negocio_slug": "cortafuego",
             "payload": {}, "lock_key": "pauta_sync"}]


def det_campania_meta():
    # Creación en Meta de campañas aprobadas (aún sin crear) + pedidos de activar/pausar.
    specs = {
        "crear":   "c.estado='aprobada' AND c.meta_campaign_id IS NULL",
        "activar": "c.estado='activar'",
        "pausar":  "c.estado='pausar'",
        "borrar":  "c.estado='descartar'",
    }
    jobs = []
    for accion, cond in specs.items():
        for row in _lines("SELECT c.id||'|'||COALESCE(p.slug,'cortafuego') "
                          "FROM contenido.pauta_campania c LEFT JOIN contenido.negocios p ON p.id=c.negocio_id "
                          f"WHERE {cond} ORDER BY c.actualizado_en"):
            cmid, slug = row.split('|', 1)
            jobs.append({"tipo": "campania_meta", "negocio_slug": slug,
                         "payload": {"campania_id": cmid, "accion": accion},
                         "lock_key": f"campania_meta:{cmid}"})
    return jobs


def det_landing():
    jobs = []
    for estado, accion in (("pendiente", "procesar"), ("aprobada", "aplicar")):
        for row in _lines(f"SELECT lc.id||'|'||p.slug FROM contenido.landing_cambios lc "
                          f"JOIN contenido.negocios p ON p.id=lc.negocio_id "
                          f"WHERE lc.estado='{estado}' ORDER BY lc.actualizado_en"):
            cid, slug = row.split('|', 1)
            jobs.append({"tipo": "landing", "negocio_slug": slug,
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
    "campania_meta": det_campania_meta,
    "pauta_sync": det_pauta_sync,
    "secrets_sync": det_secrets_sync,
    "skill_sync": det_skill_sync,
    "aprendizaje": det_aprendizaje,
    "contexto_sync": det_contexto_sync,
    "campania_propuesta": det_campania_propuesta,
    "auditoria": det_auditoria,
    "marca_capsula": det_marca_capsula,
    "descubrimiento": det_descubrimiento,
    "voz": det_voz,
    "tarjeta": det_tarjeta,
    "marca_gen": det_marca_gen,
    "grafica": det_grafica,
}


def run(solo=None):
    """`solo` limita la corrida a esos detectores. Lo usa el timer rápido de las notas de voz:
    del otro lado hay un cliente esperando la respuesta, y un ciclo de 60 s es demasiado. El
    resto de los procesos no tiene a nadie mirando, así que sigue en la cadencia normal.
    Encolar dos veces el mismo ítem es inofensivo: acquire_inflight lo deduplica."""
    encolados = 0
    # Se recorre DETECTORS y no una lista aparte: tener las dos obliga a acordarse de las dos,
    # y olvidarse de la segunda NO da error — el detector simplemente no corre nunca.
    for tipo in DETECTORS:
        if tipo not in MIGRATED or (solo and tipo not in solo):
            continue
        try:
            for job in DETECTORS[tipo]():
                if jobqueue.acquire_inflight(job["lock_key"]):
                    jobqueue.enqueue(job)
                    encolados += 1
                    log(f"encolado {job['tipo']}/{job['negocio_slug']} ({job['lock_key']})")
        except Exception as e:
            log(f"!! detector {tipo} falló: {e}")
    # Latido de salud del dispatcher (lo lee la barra de control de workers del panel). Sólo lo
    # escribe la corrida COMPLETA: si lo escribiera también la parcial, el panel mostraría verde
    # aunque hiciera media hora que no se chequea nada más que las notas de voz.
    if not solo:
        heartbeat("dispatcher", f"chequeo ok · {encolados} encolado(s)")


if __name__ == "__main__":
    try:
        run(solo=set(sys.argv[1:]) or None)
    except Exception as e:
        log(f"!! error en dispatcher: {e}")
        sys.exit(1)
