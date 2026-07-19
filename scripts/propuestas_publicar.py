#!/usr/bin/env python3
# Lee /tmp/propuestas.json (lo escribe el creativo headless) e inserta cada propuesta en la
# cola de requerimientos (tg_briefs, origen=creativo, estado=propuesta). Manda cada una a Telegram
# para que Fer pueda RESPONDER ese mensaje con la foto/video; guarda tg_msg_id para vincular la respuesta.
# Uso: propuestas_publicar.py <CID> <CHAT_ID> <BOT_TOKEN> [canal] [negocio_id]
import json, sys, subprocess, urllib.request, urllib.parse

CID, CHAT, BOT = sys.argv[1], sys.argv[2], sys.argv[3]
CANAL = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] == 'aviso' else 'instagram'
PROYECTO_ID = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] else ''
SOLICITUD_ID = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] else ''

def psql(q):
    # -q: sin el tag "INSERT 0 1" en INSERT...RETURNING (si no, ensucia el id devuelto).
    r = subprocess.run(['docker','exec','-i',CID,'psql','-U','postgres','-d','claude','-q','-t','-A','-c',q],
                       capture_output=True, text=True)
    return r.stdout.strip()

def esc(s):
    return (s or '').replace("'", "''")

def tg_send(text):
    # Telegram corta en 4096; recortamos por las dudas.
    data = urllib.parse.urlencode({'chat_id': CHAT, 'text': text[:3900], 'disable_web_page_preview': 'true'}).encode()
    try:
        resp = json.load(urllib.request.urlopen(f"https://api.telegram.org/bot{BOT}/sendMessage", data=data, timeout=25))
        if not resp.get('ok'):
            print("  TG no-ok:", json.dumps(resp)[:160], file=sys.stderr)
        return resp.get('result', {}).get('message_id')
    except Exception as e:
        print("  TG excepción:", repr(e)[:160], file=sys.stderr)
        return None

try:
    props = json.load(open('/tmp/propuestas.json'))
except Exception:
    props = []
if isinstance(props, dict):
    props = props.get('propuestas', [])

# Material que Fer adjuntó al pedido: se copia a CADA requerimiento generado (brief_material),
# para que al generar la pieza el creativo tenga ese contenido disponible.
MATERIAL = []
if SOLICITUD_ID:
    try:
        MATERIAL = json.loads(psql("SELECT COALESCE(json_agg(json_build_object('media_path',media_path,"
                                    "'media_type',media_type,'filename',filename) ORDER BY orden),'[]') "
                                    f"FROM contenido.solicitud_propuesta_material WHERE solicitud_id='{SOLICITUD_ID}';") or '[]')
    except Exception:
        MATERIAL = []

count = 0
for p in props:
    titulo = (p.get('titulo') or 'Propuesta').strip()
    concepto = (p.get('concepto') or '').strip()
    copy = (p.get('copy_tentativo') or '').strip()
    req = (p.get('requiere_material') or 'No requiere material nuevo').strip()
    fmt = (p.get('formato_sugerido') or 'feed').strip()
    # el texto del requerimiento guarda concepto + copy tentativo + formato sugerido (lo lee el agente al activarse)
    texto = concepto
    if copy:
        texto += "\n\nCopy tentativo:\n" + copy
    texto += f"\n\nFormato sugerido: {fmt}"
    pid_col = ", negocio_id" if PROYECTO_ID else ""
    pid_val = f",'{esc(PROYECTO_ID)}'" if PROYECTO_ID else ""
    bid = psql("INSERT INTO contenido.tg_briefs (chat_id, origen, estado, canal_destino, titulo, texto, requiere_material" + pid_col + ") "
               f"VALUES ('{esc(CHAT)}','creativo','propuesta','{CANAL}','{esc(titulo)}','{esc(texto)}','{esc(req)}'" + pid_val + ") RETURNING id;")
    if not bid:
        continue
    # Adjuntar el material del pedido a este requerimiento (disponible al generar la pieza).
    for i, m in enumerate(MATERIAL):
        mp = esc(m.get('media_path') or '')
        if not mp:
            continue
        mt = esc(m.get('media_type') or 'photo')
        fn = m.get('filename')
        fn_val = f"'{esc(fn)}'" if fn else "NULL"
        psql("INSERT INTO contenido.brief_material (brief_id, media_path, media_type, filename, orden) "
             f"VALUES ('{bid}','{mp}','{mt}',{fn_val},{i});")
    msg = (f"[PROPUESTA] {titulo}\n\n{concepto}\n\nNecesito: {req}\n\n"
           "Respondé este mensaje con la foto/video para activarla — o gestionala en https://panel.clausina.ar")
    mid = tg_send(msg)
    if mid:
        psql(f"UPDATE contenido.tg_briefs SET tg_msg_id={int(mid)} WHERE id='{bid}';")
    count += 1

print(count)
