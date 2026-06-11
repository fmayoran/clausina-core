#!/usr/bin/env python3
"""
Validador de calidad web de la landing de Cortafuego.
Comprueba las premisas SEO/AEO/performance del skill /creativo antes de un commit.
Uso: python3 validate_web.py   (exit 0 = ok, exit 1 = falla con reporte)
"""
import os, re, json, sys, glob
import xml.dom.minidom as minidom

BASE = os.path.join(os.path.dirname(__file__), "..", "assets", "landing")
BASE = os.path.abspath(BASE)
errors = []

def err(f, msg):
    errors.append(f"  [{os.path.basename(f)}] {msg}")

for html in sorted(glob.glob(os.path.join(BASE, "*.html"))):
    s = open(html, encoding="utf-8").read()

    # 1. Un solo <h1>
    h1 = len(re.findall(r"<h1[\s>]", s))
    if h1 != 1:
        err(html, f"debe haber exactamente 1 <h1> (hay {h1})")

    # 2. Meta description
    if not re.search(r'<meta\s+name="description"\s+content="[^"]{1,160}"', s):
        err(html, 'falta <meta name="description"> (o supera 160 car)')

    # 3. Canonical
    if 'rel="canonical"' not in s:
        err(html, 'falta <link rel="canonical">')

    # 4. Open Graph image
    if 'property="og:image"' not in s:
        err(html, 'falta og:image')

    # 5. JSON-LD parseable
    for i, block in enumerate(re.findall(r'<script type="application/ld\+json">(.*?)</script>', s, re.S), 1):
        try:
            json.loads(block)
        except Exception as e:
            err(html, f"JSON-LD #{i} inválido: {e}")

    # 6. Sin Google Fonts (fuentes self-hosted)
    if "fonts.googleapis.com" in s or "fonts.gstatic.com" in s:
        err(html, "referencia a Google Fonts (deben ser self-hosted en fonts/)")

    # 7. Sin imágenes PNG referenciadas (deben ser WebP)
    pngs = re.findall(r'img/[a-z0-9_]+\.png', s)
    if pngs:
        err(html, f"referencia(s) a PNG (usar WebP): {', '.join(sorted(set(pngs)))}")

# 8. sitemap.xml válido
sitemap = os.path.join(BASE, "sitemap.xml")
if os.path.exists(sitemap):
    try:
        minidom.parse(sitemap)
    except Exception as e:
        errors.append(f"  [sitemap.xml] XML inválido: {e}")
else:
    errors.append("  [sitemap.xml] no existe")

if errors:
    print("VALIDACIÓN DE CALIDAD WEB FALLIDA:")
    print("\n".join(errors))
    print("\nRevisar el 'Checklist de calidad web' del skill /creativo.")
    sys.exit(1)

print("Calidad web OK (SEO/AEO/estructura).")
sys.exit(0)
