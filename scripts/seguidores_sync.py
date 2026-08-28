#!/usr/bin/env python3
"""Foto diaria del perfil social de cada negocio -> contenido.perfil_social_diario.

Por qué existe: una campaña con objetivo Seguidores no se puede evaluar con los datos de pauta.
La Marketing API informa clics al perfil, no seguidores ganados; el conteo de seguidores sólo se
lee del perfil, y sólo vale como serie. Sin una foto por día no hay línea de base contra la cual
comparar, y la pregunta "¿la campaña sumó seguidores?" no tiene respuesta —que fue exactamente lo
que pasó con Mediodía Express en agosto de 2026, con la campaña ya corriendo—.

Agnóstico de negocio: recorre los que tengan Instagram configurado en el perfil. Read-only contra
Graph API. Idempotente: correrlo varias veces el mismo día pisa la fila del día.

Corre en el host (donde está el contenedor de Postgres). Lo dispara el timer cf-seguidores.
"""
import os
import sys
import json
import subprocess
import urllib.parse
import urllib.request
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ads_crypto  # noqa: E402

GRAPH = "https://graph.facebook.com/v21.0"
GRAPH_IG = "https://graph.instagram.com/v21.0"
PG_NAME_FILTER = "crm_pgvector.1."


def pg_container():
    cid = subprocess.run(["docker", "ps", "-q", "-f", f"name={PG_NAME_FILTER}"],
                         capture_output=True, text=True).stdout.strip()
    if not cid:
        raise RuntimeError("no encuentro el contenedor de Postgres")
    return cid.splitlines()[0]


def psql(sql):
    out = subprocess.run(["docker", "exec", "-i", pg_container(), "psql", "-U", "postgres",
                          "-d", "claude", "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql falló: {out.stderr.strip()}")
    return out.stdout.strip()


def negocios_con_ig():
    """Negocios de los que se puede leer el perfil de Instagram.

    Hay DOS credenciales posibles y no todos los negocios tienen las mismas: el token de ads
    (System User, va contra graph.facebook.com) y el de publicación (Instagram Login, va contra
    graph.instagram.com). Se aceptan las dos —verificado que ambas devuelven followers_count— para
    que un negocio que todavía no pauta igual acumule su serie desde el día uno. Cuando arranque a
    pautar, la línea de base ya va a estar.
    """
    filas = psql(
        "SELECT n.id||'|'||n.slug||'|'||coalesce(pp.meta_ads_ig_id,'')||'|'||coalesce(pp.meta_ads_token_enc,'')"
        "||'|'||coalesce(n.ig_user_id,'')||'|'||coalesce(pp.ig_token_enc,'') "
        "FROM contenido.negocios n JOIN contenido.negocio_perfil pp ON pp.negocio_id=n.id "
        "WHERE (pp.meta_ads_ig_id IS NOT NULL AND pp.meta_ads_token_enc IS NOT NULL) "
        "   OR (n.ig_user_id IS NOT NULL AND pp.ig_token_enc IS NOT NULL) ORDER BY n.slug;")
    out = []
    for fila in filas.splitlines():
        if not fila.strip():
            continue
        nid, slug, ads_ig, ads_tok, ig_user, ig_tok = fila.split("|", 5)
        try:
            if ads_ig and ads_tok:
                out.append({"id": nid, "slug": slug, "ig": ads_ig,
                            "token": ads_crypto.decrypt(ads_tok), "via": "ads"})
            else:
                out.append({"id": nid, "slug": slug, "ig": ig_user,
                            "token": ads_crypto.decrypt(ig_tok), "via": "ig"})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"{slug}: no se pudo descifrar el token: {e}\n")
    return out


def leer_perfil(ig, token, via="ads"):
    base = GRAPH if via == "ads" else GRAPH_IG
    url = f"{base}/{ig}?" + urllib.parse.urlencode(
        {"fields": "username,followers_count,media_count", "access_token": token})
    with urllib.request.urlopen(url, timeout=25) as r:
        return json.load(r)


def guardar(nid, seguidores, publicaciones):
    pub = "NULL" if publicaciones is None else str(int(publicaciones))
    psql("INSERT INTO contenido.perfil_social_diario(negocio_id,red,fecha,seguidores,publicaciones,actualizado_en) "
         f"VALUES('{nid}','instagram',current_date,{int(seguidores)},{pub},now()) "
         "ON CONFLICT(negocio_id,red,fecha) DO UPDATE SET seguidores=EXCLUDED.seguidores,"
         "publicaciones=EXCLUDED.publicaciones,actualizado_en=now();")


def main():
    negocios = negocios_con_ig()
    if not negocios:
        print("sin negocios con Instagram configurado")
        return 0
    fallos = 0
    for n in negocios:
        try:
            p = leer_perfil(n["ig"], n["token"], n.get("via", "ads"))
            seg = p.get("followers_count")
            if seg is None:
                # Sin el dato no se escribe: una fila en 0 rompe la serie peor que una fila faltante.
                sys.stderr.write(f"{n['slug']}: el perfil no devolvió followers_count\n")
                fallos += 1
                continue
            guardar(n["id"], seg, p.get("media_count"))
            print(f"{n['slug']}: {seg} seguidores, {p.get('media_count')} publicaciones")
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"{n['slug']}: {e}\n")
            fallos += 1
    return 1 if fallos and fallos == len(negocios) else 0


if __name__ == "__main__":
    sys.exit(main())
