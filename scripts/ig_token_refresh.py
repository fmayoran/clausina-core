#!/usr/bin/env python3
"""Renueva los tokens de Instagram antes de que venzan.

Los tokens de Instagram con login propio (los que empiezan con IGAA) duran 60 días y se pueden
extender otros 60 con una sola llamada, PERO sólo mientras siguen vivos: una vez vencidos no hay
refresh que valga y hay que volver a autorizar la app a mano.

El de Cortafuego venció el 29/07 y estuvo quince días muerto. Este script corre solo y semanal
para que eso no vuelva a pasar: mientras haya una corrida exitosa cada 60 días, el token no se
cae nunca.

Uso: ig_token_refresh.py [--dry]
"""
import json, os, subprocess, sys, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ads_crypto import decrypt, encrypt

DRY = '--dry' in sys.argv


def psql(sql):
    pg = subprocess.run(['docker', 'ps', '-q', '-f', 'name=crm_pgvector.1.'],
                        capture_output=True, text=True).stdout.strip().split('\n')[0]
    return subprocess.run(['docker', 'exec', '-i', pg, 'psql', '-U', 'postgres', '-d', 'claude',
                           '-t', '-A', '-q', '-c', sql],
                          capture_output=True, text=True, stdin=subprocess.DEVNULL).stdout.strip()


def main():
    filas = psql("""SELECT coalesce(json_agg(t),'[]') FROM (
        SELECT n.slug, p.ig_token_enc
          FROM contenido.negocio_perfil p JOIN contenido.negocios n ON n.id = p.negocio_id
         WHERE p.ig_token_enc IS NOT NULL AND n.activo) t""")
    hubo_error = False
    for r in json.loads(filas or '[]'):
        slug, enc = r['slug'], r['ig_token_enc']
        try:
            tok = decrypt(enc).strip()
        except Exception as e:
            print(f'{slug}: no se pudo descifrar ({str(e)[:60]})'); hubo_error = True; continue
        # Sólo los de Instagram con login propio se refrescan así. Los de una cuenta ligada a una
        # página de Facebook son otra API y otro flujo.
        if not tok.startswith('IGAA'):
            print(f'{slug}: token de Facebook, no se refresca por acá'); continue
        url = ('https://graph.instagram.com/refresh_access_token'
               f'?grant_type=ig_refresh_token&access_token={tok}')
        try:
            with urllib.request.urlopen(url, timeout=25) as resp:
                d = json.load(resp)
        except Exception as e:
            cuerpo = getattr(e, 'read', lambda: b'')()
            print(f'{slug}: NO se pudo renovar — {str(e)[:80]} {cuerpo[:160].decode("utf-8","replace")}')
            hubo_error = True
            continue
        nuevo, dias = d.get('access_token'), round((d.get('expires_in') or 0) / 86400)
        if not nuevo:
            print(f'{slug}: respuesta sin token'); hubo_error = True; continue
        print(f'{slug}: renovado, vence en {dias} días' + (' (dry)' if DRY else ''))
        if DRY:
            continue
        psql(f"UPDATE contenido.negocio_perfil SET ig_token_enc='{encrypt(nuevo)}' "
             f"WHERE negocio_id=(SELECT id FROM contenido.negocios WHERE slug='{slug}')")
        # n8n publica con una copia derivada de este token: si no se le avisa, sigue con el viejo
        # y la publicación se cae igual (ver la regla de secretos en CLAUDE.md).
        psql(f"INSERT INTO contenido.secrets_sync_req (slug) VALUES ('{slug}')")
    return 1 if hubo_error else 0


if __name__ == '__main__':
    sys.exit(main())
