#!/usr/bin/env python3
"""Lo que hay en la biblioteca de un negocio, para que el creativo pueda elegir de ahí.

Uso: biblioteca_listar.py <slug> [--carpeta Terminado] [--tipo image|video]

Existe porque el creativo no tenía forma de saber qué material propio hay: proponía siempre
generar algo nuevo con IA aunque en la biblioteca hubiera fotos reales del local. Y el material
real le gana al generado — es lo que Instagram premia y lo que la marca pidió priorizar.

Imprime la ruta LOCAL (para mirarla con Read antes de elegir) y la URL pública (la que se manda a
publicar: Instagram descarga la imagen desde afuera, así que una ruta de disco no le sirve).
"""
import argparse, json, subprocess, sys

BASE_URL = 'https://panel.clausina.ar/media'
DISCO = '/var/lib/docker/volumes/clausina_panel_clausina-media/_data'

ap = argparse.ArgumentParser()
ap.add_argument('slug')
ap.add_argument('--carpeta')
ap.add_argument('--tipo', choices=['image', 'video'])
ap.add_argument('--json', action='store_true')
A = ap.parse_args()


def psql(sql):
    cid = subprocess.run(['docker', 'ps', '-q', '-f', 'name=crm_pgvector.1.'],
                         capture_output=True, text=True).stdout.strip()
    r = subprocess.run(['docker', 'exec', '-i', cid, 'psql', '-U', 'postgres', '-d', 'claude',
                        '-t', '-A', '-F', '\x1f', '-c', sql], capture_output=True, text=True)
    return [l for l in r.stdout.strip().split('\n') if l]


filtros = ''
if A.carpeta:
    filtros += f" AND b.carpeta = '{A.carpeta}'"
if A.tipo:
    filtros += f" AND b.tipo = '{A.tipo}'"

filas = psql(f"""
  SELECT b.codigo, b.tipo, b.carpeta, coalesce(b.nombre,''), b.media_path,
         coalesce(b.resumen,''), to_char(b.creado_en,'YYYY-MM-DD')
    FROM contenido.biblioteca_item b JOIN contenido.negocios n ON n.id=b.negocio_id
   WHERE n.slug='{A.slug}'{filtros}
   ORDER BY b.creado_en DESC;""")

items = []
for l in filas:
    p = l.split('\x1f')
    if len(p) < 7:
        continue
    items.append({'codigo': p[0], 'tipo': p[1], 'carpeta': p[2], 'nombre': p[3],
                  'disco': f'{DISCO}/{p[4]}', 'url': f'{BASE_URL}/{p[4]}',
                  'resumen': p[5], 'fecha': p[6]})

if A.json:
    print(json.dumps(items, ensure_ascii=False, indent=1))
    sys.exit(0)

if not items:
    print('La biblioteca está vacía para ese filtro.')
    sys.exit(0)
for i in items:
    print(f"{i['codigo']}  {i['tipo']:5}  {i['carpeta']:11}  {i['fecha']}  {i['nombre'][:38]}")
    print(f"        disco: {i['disco']}")
    print(f"        url  : {i['url']}")
    if i['resumen']:
        print(f"        nota : {i['resumen'][:90]}")
print(f"\n{len(items)} ítem(s). Miralos con Read antes de elegir: el nombre del archivo no dice "
      f"qué se ve. Para publicar va la URL, no la ruta de disco.")
