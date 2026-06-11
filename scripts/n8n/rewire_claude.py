#!/usr/bin/env python3
"""Reapunta los workflows de Cortafuego a la base 'claude':
crea una credencial Postgres nueva (host crm_pgvector / db claude) y
reemplaza la credencial vieja en los workflows que la usan.
Uso puntual de migracion. No commitear la password."""
import json, os, sys, urllib.request

N8N_URL = "https://crm-n8n.dhmtev.easypanel.host"
OLD_CRED = "OpXcQp95dbNVXbCP"
PGPASS = os.environ["PGPASS"]

# API key desde .env
KEY = None
with open("/root/claudefolder/.env") as f:
    for line in f:
        if line.startswith("N8N_API_KEY="):
            KEY = line.split("=", 1)[1].strip()
HEAD = {"X-N8N-API-KEY": KEY, "Content-Type": "application/json", "accept": "application/json"}


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(N8N_URL + path, data=data, headers=HEAD, method=method)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


# 1) Crear credencial nueva
cred = api("POST", "/api/v1/credentials", {
    "name": "Postgres Cortafuego (claude)",
    "type": "postgres",
    "data": {
        "host": "crm_pgvector",
        "port": 5432,
        "database": "claude",
        "user": "postgres",
        "password": PGPASS,
        "allowUnauthorizedCerts": False,
        "ssl": "disable",
        "sshTunnel": False,
    },
})
NEW_CRED = cred["id"]
print(f"Credencial nueva creada: {NEW_CRED} ({cred['name']})")

# 2) Reapuntar workflows
wfs = api("GET", "/api/v1/workflows?limit=100")["data"]
for w in wfs:
    uses = any(n.get("credentials", {}).get("postgres", {}).get("id") == OLD_CRED
               for n in w.get("nodes", []))
    if not uses:
        continue
    full = api("GET", f"/api/v1/workflows/{w['id']}")
    changed = 0
    for n in full.get("nodes", []):
        c = n.get("credentials", {}).get("postgres")
        if c and c.get("id") == OLD_CRED:
            n["credentials"]["postgres"] = {"id": NEW_CRED, "name": "Postgres Cortafuego (claude)"}
            changed += 1
    payload = {
        "name": full["name"],
        "nodes": full["nodes"],
        "connections": full["connections"],
        "settings": full.get("settings", {}),
    }
    api("PUT", f"/api/v1/workflows/{w['id']}", payload)
    # reactivar si estaba activo
    if w.get("active"):
        try:
            api("POST", f"/api/v1/workflows/{w['id']}/activate")
        except Exception as e:
            print(f"   aviso: no se pudo reactivar {w['name']}: {e}")
    print(f"  {w['name']}: {changed} nodo(s) -> claude (active={w.get('active')})")

print("Listo.")
