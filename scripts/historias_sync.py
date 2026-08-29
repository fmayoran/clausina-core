#!/usr/bin/env python3
"""Captura las métricas de las historias de Instagram MIENTRAS VIVEN.

Por qué existe y por qué corre seguido: una historia dura 24 horas y después Instagram **borra el
objeto**. Pedirle métricas más tarde devuelve "Object does not exist": no es que estén incompletas,
es que no existen y no hay forma de recuperarlas — ni por la API ni a mano. Verificado el
29/08/2026 contra una historia del 21/08.

Por eso la auditoría venía diciendo "Historias: sin dato" con 3 historias publicadas: nadie las
midió a tiempo. Este script las guarda cada vez que corre; el upsert deja siempre la última
lectura, así que la fila final es la de la historia ya cumplida.

Agnóstico de negocio. Read-only contra Graph.
"""
import json, os, subprocess, sys, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ads_crypto  # noqa: E402

GRAPH_IG = "https://graph.instagram.com/v21.0"
PG_NAME_FILTER = "crm_pgvector.1."
# Las que la API de Instagram Login soporta para historias. `navigation` agrupa los toques de
# avance, retroceso y salida: es la señal de si la historia se mira o se saltea.
METRICAS = ["reach", "views", "replies", "navigation", "total_interactions", "shares", "profile_visits"]


def pg():
    cid = subprocess.run(["docker", "ps", "-q", "-f", f"name={PG_NAME_FILTER}"],
                         capture_output=True, text=True).stdout.strip()
    if not cid:
        raise RuntimeError("no encuentro el contenedor de Postgres")
    return cid.splitlines()[0]


def psql(sql):
    out = subprocess.run(["docker", "exec", "-i", pg(), "psql", "-U", "postgres", "-d", "claude",
                          "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql: {out.stderr.strip()}")
    return out.stdout.strip()


def g(path, params, token):
    params = dict(params); params["access_token"] = token
    try:
        with urllib.request.urlopen(f"{GRAPH_IG}/{path}?" + urllib.parse.urlencode(params), timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"error": json.loads(e.read().decode()).get("error", {}).get("message", "")[:120]}


def negocios():
    filas = psql("SELECT n.id||'|'||n.slug||'|'||coalesce(pp.ig_token_enc,'') "
                 "FROM contenido.negocios n JOIN contenido.negocio_perfil pp ON pp.negocio_id=n.id "
                 "WHERE pp.ig_token_enc IS NOT NULL ORDER BY n.slug;")
    out = []
    for f in filas.splitlines():
        if not f.strip():
            continue
        nid, slug, tok = f.split("|", 2)
        try:
            out.append({"id": nid, "slug": slug, "token": ads_crypto.decrypt(tok)})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"{slug}: token ilegible: {e}\n")
    return out


def main():
    total = 0
    for n in negocios():
        d = g("me/stories", {"fields": "id,timestamp"}, n["token"])
        if d.get("error"):
            sys.stderr.write(f"{n['slug']}: {d['error']}\n")
            continue
        vivas = d.get("data") or []
        for st in vivas:
            v = {}
            for m in METRICAS:
                r = g(f"{st['id']}/insights", {"metric": m}, n["token"])
                dd = r.get("data")
                # Métrica por métrica y no todas juntas: si una no aplica a este tipo de historia,
                # pedirlas en bloque hace fallar la llamada entera y se pierden también las buenas.
                v[m] = (dd[0].get("values", [{}])[0].get("value") if dd else None)
            col = lambda x: 'NULL' if v.get(x) is None else int(v[x])  # noqa: E731
            psql(
                "INSERT INTO contenido.ig_historia (ig_story_id,negocio_id,publicado_en,reach,views,"
                "replies,navigation,interacciones,shares,profile_visits,capturado_en) VALUES ("
                f"'{st['id']}','{n['id']}','{st.get('timestamp')}',{col('reach')},{col('views')},"
                f"{col('replies')},{col('navigation')},{col('total_interactions')},{col('shares')},"
                f"{col('profile_visits')},now()) "
                "ON CONFLICT (ig_story_id) DO UPDATE SET reach=EXCLUDED.reach,views=EXCLUDED.views,"
                "replies=EXCLUDED.replies,navigation=EXCLUDED.navigation,"
                "interacciones=EXCLUDED.interacciones,shares=EXCLUDED.shares,"
                "profile_visits=EXCLUDED.profile_visits,capturado_en=now();")
            total += 1
        print(f"{n['slug']}: {len(vivas)} historia(s) viva(s) capturada(s)")
    return 0 if total or True else 1


if __name__ == "__main__":
    sys.exit(main())
