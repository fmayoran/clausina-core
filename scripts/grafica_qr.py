#!/usr/bin/env python3
"""QR para piezas gráficas: resuelve el destino y lo inserta en el hueco que dejó el diseño.

El director de arte reserva un `<div id="qr-slot">` vacío (ver grafica_gen.md); acá generamos el
código y lo metemos ahí como imagen EMBEBIDA (data URI). Embebido a propósito: un QR que dependa
de un servicio externo deja de funcionar el día que ese servicio se cae — y para entonces ya está
impreso en miles de folletos.

Uso:  grafica_qr.py <html> <ctx.json>   (modifica el html in-place; imprime la URL codificada)
"""
import base64
import io
import json
import re
import sys

import qrcode
from qrcode.constants import ERROR_CORRECT_H


def limpiar_tel(t):
    """Deja solo dígitos; wa.me los quiere sin + ni espacios."""
    return re.sub(r"\D", "", t or "")


def destino(ctx):
    """URL final del QR según lo elegido en la pieza. Devuelve (url, rotulo) o (None, motivo)."""
    datos = ctx.get("datos") or {}
    neg = ctx.get("negocio") or {}
    modo = (datos.get("qr_destino") or "web").strip()

    if modo == "url":
        u = (datos.get("qr_url") or "").strip()
        if not u:
            return None, "se eligió URL libre pero quedó vacía"
        if not u.startswith(("http://", "https://")):
            u = "https://" + u
        return u, "Escaneá"

    if modo == "instagram":
        h = (neg.get("ig_handle") or "").strip().lstrip("@")
        if not h:
            return None, "el negocio no tiene Instagram cargado"
        return f"https://instagram.com/{h}", f"@{h}"

    if modo == "whatsapp":
        n = limpiar_tel(neg.get("whatsapp"))
        if not n:
            return None, "el negocio no tiene WhatsApp cargado"
        txt = (datos.get("qr_texto") or "").strip()
        u = f"https://wa.me/{n}"
        if txt:
            from urllib.parse import quote
            u += "?text=" + quote(txt)
        return u, "WhatsApp"

    # default: la web del negocio
    w = (neg.get("dominio_web") or "").strip()
    if not w:
        return None, "el negocio no tiene web cargada"
    if not w.startswith(("http://", "https://")):
        w = "https://" + w
    return w, w.replace("https://", "").replace("http://", "").rstrip("/")


def png_data_uri(url):
    """QR en PNG (data URI). Corrección alta: tolera tinta, dobleces y sobreimpresión."""
    q = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_H, box_size=20, border=2)
    q.add_data(url)
    q.make(fit=True)
    img = q.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def insertar(html, data_uri, rotulo):
    """Rellena el hueco #qr-slot. Devuelve (html, ok)."""
    img = (f'<img src="{data_uri}" alt="Código QR" '
           f'style="display:block;width:100%;height:100%;object-fit:contain;">')
    # 1) el hueco declarado por el diseño
    pat = re.compile(r'(<div[^>]*id=["\']qr-slot["\'][^>]*>)(.*?)(</div>)', re.I | re.S)
    if pat.search(html):
        return pat.sub(lambda m: m.group(1) + img + m.group(3), html, count=1), True
    # 2) por si el diseño usó una clase en vez del id
    pat2 = re.compile(r'(<div[^>]*class=["\'][^"\']*qr-slot[^"\']*["\'][^>]*>)(.*?)(</div>)', re.I | re.S)
    if pat2.search(html):
        return pat2.sub(lambda m: m.group(1) + img + m.group(3), html, count=1), True
    return html, False


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "uso: grafica_qr.py <html> <ctx.json>"}))
        return
    ruta_html, ruta_ctx = sys.argv[1], sys.argv[2]
    ctx = json.load(open(ruta_ctx, encoding="utf-8"))
    if not (ctx.get("datos") or {}).get("qr"):
        print(json.dumps({"ok": True, "skip": "la pieza no pidió QR"}))
        return

    url, rotulo = destino(ctx)
    if not url:
        print(json.dumps({"ok": False, "error": f"No se pudo armar el QR: {rotulo}."}, ensure_ascii=False))
        return

    html = open(ruta_html, encoding="utf-8").read()
    html2, ok = insertar(html, png_data_uri(url), rotulo)
    if not ok:
        print(json.dumps({"ok": False, "error": "el diseño no dejó el hueco #qr-slot", "url": url},
                         ensure_ascii=False))
        return
    open(ruta_html, "w", encoding="utf-8").write(html2)
    print(json.dumps({"ok": True, "url": url}, ensure_ascii=False))


if __name__ == "__main__":
    main()
