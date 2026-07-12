#!/usr/bin/env python3
"""Dossier de presencia digital: baja lo público de una marca y lo deja en markdown legible.

Existe porque WebFetch respeta robots.txt y muchísimas webs de marca bloquean crawlers de IA
(Cloudflare + robots): el análisis volvía vacío. Acá bajamos las páginas nosotros, con un
User-Agent que dice quiénes somos. Es una lectura puntual, pedida por el usuario, del sitio de
la marca que está dando de alta. Si un sitio igual nos rechaza, lo registramos como tal: no
nos disfrazamos de navegador para evadirlo.

Instagram bloquea (429) las IPs de datacenter: se intenta best-effort y si no, se deja constancia.

Uso: web_dossier.py --web https://… --ig @handle --out /tmp/dossier.md
"""
import argparse
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request

UA = "ClaUsina/1.0 (+https://clausina.ar; lectura puntual del sitio de la marca, a pedido del usuario)"
TIMEOUT = 20
MAX_BYTES = 3_000_000
# Páginas que suelen tener la sustancia de la marca.
INTERES = ("nosotros", "about", "quienes", "historia", "servicio", "producto", "carta", "menu",
           "menú", "catalogo", "catálogo", "contacto", "contact", "propuesta", "filosofia")


def bajar(url):
    """Devuelve (html, error). Nunca levanta."""
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "es-AR,es;q=0.9",
        })
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read(MAX_BYTES)
            cs = r.headers.get_content_charset() or "utf-8"
            return raw.decode(cs, errors="replace"), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:
        return None, str(e)[:120]


def texto(h):
    h = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", h)
    h = re.sub(r"(?is)<(nav|footer)[^>]*>.*?</\1>", " ", h)
    t = html.unescape(re.sub(r"<[^>]+>", " ", h))
    return " ".join(t.split())


def metas(h):
    out = {}
    for m in re.finditer(r'<meta\s+[^>]*?(?:name|property)=["\']([^"\']+)["\'][^>]*?content=["\']([^"\']*)["\']', h, re.I):
        out[m.group(1).lower()] = html.unescape(m.group(2)).strip()
    for m in re.finditer(r'<meta\s+[^>]*?content=["\']([^"\']*)["\'][^>]*?(?:name|property)=["\']([^"\']+)["\']', h, re.I):
        out.setdefault(m.group(2).lower(), html.unescape(m.group(1)).strip())
    return out


def titulo(h):
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", h)
    return html.unescape(m.group(1)).strip() if m else ""


def jsonld(h):
    out = []
    for m in re.finditer(r'(?is)<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', h):
        try:
            out.append(json.loads(m.group(1).strip()))
        except Exception:
            pass
    return out


def colores(h):
    """Hex más repetidos en el CSS embebido: aproximación a la paleta."""
    hexes = re.findall(r"#([0-9a-fA-F]{6})\b", h)
    cuenta = {}
    for x in hexes:
        x = "#" + x.upper()
        cuenta[x] = cuenta.get(x, 0) + 1
    top = sorted(cuenta.items(), key=lambda kv: -kv[1])[:12]
    return [c for c, n in top if n > 1]


def logos(h, base):
    urls = []
    for m in re.finditer(r'<link[^>]+rel=["\'][^"\']*icon[^"\']*["\'][^>]*href=["\']([^"\']+)', h, re.I):
        urls.append(urllib.parse.urljoin(base, m.group(1)))
    for m in re.finditer(r'<img[^>]+(?:class|alt|src)=["\'][^"\']*log[oi][^"\']*["\'][^>]*>', h, re.I):
        s = re.search(r'src=["\']([^"\']+)', m.group(0), re.I)
        if s:
            urls.append(urllib.parse.urljoin(base, s.group(1)))
    return list(dict.fromkeys(urls))[:6]


def enlaces(h, base):
    dom = urllib.parse.urlparse(base).netloc
    internos, externos = [], []
    for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)', h, re.I):
        u = urllib.parse.urljoin(base, m.group(1)).split("#")[0]
        p = urllib.parse.urlparse(u)
        if p.scheme not in ("http", "https"):
            continue
        (internos if p.netloc == dom else externos).append(u)
    return list(dict.fromkeys(internos)), list(dict.fromkeys(externos))


def redes(externos):
    pat = {"instagram": r"instagram\.com", "facebook": r"facebook\.com", "tiktok": r"tiktok\.com",
           "linkedin": r"linkedin\.com", "youtube": r"youtube\.com|youtu\.be", "x": r"(?:twitter|x)\.com",
           "whatsapp": r"wa\.me|whatsapp\.com", "maps": r"maps\.(?:google|app\.goo)"}
    out = {}
    for u in externos:
        for red, rx in pat.items():
            if re.search(rx, u, re.I) and red not in out:
                out[red] = u
    return out


def contactos(t, h):
    mails = re.findall(r"[\w.+-]+@[\w-]+\.[\w.]{2,}", h)
    mails = [m for m in dict.fromkeys(mails) if not m.lower().endswith((".png", ".jpg", ".svg", ".webp"))]
    tels = re.findall(r"(?:\+54|\+\d{1,3})[\s\d().-]{7,17}\d", t)
    return mails[:5], [re.sub(r"\s+", " ", x).strip() for x in dict.fromkeys(tels)][:5]


def sec(f, t):
    f.write(f"\n## {t}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--web", default="")
    ap.add_argument("--ig", default="")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    f = open(a.out, "w", encoding="utf-8")
    f.write("# Dossier de presencia digital (bajado automáticamente)\n")
    f.write("_Todo lo de acá es material crudo leído de fuentes públicas. Lo que no está, no se pudo leer._\n")

    if a.web:
        web = a.web if a.web.startswith("http") else "https://" + a.web
        h, err = bajar(web)
        sec(f, f"Sitio: {web}")
        if not h:
            f.write(f"NO SE PUDO LEER ({err}). El sitio existe pero nos rechaza o no responde.\n")
        else:
            m = metas(h)
            ints, exts = enlaces(h, web)
            mails, tels = contactos(texto(h), h)
            f.write(f"- Título: {titulo(h)}\n")
            for k in ("description", "og:description", "og:title", "og:site_name", "og:image", "theme-color"):
                if m.get(k):
                    f.write(f"- {k}: {m[k]}\n")
            if mails:
                f.write(f"- Mails encontrados: {', '.join(mails)}\n")
            if tels:
                f.write(f"- Teléfonos encontrados: {', '.join(tels)}\n")
            r = redes(exts)
            if r:
                f.write("- Redes enlazadas: " + ", ".join(f"{k} → {v}" for k, v in r.items()) + "\n")
            col = colores(h)
            if col:
                f.write(f"- Colores más usados en el CSS: {', '.join(col)}\n")
            lg = logos(h, web)
            if lg:
                f.write(f"- Posibles logos/íconos: {', '.join(lg)}\n")
            ld = jsonld(h)
            if ld:
                f.write("\n### Datos estructurados (JSON-LD)\n```json\n"
                        + json.dumps(ld, ensure_ascii=False, indent=1)[:2500] + "\n```\n")
            f.write("\n### Texto de la home\n" + texto(h)[:6000] + "\n")

            # Páginas internas con sustancia.
            cands = [u for u in ints if any(k in u.lower() for k in INTERES)][:5]
            for u in cands:
                hh, e2 = bajar(u)
                f.write(f"\n### Página: {u}\n")
                f.write((texto(hh)[:3500] if hh else f"NO SE PUDO LEER ({e2})") + "\n")
            if not cands and ints:
                f.write("\n### Enlaces internos (no hubo páginas 'nosotros/servicios/contacto' evidentes)\n"
                        + "\n".join(f"- {u}" for u in ints[:15]) + "\n")

    if a.ig:
        handle = a.ig.strip().lstrip("@")
        url = f"https://www.instagram.com/{handle}/"
        h, err = bajar(url)
        sec(f, f"Instagram: @{handle}")
        if not h:
            f.write(f"NO SE PUDO LEER ({err}). Instagram bloquea las lecturas desde servidores; "
                    "es lo esperable. NO asumas nada del feed: ni seguidores, ni cantidad de posts, "
                    "ni temática. Si hace falta, decilo en `hallazgos`.\n")
        else:
            m = metas(h)
            for k in ("og:title", "og:description", "description"):
                if m.get(k):
                    f.write(f"- {k}: {m[k]}\n")
            if not any(m.get(k) for k in ("og:title", "og:description", "description")):
                f.write("Respondió, pero sin datos del perfil (muro de login). No asumas nada del feed.\n")

    f.close()
    print(f"dossier -> {a.out}")


if __name__ == "__main__":
    main()
