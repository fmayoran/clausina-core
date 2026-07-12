#!/usr/bin/env python3
"""Lente pública de Instagram: leer el perfil de CUALQUIER cuenta Business/Creator pública.

Usa `business_discovery` de la Graph API: una cuenta IG Business nuestra (la "lente") consulta
datos públicos de otra. Es la vía OFICIAL. Scrapear instagram.com no es alternativa: Meta
responde 429 a las IPs de datacenter (probado con curl y con Chromium), y saltarlo requeriría
loguearse, que viola sus términos y arriesga la cuenta de la marca.

Límites reales, no los escondas al usuario:
- Solo lee cuentas **Business o Creator** públicas. Una cuenta **personal** no se ve. Nunca.
- Necesita un token con: instagram_basic, instagram_manage_insights, pages_read_engagement,
  pages_show_list. Sin `instagram_manage_insights` la API contesta "(#10) Application does not
  have permission" aunque no le pidas ninguna métrica.

La lente es de PLATAFORMA, no de marca (hoy usa la cuenta de Cortafuego; el pendiente es
migrarla a la cuenta de ClaUsina, que es lo correcto: mira la agencia, no una marca).

Uso:  ig_publico.py <handle> [--media N] [--fotos DIR]
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ads_crypto  # noqa: E402

API = "https://graph.facebook.com/v21.0"
CAMPOS_PERFIL = "username,name,biography,website,followers_count,media_count,profile_picture_url"
CAMPOS_MEDIA = "caption,like_count,comments_count,timestamp,media_type,media_url,thumbnail_url,permalink"


def _pg(sql):
    import subprocess
    cid = subprocess.run(["docker", "ps", "-q", "-f", "name=crm_pgvector.1."],
                         capture_output=True, text=True).stdout.strip()
    return subprocess.run(["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude",
                           "-t", "-A", "-q", "-c", sql], capture_output=True, text=True).stdout.strip()


def lente():
    """(ig_id, token) de la lente, desde la config de plataforma (cifrada en la DB)."""
    row = _pg("SELECT valor FROM contenido.plataforma_config WHERE clave='ig_lente_id'")
    tok = _pg("SELECT valor_enc FROM contenido.plataforma_config WHERE clave='ig_lente_token'")
    if not row or not tok:
        raise RuntimeError("La lente de Instagram no está configurada (panel → Configuración).")
    return row, ads_crypto.decrypt(tok)


def _get(url):
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r), None
    except urllib.error.HTTPError as e:
        err = json.loads(e.read().decode()).get("error", {})
        return None, err.get("message", "")[:200]
    except Exception as e:
        return None, str(e)[:200]


def perfil(handle, n_media=12):
    """Perfil público + últimos posts. Devuelve (datos, error)."""
    h = handle.strip().lstrip("@")
    ig_id, tok = lente()
    f = (f"business_discovery.username({h})"
         f"{{{CAMPOS_PERFIL},media.limit({n_media}){{{CAMPOS_MEDIA}}}}}")
    d, err = _get(f"{API}/{ig_id}?fields={urllib.parse.quote(f)}&access_token={tok}")
    if err:
        # El error de Meta acá es críptico: traducilo a algo que el usuario pueda accionar.
        if any(x in err for x in ("does not exist", "Cannot find", "cannot be loaded", "Invalid user id")):
            return None, (f"No se pudo leer @{h}. Instagram solo permite consultar cuentas "
                          "**Business o Creator** públicas: si es una cuenta personal o privada, "
                          "no hay forma de leerla por API.")
        if "#10" in err or "does not have permission" in err:
            return None, ("Al token de la lente le falta el permiso `instagram_manage_insights`.")
        return None, err
    bd = (d or {}).get("business_discovery") or {}
    if not bd:
        return None, f"Instagram no devolvió datos de @{h}."
    return bd, None


def cadencia(medias):
    """Cada cuántos días publica (mediana de los huecos). Señal de si la cuenta está viva."""
    from datetime import datetime
    fechas = []
    for m in medias:
        try:
            fechas.append(datetime.fromisoformat(m["timestamp"].replace("+0000", "+00:00")))
        except Exception:
            pass
    if len(fechas) < 2:
        return None
    fechas.sort(reverse=True)
    huecos = [(fechas[i] - fechas[i + 1]).days for i in range(len(fechas) - 1)]
    huecos.sort()
    return huecos[len(huecos) // 2]


def bajar_fotos(medias, dirdest, n=6):
    """Baja las imágenes del feed: el analista tiene que VER la grilla, no imaginarla."""
    os.makedirs(dirdest, exist_ok=True)
    out = []
    for i, m in enumerate(medias[:n]):
        url = m.get("thumbnail_url") if m.get("media_type") == "VIDEO" else m.get("media_url")
        if not url:
            continue
        p = os.path.join(dirdest, f"ig_{i:02d}.jpg")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ClaUsina/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r, open(p, "wb") as f:
                f.write(r.read(8_000_000))
            out.append(p)
        except Exception:
            pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("handle")
    ap.add_argument("--media", type=int, default=12)
    ap.add_argument("--fotos", default="", help="directorio donde bajar las imágenes del feed")
    a = ap.parse_args()

    d, err = perfil(a.handle, a.media)
    if err:
        print(json.dumps({"error": err}, ensure_ascii=False))
        return
    medias = (d.get("media") or {}).get("data") or []
    out = {
        "username": d.get("username"), "nombre": d.get("name"),
        "biografia": d.get("biography"), "web": d.get("website"),
        "seguidores": d.get("followers_count"), "publicaciones": d.get("media_count"),
        "foto_perfil": d.get("profile_picture_url"),
        "cadencia_dias": cadencia(medias),
        "posts": [{
            "fecha": m.get("timestamp", "")[:10], "tipo": m.get("media_type"),
            "likes": m.get("like_count"), "comentarios": m.get("comments_count"),
            "caption": m.get("caption"), "permalink": m.get("permalink"),
        } for m in medias],
    }
    if a.fotos:
        out["fotos"] = bajar_fotos(medias, a.fotos)
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
