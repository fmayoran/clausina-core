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
            "OUTCOME_AWARENESS": "REACH", "OUTCOME_PERFIL": "PROFILE_VISIT"}
# "Ganar seguidores" no existe como objetivo en Meta. Lo más cerca es mandar al PERFIL de Instagram
# y optimizar por visitas: los seguidores salen de ahí. Se modela como un objetivo propio nuestro
# —OUTCOME_PERFIL— que por dentro es OUTCOME_TRAFFIC con destino perfil, porque para quien pide la
# campaña la diferencia entre "llevar a la web" y "llevar al perfil" es la que importa.
OBJ_META = {"OUTCOME_PERFIL": "OUTCOME_TRAFFIC"}
DEST_TYPE = {"OUTCOME_PERFIL": "INSTAGRAM_PROFILE"}
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
        "FROM contenido.pauta_campania c JOIN contenido.negocios p ON p.id=c.negocio_id "
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
    psql(f"UPDATE contenido.pauta_campania SET {', '.join(sets)} WHERE id='{cid}';")


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
         # Las ubicaciones se ajustan después según el tipo de creativo (ver UBICACIONES).
         "instagram_positions": ["stream", "explore"],
         "targeting_automation": {"advantage_audience": 0}}
    gen = aud.get("generos") or []
    if gen and "todos" not in gen:
        t["genders"] = [1] if gen == ["M"] else ([2] if gen == ["F"] else [1, 2])
    intereses = resolve_interests([i.get("nombre") or i for i in (aud.get("intereses") or [])], token)
    if intereses:
        t["flexible_spec"] = [{"interests": intereses}]
    return t


# Las ubicaciones dependen del CREATIVO, no del gusto. Meta rechaza el anuncio entero si no
# coinciden, y el error aparece recién en Ads Manager: la campaña se crea "bien" y no entrega.
# Aprendido a los golpes con la prueba de entrega:
#   - "No se admiten anuncios por secuencia en la vista Explorar video": un carrusel/imagen NO
#     puede ir en `reels`, que es una superficie de video.
#   - "Relación de aspecto no válida": en feed y explorar la imagen tiene que estar entre 4:5
#     (0,8) y 1,91:1. Una foto 9:16 —lo normal para historias— no entra.
UBICACIONES = {"image": ["stream", "explore"], "video": ["reels", "story"]}


def ubicaciones_para(tipo):
    return UBICACIONES.get(tipo or "image", ["stream", "explore"])


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
               "(SELECT p.dominio_web FROM contenido.negocios p WHERE p.id=c.negocio_id) dominio,"
               "(SELECT m.tipo::text FROM contenido.media m WHERE m.pieza_id=c.pieza_id ORDER BY m.orden LIMIT 1) tipo_media "
               f"FROM contenido.pauta_campania c WHERE c.id='{cid}') t;")
    if not row:
        raise RuntimeError("campaña inexistente")
    d = json.loads(row)
    if d.get("meta_campaign_id"):
        return "ya creada"

    # Las piezas de la campaña, en orden. Cada una va a ser UN anuncio dentro del MISMO conjunto:
    # así compiten por el mismo público y Meta le da entrega a la que rinde. Partirlas en varios
    # conjuntos sería peor —ninguno junta los eventos que Meta necesita para aprender, y compiten
    # entre sí en la subasta—.
    piezas = []
    for linea in psql(
            "SELECT cp.id||'|'||coalesce(r.ig_post_id,'')||'|'||coalesce(pz.titulo_interno,'') "
            "FROM contenido.pauta_campania_pieza cp "
            "JOIN contenido.piezas pz ON pz.id=cp.pieza_id "
            "LEFT JOIN contenido.revisiones r ON r.pieza_id=cp.pieza_id AND r.estado='publicada' "
            f"WHERE cp.campania_id='{cid}' ORDER BY cp.orden, cp.creado_en").split("\n"):
        if not linea.strip():
            continue
        rid, media, titulo = (linea.split("|", 2) + ["", ""])[:3]
        if media:
            piezas.append({"rel": rid, "media": media, "titulo": titulo})
    if not piezas:
        set_estado(cid, "error", "La campaña necesita al menos un post ya publicado como creativo.")
        return "sin creativo"
    # Meta no deja promocionar un VIDEO de Instagram ya publicado sin subirlo antes a Facebook:
    # "Al anunciar un video de Instagram existente, debes subirlo a Facebook antes de crear el
    # anuncio". Se avisa acá y no en medio de la creación, con la campaña a medio armar.
    if (d.get("tipo_media") or "image") == "video":
        set_estado(cid, "error",
                   "El creativo elegido es un video. Meta no permite promocionar un video de "
                   "Instagram ya publicado sin subirlo antes a Facebook: elegí una foto o un "
                   "carrusel.")
        return "creativo video"

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
        "name": d["nombre"], "objective": OBJ_META.get(objetivo, objetivo), "status": "PAUSED",
        "special_ad_categories": "[]", "is_adset_budget_sharing_enabled": "false",
        "access_token": token})
    camp_id = camp["id"]

    try:
        # 2) Conjunto
        targeting = build_targeting(d.get("audiencia"), token)
        targeting["instagram_positions"] = ubicaciones_para(d.get("tipo_media"))
        adset_p = {"name": d["nombre"], "campaign_id": camp_id, "status": "PAUSED",
                   "billing_event": "IMPRESSIONS", "optimization_goal": opt,
                   "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
                   "targeting": json.dumps(targeting), "access_token": token}
        if objetivo in DEST_TYPE:
            adset_p["destination_type"] = DEST_TYPE[objetivo]
        adset_p["daily_budget" if es_diario else "lifetime_budget"] = str(monto_cents)
        if d.get("fi"):
            adset_p["start_time"] = f"{d['fi']}T00:00:00-0300"
        if d.get("ff"):
            adset_p["end_time"] = f"{d['ff']}T23:59:00-0300"
        elif not es_diario:
            raise RuntimeError("presupuesto total requiere fecha de fin")
        adset = graph("POST", f"{act}/adsets", adset_p)
        adset_id = adset["id"]

        # 3 y 4) Un creativo y un anuncio POR PIEZA, todos en el mismo conjunto.
        ads_ids = []
        for i, pz in enumerate(piezas, 1):
            # El nombre lleva el título de la pieza: en el reporte de Meta, tres anuncios con el
            # mismo nombre no se pueden distinguir, que es justo lo que se quiere comparar.
            nombre_ad = f"{d['nombre']} — {pz['titulo']}"[:120] if pz["titulo"] else f"{d['nombre']} {i}"
            crea_p = {"name": nombre_ad, "object_id": page, "instagram_user_id": ig,
                      "source_instagram_media_id": pz["media"], "access_token": token}
            # Con destino perfil el anuncio lleva al perfil de Instagram: agregarle un link externo
            # sería mandarlo a otro lado que el que la campaña eligió.
            if objetivo not in DEST_TYPE:
                crea_p["call_to_action"] = json.dumps({"type": cta, "value": {"link": link}})
            creative = graph("POST", f"{act}/adcreatives", crea_p)
            ad = graph("POST", f"{act}/ads", {
                "name": nombre_ad, "adset_id": adset_id,
                "creative": json.dumps({"creative_id": creative["id"]}),
                "status": "PAUSED", "access_token": token})
            psql(f"UPDATE contenido.pauta_campania_pieza SET meta_creative_id={dq(creative['id'])}, "
                 f"meta_ad_id={dq(ad['id'])} WHERE id='{pz['rel']}';")
            ads_ids.append(ad["id"])

        cuantos = f"{len(ads_ids)} anuncios" if len(ads_ids) > 1 else "1 anuncio"
        set_estado(cid, "pausada",
                   f"Creada en Meta (pausada) con {cuantos}. Presupuesto {'diario' if es_diario else 'total'} "
                   f"{monto_cents/100:.0f} {pres.get('moneda','USD')}. Activala para que empiece a correr.",
                   # meta_ad_id guarda el primero por compatibilidad; el detalle por pieza vive en
                   # pauta_campania_pieza, que es de donde sale el rendimiento por anuncio.
                   meta={"meta_campaign_id": camp_id, "meta_adset_id": adset_id, "meta_ad_id": ads_ids[0]})
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
               f"FROM contenido.pauta_campania WHERE id='{cid}';").split("|")
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
    camp = psql(f"SELECT coalesce(meta_campaign_id,'') FROM contenido.pauta_campania WHERE id='{cid}';")
    if camp:
        try:
            graph("POST", camp, {"status": "DELETED", "access_token": token})
        except Exception as e:
            if "does not exist" not in str(e).lower() and "cannot be loaded" not in str(e).lower():
                set_estado(cid, "error", f"No se pudo borrar en Meta: {e}")
                raise
    psql("UPDATE contenido.pauta_campania SET estado='descartada', meta_campaign_id=NULL, "
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
