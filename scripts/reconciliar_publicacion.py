#!/usr/bin/env python3
"""Reconcilia el estado de publicación con lo que REALMENTE hay en Instagram.

Nace de un incidente real (jul-2026): al publicar un Reel, la Graph API devolvió
`OAuthException code 2 is_transient` — pero **publicó igual**. Como el sistema lo tomó por
fallido, cada reintento generó una copia: terminaron 5 Reels idénticos en la cuenta del cliente.

La lección: con la API de Instagram, "error" NO significa "no se publicó". La única fuente de
verdad es la cuenta. Este script la consulta y sincroniza:

  - Pieza 'aprobada' sin publicar + SÍ está en Instagram  -> la marca publicada (con su post real).
    Efecto: el reintento queda bloqueado, no se puede duplicar.
  - Pieza 'aprobada' sin publicar y NO está en Instagram  -> la devuelve a pendiente para
    reintentar limpio (nada quedó a mitad).
  - Además detecta DUPLICADOS ya publicados y los reporta (borrarlos es manual: la API de
    publicación no permite borrar).

Uso:  reconciliar_publicacion.py [--aplicar]   (sin --aplicar solo informa)
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ads_crypto  # noqa: E402

APLICAR = "--aplicar" in sys.argv
MARGEN_MIN = 20   # una pieza aprobada hace menos de esto puede estar publicándose todavía
# OJO: filtramos por aprobado_en, NO por actualizado_en: un trigger (trg_rev_upd) pisa
# actualizado_en en cada UPDATE, así que no sirve para medir cuánto lleva trabada.


def psql(sql):
    cid = subprocess.run(["docker", "ps", "-q", "-f", "name=crm_pgvector.1."],
                         capture_output=True, text=True).stdout.strip()
    return subprocess.run(["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude",
                           "-t", "-A", "-q", "-c", sql], capture_output=True, text=True)


def q(sql):
    return psql(sql).stdout.strip()


def ig_media(token, limite=25):
    """Últimos posts de la cuenta propia (graph.instagram.com)."""
    url = (f"https://graph.instagram.com/v19.0/me/media"
           f"?fields=id,caption,timestamp,permalink,media_type&limit={limite}&access_token={token}")
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r).get("data", []), None
    except urllib.error.HTTPError as e:
        try:
            return None, json.loads(e.read().decode()).get("error", {}).get("message", "")[:120]
        except Exception:
            return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)[:120]


def norm(t):
    """Normaliza para comparar captions (IG recorta/reformatea)."""
    return re.sub(r"\s+", " ", (t or "")).strip().lower()[:120]


def main():
    # Piezas que quedaron entre 'aprobada' y 'publicada'.
    # JSON, NO texto separado por líneas: los captions tienen saltos de línea y romperían el parseo.
    crudo = q("SELECT coalesce(json_agg(t)::text,'[]') FROM ("
              "SELECT pz.id AS pieza_id, n.slug, pz.numero, coalesce(r.caption,'') AS caption "
              "FROM contenido.piezas pz "
              "JOIN contenido.revisiones r ON r.id=pz.revision_vigente "
              "JOIN contenido.negocios n ON n.id=pz.negocio_id "
              "WHERE r.estado='aprobada' AND r.publicado_en IS NULL "
              f"AND r.aprobado_en < now()-interval '{MARGEN_MIN} minutes') t")
    try:
        pendientes = json.loads(crudo or "[]")
    except Exception:
        print("  no pude leer las piezas trabadas"); return

    if not pendientes:
        print("  sin piezas trabadas entre aprobar y publicar")
    # Token por negocio (cacheado): solo consultamos las cuentas que hagan falta.
    cache = {}

    def token_de(slug):
        if slug not in cache:
            enc = q("SELECT coalesce(pp.ig_token_enc,'') FROM contenido.negocio_perfil pp "
                    f"JOIN contenido.negocios n ON n.id=pp.negocio_id WHERE n.slug='{slug}'")
            cache[slug] = ads_crypto.decrypt(enc) if enc else None
        return cache[slug]

    for fila in pendientes:
        pid, slug, numero, caption = fila['pieza_id'], fila['slug'], fila['numero'], fila['caption']
        tok = token_de(slug)
        if not tok:
            print(f"  CF-{int(numero):04d} ({slug}): sin token de IG, no puedo verificar")
            continue
        posts, err = ig_media(tok)
        if posts is None:
            print(f"  CF-{int(numero):04d} ({slug}): no pude consultar Instagram ({err})")
            continue

        iguales = [p for p in posts if norm(p.get("caption")) and norm(p.get("caption")) == norm(caption)]
        if iguales:
            # SÍ se publicó (aunque la API dijera que falló). Sincronizamos con el más viejo.
            iguales.sort(key=lambda p: p.get("timestamp", ""))
            real = iguales[0]
            print(f"  CF-{int(numero):04d} ({slug}): SÍ está publicada -> {real['permalink']}"
                  + (f"  [OJO: {len(iguales)} DUPLICADOS en la cuenta]" if len(iguales) > 1 else ""))
            if len(iguales) > 1:
                for d in iguales[1:]:
                    print(f"        duplicado a borrar a mano: {d['permalink']}")
            if APLICAR:
                r = psql(
                    "WITH v AS (UPDATE contenido.revisiones r SET estado='publicada', "
                    f"publicado_en='{real['timestamp']}', ig_post_id='{real['id']}', "
                    f"ig_permalink='{real['permalink']}' "
                    f"FROM contenido.piezas pz WHERE pz.id='{pid}' AND r.id=pz.revision_vigente "
                    "RETURNING r.pieza_id) "
                    "UPDATE contenido.piezas pz SET estado='publicada' FROM v WHERE pz.id=v.pieza_id;")
                print("        -> marcada como publicada" if r.returncode == 0 else "        -> ERROR al marcar")
        else:
            # NO se publicó: devolver a pendiente para reintentar sin residuos.
            print(f"  CF-{int(numero):04d} ({slug}): NO está en Instagram -> devolver a pendiente")
            if APLICAR:
                r = psql(
                    "UPDATE contenido.revisiones r SET estado='pendiente_aprobacion', aprobado_en=NULL, "
                    "aprobado_por=NULL FROM contenido.piezas pz "
                    f"WHERE pz.id='{pid}' AND r.id=pz.revision_vigente AND r.publicado_en IS NULL; "
                    f"UPDATE contenido.piezas SET estado='pendiente_aprobacion' WHERE id='{pid}' AND estado='aprobada';")
                print("        -> devuelta a pendiente" if r.returncode == 0 else "        -> ERROR")

    if not APLICAR and pendientes:
        print("\n  (informativo — para aplicar los cambios: reconciliar_publicacion.py --aplicar)")


if __name__ == "__main__":
    main()
