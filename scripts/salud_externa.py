#!/usr/bin/env python3
"""Salud de los servicios de terceros de los que depende ClaUsina.

POR QUÉ EXISTE: Higgsfield estuvo sin credencial DOS SEMANAS y nos enteramos el día que un
trabajo la necesitó — el pedido de un asset falló y quedó ahí. Lo mismo puede pasar con
cualquier token de Meta, que vence: la publicación deja de andar y el primer aviso es un
cliente preguntando por qué no salió nada.

Es distinto de verificar_sistema.py a propósito. Ese mira ADENTRO (¿el SQL de n8n apunta a
tablas que existen?, ¿corrió el respaldo?); este mira AFUERA, y afuera falla distinto: se cae
la red, un token vence, se acaban los créditos. Un fallo acá no siempre es culpa nuestra, pero
siempre es nuestro problema.

Escribe el resultado en contenido.plataforma_config (clave 'salud_externa'), igual que el
verificador. El panel sólo lee.

Uso:  salud_externa.py [--json]
Salida: 0 si nada está caído, 1 si hay algún servicio caído.
"""
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

MOTOR = os.path.dirname(os.path.abspath(__file__))
GRAPH = "https://graph.facebook.com/v21.0"
OK, CAIDO, AVISO = "ok", "fallo", "aviso"
TIMEOUT = 12


def sh(cmd, timeout=45):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or r.stderr).strip()
    except Exception as e:
        return f"__error__ {e}"


def cid():
    return sh("docker ps -q -f name=crm_pgvector.1.", 15)


def psql(sql):
    c = cid()
    if not c:
        return ""
    r = subprocess.run(["docker", "exec", "-i", c, "psql", "-U", "postgres", "-d", "claude",
                        "-t", "-A", "-F", "\t", "-q", "-c", sql],
                       capture_output=True, text=True, timeout=30)
    return r.stdout.strip()


def get(url, token=None):
    """GET que devuelve (datos, error_legible). Nunca lanza: un servicio caído no puede
    voltear el chequeo de los demás."""
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        try:
            cuerpo = json.loads(e.read().decode())
            msg = (cuerpo.get("error") or {}).get("message") or str(e)
        except Exception:
            msg = f"HTTP {e.code}"
        return None, msg
    except Exception as e:
        return None, str(e)[:120]


# ── Plataforma ───────────────────────────────────────────────────────────────

def chk_higgsfield():
    """La CLI del host. La credencial es un device login que caduca y sólo se renueva a mano:
    el aviso tiene que llegar ANTES de que un trabajo la necesite."""
    salida = sh("timeout 40 higgsfield account status 2>&1", 50)
    if "__error__" in salida or not salida:
        return CAIDO, "no responde", ["revisá que la CLI esté instalada en el host"]
    bajo = salida.lower()
    if "not authenticated" in bajo or "auth login" in bajo:
        return CAIDO, "sin credencial", [
            "corré 'higgsfield auth login' en el VPS y aprobá en el navegador",
            "sin esto, generar imágenes o video con IA falla"]
    # "correo — ultra plan, 2996 credits"
    creditos = None
    for t in salida.replace(",", " ").split():
        if t.isdigit():
            creditos = int(t)
    linea = salida.splitlines()[0][:120]
    if creditos is not None and creditos < 300:
        return AVISO, f"quedan {creditos} créditos", [linea]
    return OK, linea, []


def chk_claude():
    """La clave con la que el panel le habla al modelo (FAQ, voz, interpretación de reservas).
    Se pregunta por la lista de modelos: no consume tokens y falla igual si la clave no sirve."""
    clave = ""
    env = f"{os.path.dirname(MOTOR)}/plataforma.env"
    if os.path.isfile(env):
        for ln in open(env, encoding="utf-8", errors="ignore"):
            if ln.startswith("ANTHROPIC_API_KEY="):
                clave = ln.split("=", 1)[1].strip().strip('"').strip("'")
    if not clave:
        return AVISO, "sin clave configurada", ["el panel no puede interpretar audios ni responder preguntas"]
    req = urllib.request.Request("https://api.anthropic.com/v1/models?limit=1")
    req.add_header("x-api-key", clave)
    req.add_header("anthropic-version", "2023-06-01")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            json.loads(r.read().decode())
        return OK, "clave válida", []
    except urllib.error.HTTPError as e:
        return CAIDO, f"la clave no sirve (HTTP {e.code})", ["revisá ANTHROPIC_API_KEY en core/plataforma.env"]
    except Exception as e:
        return AVISO, f"no se pudo consultar: {str(e)[:80]}", []


# ── Por negocio ──────────────────────────────────────────────────────────────

def _negocios():
    """Cada negocio activo con lo que tenga configurado. Los tokens vienen cifrados: se
    descifran acá, en el host, que es el único lugar con la clave de plataforma."""
    filas = psql(
        "SELECT n.slug, n.nombre, COALESCE(n.telegram_chat_id,''), "
        "  COALESCE(p.wa_phone_id,''), COALESCE(p.wa_token_enc,''), "
        "  COALESCE(n.ig_user_id,''), COALESCE(p.ig_token_enc,''), "
        "  COALESCE(p.meta_ads_account_id,''), COALESCE(p.meta_ads_token_enc,'') "
        "  FROM contenido.negocios n "
        "  LEFT JOIN contenido.negocio_perfil p ON p.negocio_id = n.id "
        " WHERE n.activo ORDER BY n.nombre")
    out = []
    for ln in filas.splitlines():
        c = ln.split("\t")
        if len(c) < 9:
            continue
        out.append(dict(slug=c[0], nombre=c[1], tg_chat=c[2], wa_phone=c[3], wa_enc=c[4],
                        ig_user=c[5], ig_enc=c[6], ads_cuenta=c[7], ads_enc=c[8]))
    return out


def descifrar(enc):
    if not enc:
        return ""
    r = sh(f"python3 {MOTOR}/ads_crypto.py decrypt {enc!r} 2>/dev/null", 20)
    return "" if "__error__" in r else r


def chk_meta(negocios):
    """Los tokens de Meta (WhatsApp, Instagram, Ads) vencen. Cuando eso pasa la publicación y el
    asistente dejan de andar SIN avisar: el panel dice 'publicando' y no sale nada. Un solo
    chequeo para los tres porque comparten API y modo de fallar."""
    res = {"whatsapp": [], "instagram": [], "ads": []}
    for n in negocios:
        if n["wa_phone"] and n["wa_enc"]:
            tok = descifrar(n["wa_enc"])
            if not tok:
                res["whatsapp"].append((n, CAIDO, "no se pudo descifrar el token"))
            else:
                d, err = get(f"{GRAPH}/{n['wa_phone']}?fields=display_phone_number,verified_name", tok)
                res["whatsapp"].append((n, OK, d.get("display_phone_number", "conectado")) if d
                                       else (n, CAIDO, err))
        if n["ig_user"] and n["ig_enc"]:
            tok = descifrar(n["ig_enc"])
            if not tok:
                res["instagram"].append((n, CAIDO, "no se pudo descifrar el token"))
            else:
                # Dos APIs distintas con el mismo nombre. Los tokens que empiezan con IGAA son de
                # Instagram con login propio y viven en graph.instagram.com; los de una cuenta
                # conectada a una página de Facebook van por graph.facebook.com. Preguntarle al
                # host equivocado devuelve "Cannot parse access token", que se lee como un token
                # roto cuando en realidad el token está bien y el equivocado es el chequeo.
                if tok.startswith("IGAA"):
                    d, err = get(f"https://graph.instagram.com/v21.0/me?fields=id,username", tok)
                else:
                    d, err = get(f"{GRAPH}/{n['ig_user']}?fields=username", tok)
                res["instagram"].append((n, OK, "@" + d.get("username", "")) if d else (n, CAIDO, err))
        if n["ads_cuenta"] and n["ads_enc"]:
            tok = descifrar(n["ads_enc"])
            if not tok:
                res["ads"].append((n, CAIDO, "no se pudo descifrar el token"))
            else:
                cta = n["ads_cuenta"] if n["ads_cuenta"].startswith("act_") else "act_" + n["ads_cuenta"]
                d, err = get(f"{GRAPH}/{cta}?fields=name,account_status", tok)
                res["ads"].append((n, OK, d.get("name", "conectada")) if d else (n, CAIDO, err))
    return res


def chk_telegram(negocios):
    """El canal por el que ClaUsina le avisa a la persona que aprueba. Si se cae, las
    aprobaciones no llegan y las piezas se quedan esperando sin que nadie lo note."""
    salidas = []
    for n in negocios:
        env = f"/root/clausina/marcas/{n['slug']}/{n['slug']}.env"
        tok = ""
        if os.path.isfile(env):
            for ln in open(env, encoding="utf-8", errors="ignore"):
                if ln.startswith("TELEGRAM_BOT_TOKEN="):
                    tok = ln.split("=", 1)[1].strip().strip('"').strip("'")
        if not tok:
            continue
        d, err = get(f"https://api.telegram.org/bot{tok}/getMe")
        if d and d.get("ok"):
            salidas.append((n, OK, "@" + (d.get("result") or {}).get("username", "")))
        else:
            salidas.append((n, CAIDO, err or "el bot no responde"))
    return salidas


# ── Armado ───────────────────────────────────────────────────────────────────

def _legible(msg):
    """El error crudo de Meta es una parrafada; lo que importa es qué hacer. Un token vencido y
    uno revocado se arreglan igual (renovarlo) pero se leen distinto en el crudo."""
    m = msg or ""
    if "Session has expired" in m or "expired" in m.lower():
        cuando = m.split("expired on", 1)[1].split(".")[0].strip() if "expired on" in m else ""
        return f"el token venció{' el ' + cuando if cuando else ''} — hay que renovarlo"
    if "Cannot parse access token" in m or "Invalid OAuth" in m:
        return "el token no es válido — hay que volver a generarlo"
    return m[:140]


def _grupo(nombre, items, vacio):
    """Un servicio con varios negocios: el estado del grupo es el peor de sus negocios. Si uno
    de cinco está caído, el grupo NO puede decir 'ok' — es justo el que hay que mirar."""
    if not items:
        return {"chequeo": nombre, "estado": AVISO, "mensaje": vacio, "detalle": []}
    caidos = [(n, m) for n, e, m in items if e == CAIDO]
    detalle = [f"{n['nombre']}: {_legible(m)}" for n, m in caidos]
    if caidos:
        return {"chequeo": nombre, "estado": CAIDO,
                "mensaje": f"{len(caidos)} de {len(items)} con problemas", "detalle": detalle}
    return {"chequeo": nombre, "estado": OK,
            "mensaje": " · ".join(f"{n['nombre']}: {m}" for n, _, m in items)[:180], "detalle": []}


def main():
    negocios = _negocios()
    res = []

    for nombre, fn in [("Higgsfield · imagen y video con IA", chk_higgsfield),
                       ("Claude · el modelo del asistente", chk_claude)]:
        try:
            e, m, d = fn()
        except Exception as ex:
            e, m, d = AVISO, f"el chequeo falló: {str(ex)[:90]}", []
        res.append({"chequeo": nombre, "estado": e, "mensaje": m, "detalle": d})

    try:
        meta = chk_meta(negocios)
    except Exception as ex:
        meta = {"whatsapp": [], "instagram": [], "ads": []}
        res.append({"chequeo": "Meta", "estado": AVISO,
                    "mensaje": f"el chequeo falló: {str(ex)[:90]}", "detalle": []})
    res.append(_grupo("WhatsApp · el canal del cliente", meta["whatsapp"], "ningún negocio con WhatsApp"))
    res.append(_grupo("Instagram · publicación", meta["instagram"], "ningún negocio con Instagram"))
    res.append(_grupo("Meta Ads · pauta", meta["ads"], "ningún negocio con pauta"))

    try:
        tg = chk_telegram(negocios)
    except Exception:
        tg = []
    res.append(_grupo("Telegram · avisos de aprobación", tg, "ningún negocio con Telegram"))

    hay_caido = any(r["estado"] == CAIDO for r in res)
    if "--json" in sys.argv:
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        icono = {OK: "OK  ", CAIDO: "CAÍDO", AVISO: "aviso"}
        for r in res:
            print(f"  [{icono[r['estado']]}] {r['chequeo']}: {r['mensaje']}")
            for d in r["detalle"][:6]:
                print(f"           - {d}")
    return 1 if hay_caido else 0


if __name__ == "__main__":
    sys.exit(main())
