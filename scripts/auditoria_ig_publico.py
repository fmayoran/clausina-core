#!/usr/bin/env python3
"""Auditoría de Instagram de una cuenta que la plataforma NO publica: la mirada de afuera.

POR QUÉ EXISTE. `auditoria_ig.py` mide lo que ClaUsina publicó: sale de `contenido.revisiones` y
cruza las métricas privadas que trae el sync. Para un negocio que ACABA de entrar eso es cero, y la
auditoría moría con "no tiene sitio cargado ni publicaciones con métricas" — justo cuando más sirve,
porque es el momento de decidir qué hacer con la cuenta. Wera Sushi entró el 10/10/2026 con 136
publicaciones propias y 2675 seguidores, y la plataforma no tenía forma de mirarlas.

Esto lee la cuenta por `business_discovery` (la lente pública) y arma la misma figura que la pantalla
ya dibuja, con una diferencia que NO se disimula: desde afuera se ven los likes y los comentarios,
y NADA más. Alcance, impresiones, guardados, compartidos y visitas al perfil son métricas privadas
del dueño de la cuenta: sin su token no existen. Entonces acá:

  - la interacción se mide sobre SEGUIDORES, nunca sobre alcance;
  - todo lo que depende del alcance viaja en `null`, no en cero — un cero se lee como "rinde mal"
    cuando lo que pasa es que no lo podemos ver;
  - el JSON se marca con `fuente: 'lente_publica'` para que la pantalla lo diga.

Uso: auditoria_ig_publico.py <slug>  ->  JSON por stdout.
"""
import json
import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import benchmarks as B      # noqa: E402
import ig_publico           # noqa: E402

NOMBRE_DIA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo']
# Cómo nombramos los formatos: igual que la auditoría propia, para que las dos pantallas se lean
# igual. CAROUSEL_ALBUM va aparte porque en casi toda cuenta rinde distinto que la foto suelta.
FORMATO = {'VIDEO': 'reel', 'IMAGE': 'feed', 'CAROUSEL_ALBUM': 'carrusel'}

NOTA_LIMITE = (
    'Medido desde afuera, con la lente pública de Instagram: se ven los likes y los comentarios de '
    'cada publicación, y nada más. El alcance, las impresiones, los guardados, los compartidos y '
    'las visitas al perfil son métricas privadas de la cuenta y no se pueden leer sin su token. '
    'Por eso la interacción va sobre SEGUIDORES y no sobre alcance, y lo que depende del alcance '
    'aparece sin dato en vez de en cero. Conectando el Instagram del negocio, la próxima auditoría '
    'mide todo.')


def pg(sql):
    cid = subprocess.run(['docker', 'ps', '-q', '-f', 'name=crm_pgvector.1.'],
                         capture_output=True, text=True).stdout.strip().split('\n')[0]
    return subprocess.run(['docker', 'exec', '-i', cid, 'psql', '-U', 'postgres', '-d', 'claude',
                           '-t', '-A', '-q', '-c', sql],
                          capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout.strip()


def main():
    slug = sys.argv[1] if len(sys.argv) > 1 else ''
    if not slug:
        print(json.dumps({'error': 'sin slug'})); return

    handle = pg(f"SELECT coalesce(ig_handle,'') FROM contenido.negocios WHERE slug='{slug}'")
    if not handle:
        print(json.dumps({'vacio': True, 'motivo': 'El negocio no tiene handle de Instagram cargado.'},
                         ensure_ascii=False)); return

    try:
        d, err = ig_publico.perfil(handle, 50)
    except Exception as e:
        print(json.dumps({'vacio': True, 'motivo': str(e)[:400]}, ensure_ascii=False)); return
    if err or not d:
        print(json.dumps({'vacio': True, 'motivo': err or 'Instagram no devolvió datos.'},
                         ensure_ascii=False)); return

    seguidores = d.get('followers_count') or None
    medias = ((d.get('media') or {}).get('data')) or []
    if not medias:
        print(json.dumps({'vacio': True,
                          'motivo': f'@{handle} no tiene publicaciones visibles por API.'},
                         ensure_ascii=False)); return

    posts = []
    for m in medias:
        try:
            ts = datetime.fromisoformat((m.get('timestamp') or '').replace('+0000', '+00:00'))
        except Exception:
            continue
        interac = (m.get('like_count') or 0) + (m.get('comments_count') or 0)
        posts.append({
            'fecha': ts.strftime('%Y-%m-%d'), 'mes': ts.strftime('%Y-%m'),
            # weekday(): 0 = lunes. La auditoría propia usa EXTRACT(dow) de Postgres, donde
            # 0 = domingo; se normaliza acá para que las dos pantallas digan el mismo día.
            'dow': ts.weekday(),
            'titulo': (m.get('caption') or '').replace('\n', ' ').strip()[:40],
            'formato': FORMATO.get(m.get('media_type'), 'feed'),
            'likes': m.get('like_count') or 0, 'comentarios': m.get('comments_count') or 0,
            'interac': interac, 'permalink': m.get('permalink'),
            'er_pct': round(100 * interac / seguidores, 2) if seguidores else 0,
            # Sin token de la cuenta no hay alcance. Van en null, no en cero: ver NOTA_LIMITE.
            'reach': None, 'views': None, 'saved': None, 'shares': None,
        })
    if not posts:
        print(json.dumps({'vacio': True, 'motivo': 'Las publicaciones no traían fecha legible.'},
                         ensure_ascii=False)); return
    posts.sort(key=lambda p: p['fecha'])

    med = lambda xs: round(sorted(xs)[len(xs) // 2], 1) if xs else None
    prom = lambda xs: round(sum(xs) / len(xs), 1) if xs else None
    interac_prom = prom([p['interac'] for p in posts])
    # La MEDIANA además del promedio: un sorteo con 190 comentarios —Wera tuvo uno— le corre el
    # promedio a toda la cuenta y hace parecer normal algo que pasó una vez.
    interac_med = med([p['interac'] for p in posts])
    er_seguidores = round(100 * interac_prom / seguidores, 2) if seguidores and interac_prom else None

    f0, f1 = posts[0]['fecha'], posts[-1]['fecha']
    dias = max(1, (datetime.fromisoformat(f1) - datetime.fromisoformat(f0)).days)
    cadencia_sem = round(len(posts) / (dias / 7), 2) if dias >= 7 else None

    cad = defaultdict(list)
    for p in posts:
        cad[p['mes']].append(p)
    cadencia = [{'mes': m, 'posts': len(v), 'reach_prom': 0,
                 'interac_prom': prom([x['interac'] for x in v])}
                for m, v in sorted(cad.items())]

    fmt = defaultdict(list)
    for p in posts:
        fmt[p['formato']].append(p)
    por_formato = [{'formato': k, 'n': len(v),
                    'reach_prom': 0, 'views_prom': 0, 'er_pct': None,
                    'interac_prom': prom([x['interac'] for x in v]),
                    'interac_med': med([x['interac'] for x in v]),
                    'er_seguidores': round(100 * med([x['interac'] for x in v]) / seguidores, 2)
                                     if seguidores else None}
                   for k, v in sorted(fmt.items(), key=lambda kv: -len(kv[1]))]

    dsem = defaultdict(list)
    for p in posts:
        dsem[p['dow']].append(p['interac'])
    por_dia = [{'dia': NOMBRE_DIA[k], 'n': len(v), 'reach_prom': 0, 'interac_prom': prom(v)}
               for k, v in sorted(dsem.items())]

    top = sorted(posts, key=lambda p: -p['interac'])[:5]

    metricas = [B.ficha('er_seguidores', er_seguidores),
                B.ficha('cadencia_semanal', cadencia_sem),
                # Explícitas en null para que la pantalla muestre "sin dato" y no las omita: que
                # falten tiene que verse, porque es la diferencia entre esta auditoría y la propia.
                B.ficha('er_alcance', None), B.ficha('reach_rate', None)]

    print(json.dumps({
        'fuente': 'lente_publica',
        'nota_fuente': NOTA_LIMITE,
        'handle': d.get('username') or handle,
        'nombre': d.get('name'),
        'biografia': d.get('biography'),
        'web': d.get('website'),
        'followers': seguidores,
        'crecimiento': None,
        'publicaciones_totales': d.get('media_count'),
        'mes': None,
        'historias': None,
        'historias_nota': ('Las historias de una cuenta ajena no se pueden leer por API: sólo las ve '
                           'su dueño. Se van a medir en cuanto el negocio conecte su Instagram.'),
        'metricas': metricas,
        'periodo': f'{f0} → {f1}',
        'global': {
            'posts': len(posts), 'con_metricas': 0,
            'er_alcance': None, 'er_seguidores': er_seguidores,
            'reach_prom': None, 'reach_rate': None, 'views_prom': None,
            'guard_prom': None, 'compart_prom': None,
            'interac_prom': interac_prom, 'interac_med': interac_med,
            'likes_prom': prom([p['likes'] for p in posts]),
            'comentarios_prom': prom([p['comentarios'] for p in posts]),
        },
        'benchmark': {'er_seguidores_tipico': '1-1,5%', 'cadencia_tipica': '3-5 por semana'},
        'cadencia': cadencia, 'por_formato': por_formato, 'por_dia': por_dia, 'top': top,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
