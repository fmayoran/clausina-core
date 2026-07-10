#!/usr/bin/env python3
"""Regenera los secretos DERIVADOS a partir de la DB (fuente de verdad).

Principio: el perfil de la marca (DB, token cifrado) manda. Los consumidores que no pueden
leer la DB reciben una copia regenerada desde acá. El HOST descifra (tiene APP_ENC_KEY);
n8n NUNCA ve la clave maestra, y el token queda en su credencial (enmascarado en los logs).

Hoy sincroniza: credencial de Instagram en n8n (la usa el workflow de publicación).
La API de n8n no permite ACTUALIZAR credenciales -> se crea una nueva, se repunta el
workflow y se borra la vieja. Nunca borra la vieja si el repunte falló.

Uso: sync_secrets.py [--dry-run] [slug]
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ads_crypto  # noqa: E402

ROOT_ENV = "/root/clausina/.env"
PG_NAME_FILTER = "crm_pgvector.1."
WF_PUBLICAR = "xosqlg1QJm8LVUKQ"          # ClaUsina - Publicar (Fase C)
BACKUP_DIR = "/root/clausina/core/scripts/n8n/backups"


def load_env(path):
    d = {}
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return d


ENV = load_env(ROOT_ENV)
N8N_BASE = (ENV.get("N8N_API_BASE") or "https://crm-n8n.dhmtev.easypanel.host").rstrip("/")
N8N_KEY = ENV.get("N8N_API_KEY", "")


def n8n(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"{N8N_BASE}/api/v1/{path}", data=data, method=method,
                                 headers={"X-N8N-API-KEY": N8N_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        return json.loads(body) if body else {}


def psql(sql):
    cid = subprocess.run(["docker", "ps", "-q", "-f", f"name={PG_NAME_FILTER}"],
                         capture_output=True, text=True).stdout.strip()
    out = subprocess.run(["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude",
                          "-q", "-t", "-A", "-c", sql], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"psql: {out.stderr.strip()}")
    return out.stdout.strip()


def ig_token(slug):
    """Token de IG del perfil (descifrado). Nunca se imprime."""
    enc = psql("SELECT coalesce(pp.ig_token_enc,'') FROM contenido.proyectos p "
               f"JOIN contenido.proyecto_perfil pp ON pp.proyecto_id=p.id WHERE p.slug='{slug}'")
    if not enc:
        raise RuntimeError(f"la marca '{slug}' no tiene token de IG en el perfil")
    return ads_crypto.decrypt(enc)


def cred_ids_del_workflow(wf):
    ids = []
    for nd in wf.get("nodes", []):
        c = (nd.get("credentials") or {}).get("httpQueryAuth")
        if c and c.get("id") and c["id"] not in ids:
            ids.append(c["id"])
    return ids


def sync_ig_cred(slug, dry_run=False):
    tok = ig_token(slug)                       # valida que exista y descifre
    wf = n8n("GET", f"workflows/{WF_PUBLICAR}")
    viejas = cred_ids_del_workflow(wf)
    n_nodos = sum(1 for nd in wf["nodes"] if (nd.get("credentials") or {}).get("httpQueryAuth"))
    print(f"workflow '{wf['name']}': {n_nodos} nodos usan credencial IG (actual: {viejas})")
    if dry_run:
        print("dry-run: crearía credencial nueva, repuntaría el workflow y borraría", viejas)
        return None

    os.makedirs(BACKUP_DIR, exist_ok=True)
    bpath = os.path.join(BACKUP_DIR, f"cf-pub-publish.pre-sync.json")
    with open(bpath, "w") as f:
        json.dump(wf, f, ensure_ascii=False)
    print("backup del workflow:", bpath)

    nueva = n8n("POST", "credentials", {
        "name": f"{slug} IG Token (auto)", "type": "httpQueryAuth",
        "data": {"name": "access_token", "value": tok, "allowedHttpRequestDomains": "all"}})
    new_id = nueva["id"]
    print("credencial nueva creada:", new_id)

    try:
        for nd in wf["nodes"]:
            if (nd.get("credentials") or {}).get("httpQueryAuth"):
                nd["credentials"]["httpQueryAuth"] = {"id": new_id, "name": nueva["name"]}
        body = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"],
                "settings": wf.get("settings") or {}}
        n8n("PUT", f"workflows/{WF_PUBLICAR}", body)
        n8n("POST", f"workflows/{WF_PUBLICAR}/activate")
        print("workflow repuntado y reactivado")
    except Exception as e:
        # No borramos la vieja: el workflow puede seguir usándola.
        n8n("DELETE", f"credentials/{new_id}")
        raise RuntimeError(f"falló el repunte, revertido (credencial nueva borrada): {e}")

    for oid in viejas:
        if oid != new_id:
            try:
                n8n("DELETE", f"credentials/{oid}")
                print("credencial vieja borrada:", oid)
            except Exception as e:  # noqa: BLE001
                print(f"aviso: no se pudo borrar la vieja {oid}: {e}", file=sys.stderr)
    return new_id


def main():
    args = [a for a in sys.argv[1:]]
    dry = "--dry-run" in args
    args = [a for a in args if not a.startswith("--")]
    slug = args[0] if args else "cortafuego"
    try:
        sync_ig_cred(slug, dry_run=dry)
        print("sync OK")
        return 0
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"sync_secrets: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
