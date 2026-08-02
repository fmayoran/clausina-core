#!/usr/bin/env python3
"""Regenera en n8n la lista de chats de Telegram autorizados, desde la base.

Por qué existe: Telegram quedó definido como la consola del OPERADOR — alertas de plataforma y
la interacción de Fer. La aprobación de piezas por parte de clientes va a WhatsApp. Hasta hoy
el bot le hacía caso a cualquier chat que recibiera el botón: quien tuviera acceso a ese mensaje
podía aprobar una pieza.

Cómo: el nodo Code de n8n no puede consultar Postgres (y NO queremos darle acceso). Así que
seguimos el patrón que ya usa la plataforma para secretos — consumidor que no lee la base,
copia derivada regenerada desde la base. Acá la copia es una línea de constante en el Router.

Uso:
  sync_telegram_admins.py            # aplica
  sync_telegram_admins.py --dry-run  # muestra qué haría
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

WORKFLOW = 'ClaUsina - Telegram (botones)'
MARCA_INI = '// >>> ADMINS AUTORIZADOS (generado por sync_telegram_admins.py — no editar a mano)'
MARCA_FIN = '// <<< FIN ADMINS'


def env(archivo='/root/clausina/.env'):
    d = {}
    with open(archivo, encoding='utf-8') as f:
        for l in f:
            l = l.strip()
            if l and not l.startswith('#') and '=' in l:
                k, v = l.split('=', 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    return d


def psql(sql):
    cid = subprocess.run(['docker', 'ps', '-q', '-f', 'name=crm_pgvector.1.'],
                         capture_output=True, text=True).stdout.strip()
    if not cid:
        raise RuntimeError('no encuentro el contenedor de Postgres')
    r = subprocess.run(['docker', 'exec', '-i', cid, 'psql', '-U', 'postgres', '-d', 'claude',
                        '-t', '-A', '-c', sql], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f'psql falló: {r.stderr.strip()}')
    return r.stdout.strip()


def api(url, key, metodo='GET', cuerpo=None):
    req = urllib.request.Request(url, method=metodo,
                                 headers={'X-N8N-API-KEY': key, 'Content-Type': 'application/json'},
                                 data=json.dumps(cuerpo).encode() if cuerpo else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def guarda(chats):
    """El bloque que se inyecta arriba del Router. Sin chats autorizados NO deja pasar nada:
    fallar cerrado es lo correcto acá — si la sincronización se rompe, preferimos que el bot
    no haga nada antes que le haga caso a cualquiera."""
    lista = ', '.join(json.dumps(c) for c in chats)
    return f"""{MARCA_INI}
const ADMINS = [{lista}];
const _b = $json.body || $json;
const _chat = String(
  (_b.callback_query && _b.callback_query.message && _b.callback_query.message.chat.id) ||
  (_b.message && _b.message.chat && _b.message.chat.id) || ''
);
if (!ADMINS.includes(_chat)) return [{{json: {{tipo: 'ignore', motivo: 'chat_no_autorizado', chat_id: _chat}}}}];
{MARCA_FIN}"""


def main():
    seco = '--dry-run' in sys.argv
    e = env()
    url, key = e.get('N8N_URL'), e.get('N8N_API_KEY')
    if not url or not key:
        print('  ERROR: faltan N8N_URL / N8N_API_KEY en .env'); return 1

    chats = [c for c in psql(
        "SELECT telegram_chat_id FROM contenido.usuario "
        "WHERE rol_plataforma='admin' AND activo AND telegram_chat_id IS NOT NULL "
        "ORDER BY telegram_chat_id").splitlines() if c.strip()]
    print(f'  admins con chat asociado: {len(chats)}')
    if not chats:
        print('  ABORTO: ningún admin tiene chat asociado — aplicarlo dejaría el bot mudo.')
        return 1

    wfs = api(f'{url}/api/v1/workflows?limit=100', key)['data']
    wf = next((w for w in wfs if w['name'] == WORKFLOW), None)
    if not wf:
        print(f'  ERROR: no encuentro el workflow "{WORKFLOW}"'); return 1
    wf = api(f"{url}/api/v1/workflows/{wf['id']}", key)

    router = next((n for n in wf['nodes'] if n['name'] == 'Router'), None)
    if not router:
        print('  ERROR: el workflow no tiene nodo Router'); return 1

    code = router['parameters'].get('jsCode', '')
    # Idempotente: si ya hay un bloque generado, se reemplaza entero.
    nuevo = re.sub(re.escape(MARCA_INI) + r'.*?' + re.escape(MARCA_FIN),
                   guarda(chats), code, flags=re.S)
    if nuevo == code:
        nuevo = guarda(chats) + '\n' + code

    if nuevo == code:
        print('  sin cambios'); return 0
    if seco:
        print('  --- se inyectaría ---')
        for l in guarda(chats).split('\n'):
            print('  ' + l)
        return 0

    router['parameters']['jsCode'] = nuevo
    api(f"{url}/api/v1/workflows/{wf['id']}", key, 'PUT', {
        'name': wf['name'], 'nodes': wf['nodes'],
        'connections': wf['connections'], 'settings': wf.get('settings', {}),
    })
    api(f"{url}/api/v1/workflows/{wf['id']}/activate", key, 'POST')
    print(f'  aplicado: {len(chats)} chat(s) autorizados · workflow reactivado')
    return 0


if __name__ == '__main__':
    sys.exit(main())
