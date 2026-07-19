#!/usr/bin/env python3
"""Publicar en Meta una campaña aprobada (o activarla/pausarla). Determinístico, sin agente.

Recipe validado contra Graph API v21.0:
  Campaña   -> objective, status=PAUSED, special_ad_categories=[], is_adset_budget_sharing_enabled=false
  Conjunto  -> optimization_goal por objetivo, billing IMPRESSIONS, presupuesto (centavos),
               targeting {geo cities(radio>=17km), edad, generos, intereses, IG placements,
               targeting_automation.advantage_audience=0}
  Creativo  -> object_id(Página) + instagram_user_id + source_instagram_media_id + call_to_action.value.link
  Anuncio   -> adset_id + creative, status=PAUSED

TODO todo se crea PAUSADO. Nada gasta hasta 'activar' (con OK de Fer). Uso:
  pauta_publish.py crear|activar|pausar <campania_id>
"""
import json
import secrets
import subprocess
import sys
import urllib.parse
import urllib.request

import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ads_crypto  # noqa: E402

GRAPH = "https://graph.facebook.com/v21.0"
PG_NAME_FILTER = "crm_pgvector.1."

OPT_GOAL = {"OUTCOME_TRAFFIC": "LINK_CLICKS", "OUTCOME_ENGAGEMENT": "POST_ENGAGEMENT",
            "OUTCOME_AWARENESS": "REACH"}
CTA_OK = {"LEARN_MORE", "SHOP_NOW", "BOOK_TRAVEL", "CONTACT_US", "SIGN_UP"}


def load_env(path):
    d = {}
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return d


def config_for_campania(cid):
    """Config de ads de la marca dueña de la campaña, desde el perfil (DB). Agnóstico.
    IDs en claro; token descifrado con APP_ENC_KEY. Devuelve dict {act,page,ig,token,slug}."""
    row = psql(
        "SELECT coalesce(pp.meta_ads_account_id,'')||'|'||coalesce(pp.meta_ads_page_id,'')||'|'||"
        "coalesce(pp.meta_ads_ig_id,'')||'|'||coalesce(pp.meta_ads_token_enc,'')||'|'||p.slug "
        "FROM contenido.campanias c JOIN contenido.negocios p ON p.id=c.negocio_id "
        "JOIN contenido.negocio_perfil pp ON pp.negocio_id=c.negocio_id "
        f"WHERE c.id='{cid}'")
    if not row:
        raise RuntimeError("la campaña no tiene pauta configurada en el perfil de la marca")
    act, page, ig, tok_enc, slug = row.split("|", 4)
    return {"act": act, "page": page, "ig": ig,
            "token": ads_crypto.decrypt(tok_enc) if tok_enc else "", "slug": slug}


def graph(method, path, params):
    data = urllib.parse.urlencode(params).encode() if method != "GET" else None
    url = f"{GRAPH}/{path}" + (f"?{urllib.parse.urlencode(params)}" if method == "GET" else "")
    req = urllib.request.Request(url, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            err = json.loads(body)["error"]
            msg = err.get("error_user_msg") or err.get("message") or body
        except Exception:
            msg = body
        raise RuntimeError(msg)


# --- Postgres (docker exec, igual que el resto del motor) ---
def pg_container():
    cid = subprocess.run(["docker", "ps", "-q", "-f", f"name={PG_NAME_FILTER}"],
                         capture_output=True, text=True).stdout.strip()
    if not cid:
        raise RuntimeError("No se encontró el contenedor Postgres.")
    return cid


def psql(sql):
    out = subprocess.run(["docker", "exec", "-i", pg_container(), "psql", "-U", "postgres",
                          "-d", "claude", "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql: {out.stderr.strip()}")
    return out.stdout.strip()


def dq(v):
    t = "x" + secrets.token_hex(8)
    return f"${t}${v or ''}${t}$"


def set_estado(cid, estado, resumen=None, meta=None):
    sets = [f"estado='{estado}'", "actualizado_en=now()"]
    if resumen is not None:
        sets.append(f"resumen={dq(resumen[:2000])}")
    for k, v in (meta or {}).items():
        sets.append(f"{k}={dq(v)}")
    psql(f"UPDATE contenido.campanias SET {', '.join(sets)} WHERE id='{cid}';")


# --- Resolución de targeting ---
def resolve_city(nombre, token):
    q = graph("GET", "search", {"type": "adgeolocation", "location_types": '["city"]',
                                "q": nombre.split(",")[0].strip(), "limit": 10, "access_token": token})
    data = q.get("data", [])
    ar = [c for c in data if c.get("country_code") == "AR"] or data
    return ar[0]["key"] if ar else None


def resolve_interests(nombres, token):
    out = []
    for n in nombres:
        try:
            q = graph("GET", "search", {"type": "adinterest", "q": n, "limit": 1, "access_token": token})
            d = q.get("data", [])
            if d:
                out.append({"id": d[0]["id"], "name": d[0]["name"]})
        except Exception:
            pass
    return out


def build_targeting(aud, token):
    aud = aud or {}
    geo = {}
    cities = []
    for u in (aud.get("ubicaciones") or []):
        key = resolve_city(u.get("nombre", ""), token)
        if not key:
            continue
        c = {"key": key}
        rk = u.get("radio_km")
        if rk:
            c["radius"] = max(17, min(80, int(rk)))
            c["distance_unit"] = "kilometer"
        cities.append(c)
    if cities:
        geo["cities"] = cities
    else:
        geo["countries"] = ["AR"]  # fallback seguro
    t = {"geo_locations": geo,
         "age_min": int(aud.get("edad_min") or 18),
         "age_max": int(aud.get("edad_max") or 65),
         "publisher_platforms": ["instagram"],
         "instagram_positions": ["stream", "story", "reels", "explore"],
         "targeting_automation": {"advantage_audience": 0}}
    gen = aud.get("generos") or []
    if gen and "todos" not in gen:
        t["genders"] = [1] if gen == ["M"] else ([2] if gen == ["F"] else [1, 2])
    intereses = resolve_interests([i.get("nombre") or i for i in (aud.get("intereses") or [])], token)
    if intereses:
        t["flexible_spec"] = [{"interests": intereses}]
    return t


def crear(cid):
    cfg = config_for_campania(cid)
    token = cfg["token"]; act = cfg["act"]; page = cfg["page"]; ig = cfg["ig"]
    if not all([token, act, page, ig]):
        raise RuntimeError(f"Faltan credenciales de ads en el perfil de {cfg['slug']}")
    if not act.startswith("act_"):
        act = "act_" + act

    row = psql("SELECT row_to_json(t) FROM (SELECT c.nombre,c.objetivo,c.audiencia,c.presupuesto,"
               "to_char(c.fecha_inicio,'YYYY-MM-DD') fi,to_char(c.fecha_fin,'YYYY-MM-DD') ff,"
               "c.url_destino,c.cta,c.meta_campaign_id,"
               "(SELECT r.ig_post_id FROM contenido.revisiones r WHERE r.pieza_id=c.pieza_id AND r.estado='publicada' LIMIT 1) ig_media,"
               "(SELECT p.dominio_web FROM contenido.negocios p WHERE p.id=c.negocio_id) dominio "
               f"FROM contenido.campanias c WHERE c.id='{cid}') t;")
    if not row:
        raise RuntimeError("campaña inexistente")
    d = json.loads(row)
    if d.get("meta_campaign_id"):
        return "ya creada"
    ig_media = d.get("ig_media")
    if not ig_media:
        set_estado(cid, "error", "La campaña necesita un post ya publicado como creativo.")
        return "sin creativo"

    objetivo = d["objetivo"]
    opt = OPT_GOAL.get(objetivo, "LINK_CLICKS")
    pres = d.get("presupuesto") or {}
    monto_cents = int(round(float(pres.get("monto") or 5) * 100))
    es_diario = (pres.get("tipo") or "diario") == "diario"
    dominio = d.get("dominio") or "cortafuego.ar"
    link = d.get("url_destino") or f"https://{dominio.lstrip('https://').lstrip('http://')}"
    cta = d.get("cta") if d.get("cta") in CTA_OK else "LEARN_MORE"

    # 1) Campaña
    camp = graph("POST", f"{act}/campaigns", {
        "name": d["nombre"], "objective": objetivo, "status": "PAUSED",
        "special_ad_categories": "[]", "is_adset_budget_sharing_enabled": "false",
        "access_token": token})
    camp_id = camp["id"]

    try:
        # 2) Conjunto
        targeting = build_targeting(d.get("audiencia"), token)
        adset_p = {"name": d["nombre"], "campaign_id": camp_id, "status": "PAUSED",
                   "billing_event": "IMPRESSIONS", "optimization_goal": opt,
                   "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                   "targeting": json.dumps(targeting), "access_token": token}
        adset_p["daily_budget" if es_diario else "lifetime_budget"] = str(monto_cents)
        if d.get("fi"):
            adset_p["start_time"] = f"{d['fi']}T00:00:00-0300"
        if d.get("ff"):
            adset_p["end_time"] = f"{d['ff']}T23:59:00-0300"
        elif not es_diario:
            raise RuntimeError("presupuesto total requiere fecha de fin")
        adset = graph("POST", f"{act}/adsets", adset_p)
        adset_id = adset["id"]

        # 3) Creativo (desde el post de IG ya publicado)
        creative = graph("POST", f"{act}/adcreatives", {
            "name": d["nombre"], "object_id": page, "instagram_user_id": ig,
            "source_instagram_media_id": ig_media,
            "call_to_action": json.dumps({"type": cta, "value": {"link": link}}),
            "access_token": token})
        creative_id = creative["id"]

        # 4) Anuncio
        ad = graph("POST", f"{act}/ads", {
            "name": d["nombre"], "adset_id": adset_id,
            "creative": json.dumps({"creative_id": creative_id}),
            "status": "PAUSED", "access_token": token})

        set_estado(cid, "pausada",
                   f"Creada en Meta (pausada). Presupuesto {'diario' if es_diario else 'total'} "
                   f"{monto_cents/100:.0f} {pres.get('moneda','USD')}. Activala para que empiece a correr.",
                   meta={"meta_campaign_id": camp_id, "meta_adset_id": adset_id, "meta_ad_id": ad["id"]})
        return "ok:" + camp_id
    except Exception as e:
        # Limpieza: borrar la campaña a medias en Meta para que el reintento sea limpio.
        try:
            graph("POST", camp_id, {"status": "DELETED", "access_token": token})
        except Exception:
            pass
        msg = str(e)
        if "desarrollo" in msg.lower() or "development" in msg.lower():
            msg = ("La app de Meta está en modo Desarrollo. Pasala a modo Live en el App "
                   "Dashboard (developers.facebook.com/apps) y reintentá.")
        set_estado(cid, "error", f"No se pudo crear la campaña: {msg}")
        raise


def _set_status(cid, status, nuevo_estado):
    token = config_for_campania(cid)["token"]
    ids = psql("SELECT coalesce(meta_campaign_id,'')||'|'||coalesce(meta_adset_id,'')||'|'||coalesce(meta_ad_id,'') "
               f"FROM contenido.campanias WHERE id='{cid}';").split("|")
    for oid in ids:
        if oid:
            try:
                graph("POST", oid, {"status": status, "access_token": token})
            except Exception as e:
                set_estado(cid, "error", f"No se pudo cambiar a {status}: {e}")
                raise
    resumen = ("Corriendo en Meta." if nuevo_estado == "activa"
               else "Pausada en Meta. Activala para reanudar." if nuevo_estado == "pausada" else None)
    set_estado(cid, nuevo_estado, resumen=resumen)
    return "ok"


def borrar(cid):
    """Descartar una campaña ya creada: la borra en Meta (cascada a conjunto/anuncio) y marca descartada."""
    token = config_for_campania(cid)["token"]
    camp = psql(f"SELECT coalesce(meta_campaign_id,'') FROM contenido.campanias WHERE id='{cid}';")
    if camp:
        try:
            graph("POST", camp, {"status": "DELETED", "access_token": token})
        except Exception as e:
            if "does not exist" not in str(e).lower() and "cannot be loaded" not in str(e).lower():
                set_estado(cid, "error", f"No se pudo borrar en Meta: {e}")
                raise
    psql("UPDATE contenido.campanias SET estado='descartada', meta_campaign_id=NULL, "
         f"meta_adset_id=NULL, meta_ad_id=NULL, actualizado_en=now() WHERE id='{cid}';")
    return "ok"


def main():
    if len(sys.argv) != 3:
        print("uso: pauta_publish.py crear|activar|pausar|borrar <campania_id>", file=sys.stderr)
        return 2
    accion, cid = sys.argv[1], sys.argv[2]
    try:
        if accion == "crear":
            print(crear(cid))
        elif accion == "activar":
            print(_set_status(cid, "ACTIVE", "activa"))
        elif accion == "pausar":
            print(_set_status(cid, "PAUSED", "pausada"))
        elif accion == "borrar":
            print(borrar(cid))
        else:
            print("acción inválida", file=sys.stderr); return 2
        return 0
    except Exception as e:
        sys.stderr.write(f"{accion} {cid}: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
