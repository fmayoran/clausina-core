#!/usr/bin/env bash
# Deja clausina.ar listo para Google Workspace en una sola corrida.
#
# Aplica: verificación del dominio (TXT), entrega de correo (MX), SPF y DMARC.
# NO toca los registros A: la landing sigue exactamente como está.
#
# Uso:
#   dns_workspace.sh --verificar "google-site-verification=XXXX"   # paso 1, antes de activar Gmail
#   dns_workspace.sh --correo                                      # paso 2, ya con Workspace provisto
#   dns_workspace.sh --dkim "v=DKIM1; k=rsa; p=MIIBI..."           # paso 3, tras generar la clave
#   dns_workspace.sh --estado                                      # ver qué hay hoy
#
# Idempotente: si un registro ya existe con el mismo valor, no lo duplica.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
set -a; source .env 2>/dev/null; set +a

DOM="clausina.ar"
API="https://api.cloudflare.com/client/v4"
H_AUTH="Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "ERROR: falta CLOUDFLARE_API_TOKEN en .env"; exit 1; }

ZID=$(curl -s -m 20 "$API/zones?name=$DOM" -H "$H_AUTH" \
  | python3 -c "import sys,json;r=json.load(sys.stdin).get('result') or [];print(r[0]['id'] if r else '')")
[ -n "$ZID" ] || { echo "ERROR: no encuentro la zona $DOM (¿el token tiene permiso?)"; exit 1; }

# Crea el registro, o actualiza el que ya cumple ESA MISMA función.
#
# OJO — esto ya rompió una vez: en un mismo nombre conviven varios TXT (verificación de dominio,
# SPF, y lo que venga). Reemplazar "el primer TXT que aparezca" borró el de verificación de
# Google al escribir el SPF, y sin ese registro Google puede des-verificar el dominio y
# suspender el servicio. Por eso los TXT se emparejan por PREFIJO: un SPF sólo pisa a otro SPF.
upsert() { # tipo nombre contenido [prioridad]
  local tipo="$1" nombre="$2" contenido="$3" prio="${4:-}"
  local existente
  existente=$(curl -s -m 20 "$API/zones/$ZID/dns_records?type=$tipo&name=$nombre" -H "$H_AUTH" \
    | CONTENIDO="$contenido" TIPO="$tipo" python3 -c "
import sys, json, os
r = json.load(sys.stdin).get('result') or []
nuevo, tipo = os.environ['CONTENIDO'], os.environ['TIPO']

def familia(v):
    v = v.strip('\"').lower()
    for p in ('v=spf1', 'v=dmarc1', 'google-site-verification=', 'v=dkim1'):
        if v.startswith(p):
            return p
    return None

# Idéntico: no hay nada que hacer.
for x in r:
    if x['content'].strip('\"') == nuevo.strip('\"'):
        print('MISMO'); break
else:
    if tipo == 'TXT':
        # Sólo pisamos un TXT de la MISMA familia; si no hay, se crea uno nuevo y conviven.
        f = familia(nuevo)
        ids = [x['id'] for x in r if f and familia(x['content']) == f]
        print(ids[0] if ids else '')
    elif tipo == 'MX':
        print('')          # los MX se agregan; la limpieza de los viejos es aparte
    else:
        print(r[0]['id'] if r else '')")

  if [ "$existente" = "MISMO" ]; then echo "  ya estaba: $tipo $nombre"; return; fi

  local body
  body=$(python3 - "$tipo" "$nombre" "$contenido" "$prio" <<'PY'
import json, sys
t, n, c, p = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d = {"type": t, "name": n, "content": c, "ttl": 3600}
if p: d["priority"] = int(p)
print(json.dumps(d))
PY
)
  local url="$API/zones/$ZID/dns_records" metodo=POST
  [ -n "$existente" ] && { url="$url/$existente"; metodo=PUT; }
  local out
  out=$(curl -s -m 25 -X $metodo "$url" -H "$H_AUTH" -H 'Content-Type: application/json' --data "$body")
  if echo "$out" | grep -q '"success":true'; then
    echo "  aplicado: $tipo $nombre"
  else
    echo "  FALLÓ $tipo $nombre → $(echo "$out" | python3 -c "import sys,json;print([e.get('message') for e in json.load(sys.stdin).get('errors',[])])" 2>/dev/null)"
  fi
}

estado() {
  echo "Estado actual de $DOM:"
  for t in MX TXT; do
    curl -s -m 20 "$API/zones/$ZID/dns_records?type=$t&per_page=50" -H "$H_AUTH" \
      | python3 -c "
import sys,json
for x in json.load(sys.stdin).get('result') or []:
    print('  %-4s %-28s %s' % (x['type'], x['name'], x['content'][:70]))"
  done
  echo "  (los registros A de la landing no se tocan)"
}

case "${1:-}" in
  --verificar)
    [ -n "${2:-}" ] || { echo "uso: $0 --verificar \"google-site-verification=XXXX\""; exit 2; }
    upsert TXT "$DOM" "$2"
    echo "Listo. Volvé a la consola de Google y tocá Verificar (puede tardar unos minutos)."
    ;;
  --correo)
    # Google Workspace usa UN solo MX desde 2023. Los 5 registros viejos (ASPMX, ALT1…) son legado.
    upsert MX "$DOM" "smtp.google.com" 1
    # SPF: autoriza a Google a mandar como @clausina.ar. ~all = falla suave, lo recomendado al empezar.
    upsert TXT "$DOM" "v=spf1 include:_spf.google.com ~all"
    # DMARC en p=none: sólo observa y reporta, no rechaza nada. Se endurece más adelante.
    upsert TXT "_dmarc.$DOM" "v=DMARC1; p=none; rua=mailto:postmaster@$DOM"
    echo "Listo. El correo de @$DOM entra por Google."
    ;;
  --dkim)
    [ -n "${2:-}" ] || { echo "uso: $0 --dkim \"v=DKIM1; k=rsa; p=...\""; exit 2; }
    upsert TXT "google._domainkey.$DOM" "$2"
    echo "Listo. Activá la firma DKIM en la consola de Workspace."
    ;;
  --estado|"") estado ;;
  *) echo "uso: $0 [--verificar <token> | --correo | --dkim <valor> | --estado]"; exit 2 ;;
esac
