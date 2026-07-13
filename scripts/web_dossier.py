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
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

MOTOR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Debajo de esto, el HTML estático es un cascarón: el sitio se arma con JS -> hay que renderizar.
MIN_TEXTO = 900


def render(url, out_html, out_png):
    """Chromium (Playwright) para sitios JS y para VER la marca. Devuelve (html, png, error)."""
    try:
        r = subprocess.run(["node", f"{MOTOR}/scripts/web_render.js", url, out_html, out_png],
                           capture_output=True, text=True, timeout=90)
        d = json.loads((r.stdout or "{}").strip().splitlines()[-1])
    except Exception as e:
        return None, None, str(e)[:120]
    if not d.get("ok"):
        return None, None, d.get("error", "render falló")
    h = open(out_html, encoding="utf-8", errors="replace").read() if os.path.exists(out_html) else None
    png = out_png if (out_png and os.path.exists(out_png)) else None
    return h, png, None


def paleta_real(png, n=6):
    """Colores dominantes de la captura. El CSS miente (variables, gradientes); el píxel no."""
    try:
        from PIL import Image
        im = Image.open(png).convert("RGB").resize((320, 200))
        q = im.quantize(colors=12, method=Image.MEDIANCUT).convert("RGB")
        cuenta = sorted(q.getcolors(80_000) or [], key=lambda kv: -kv[0])
        total = sum(c for c, _ in cuenta) or 1
        out = []
        for c, (r, g, b) in cuenta[:n]:
            out.append(("#%02X%02X%02X" % (r, g, b), round(100 * c / total)))
        return out
    except Exception:
        return []

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
    ap.add_argument("--shot", default="", help="ruta del screenshot de la home (habilita el render)")
    a = ap.parse_args()

    f = open(a.out, "w", encoding="utf-8")
    f.write("# Dossier de presencia digital (bajado automáticamente)\n")
    f.write("_Todo lo de acá es material crudo leído de fuentes públicas. Lo que no está, no se pudo leer._\n")

    if a.web:
        web = a.web if a.web.startswith("http") else "https://" + a.web
        h, err = bajar(web)
        sec(f, f"Sitio: {web}")

        # Si el HTML estático viene vacío o flaco, el sitio se arma con JS: renderizamos.
        render_err = None
        if a.shot and (not h or len(texto(h)) < MIN_TEXTO):
            hr, png, render_err = render(web, a.shot.replace(".png", ".html"), a.shot)
            if hr:
                h = hr
                f.write("_(el sitio se arma con JS: leído con navegador)_\n")
        elif a.shot:
            _, _, render_err = render(web, a.shot.replace(".png", ".html"), a.shot)

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
            # Paleta desde la captura: el CSS miente (variables, gradientes, imágenes); el píxel no.
            if a.shot and os.path.exists(a.shot):
                pal = paleta_real(a.shot)
                if pal:
                    f.write("- Paleta REAL de la home (colores dominantes de la captura, con % de superficie): "
                            + ", ".join(f"{c} ({p}%)" for c, p in pal) + "\n")
                f.write(f"- Captura de la home: {a.shot} — **abrila con Read**: es la única forma de ver "
                        "de verdad la identidad visual (tipografía, imaginario, uso del color).\n")
            elif render_err:
                f.write(f"- (No se pudo capturar la home: {render_err})\n")
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
        sec(f, f"Instagram: @{handle}")
        # Vía OFICIAL (business_discovery), no scraping: instagram.com da 429 a los servidores.
        try:
            import ig_publico
            d, err = ig_publico.perfil(handle, n_media=12)
        except Exception as e:
            d, err = None, str(e)[:200]

        if err or not d:
            f.write(f"NO SE PUDO LEER: {err}\n"
                    "NO asumas nada del feed: ni seguidores, ni cantidad de posts, ni temática. "
                    "Decilo en `hallazgos`.\n")
        else:
            medias = (d.get("media") or {}).get("data") or []
            cad = ig_publico.cadencia(medias)
            f.write(f"- Nombre: {d.get('name') or ''}\n")
            f.write(f"- Seguidores: {d.get('followers_count'):,} · Publicaciones: {d.get('media_count'):,}\n")
            if d.get("website"):
                f.write(f"- Web que declara en la bio: {d['website']}\n")
            if cad is not None:
                f.write(f"- Cadencia: publica cada ~{cad} día(s) (mediana de los últimos posts)\n")
            f.write(f"- Bio:\n```\n{d.get('biography') or ''}\n```\n")
            if medias:
                ls = [m.get("like_count") or 0 for m in medias]
                f.write(f"\n### Últimos {len(medias)} posts (engagement real: promedio {sum(ls)//len(ls)} likes)\n")
                for m in medias:
                    cap = " ".join((m.get("caption") or "").split())[:220]
                    f.write(f"- **{m.get('timestamp','')[:10]}** · {m.get('media_type')} · "
                            f"{m.get('like_count')} likes · {m.get('comments_count')} comentarios\n"
                            f"  > {cap}\n")
                # Las imágenes del feed: el estilo visual se VE, no se deduce de los captions.
                if a.shot:
                    dirf = a.shot.rsplit(".", 1)[0] + "_igfeed"
                    fotos = ig_publico.bajar_fotos(medias, dirf, n=6)
                    if fotos:
                        f.write(f"\n### Imágenes del feed ({len(fotos)}) — **abrilas con Read**\n"
                                "Es la grilla real de la marca: mirá el tratamiento visual, la paleta, "
                                "si usan fotos propias o stock, si hay texto sobre la imagen.\n"
                                + "\n".join(f"- {p}" for p in fotos) + "\n")

    f.close()
    print(f"dossier -> {a.out}")


if __name__ == "__main__":
    main()
