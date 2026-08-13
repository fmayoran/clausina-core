#!/usr/bin/env python3
"""Auditoría técnica de la web de un negocio, contra el sitio VIVO.

Uso: auditoria_web.py <url>   ->  JSON por stdout con la forma que dibuja el panel.

No se reusa validate_web.py a propósito: aquél mira los archivos de la cápsula ANTES de un commit
y bloquea. Éste mira lo que el visitante recibe hoy, que es lo único que importa para auditar —un
deploy que no salió deja la cápsula perfecta y el sitio viejo—.

El checklist es el mismo que ya estaba guardado en las auditorías de junio: los nombres de ítem se
respetan para que dos auditorías del mismo negocio se puedan comparar.
"""
import json, re, sys, urllib.parse, urllib.request

TIMEOUT = 20
UA = 'Mozilla/5.0 (compatible; ClaUsinaAuditor/1.0)'


def traer(url):
    pedido = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(pedido, timeout=TIMEOUT) as r:
        return r.status, r.read().decode('utf-8', 'replace')


def existe(url):
    try:
        return traer(url)[0] == 200
    except Exception:
        return False


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else ''
    if not url:
        print(json.dumps({'error': 'sin url'})); return
    if not url.startswith('http'):
        url = 'https://' + url
    base = '{0.scheme}://{0.netloc}'.format(urllib.parse.urlsplit(url))
    dominio = urllib.parse.urlsplit(url).netloc

    try:
        estado, html = traer(url)
    except Exception as e:
        print(json.dumps({'error': f'no responde: {str(e)[:120]}'})); return

    bajo = html.lower()

    def meta(prop, attr='name'):
        m = re.search(r'<meta[^>]+%s=["\']%s["\'][^>]*content=["\']([^"\']*)' % (attr, prop), html, re.I)
        if not m:
            m = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]*%s=["\']%s["\']' % (attr, prop), html, re.I)
        return m.group(1).strip() if m else ''

    titulo = (re.search(r'<title[^>]*>(.*?)</title>', html, re.I | re.S).group(1).strip()
              if re.search(r'<title[^>]*>(.*?)</title>', html, re.I | re.S) else '')
    desc = meta('description')
    h1 = len(re.findall(r'<h1\b', bajo))
    imgs = re.findall(r'<img[^>]+src=["\']([^"\']+)', html, re.I)
    webp = [x for x in imgs if '.webp' in x.lower()]
    sin_alt = len([t for t in re.findall(r'<img[^>]*>', html, re.I) if not re.search(r'\balt=', t, re.I)])

    # JSON-LD: no alcanza con que esté, tiene que parsear. Uno roto no lo lee ningún buscador.
    ld_tipos, ld_ok = [], True
    for bloque in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.I | re.S):
        try:
            d = json.loads(bloque.strip())
            for x in (d if isinstance(d, list) else [d]):
                t = x.get('@type') if isinstance(x, dict) else None
                if t: ld_tipos.append(str(t).lower())
        except Exception:
            ld_ok = False

    chk = [
        ('SEO', 'Título', bool(titulo) and len(titulo) <= 60, f'{len(titulo)} car.' if titulo else 'falta'),
        ('SEO', 'Meta description', bool(desc) and len(desc) <= 160, f'{len(desc)} car.' if desc else 'falta'),
        ('SEO', 'Canonical', 'rel="canonical"' in bajo or "rel='canonical'" in bajo, ''),
        ('SEO', 'Un solo H1', h1 == 1, f'{h1} h1'),
        ('SEO', 'robots.txt', existe(base + '/robots.txt'), ''),
        ('SEO', 'sitemap.xml', existe(base + '/sitemap.xml'), ''),
        ('Social', 'og:title', bool(meta('og:title', 'property')), ''),
        ('Social', 'og:description', bool(meta('og:description', 'property')), ''),
        ('Social', 'og:image', bool(meta('og:image', 'property')), ''),
        ('Social', 'Twitter card', bool(meta('twitter:card')), ''),
        ('Datos', 'JSON-LD (schema)', bool(ld_tipos) and ld_ok,
         (','.join(sorted(set(ld_tipos))[:3]) if ld_tipos else 'falta') + ('' if ld_ok else ' (no parsea)')),
        ('Mobile', 'Viewport', 'name="viewport"' in bajo or "name='viewport'" in bajo, ''),
        ('Mobile', 'HTTPS', url.startswith('https') and estado == 200, f'HTTP {estado}'),
        ('Perf', 'Imágenes en WebP', bool(imgs) and len(webp) == len(imgs), f'{len(webp)}/{len(imgs)}'),
        ('Perf', 'Favicon', 'rel="icon"' in bajo or "rel='icon'" in bajo or 'rel="shortcut icon"' in bajo, ''),
        ('Perf', 'HTML liviano', len(html) < 120_000, f'{round(len(html)/1024)} KB'),
        # Accesibilidad: un alt vacío no rompe nada visible, y por eso se olvida siempre.
        ('Mobile', 'Imágenes con alt', sin_alt == 0, 'todas' if sin_alt == 0 else f'{sin_alt} sin alt'),
        # Sin fuentes de Google el sitio no le cuenta a un tercero quién lo visita.
        ('Perf', 'Fuentes propias', 'fonts.googleapis.com' not in bajo, ''),
    ]

    cats = {}
    for cat, item, ok, det in chk:
        c = cats.setdefault(cat, {'nombre': cat, 'ok': 0, 'total': 0})
        c['total'] += 1
        c['ok'] += 1 if ok else 0
    for c in cats.values():
        c['pct'] = round(100 * c['ok'] / c['total'])

    ok_n = sum(1 for x in chk if x[2])
    print(json.dumps({
        'dominio': dominio,
        'score': round(100 * ok_n / len(chk)),
        'checks_ok': ok_n, 'checks_total': len(chk),
        'html_kb': round(len(html) / 1024),
        'recursos': {'imagenes': len(imgs), 'webp': len(webp),
                     'css': len(re.findall(r'<link[^>]+stylesheet', html, re.I)),
                     'scripts': len(re.findall(r'<script[^>]+src=', html, re.I))},
        'categorias': list(cats.values()),
        'checklist': [{'cat': c, 'item': i, 'ok': o, 'detalle': d} for c, i, o, d in chk],
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
