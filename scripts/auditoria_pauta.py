#!/usr/bin/env python3
"""Auditoría de la pauta en Meta de un negocio.

Uso: auditoria_pauta.py <slug>  ->  JSON por stdout, con la forma que dibuja el panel.

Sale de lo que ya está medido en la base (contenido.ads_daily y ads_ad_daily, que llena el cron
pauta_sync), no de una lectura en vivo: auditar es mirar la serie.

Dos criterios que definen qué se mira:

1. **El CTR comparable es el DE LINK, no el total.** El total cuenta cualquier clic —abrir el
   post, "ver más", tocar el perfil— y da entre 1,5x y 2x más alto que el número contra el que
   existen benchmarks. Compararlo contra un benchmark de link infla el resultado y lleva a
   decisiones malas.

2. **El alcance de pauta se compra, no se gana.** Comparar avisos entre sí por impresiones sólo
   dice quién tuvo más presupuesto. Lo comparable es CPM y CTR.
"""
import json, subprocess, sys, os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import benchmarks as B  # noqa: E402


def q(sql):
    pg = subprocess.run(['docker', 'ps', '-q', '-f', 'name=crm_pgvector.1.'],
                        capture_output=True, text=True).stdout.strip().split('\n')[0]
    r = subprocess.run(['docker', 'exec', '-i', pg, 'psql', '-U', 'postgres', '-d', 'claude',
                        '-t', '-A', '-q', '-c', sql],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL)
    return r.stdout.strip()


def pct(num, den, dec=2):
    return round(100 * num / den, dec) if den else None


def main():
    slug = sys.argv[1] if len(sys.argv) > 1 else ''
    if not slug:
        print(json.dumps({'error': 'sin slug'})); return

    dias = json.loads(q(f"""
      SELECT coalesce(json_agg(t), '[]') FROM (
        SELECT to_char(d.fecha,'YYYY-MM-DD') AS fecha, d.gasto::float, d.impresiones,
               d.alcance, d.clics, coalesce(d.clics_link, 0) AS clics_link
          FROM contenido.ads_daily d JOIN contenido.negocios n ON n.id = d.negocio_id
         WHERE n.slug = '{slug}' ORDER BY d.fecha) t""") or '[]')

    # Nunca se pautó: decirlo, no dibujar ceros. Un tablero en cero se lee como "anda mal".
    if not dias or not any(d['impresiones'] for d in dias):
        print(json.dumps({'vacio': True,
                          'motivo': 'Todavía no hay pauta con datos. Cuando una campaña entregue, '
                                    'este diagnóstico se llena solo.'}, ensure_ascii=False))
        return

    gasto = sum(d['gasto'] or 0 for d in dias)
    impr = sum(d['impresiones'] or 0 for d in dias)
    alcance = sum(d['alcance'] or 0 for d in dias)
    clics = sum(d['clics'] or 0 for d in dias)
    clics_link = sum(d['clics_link'] or 0 for d in dias)

    # Por anuncio: es donde se ve qué creativo gana, que es para lo que se pone más de uno.
    avisos = json.loads(q(f"""
      SELECT coalesce(json_agg(t), '[]') FROM (
        SELECT p.numero, left(p.titulo_interno, 42) AS titulo,
               sum(a.gasto)::float AS gasto, sum(a.impresiones)::bigint AS impresiones,
               sum(a.alcance)::bigint AS alcance, sum(a.clics)::bigint AS clics,
               sum(coalesce(a.clics_link,0))::bigint AS clics_link
          FROM contenido.ads_ad_daily a
          JOIN contenido.negocios n ON n.id = a.negocio_id
          JOIN contenido.pauta_campania_pieza cp ON cp.meta_ad_id = a.meta_ad_id
          JOIN contenido.piezas p ON p.id = cp.pieza_id
         WHERE n.slug = '{slug}'
         GROUP BY p.numero, p.titulo_interno
        HAVING sum(a.impresiones) > 0
         ORDER BY sum(a.gasto) DESC) t""") or '[]')
    for a in avisos:
        a['cpm'] = round(a['gasto'] / a['impresiones'] * 1000, 2) if a['impresiones'] else None
        a['ctr'] = pct(a['clics'], a['impresiones'])
        a['ctr_link'] = pct(a['clics_link'], a['impresiones'])

    # El ganador se declara sólo con volumen suficiente detrás. Con pocas impresiones la
    # diferencia entre dos creativos es ruido, y nombrar un ganador falso hace tirar el bueno.
    MIN_IMPR = 5000
    comparables = [a for a in avisos if a['impresiones'] >= MIN_IMPR and a['ctr_link'] is not None]
    ganador = None
    if len(comparables) >= 2:
        orden = sorted(comparables, key=lambda a: -a['ctr_link'])
        mejor, peor = orden[0], orden[-1]
        # Una diferencia de menos de 20% relativo tampoco alcanza para llamar un ganador.
        if peor['ctr_link'] and (mejor['ctr_link'] - peor['ctr_link']) / peor['ctr_link'] >= 0.2:
            ganador = {'numero': mejor['numero'], 'titulo': mejor['titulo'], 'ctr': mejor['ctr_link'],
                       'contra': {'numero': peor['numero'], 'ctr': peor['ctr_link']},
                       'veces': round(mejor['ctr_link'] / peor['ctr_link'], 1)}

    campanias = json.loads(q(f"""
      SELECT coalesce(json_agg(t), '[]') FROM (
        SELECT c.nombre, c.estado, c.objetivo,
               to_char(c.fecha_inicio,'YYYY-MM-DD') AS desde,
               to_char(c.fecha_fin,'YYYY-MM-DD') AS hasta,
               c.presupuesto->>'tipo' AS pres_tipo,
               (c.presupuesto->>'monto')::float AS pres_monto,
               (SELECT count(*) FROM contenido.pauta_campania_pieza x WHERE x.campania_id = c.id) AS avisos
          FROM contenido.pauta_campania c JOIN contenido.negocios n ON n.id = c.negocio_id
         WHERE n.slug = '{slug}' AND c.estado <> 'descartada'
         ORDER BY c.creado_en DESC) t""") or '[]')

    ctr_total = pct(clics, impr)
    ctr_link = pct(clics_link, impr)
    frecuencia = round(impr / alcance, 2) if alcance else None
    cpm = round(gasto / impr * 1000, 2) if impr else None

    metricas = [B.ficha('ctr_link', ctr_link), B.ficha('frecuencia', frecuencia),
                B.ficha('cpm_ars', cpm)]

    print(json.dumps({
        'periodo': f"{dias[0]['fecha']} → {dias[-1]['fecha']}",
        'global': {'dias': len(dias), 'gasto': round(gasto, 2), 'impresiones': impr,
                   'alcance': alcance, 'clics': clics, 'clics_link': clics_link,
                   'ctr': ctr_total, 'ctr_link': ctr_link,
                   'frecuencia': frecuencia, 'cpm': cpm,
                   'costo_clic': round(gasto / clics_link, 3) if clics_link else None},
        # El CTR de ads_daily es el TOTAL (clics de cualquier tipo). Se dice, para que nadie lo
        # lea como el de link: el benchmark de link es otro número y este queda inflado contra él.
        # Se guardan los dos y se compara SIEMPRE el de link, que es el que tiene benchmark.
        'aviso_ctr': 'Se comparan los clics AL DESTINO, no cualquier toque. El CTR total aparece '
                     'al lado sólo como referencia: es 1,5x-2x mayor y no es comparable.',
        'metricas': metricas,
        'por_dia': dias,
        'avisos': avisos,
        'ganador': ganador,
        'min_impresiones_comparar': MIN_IMPR,
        'campanias': campanias,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
