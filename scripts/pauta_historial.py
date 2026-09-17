#!/usr/bin/env python3
"""Historial de campañas de pauta, con su OBJETIVO y cómo rindió cada una.

POR QUÉ EXISTE. El estratega ya sabía cómo rindió cada PIEZA —gasto, CPM, CTR— pero no cómo rindió
cada CAMPAÑA ni con qué objetivo se corrió. Sin eso no puede contestar la pregunta que de verdad
importa antes de gastar: "¿qué tipo de campaña le funciona a ESTE negocio?". Con eso puede ver, por
ejemplo, que las de tráfico rinden 3,3% de CTR y las de reconocimiento 0,13% en la misma cuenta, y
recomendar en consecuencia en vez de por costumbre.

Las métricas son de TODA la vida de la campaña (date_preset=maximum), no de los últimos 30 días:
una campaña de julio tiene que poder compararse con una de septiembre.

Sale por stdout como JSON. Si algo falla devuelve una lista vacía: es contexto, no un requisito.
"""
import json
import sys

sys.path.insert(0, "/root/clausina/core/scripts")
import pauta_sync as ps  # noqa: E402

OBJ = ps.OBJETIVOS if hasattr(ps, "OBJETIVOS") else {}


def historial(slug):
    marcas = ps.discover_brands()
    if slug not in marcas:
        return []
    act, token = marcas[slug]["act"], marcas[slug]["token"]
    if not act.startswith("act_"):
        act = "act_" + act

    camps = ps.graph_get(f"{act}/campaigns", token, {
        "fields": "name,objective,effective_status,start_time,stop_time,daily_budget,lifetime_budget",
        "limit": 100}).get("data", [])

    # Las métricas de toda la vida, en UNA llamada por cuenta y no una por campaña.
    ins = {}
    try:
        for r in ps.graph_get(f"{act}/insights", token, {
                "level": "campaign", "date_preset": "maximum",
                "fields": "campaign_id,spend,impressions,reach,clicks,ctr,cpm",
                "limit": 200}).get("data", []):
            ins[r.get("campaign_id")] = r
    except Exception:
        pass

    out = []
    for c in camps:
        i = ins.get(c.get("id"), {})
        gasto = ps.num(i.get("spend"))
        # Una campaña que no gastó no enseña nada y ensucia la comparación: se deja afuera.
        if gasto <= 0:
            continue
        out.append({
            "nombre": c.get("name"),
            "objetivo": OBJ.get(c.get("objective"), c.get("objective") or "—"),
            "objetivo_meta": c.get("objective"),
            "desde": (c.get("start_time") or "")[:10],
            "hasta": (c.get("stop_time") or "")[:10] or None,
            "gasto": round(gasto, 2),
            "impresiones": int(ps.num(i.get("impressions"))),
            "alcance": int(ps.num(i.get("reach"))),
            "clics": int(ps.num(i.get("clicks"))),
            "ctr": round(ps.num(i.get("ctr")), 2),
            "cpm": round(ps.num(i.get("cpm")), 2),
        })
    out.sort(key=lambda x: x["desde"] or "", reverse=True)
    return out


if __name__ == "__main__":
    slug = sys.argv[1] if len(sys.argv) > 1 else "cortafuego"
    try:
        print(json.dumps(historial(slug), ensure_ascii=False))
    except Exception:
        print("[]")
