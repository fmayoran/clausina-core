#!/usr/bin/env python3
"""Reconstruye cf-pub-publish con: no-op en doble disparo (T1), poll de status real (T2),
y rama de Historias STORIES (T3). Escribe el JSON versionado; el push lo hace aparte."""
import json
IG = "27632458043024661"
PG = {"postgres": {"id": "DRC5p50dRb5kYMOn", "name": "Postgres Cortafuego (claude)"}}
TG = {"httpQueryAuth": {"id": "ZqmyQ7hDQYu8xWC9", "name": "Cortafuego IG Token"}}
MEDIA_URL = f"https://graph.instagram.com/v19.0/{IG}/media"
PUB_URL = f"https://graph.instagram.com/v19.0/{IG}/media_publish"

def ifstr(left, op, right=None, combinator="and", conds=None):
    if conds is None:
        conds = [{"leftValue": left, "rightValue": right if right is not None else "",
                  "operator": {"type": "string", "operation": op, **({"singleValue": True} if right is None else {})}}]
    return {"conditions": {"options": {"caseSensitive": True, "typeValidation": "loose"},
                            "conditions": conds, "combinator": combinator}}

def http(method, url, qparams, name, nid, pos, onerr=None):
    n = {"parameters": {"method": method, "url": url, "authentication": "genericCredentialType",
            "genericAuthType": "httpQueryAuth", "sendQuery": True,
            "queryParameters": {"parameters": [{"name": k, "value": v} for k, v in qparams]}, "options": {}},
         "id": nid, "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
         "position": pos, "credentials": TG}
    if onerr: n["onError"] = onerr
    return n

def pgq(query, qr, name, nid, pos):
    return {"parameters": {"operation": "executeQuery", "query": query,
            "options": {"queryReplacement": qr}}, "id": nid, "name": name,
            "type": "n8n-nodes-base.postgres", "typeVersion": 2.5, "position": pos, "credentials": PG}

def ifnode(params, name, nid, pos):
    return {"parameters": params, "id": nid, "name": name, "type": "n8n-nodes-base.if", "typeVersion": 2, "position": pos}

def resp(text, name, nid, pos):
    return {"parameters": {"respondWith": "text", "responseBody": text, "options": {}},
            "id": nid, "name": name, "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.1, "position": pos}

A = "$('Aprobar').item.json"
COLAB = "={{ JSON.stringify("+A+".colaboradores || []) }}"
TAGS_IMG = "={{ JSON.stringify(("+A+".colaboradores || []).map(u=>({username:u,x:0.5,y:0.9}))) }}"
TAGS_VID = "={{ JSON.stringify(("+A+".colaboradores || []).map(u=>({username:u}))) }}"
nodes = [
  {"parameters": {"httpMethod": "GET", "path": "cf-pub-publish", "responseMode": "responseNode", "options": {}},
   "id": "Webhook", "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [120, 600], "webhookId": "cf-pub-publish"},

  pgq("UPDATE contenido.revisiones SET estado='aprobada', aprobado_por='Fer', aprobado_en=now() WHERE token=$1 AND estado='pendiente_aprobacion' RETURNING caption, token, pieza_id, formato, (SELECT url FROM contenido.media WHERE pieza_id=revisiones.pieza_id AND orden=1) AS asset_ig, (SELECT tipo FROM contenido.media WHERE pieza_id=revisiones.pieza_id AND orden=1) AS tipo_media, (SELECT p.ig_colaboradores FROM contenido.proyectos p WHERE p.id=(SELECT proyecto_id FROM contenido.piezas WHERE id=revisiones.pieza_id)) AS colaboradores",
      "={{ $json.query.token }}", "Aprobar", "Aprobar", [300, 600]),

  # T1: ¿hubo cambio? (si la pieza ya estaba decidida, Aprobar no devuelve pieza_id)
  ifnode(ifstr("={{ $json.pieza_id }}", "notEmpty"), "huboCambio", "huboCambio", [480, 600]),
  resp("Esta publicación ya fue decidida.", "RespYa", "RespYa", [660, 760]),

  # T3: ¿es Historia?
  ifnode(ifstr("={{ "+A+".formato }}", "equals", "story"), "esStory", "esStory", [660, 600]),
  ifnode(ifstr("={{ "+A+".tipo_media }}", "equals", "video"), "esStoryVideo", "esStoryVideo", [840, 440]),
  http("POST", MEDIA_URL, [("media_type", "STORIES"), ("video_url", "={{ "+A+".asset_ig }}")], "ContainerStoryVid", "ContainerStoryVid", [1040, 360]),
  http("POST", MEDIA_URL, [("media_type", "STORIES"), ("image_url", "={{ "+A+".asset_ig }}")], "ContainerStoryImg", "ContainerStoryImg", [1040, 520]),

  # Feed: carrusel / reel / imagen
  pgq("SELECT count(*) AS n FROM contenido.media WHERE pieza_id=$1", "={{ "+A+".pieza_id }}", "MediaCount", "MediaCount", [840, 760]),
  ifnode({"conditions": {"options": {"caseSensitive": True, "typeValidation": "loose"},
          "conditions": [{"leftValue": "={{ $json.n }}", "rightValue": 1, "operator": {"type": "number", "operation": "gt"}}], "combinator": "and"}},
         "EsCarrusel", "EsCarrusel", [1020, 760]),
  pgq("SELECT url FROM contenido.media WHERE pieza_id=$1 ORDER BY orden", "={{ "+A+".pieza_id }}", "MediaList", "MediaList", [1200, 660]),
  http("POST", MEDIA_URL, [("image_url", "={{ $json.url }}"), ("is_carousel_item", "true")], "Child", "Child", [1380, 660]),
  {"parameters": {"jsCode": "return [{ json: { children: $input.all().map(i => i.json.id).filter(Boolean).join(',') } }];"},
   "id": "JoinChildren", "name": "JoinChildren", "type": "n8n-nodes-base.code", "typeVersion": 2, "position": [1560, 660]},
  http("POST", MEDIA_URL, [("media_type", "CAROUSEL"), ("children", "={{ $json.children }}"), ("caption", "={{ "+A+".caption }}"), ("collaborators", COLAB)], "CarouselCont", "CarouselCont", [1740, 660]),
  ifnode(ifstr("={{ "+A+".tipo_media }}", "equals", "video"), "EsVideo", "EsVideo", [1200, 860]),
  http("POST", MEDIA_URL, [("media_type", "REELS"), ("video_url", "={{ "+A+".asset_ig }}"), ("caption", "={{ "+A+".caption }}"), ("collaborators", COLAB), ("user_tags", TAGS_VID)], "ContainerReel", "ContainerReel", [1400, 800]),
  http("POST", MEDIA_URL, [("image_url", "={{ "+A+".asset_ig }}"), ("caption", "={{ "+A+".caption }}"), ("media_type", "IMAGE"), ("collaborators", COLAB), ("user_tags", TAGS_IMG)], "ContainerImg", "ContainerImg", [1400, 940]),

  # T2: poll de status del contenedor
  http("GET", "=https://graph.instagram.com/v19.0/{{ $json.id }}", [("fields", "status_code")], "CheckStatus", "CheckStatus", [2000, 600]),
  ifnode(ifstr("={{ $json.status_code }}", "equals", "FINISHED"), "esFinished", "esFinished", [2180, 600]),
  ifnode({"conditions": {"options": {"caseSensitive": True, "typeValidation": "loose"},
          "conditions": [{"leftValue": "={{ $json.status_code }}", "rightValue": "ERROR", "operator": {"type": "string", "operation": "equals"}},
                          {"leftValue": "={{ $json.status_code }}", "rightValue": "EXPIRED", "operator": {"type": "string", "operation": "equals"}}], "combinator": "or"}},
         "esError", "esError", [2180, 760]),
  resp("Instagram no pudo procesar el contenido (status ERROR/EXPIRED).", "RespErr", "RespErr", [2360, 860]),
  {"parameters": {"amount": 5, "unit": "seconds"}, "id": "WaitPoll", "name": "WaitPoll", "type": "n8n-nodes-base.wait", "typeVersion": 1.1, "position": [2360, 680], "webhookId": "cf-poll"},

  http("POST", PUB_URL, [("creation_id", "={{ $json.id }}")], "Publicar", "Publicar", [2380, 540]),
  http("GET", "=https://graph.instagram.com/v19.0/{{ $json.id }}", [("fields", "permalink")], "Permalink", "Permalink", [2560, 540], onerr="continueRegularOutput"),
  pgq("UPDATE contenido.revisiones SET estado='publicada', ig_post_id=$2, ig_permalink=NULLIF($3,''), publicado_en=now() WHERE token=$1 RETURNING ig_post_id",
      "={{ [ "+A+".token, $('Publicar').item.json.id, ($('Permalink').item.json.permalink || '') ] }}", "MarcarPub", "MarcarPub", [2740, 540]),
  resp("=<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><body style='font-family:sans-serif;background:#080806;color:#f5f2ec;text-align:center;padding:60px 20px'><div style='font-size:2rem;font-weight:900;color:#ff4400'>CORTAFUEGO</div><h2 style='font-size:1.8rem'>Publicada</h2><p style='color:#8a8a82'>Ya podes cerrar esta pestana.</p></body>", "Respond", "Respond", [2920, 540]),
]

def c(node, *targets):
    return {node: {"main": [[{"node": t, "type": "main", "index": 0} for t in (targets if isinstance(targets, tuple) else (targets,))]]}}

connections = {}
def link(src, *outs):
    # outs: list of lists (each output index → list of target node names)
    connections[src] = {"main": [[{"node": t, "type": "main", "index": 0} for t in lst] for lst in outs]}

link("Webhook", ["Aprobar"])
link("Aprobar", ["huboCambio"])
link("huboCambio", ["esStory"], ["RespYa"])          # true / false
link("esStory", ["esStoryVideo"], ["MediaCount"])     # story / feed
link("esStoryVideo", ["ContainerStoryVid"], ["ContainerStoryImg"])
link("ContainerStoryVid", ["CheckStatus"])
link("ContainerStoryImg", ["CheckStatus"])
link("MediaCount", ["EsCarrusel"])
link("EsCarrusel", ["MediaList"], ["EsVideo"])
link("MediaList", ["Child"])
link("Child", ["JoinChildren"])
link("JoinChildren", ["CarouselCont"])
link("CarouselCont", ["CheckStatus"])
link("EsVideo", ["ContainerReel"], ["ContainerImg"])
link("ContainerReel", ["CheckStatus"])
link("ContainerImg", ["CheckStatus"])
link("CheckStatus", ["esFinished"])
link("esFinished", ["Publicar"], ["esError"])
link("esError", ["RespErr"], ["WaitPoll"])
link("WaitPoll", ["CheckStatus"])
link("Publicar", ["Permalink"])
link("Permalink", ["MarcarPub"])
link("MarcarPub", ["Respond"])

wf = {"name": "Cortafuego - Publicar (Fase C)", "nodes": nodes, "connections": connections, "settings": {}}
json.dump(wf, open("/root/claudefolder/core/scripts/n8n/workflows/cf-pub-publish.json", "w"), ensure_ascii=False, indent=2)
print("nodos:", len(nodes))
