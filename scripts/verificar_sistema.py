#!/usr/bin/env python3
"""Verificador de integridad de ClaUsina: detecta las roturas que NO avisan solas.

Nace de un incidente real (jul-2026): al renombrar proyecto->negocio, los workflows de n8n
quedaron con SQL apuntando a tablas que ya no existían. Publicar dejó de funcionar para TODOS
los negocios durante 3 días y nadie se enteró — el panel decía "publicando" y la pieza quedaba
pendiente. Ninguna prueba lo detectaba porque no había ninguna.

Chequea lo que puede romperse en silencio:
  1. n8n: cada tabla/columna que su SQL embebido referencia, ¿existe todavía en la base?
  2. n8n alcanzable desde el panel (el DNS del contenedor es intermitente).
  3. Respaldo: ¿corrió hoy y llegó AFUERA del VPS?
  4. Workers/dispatcher vivos (si mueren, todo queda encolado sin avisar).
  5. Jobs colgados en 'procesando' más de lo razonable.
  6. Piezas aprobadas que nunca se publicaron (el circuito quedó a mitad).
  7. Disco.

Uso:  verificar_sistema.py [--json]
Salida: 0 si todo OK, 1 si hay algún fallo. Pensado para cron (avisa por Telegram si falla).
"""
import json
import os
import re
import subprocess
import sys

N8N_SQLITE = "/var/lib/docker/volumes/crm_n8n_data/_data/database.sqlite"
BACKUP_LOG = "/root/backups/postgres/backup.log"
OK, FALLO, AVISO = "ok", "fallo", "aviso"


def sh(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def psql(sql):
    cid = sh("docker ps -q -f name=crm_pgvector.1.")
    if not cid:
        return None
    return sh(f'docker exec -i {cid} psql -U postgres -d claude -t -A -q -c "{sql}"')


# --- 1) El SQL embebido en n8n vs. el schema real ---------------------------------
def check_n8n_schema():
    if not os.path.exists(N8N_SQLITE):
        return AVISO, "no encuentro la base de n8n", []
    # OJO: SQLite NO interpreta '\t' como tabulador (lo toma literal). Consulto workflow por
    # workflow: es robusto ante JSON con saltos de línea y son una docena, no hay costo.
    nombres = [n for n in sh(
        f"sqlite3 {N8N_SQLITE} \"SELECT name FROM workflow_entity WHERE active=1;\"", 60).splitlines() if n.strip()]
    if not nombres:
        return AVISO, "no pude leer los workflows de n8n", []

    reales = set((psql(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='contenido' "
        "UNION SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace "
        "WHERE n.nspname='contenido'") or "").splitlines())
    if not reales:
        return FALLO, "no pude leer el schema de la base", []

    rotos, cols_rotas = [], []

    for wf in nombres:
        seguro = wf.replace("'", "''")
        nodes = sh(f"sqlite3 {N8N_SQLITE} \"SELECT nodes FROM workflow_entity "
                   f"WHERE active=1 AND name='{seguro}';\"", 60)
        if not nodes:
            continue
        for tabla in sorted(set(re.findall(r"contenido\.([a-z_]+)", nodes))):
            if tabla not in reales:
                rotos.append(f"{wf}: contenido.{tabla} NO EXISTE")
        # columnas con nombre viejo (el renombre proyecto->negocio dejó estas atrás)
        for col in sorted(set(re.findall(r"\b(proyecto_id|marca_id)\b", nodes))):
            cols_rotas.append(f"{wf}: usa la columna '{col}' (renombrada)")

    problemas = rotos + cols_rotas
    if problemas:
        return FALLO, f"{len(problemas)} referencia(s) rota(s) en n8n — publicar/notificar puede estar caído", problemas
    return OK, f"{len(nombres)} workflows activos, su SQL coincide con el schema", []


# --- 2) n8n alcanzable desde el panel ---------------------------------------------
def check_n8n_red():
    cid = sh("docker ps -q -f name=clausina_panel")
    if not cid:
        return FALLO, "el panel no está corriendo", []
    js = ("fetch('https://crm-n8n.dhmtev.easypanel.host/healthz',{signal:AbortSignal.timeout(8000)})"
          ".then(r=>console.log('OK'+r.status)).catch(e=>console.log('ERR'+(e.cause?.code||e.message)))")
    out = sh(f"docker exec {cid} node -e \"{js}\"", 30)
    if out.startswith("OK"):
        return OK, "el panel alcanza n8n", []
    return FALLO, f"el panel NO alcanza n8n ({out or 'sin respuesta'}) — aprobar/publicar va a fallar", []


# --- 3) Respaldo fuera del VPS -----------------------------------------------------
def check_backup():
    if not os.path.exists(BACKUP_LOG):
        return FALLO, "no hay log de respaldo", []
    ult = sh(f"tail -40 {BACKUP_LOG} | grep -E 'off-site (OK|sin cambios)' | tail -1")
    if not ult:
        err = sh(f"tail -10 {BACKUP_LOG} | grep ERROR | tail -1")
        return FALLO, f"el respaldo NO está saliendo del VPS. {err[:110]}", []
    dias = sh("python3 -c \"import datetime,sys;"
              "l=open('%s').read().splitlines();"
              "f=[x[:10] for x in l if 'off-site' in x and ('OK' in x or 'sin cambios' in x)];"
              "print((datetime.date.today()-datetime.date.fromisoformat(f[-1])).days if f else 99)\"" % BACKUP_LOG)
    try:
        d = int(dias)
    except Exception:
        d = 99
    if d > 2:
        return FALLO, f"el último respaldo off-site fue hace {d} días", []
    return OK, f"respaldo off-site al día (hace {d} día/s)", []


# --- 4) Motor vivo -----------------------------------------------------------------
def check_motor():
    out, probs = [], []
    for unidad, etiqueta in (("cf-worker", "worker"), ("cf-dispatcher.timer", "dispatcher")):
        est = sh(f"systemctl is-active {unidad}")
        if est not in ("active", "waiting"):
            probs.append(f"{etiqueta} ({unidad}) está '{est or 'desconocido'}'")
        else:
            out.append(f"{etiqueta} ok")
    if probs:
        return FALLO, "el motor no está sano: " + "; ".join(probs), probs
    return OK, ", ".join(out), []


# --- 5) Trabajos colgados ----------------------------------------------------------
def check_colgados():
    tablas = [("negocio_gen", "estilo/manual"), ("grafica_version", "gráfica"),
              ("negocio_descubrimiento", "alta de negocio"), ("solicitudes_propuesta", "propuestas"),
              ("solicitudes_biblioteca", "biblioteca")]
    colgados = []
    for t, etiqueta in tablas:
        n = psql(f"SELECT count(*) FROM contenido.{t} WHERE estado='procesando' "
                 f"AND creado_en < now()-interval '45 minutes'")
        if n and n.isdigit() and int(n) > 0:
            colgados.append(f"{etiqueta}: {n} colgado(s)")
    if colgados:
        return AVISO, "; ".join(colgados), colgados
    return OK, "sin trabajos colgados", []


# --- 6) Circuito de publicación a medio camino -------------------------------------
def check_publicacion():
    n = psql("SELECT count(*) FROM contenido.piezas pz JOIN contenido.revisiones r ON r.id=pz.revision_vigente "
             "WHERE r.estado='aprobada' AND r.publicado_en IS NULL "
             "AND r.actualizado_en < now()-interval '30 minutes'")
    if n and n.isdigit() and int(n) > 0:
        return FALLO, f"{n} pieza(s) aprobadas que NUNCA se publicaron (el circuito quedó a mitad)", []
    return OK, "sin piezas trabadas entre aprobar y publicar", []


# --- 7) Disco ----------------------------------------------------------------------
def check_disco():
    uso = sh("df -h / | tail -1 | awk '{print $5}'").rstrip("%")
    try:
        u = int(uso)
    except Exception:
        return AVISO, "no pude leer el disco", []
    n8n_mb = int(sh(f"du -sm {N8N_SQLITE} 2>/dev/null | cut -f1") or 0)
    extra = f" · sqlite de n8n: {n8n_mb} MB" if n8n_mb else ""
    if u >= 85:
        return FALLO, f"disco al {u}%{extra}", []
    if u >= 70 or n8n_mb > 2000:
        return AVISO, f"disco al {u}%{extra}", []
    return OK, f"disco al {u}%{extra}", []


CHEQUEOS = [
    ("n8n ↔ schema", check_n8n_schema),
    ("n8n alcanzable", check_n8n_red),
    ("respaldo off-site", check_backup),
    ("motor (worker/dispatcher)", check_motor),
    ("trabajos colgados", check_colgados),
    ("circuito de publicación", check_publicacion),
    ("disco", check_disco),
]


def main():
    como_json = "--json" in sys.argv
    res, hay_fallo = [], False
    for nombre, fn in CHEQUEOS:
        try:
            estado, msg, detalle = fn()
        except Exception as e:
            estado, msg, detalle = AVISO, f"el chequeo falló: {str(e)[:90]}", []
        if estado == FALLO:
            hay_fallo = True
        res.append({"chequeo": nombre, "estado": estado, "mensaje": msg, "detalle": detalle})

    if como_json:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        icono = {OK: "OK  ", FALLO: "FALLO", AVISO: "aviso"}
        for r in res:
            print(f"  [{icono[r['estado']]}] {r['chequeo']}: {r['mensaje']}")
            for d in r["detalle"][:6]:
                print(f"           - {d}")
    return 1 if hay_fallo else 0


if __name__ == "__main__":
    sys.exit(main())
