#!/usr/bin/env python3
"""Sync de Pauta: le pega a la Meta Marketing API con el token de cada cápsula y guarda el
último snapshot en contenido.ads_snapshot. El panel lee de la DB (no hace llamadas externas).

Corre en el host (donde viven los <slug>.env y el contenedor Postgres). Lo dispara el timer
systemd cf-pauta-sync. Read-only: sólo GET a Graph API; nunca crea ni edita campañas.
"""
import json
import secrets
import subprocess
import sys
import urllib.parse
import urllib.request

GRAPH = "https://graph.facebook.com/v21.0"
PG_NAME_FILTER = "crm_pgvector.1."
MARCAS_DIR = "/root/clausina/marcas"


def discover_brands():
    """Agnóstico: recorre las marcas (proyectos) y devuelve las que tienen credenciales de ads
    (META_ADS_ACCOUNT_ID + META_ADS_TOKEN) en su cápsula marcas/<slug>/<slug>.env."""
    brands = {}
    for slug in [s for s in psql("SELECT slug FROM contenido.proyectos ORDER BY slug").splitlines() if s.strip()]:
        path = f"{MARCAS_DIR}/{slug}/{slug}.env"
        env = load_env(path)
        if env.get("META_ADS_ACCOUNT_ID") and env.get("META_ADS_TOKEN"):
            brands[slug] = path
    return brands

# Códigos de estado de cuenta publicitaria (subset habitual).
ACCOUNT_STATUS = {
    1: "Activa", 2: "Deshabilitada", 3: "Sin liquidar", 7: "En revisión de riesgo",
    8: "Pago pendiente", 9: "Período de gracia", 100: "Cierre pendiente",
    101: "Cerrada", 201: "Activa", 202: "Cerrada",
}
EFFECTIVE_STATUS = {
    "ACTIVE": "Activa", "PAUSED": "Pausada", "DELETED": "Eliminada",
    "ARCHIVED": "Archivada", "IN_PROCESS": "En proceso", "WITH_ISSUES": "Con problemas",
    "CAMPAIGN_PAUSED": "Campaña pausada", "ADSET_PAUSED": "Conjunto pausado",
}
OBJETIVOS = {
    "OUTCOME_TRAFFIC": "Tráfico", "OUTCOME_ENGAGEMENT": "Interacción",
    "OUTCOME_AWARENESS": "Reconocimiento", "OUTCOME_LEADS": "Clientes potenciales",
    "OUTCOME_SALES": "Ventas", "OUTCOME_APP_PROMOTION": "Promoción de app",
}


def load_env(path):
    d = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return d


def graph_get(path, token, params=None):
    q = dict(params or {})
    q["access_token"] = token
    url = f"{GRAPH}/{path}?{urllib.parse.urlencode(q)}"
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)


def num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def cents(v):
    """Meta devuelve amount_spent/balance/budget en centavos (minor units)."""
    return round(num(v) / 100, 2)


def build_snapshot(act, token):
    if not act.startswith("act_"):
        act = "act_" + act

    cuenta_raw = graph_get(act, token, {
        "fields": "name,currency,account_status,amount_spent,balance,spend_cap"})
    cuenta = {
        "nombre": cuenta_raw.get("name"),
        "moneda": cuenta_raw.get("currency"),
        "estado": cuenta_raw.get("account_status"),
        "estado_txt": ACCOUNT_STATUS.get(cuenta_raw.get("account_status"), "—"),
        "gastado_total": cents(cuenta_raw.get("amount_spent")),
        "saldo": cents(cuenta_raw.get("balance")),
    }

    camp_raw = graph_get(f"{act}/campaigns", token, {
        "fields": "name,objective,effective_status,daily_budget,lifetime_budget,start_time,stop_time",
        "limit": 100})
    campanias = camp_raw.get("data", [])

    # Insights por campaña (últimos 30 días) -> mapa por campaign_id.
    ins_by_camp = {}
    totales = {"gasto": 0.0, "impresiones": 0, "alcance": 0, "clics": 0, "ctr": 0.0}
    try:
        ins = graph_get(f"{act}/insights", token, {
            "date_preset": "last_30d", "level": "campaign",
            "fields": "campaign_id,spend,impressions,reach,clicks,ctr,actions", "limit": 200})
        for row in ins.get("data", []):
            ins_by_camp[row.get("campaign_id")] = row
        acct = graph_get(f"{act}/insights", token, {
            "date_preset": "last_30d",
            "fields": "spend,impressions,reach,clicks,ctr", "limit": 1})
        a = (acct.get("data") or [{}])[0]
        totales = {
            "gasto": round(num(a.get("spend")), 2),
            "impresiones": int(num(a.get("impressions"))),
            "alcance": int(num(a.get("reach"))),
            "clics": int(num(a.get("clicks"))),
            "ctr": round(num(a.get("ctr")), 2),
        }
    except Exception as e:  # noqa: BLE001  (insights vacíos o cuenta nueva: no es error fatal)
        sys.stderr.write(f"insights: {e}\n")

    def budget(c):
        b = c.get("daily_budget") or c.get("lifetime_budget")
        if not b:
            return None
        tipo = "diario" if c.get("daily_budget") else "total"
        return {"monto": cents(b), "tipo": tipo}

    campanias_out = []
    for c in campanias:
        cid = c.get("id")
        i = ins_by_camp.get(cid, {})
        campanias_out.append({
            "id": cid,
            "nombre": c.get("name"),
            "objetivo": OBJETIVOS.get(c.get("objective"), c.get("objective") or "—"),
            "estado": c.get("effective_status"),
            "estado_txt": EFFECTIVE_STATUS.get(c.get("effective_status"), c.get("effective_status") or "—"),
            "presupuesto": budget(c),
            "gasto": round(num(i.get("spend")), 2),
            "impresiones": int(num(i.get("impressions"))),
            "alcance": int(num(i.get("reach"))),
            "clics": int(num(i.get("clicks"))),
            "ctr": round(num(i.get("ctr")), 2),
        })

    return {
        "cuenta": cuenta,
        "ventana": "Últimos 30 días",
        "totales": totales,
        "campanias": campanias_out,
        "sin_campanias": len(campanias_out) == 0,
        "moneda": cuenta.get("moneda") or "USD",
    }


def fetch_daily(act, token):
    """Serie diaria (últimos 30d) a nivel cuenta: gasto/impresiones/alcance/clics por jornada."""
    if not act.startswith("act_"):
        act = "act_" + act
    out = []
    try:
        ins = graph_get(f"{act}/insights", token, {
            "time_increment": 1, "date_preset": "last_30d",
            "fields": "spend,impressions,reach,clicks", "limit": 60})
        for r in ins.get("data", []):
            out.append({
                "fecha": r.get("date_start"),
                "gasto": round(num(r.get("spend")), 2),
                "impresiones": int(num(r.get("impressions"))),
                "alcance": int(num(r.get("reach"))),
                "clics": int(num(r.get("clicks"))),
            })
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"daily: {e}\n")
    return out


def upsert_daily(pid, daily):
    for d in daily:
        if not d.get("fecha"):
            continue
        psql(
            "INSERT INTO contenido.ads_daily(proyecto_id,fecha,gasto,impresiones,alcance,clics,actualizado_en) "
            f"VALUES('{pid}','{d['fecha']}',{d['gasto']},{d['impresiones']},{d['alcance']},{d['clics']},now()) "
            "ON CONFLICT(proyecto_id,fecha) DO UPDATE SET gasto=EXCLUDED.gasto,impresiones=EXCLUDED.impresiones,"
            "alcance=EXCLUDED.alcance,clics=EXCLUDED.clics,actualizado_en=now();")


def pg_container():
    cid = subprocess.run(["docker", "ps", "-q", "-f", f"name={PG_NAME_FILTER}"],
                         capture_output=True, text=True).stdout.strip()
    if not cid:
        raise RuntimeError("No se encontró el contenedor Postgres (crm_pgvector).")
    return cid


def psql(sql):
    out = subprocess.run(
        ["docker", "exec", "-i", pg_container(), "psql", "-U", "postgres", "-d", "claude",
         "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql falló: {out.stderr.strip()}")
    return out.stdout.strip()


def upsert(slug, snapshot):
    pid = psql(f"SELECT id FROM contenido.proyectos WHERE slug='{slug}'")
    if not pid:
        raise RuntimeError(f"proyecto '{slug}' no existe")
    payload = json.dumps(snapshot, ensure_ascii=False)
    tag = "j" + secrets.token_hex(6)  # dollar-quote seguro (arranca con letra)
    psql(
        f"INSERT INTO contenido.ads_snapshot(proyecto_id,capturado_en,data) "
        f"VALUES('{pid}', now(), ${tag}${payload}${tag}$::jsonb) "
        f"ON CONFLICT(proyecto_id) DO UPDATE SET capturado_en=now(), data=EXCLUDED.data;")
    return pid


def heartbeat(msg):
    sql = ("INSERT INTO contenido.batch_runs(proceso,last_run,last_msg) "
           f"VALUES('pauta',now(),$m${msg}$m$) "
           "ON CONFLICT(proceso) DO UPDATE SET last_run=now(), last_msg=EXCLUDED.last_msg;")
    try:
        subprocess.run(["docker", "exec", "-i", pg_container(), "psql", "-U", "postgres",
                        "-d", "claude", "-q", "-c", sql], capture_output=True, text=True)
    except Exception:  # noqa: BLE001
        pass


def main():
    ok, errs = 0, []
    brands = discover_brands()
    for slug, envpath in brands.items():
        env = load_env(envpath)
        act = env.get("META_ADS_ACCOUNT_ID")
        token = env.get("META_ADS_TOKEN")
        if not act or not token:
            continue  # marca sin pauta configurada
        try:
            snap = build_snapshot(act, token)
            pid = upsert(slug, snap)
            try:
                upsert_daily(pid, fetch_daily(act, token))
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f"{slug} daily: {e}\n")
            n = len(snap["campanias"])
            print(f"{slug}: OK ({n} campaña(s), gasto 30d {snap['totales']['gasto']} {snap['moneda']})")
            ok += 1
        except Exception as e:  # noqa: BLE001
            errs.append(f"{slug}: {e}")
            sys.stderr.write(f"{slug}: {e}\n")
    heartbeat(f"sync {ok} marca(s)" + (f"; errores: {'; '.join(errs)}" if errs else ""))
    return 0 if not errs else 1


if __name__ == "__main__":
    sys.exit(main())
