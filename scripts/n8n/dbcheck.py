#!/usr/bin/env python3
"""Crea un workflow temporal que usa la credencial nueva y devuelve current_database().
Solo lectura sobre la base. Borra el workflow al final."""
import json, urllib.request

N8N_URL = "https://crm-n8n.dhmtev.easypanel.host"
CRED = "DRC5p50dRb5kYMOn"
KEY = None
with open("/root/clausina/.env") as f:
    for line in f:
        if line.startswith("N8N_API_KEY="):
            KEY = line.split("=", 1)[1].strip()
HEAD = {"X-N8N-API-KEY": KEY, "Content-Type": "application/json", "accept": "application/json"}


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(N8N_URL + path, data=data, headers=HEAD, method=method)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode()) if r.read else None


wf = {
    "name": "TMP dbcheck",
    "nodes": [
        {"parameters": {"httpMethod": "GET", "path": "cf-dbcheck", "responseMode": "responseNode", "options": {}},
         "id": "a", "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2,
         "position": [220, 300], "webhookId": "cf-dbcheck"},
        {"parameters": {"operation": "executeQuery", "query": "SELECT current_database() AS db", "options": {}},
         "id": "b", "name": "Postgres", "type": "n8n-nodes-base.postgres", "typeVersion": 2.5,
         "position": [440, 300], "alwaysOutputData": True,
         "credentials": {"postgres": {"id": CRED, "name": "Postgres Cortafuego (claude)"}}},
        {"parameters": {"respondWith": "json", "responseBody": "={{ JSON.stringify($json) }}", "options": {}},
         "id": "c", "name": "Respond", "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.1,
         "position": [660, 300]},
    ],
    "connections": {
        "Webhook": {"main": [[{"node": "Postgres", "type": "main", "index": 0}]]},
        "Postgres": {"main": [[{"node": "Respond", "type": "main", "index": 0}]]},
    },
    "settings": {},
}

created = api("POST", "/api/v1/workflows", wf)
wid = created["id"]
print("workflow temporal:", wid)
try:
    api("POST", f"/api/v1/workflows/{wid}/activate")
    import time; time.sleep(1)
    req = urllib.request.Request(N8N_URL + "/webhook/cf-dbcheck", method="GET")
    with urllib.request.urlopen(req) as r:
        print("current_database ->", r.read().decode())
finally:
    api("DELETE", f"/api/v1/workflows/{wid}")
    print("workflow temporal borrado")
