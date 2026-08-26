#!/usr/bin/env python3
"""Qué le funcionó al negocio en Instagram, resumido para que el creativo pueda usarlo.

Uso: rendimiento.py <slug> [--json]

Existe porque el creativo proponía a ciegas: decidía con el contexto de marca y las referencias
de otras cuentas, sin mirar nunca cómo le fue a lo que ya publicó ESTE negocio. Los datos estaban
—`ig_metricas` se sincroniza sola— pero nadie se los daba.

Lo que devuelve NO son filas: es un resumen con mediana por formato y los extremos con su título,
que es lo que se puede leer y usar para decidir. Y viene con la advertencia de tamaño de muestra,
porque con quince publicaciones cualquier "patrón" es una corazonada, no un dato.
"""
import argparse, json, subprocess, statistics, sys

ap = argparse.ArgumentParser()
ap.add_argument('slug')
ap.add_argument('--json', action='store_true')
A = ap.parse_args()

SEP = '\x1f'


def psql(sql):
    cid = subprocess.run(['docker', 'ps', '-q', '-f', 'name=crm_pgvector.1.'],
                         capture_output=True, text=True).stdout.strip()
    r = subprocess.run(['docker', 'exec', '-i', cid, 'psql', '-U', 'postgres', '-d', 'claude',
                        '-t', '-A', '-F', SEP, '-c', sql], capture_output=True, text=True)
    return [l.split(SEP) for l in r.stdout.strip().split('\n') if l]


filas = psql(f"""
  SELECT pz.numero, coalesce(r.formato,'feed'), coalesce(pz.titulo_interno,''),
         coalesce(im.views,0), coalesce(im.reach,0), coalesce(im.likes,0),
         to_char(r.publicado_en,'YYYY-MM-DD'),
         (SELECT count(*) FROM contenido.media m WHERE m.pieza_id=pz.id)
    FROM contenido.revisiones r
    JOIN contenido.piezas pz ON pz.id=r.pieza_id
    JOIN contenido.negocios n ON n.id=pz.negocio_id
    JOIN contenido.ig_metricas im ON im.ig_post_id=r.ig_post_id
   WHERE n.slug='{A.slug}' AND r.estado='publicada'
   ORDER BY r.publicado_en;""")

piezas = []
for f in filas:
    if len(f) < 8:
        continue
    n_media = int(f[7] or 1)
    fmt = f[1]
    # Un carrusel se declara como 'feed' igual que una foto suelta; se distingue por la cantidad
    # de medios, que es lo que de verdad cambia cómo se consume.
    if fmt == 'feed' and n_media > 1:
        fmt = 'carrusel'
    piezas.append({'numero': int(f[0]), 'formato': fmt, 'titulo': f[2],
                   'views': int(f[3]), 'reach': int(f[4]), 'likes': int(f[5]), 'fecha': f[6]})

if not piezas:
    print(f'{A.slug}: todavía no hay publicaciones con métricas. '
          f'Proponé con el contexto de marca y las referencias; no hay historia que mirar.')
    sys.exit(0)

por_formato = {}
for p in piezas:
    por_formato.setdefault(p['formato'], []).append(p)

resumen = {'negocio': A.slug, 'publicaciones': len(piezas),
           'desde': piezas[0]['fecha'], 'hasta': piezas[-1]['fecha'], 'formatos': {}}
for fmt, ps in sorted(por_formato.items(), key=lambda kv: -len(kv[1])):
    resumen['formatos'][fmt] = {
        'cantidad': len(ps),
        'views_mediana': int(statistics.median([p['views'] for p in ps])),
        'reach_mediana': int(statistics.median([p['reach'] for p in ps])),
        'likes_mediana': int(statistics.median([p['likes'] for p in ps])),
    }

ordenadas = sorted(piezas, key=lambda p: -p['views'])
k = 3 if len(piezas) < 12 else 5
resumen['mejores'] = ordenadas[:k]
resumen['peores'] = ordenadas[-k:][::-1]
# Mediana y no promedio: un solo pico se lleva el promedio y hace parecer normal lo que fue
# excepcional.
resumen['views_mediana'] = int(statistics.median([p['views'] for p in piezas]))
# ── Lo PAGO, que es otra cosa que lo orgánico ────────────────────────────────
# Una pieza puede volar de orgánico y ser cara en pauta, o al revés: el alcance orgánico lo decide
# el algoritmo y el pago lo comprás. Van separados a propósito; mezclarlos escondería justamente
# la comparación que interesa.
pagas = psql(f"""
  SELECT p2.numero, coalesce(p2.titulo_interno,''),
         sum(a.gasto)::numeric(12,2), sum(a.impresiones), sum(a.alcance), sum(a.clics),
         min(a.fecha)::text, max(a.fecha)::text
    FROM contenido.ads_ad_daily a
    JOIN contenido.negocios n ON n.id = a.negocio_id
    JOIN contenido.pauta_campania_pieza cp ON cp.meta_ad_id = a.meta_ad_id
    JOIN contenido.piezas p2 ON p2.id = cp.pieza_id
   WHERE n.slug='{A.slug}'
   GROUP BY p2.numero, p2.titulo_interno
   HAVING sum(a.impresiones) > 0
   ORDER BY sum(a.gasto) DESC;""")

resumen['pauta'] = []
for f in pagas:
    if len(f) < 8:
        continue
    gasto, impr, clics = float(f[2] or 0), int(f[3] or 0), int(f[5] or 0)
    resumen['pauta'].append({
        'numero': int(f[0]), 'titulo': f[1], 'gasto': gasto, 'impresiones': impr,
        'alcance': int(f[4] or 0), 'clics': clics,
        # CPM y CTR son lo comparable entre anuncios: el gasto solo dice cuánto se le puso encima.
        'cpm': round(gasto / impr * 1000, 2) if impr else None,
        'ctr': round(clics / impr * 100, 2) if impr else None,
        'desde': f[6], 'hasta': f[7]})

resumen['aviso'] = (
    'MUESTRA CHICA: con menos de 20 publicaciones esto es una pista, no una regla. '
    'No descartes una idea sólo porque su formato rindió poco acá.'
    if len(piezas) < 20 else
    'Las vistas dependen también de cuándo se publicó y de cuántos seguidores había entonces: '
    'compará sobre todo piezas cercanas en el tiempo.')

if A.json:
    print(json.dumps(resumen, ensure_ascii=False, indent=1))
    sys.exit(0)

print(f"== {A.slug} · {len(piezas)} publicaciones con métricas ({resumen['desde']} → {resumen['hasta']})")
print(f"   mediana general: {resumen['views_mediana']} views\n")
print("Por formato (mediana):")
for fmt, d in resumen['formatos'].items():
    print(f"  {fmt:9} n={d['cantidad']:<4} views {d['views_mediana']:<8} "
          f"reach {d['reach_mediana']:<8} likes {d['likes_mediana']}")
print("\nLo que MEJOR funcionó:")
for p in resumen['mejores']:
    print(f"  CF-{p['numero']:04d} {p['formato']:9} {p['views']:>7} views · {p['likes']:>4} likes · "
          f"{p['fecha']} · {p['titulo'][:52]}")
print("\nLo que PEOR funcionó:")
for p in resumen['peores']:
    print(f"  CF-{p['numero']:04d} {p['formato']:9} {p['views']:>7} views · {p['likes']:>4} likes · "
          f"{p['fecha']} · {p['titulo'][:52]}")
if resumen['pauta']:
    print("\nEn PAUTA (lo que se promocionó con plata; el alcance acá se compra, no se gana):")
    for p in resumen['pauta']:
        print(f"  CF-{p['numero']:04d} {p['gasto']:>7.2f} gastado · {p['impresiones']:>7} impr · "
              f"CPM {p['cpm']} · CTR {p['ctr']}% · {p['titulo'][:38]}")
    print("  Comparar entre sí por CPM y CTR, no por alcance: el alcance lo define el presupuesto.")
else:
    print("\nEn PAUTA: todavía no hay nada promocionado con datos. Elegí los creativos por el "
          "rendimiento orgánico y por lo que empuje el objetivo.")

print(f"\n{resumen['aviso']}")
