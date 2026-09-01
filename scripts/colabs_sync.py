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
        "SELECT n.slug||'|'||coalesce(pp.meta_ads_ig_id,'')||'|'||coalesce(pp.meta_ads_token_enc,'') "
        "FROM contenido.negocios n JOIN contenido.negocio_perfil pp ON pp.negocio_id=n.id "
        "WHERE pp.meta_ads_ig_id IS NOT NULL AND pp.meta_ads_token_enc IS NOT NULL ORDER BY n.slug;")
    out = []
    for f in filas.splitlines():
        if not f.strip():
            continue
        slug, ig, tok = f.split("|", 2)
        try:
            out.append({"slug": slug, "ig": ig, "token": ads_crypto.decrypt(tok)})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"{slug}: token ilegible: {e}\n")
    return out


def main():
    total = pendientes = 0
    for n in negocios():
        u = f"{FB}/{n['ig']}/media?" + urllib.parse.urlencode(
            {"fields": "id,collaborators", "limit": "100", "access_token": n["token"]})
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
            # Se escribe por ig_post_id: es la única llave que comparten la API y nuestra base.
            psql("UPDATE contenido.revisiones SET colab_estado=$j$" + json.dumps(estado, ensure_ascii=False)
                 + "$j$::jsonb WHERE ig_post_id='" + m["id"] + "';")
            total += 1
        print(f"{n['slug']}: {total} publicacion(es) con colaboradores")
    if pendientes:
        print(f"ATENCION: {pendientes} invitacion(es) sin aceptar — es alcance que no se esta usando")
    return 0


if __name__ == "__main__":
    sys.exit(main())
