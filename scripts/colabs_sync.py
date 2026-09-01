#!/usr/bin/env python3
"""Estado de las invitaciones de colaboración (Collab) de Instagram -> revisiones.colab_estado.

Por qué existe: cuando invitamos a otra cuenta a colaborar, el post sale en las dos grillas y llega
al doble de gente — pero SÓLO si la otra cuenta acepta. Si queda pendiente, no pasa nada y no avisa
nadie. Pasó con CF-0261 y @ardora.sport: la invitación quedó colgada tres semanas sin que se notara.

El dato sólo lo devuelve graph.facebook.com (con el token de ads), no graph.instagram.com. Lo que
NO existe por ninguna API son las colaboraciones que aceptamos nosotros: esos posts pertenecen a
quien los publicó, e Instagram ni siquiera los cuenta en nuestro media_count. Para verlos habría
que leer desde la cuenta que publicó.

Agnóstico de negocio. Read-only contra Graph.
"""
import json, os, subprocess, sys, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ads_crypto  # noqa: E402

FB = "https://graph.facebook.com/v21.0"
PG_NAME_FILTER = "crm_pgvector.1."


def pg():
    c = subprocess.run(["docker", "ps", "-q", "-f", f"name={PG_NAME_FILTER}"],
                       capture_output=True, text=True).stdout.strip()
    if not c:
        raise RuntimeError("no encuentro el contenedor de Postgres")
    return c.splitlines()[0]


def psql(sql):
    out = subprocess.run(["docker", "exec", "-i", pg(), "psql", "-U", "postgres", "-d", "claude",
                          "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql: {out.stderr.strip()}")
    return out.stdout.strip()


def negocios():
    filas = psql(
        "SELECT n.slug||'|'||coalesce(pp.meta_ads_ig_id,'')||'|'||coalesce(pp.meta_ads_token_enc,'')||'|'||n.id "
        "FROM contenido.negocios n JOIN contenido.negocio_perfil pp ON pp.negocio_id=n.id "
        "WHERE pp.meta_ads_ig_id IS NOT NULL AND pp.meta_ads_token_enc IS NOT NULL ORDER BY n.slug;")
    out = []
    for f in filas.splitlines():
        if not f.strip():
            continue
        slug, ig, tok, nid = f.split("|", 3)
        try:
            out.append({"slug": slug, "ig": ig, "token": ads_crypto.decrypt(tok), "negocio_id": nid})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"{slug}: token ilegible: {e}\n")
    return out


def mapa_cuentas():
    """ig_user_id -> negocio, para reconocer cuando un colaborador es otro negocio de la casa."""
    out = {}
    for f in psql("SELECT id||'|'||slug||'|'||coalesce(ig_user_id,'') FROM contenido.negocios "
                  "WHERE ig_user_id IS NOT NULL;").splitlines():
        if f.strip():
            nid, slug, ig = f.split("|", 2)
            out[ig] = {"id": nid, "slug": slug}
    return out


def guardar_externa(m, colab, autor):
    """Una publicación de OTRA cuenta donde un negocio nuestro es colaborador.

    Instagram no se las devuelve al colaborador —ni siquiera se las cuenta en media_count—, así que
    la única forma de verlas es leerlas desde la cuenta que publicó. Por eso esto se llena mirando
    la grilla del autor, no la del negocio al que le interesan.
    """
    cap = (m.get("caption") or "").replace("$j$", "")
    psql(
        "INSERT INTO contenido.colaboracion_externa (ig_post_id,negocio_id,autor,autor_negocio_id,"
        "permalink,caption,media_url,tipo,publicado_en,estado,capturado_en) VALUES ("
        f"'{m['id']}','{colab['id']}',$j${autor['slug']}$j$,"
        + (f"'{autor['id']}'" if autor.get("id") else "NULL") + ","
        f"$j${m.get('permalink') or ''}$j$,$j${cap}$j$,"
        f"$j${m.get('thumbnail_url') or m.get('media_url') or ''}$j$,"
        f"$j${m.get('media_type') or ''}$j$,"
        + (f"'{m['timestamp']}'" if m.get("timestamp") else "NULL") + ","
        f"$j${colab.get('estado') or ''}$j$, now()) "
        "ON CONFLICT (ig_post_id, negocio_id) DO UPDATE SET estado=EXCLUDED.estado,"
        "caption=EXCLUDED.caption,media_url=EXCLUDED.media_url,capturado_en=now();")


def main():
    total = pendientes = externas = 0
    cuentas = mapa_cuentas()
    for n in negocios():
        u = f"{FB}/{n['ig']}/media?" + urllib.parse.urlencode(
            {"fields": "id,timestamp,permalink,caption,media_type,thumbnail_url,media_url,collaborators",
             "limit": "100", "access_token": n["token"]})
        try:
            with urllib.request.urlopen(u, timeout=30) as r:
                data = json.load(r).get("data", [])
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"{n['slug']}: {e}\n")
            continue
        for m in data:
            cols = (m.get("collaborators") or {}).get("data") or []
            if not cols:
                continue
            estado = {c["username"]: c.get("invite_status") for c in cols if c.get("username")}
            pendientes += sum(1 for v in estado.values() if v and v.lower() != "accepted")
            # Si el invitado es otro negocio de la casa, la publicación le interesa a ÉL: en su
            # grilla sale, pero su propia API no se la devuelve.
            for c in cols:
                otro = cuentas.get(c.get("id"))
                if otro and otro["slug"] != n["slug"] and (c.get("invite_status") or "").lower() == "accepted":
                    guardar_externa(m, {"id": otro["id"], "estado": c.get("invite_status")},
                                    {"slug": n["slug"], "id": n.get("negocio_id")})
                    externas += 1
            # Se escribe por ig_post_id: es la única llave que comparten la API y nuestra base.
            psql("UPDATE contenido.revisiones SET colab_estado=$j$" + json.dumps(estado, ensure_ascii=False)
                 + "$j$::jsonb WHERE ig_post_id='" + m["id"] + "';")
            total += 1
        print(f"{n['slug']}: {total} publicacion(es) con colaboradores")
    if externas:
        print(f"{externas} publicacion(es) de otras cuentas donde un negocio nuestro colabora")
    if pendientes:
        print(f"ATENCION: {pendientes} invitacion(es) sin aceptar — es alcance que no se esta usando")
    return 0


if __name__ == "__main__":
    sys.exit(main())
