#!/usr/bin/env python3
"""Auditoría de Instagram de un negocio: KPIs sobre lo publicado + comparación con benchmark.

Uso: auditoria_ig.py <slug>   ->  JSON por stdout con la forma que dibuja el panel.

Sale de lo que la plataforma ya midió (contenido.ig_metricas, que llena el sync de Meta), no de
una lectura en vivo: auditar es mirar la serie, y la serie está en la base.

El benchmark es de referencia pública para cuentas chicas de negocio local; no es una medición del
rubro. Se declara como tal en la pantalla ("típico 1-3%") para que nadie lo lea como una promesa.
"""
import json, os, subprocess, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import benchmarks as B  # noqa: E402

BENCHMARK = {
    'er_alcance_tipico': '1-3%',
    'er_seguidores_tipico': '1-1,5%',
    'reach_rate_tipico': '20-35%',
    'cadencia_tipica': '3-5 por semana',
}


def q(sql):
    pg = subprocess.run(['docker', 'ps', '-q', '-f', 'name=crm_pgvector.1.'],
                        capture_output=True, text=True).stdout.strip().split('\n')[0]
    r = subprocess.run(['docker', 'exec', '-i', pg, 'psql', '-U', 'postgres', '-d', 'claude',
                        '-t', '-A', '-q', '-c', sql], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    return r.stdout.strip()


def main():
    slug = sys.argv[1] if len(sys.argv) > 1 else ''
    if not slug:
        print(json.dumps({'error': 'sin slug'})); return

    filas = q(f"""
      SELECT coalesce(json_agg(t), '[]') FROM (
        SELECT to_char(r.publicado_en, 'YYYY-MM-DD') AS fecha,
               to_char(r.publicado_en, 'YYYY-MM')    AS mes,
               EXTRACT(dow FROM r.publicado_en)::int AS dow,
               p.titulo_interno AS titulo,
               CASE WHEN EXISTS (SELECT 1 FROM contenido.media m
                                  WHERE m.pieza_id = p.id AND m.tipo = 'video')
                    THEN 'reel' ELSE 'feed' END AS formato,
               coalesce(g.reach,0) AS reach, coalesce(g.views,0) AS views,
               coalesce(g.saved,0) AS saved, coalesce(g.shares,0) AS shares,
               coalesce(g.total_interactions,
                        coalesce(g.likes,0)+coalesce(g.comments,0)+coalesce(g.saved,0)+coalesce(g.shares,0)) AS interac
          FROM contenido.revisiones r
          JOIN contenido.piezas p ON p.id = r.pieza_id
          JOIN contenido.negocios n ON n.id = p.negocio_id
          LEFT JOIN contenido.ig_metricas g ON g.ig_post_id = r.ig_post_id
         WHERE n.slug = '{slug}' AND r.ig_post_id IS NOT NULL AND r.publicado_en IS NOT NULL
         ORDER BY r.publicado_en) t""")
    posts = json.loads(filas or '[]')
    # Sin nada publicado no hay auditoría de Instagram que valga: inventar KPIs sobre cero posts es
    # peor que decir que todavía no hay datos.
    if not posts:
        print(json.dumps({'vacio': True, 'benchmark': BENCHMARK}, ensure_ascii=False)); return

    con_reach = [p for p in posts if p['reach']]
    prom = lambda xs: round(sum(xs) / len(xs), 1) if xs else None

    reach_prom = prom([p['reach'] for p in con_reach])
    interac_prom = prom([p['interac'] for p in con_reach])
    er_alcance = round(100 * sum(p['interac'] for p in con_reach) / sum(p['reach'] for p in con_reach), 2) \
        if con_reach and sum(p['reach'] for p in con_reach) else None

    # Los seguidores salen de la SERIE de contenido.perfil_social_diario, no de una lectura suelta.
    # Antes llegaban por la variable IG_SEGUIDORES, que el job llenaba pegándole a
    # graph.facebook.com con el token de Instagram Login — combinación que devuelve "Invalid OAuth
    # access token". Nunca traía nada, así que la auditoría venía diciendo "seguidores: sin dato" y
    # recomendando medirlos como punto 1, con el dato disponible del otro lado.
    # La serie además da algo que el valor suelto no: cuánto creció, que es la pregunta real.
    seguidores = crecimiento = None
    serie = json.loads(q(f"""
      SELECT coalesce(json_agg(t), '[]') FROM (
        SELECT to_char(d.fecha,'YYYY-MM-DD') AS fecha, d.seguidores
          FROM contenido.perfil_social_diario d JOIN contenido.negocios n ON n.id = d.negocio_id
         WHERE n.slug = '{slug}' AND d.red = 'instagram'
         ORDER BY d.fecha DESC LIMIT 60) t""") or '[]')
    if serie:
        seguidores = serie[0]['seguidores']
        if len(serie) > 1:
            viejo = serie[-1]['seguidores']
            crecimiento = {'desde': serie[-1]['fecha'], 'hasta': serie[0]['fecha'],
                           'dias': len(serie), 'de': viejo, 'a': seguidores,
                           'alta': seguidores - viejo,
                           'pct': round(100 * (seguidores - viejo) / viejo, 2) if viejo else None}
    if not seguidores:
        try:
            seguidores = int(os.environ.get('IG_SEGUIDORES') or 0) or None
        except ValueError:
            pass
    er_seguidores = round(100 * (interac_prom or 0) / seguidores, 2) if seguidores else None
    reach_rate = round(100 * (reach_prom or 0) / seguidores, 1) if seguidores else None

    # Cadencia real del período, para poder contrastarla contra el benchmark sin que la lea un
    # modelo a ojo desde la tabla mensual.
    from datetime import date as _d
    def _f(x):
        a, b, c = x.split('-'); return _d(int(a), int(b), int(c))
    dias_periodo = max(1, (_f(posts[-1]['fecha']) - _f(posts[0]['fecha'])).days)
    cadencia_sem = round(len(posts) / (dias_periodo / 7), 2) if dias_periodo >= 7 else None

    cad = defaultdict(list)
    for p in posts:
        cad[p['mes']].append(p)
    cadencia = [{'mes': m, 'posts': len(v), 'reach_prom': prom([x['reach'] for x in v if x['reach']]) or 0}
                for m, v in sorted(cad.items())]

    fmt = defaultdict(list)
    for p in posts:
        fmt[p['formato']].append(p)
    por_formato = [{'formato': f, 'n': len(v),
                    'reach_prom': prom([x['reach'] for x in v if x['reach']]) or 0,
                    'views_prom': prom([x['views'] for x in v if x['views']]) or 0,
                    'er_pct': round(100 * sum(x['interac'] for x in v) / max(1, sum(x['reach'] for x in v)), 2)}
                   for f, v in sorted(fmt.items(), key=lambda kv: -len(kv[1]))]

    for p in posts:
        p['er_pct'] = round(100 * p['interac'] / p['reach'], 1) if p['reach'] else 0
        p['titulo'] = (p['titulo'] or '')[:40]
    top = sorted(con_reach, key=lambda x: -x['er_pct'])[:5]

    # Qué día rinde mejor: es la recomendación más accionable que sale de la serie propia.
    dsem = defaultdict(list)
    for p in con_reach:
        dsem[p['dow']].append(p['reach'])
    NOMBRE = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
    por_dia = [{'dia': NOMBRE[d], 'n': len(v), 'reach_prom': prom(v)} for d, v in sorted(dsem.items())]

    metricas = [B.ficha('er_alcance', er_alcance), B.ficha('er_seguidores', er_seguidores),
                B.ficha('reach_rate', reach_rate),
                B.ficha('cadencia_semanal', cadencia_sem)]

    print(json.dumps({
        'followers': seguidores,
        'crecimiento': crecimiento,
        'metricas': metricas,
        'periodo': f"{posts[0]['fecha']} → {posts[-1]['fecha']}",
        'global': {
            'posts': len(posts),
            'con_metricas': len(con_reach),
            'er_alcance': er_alcance,
            'er_seguidores': er_seguidores,
            'reach_prom': reach_prom, 'reach_rate': reach_rate,
            'views_prom': prom([p['views'] for p in posts if p['views']]),
            'guard_prom': prom([p['saved'] for p in con_reach]),
            'compart_prom': prom([p['shares'] for p in con_reach]),
            'interac_prom': interac_prom,
        },
        'benchmark': BENCHMARK,
        'cadencia': cadencia,
        'por_formato': por_formato,
        'por_dia': por_dia,
        'top': top,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
