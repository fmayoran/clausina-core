#!/usr/bin/env python3
"""Regenera los archivos de contexto de un negocio desde la base — ClaUsina.

La base es la fuente de verdad; los .md de `marcas/<slug>/contexto/` son copias derivadas que
existen sólo porque el agente lee archivos. Mismo patrón que los skills, pero atado al negocio.

Escribe tres archivos:
  CONTEXTO_MARCA.md   — la FICHA (hechos consultables) + la marca + el brief (la narrativa)
  ESTILO.md           — el sistema de diseño
  REFERENCIAS.md      — el banco de referencias de estilo

POR QUÉ LA FICHA TAMBIÉN: hasta hoy el archivo llevaba sólo el brief, así que el creativo no
sabía el rubro, las sedes, la zona, el ticket, el público ni los horarios del negocio —la mitad
de lo que lo define, y lo único que está en formato consultable—. Escribía a ciegas sobre datos
que la plataforma ya tenía.

Uso:  contexto_a_md.py <slug>
"""
import json
import os
import subprocess
import sys

DIAS = {1: 'lunes', 2: 'martes', 3: 'miércoles', 4: 'jueves', 5: 'viernes', 6: 'sábado', 7: 'domingo'}


def psql(sql, cid):
    r = subprocess.run(["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude",
                        "-t", "-A", "-q", "-c", sql], capture_output=True, text=True, timeout=60)
    return r.stdout


def uno(sql, cid):
    return psql(sql, cid).strip()


def ficha_md(cid, slug):
    """Los hechos, en el formato en que se consultan. Vacío si el negocio no cargó la ficha."""
    j = uno(f"""SELECT coalesce(row_to_json(t)::text,'') FROM (
      SELECT a.nombre AS rubro, i.zona_modo, i.zona_km, i.zona_localidades,
             i.ticket_min, i.ticket_max, i.moneda, i.ticket_unidad, i.publico, i.atributos, i.horarios,
             (SELECT json_agg(json_build_object('nombre',s.nombre,'direccion',s.direccion,
                'localidad',s.localidad,'partido',s.partido,'provincia',s.provincia,'principal',s.principal)
                ORDER BY s.principal DESC, s.orden) FROM contenido.negocio_sede s WHERE s.negocio_id=n.id) AS sedes
        FROM contenido.negocios n
        JOIN contenido.negocio_identidad i ON i.negocio_id = n.id
        LEFT JOIN contenido.actividad a ON a.id = i.actividad_id
       WHERE n.slug='{slug}') t;""", cid)
    if not j:
        return ""
    d = json.loads(j)
    out = ["## Ficha — los hechos", ""]
    if d.get("rubro"):
        out.append(f"**Rubro:** {d['rubro']}")
    sedes = d.get("sedes") or []
    for s in sedes:
        dire = ", ".join(x for x in [s.get("direccion"), s.get("localidad"), s.get("partido"), s.get("provincia")] if x)
        out.append(f"**Sede{' principal' if s.get('principal') else ''}:** {dire}")
    if d.get("zona_localidades"):
        out.append(f"**Zona de influencia:** {', '.join(d['zona_localidades'])}")
    elif d.get("zona_km"):
        out.append(f"**Zona de influencia:** {d['zona_km']} km a la redonda")
    if d.get("ticket_min") or d.get("ticket_max"):
        mon = d.get("moneda") or "ARS"
        uni = d.get("ticket_unidad") or "persona"
        out.append(f"**Ticket:** {mon} {int(float(d.get('ticket_min') or 0))}–{int(float(d.get('ticket_max') or 0))} por {uni}")
    p = d.get("publico") or {}
    if p.get("edades"):
        out.append(f"**Edades:** {p['edades'][0]} a {p['edades'][1]}")
    if p.get("momentos"):
        out.append(f"**Momentos:** {', '.join(p['momentos'])}")
    if p.get("intereses"):
        out.append(f"**Intereses:** {', '.join(p['intereses'])}")
    if d.get("atributos"):
        out.append(f"**Atributos:** {', '.join(d['atributos'])}")
    h = d.get("horarios") or {}
    if h:
        out.append(f"**Horarios:** {json.dumps(h, ensure_ascii=False)}")
    out.append("")
    return "\n".join(out)


def turnos_md(cid, slug):
    """Si el negocio toma reservas, cuándo. El creativo no puede invitar a un turno que no corre."""
    filas = psql(f"""SELECT coalesce(t.nombre_publico,t.nombre) || '|' ||
                            to_char(t.hora_desde,'HH24:MI') || '|' || to_char(t.hora_hasta,'HH24:MI') || '|' ||
                            array_to_string(t.dias, ',')
                       FROM contenido.turno t JOIN contenido.negocios n ON n.id=t.negocio_id
                      WHERE n.slug='{slug}' AND t.activo ORDER BY t.orden;""", cid)
    if not filas.strip():
        return ""
    out = ["## Turnos de atención", ""]
    for ln in filas.strip().split("\n"):
        c = ln.split("|")
        if len(c) < 4:
            continue
        dias = ", ".join(DIAS.get(int(x), x) for x in c[3].split(",") if x)
        out.append(f"- **{c[0]}** — {c[1]} a {c[2]} · {dias}")
    out.append("")
    return "\n".join(out)


def main():
    slug = sys.argv[1] if len(sys.argv) > 1 else ""
    if not slug.replace("-", "").isalnum():
        print("uso: contexto_a_md.py <slug>", file=sys.stderr)
        return 2
    cid = subprocess.run(["docker", "ps", "-q", "-f", "name=crm_pgvector.1."],
                         capture_output=True, text=True).stdout.strip()
    if not cid:
        print("sin contenedor de base", file=sys.stderr)
        return 1

    dest = f"/root/clausina/marcas/{slug}/contexto"
    if not os.path.isdir(os.path.dirname(dest)):
        print(f"{slug}: sin cápsula en disco, no escribo", file=sys.stderr)
        return 0
    os.makedirs(dest, exist_ok=True)

    nombre = uno(f"SELECT nombre FROM contenido.negocios WHERE slug='{slug}';", cid)
    if not nombre:
        print(f"{slug}: no existe", file=sys.stderr)
        return 1

    cab = uno(f"""SELECT concat_ws(E'\\n',
        '**Slogan:** ' || coalesce(pp.slogan,'—'),
        '**Instagram:** ' || coalesce(n.ig_handle,'—'),
        '**Web:** ' || coalesce(n.dominio_web,'—'),
        '**WhatsApp:** ' || coalesce(n.whatsapp,'—'),
        '**Logo (fondo oscuro):** ' || coalesce(pp.logo,'—'),
        '**Logo (fondo claro):** ' || coalesce(pp.logo_claro,'(no cargado)'))
      FROM contenido.negocios n LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id=n.id
      WHERE n.slug='{slug}';""", cid)
    marca = uno(f"""SELECT coalesce(ni.marca::text,'') FROM contenido.negocio_identidad ni
                     JOIN contenido.negocios n ON n.id=ni.negocio_id WHERE n.slug='{slug}';""", cid)
    brief = psql(f"""SELECT coalesce(pp.brief_md,'') FROM contenido.negocios n
                      LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id=n.id WHERE n.slug='{slug}';""", cid)

    partes = [f"# {nombre} — Contexto de marca",
              "> Generado desde la base, que es la fuente de verdad. **Editar en el panel → Identidad**, "
              "nunca este archivo: cualquier cambio acá se pierde en la próxima regeneración.",
              "", cab, ""]
    f = ficha_md(cid, slug)
    if f:
        partes.append(f)
    t = turnos_md(cid, slug)
    if t:
        partes.append(t)
    if marca and marca != "{}":
        partes.append("## Tokens de marca\n\n```json\n" + marca + "\n```\n")
    if brief.strip():
        partes.append("## Brief — la narrativa\n\n" + brief.strip() + "\n")

    escribir(os.path.join(dest, "CONTEXTO_MARCA.md"), "\n".join(partes))

    # Los otros dos, cada uno con su archivo: son textos largos y separados se leen mejor.
    for campo, arch, titulo in [("estilo_md", "ESTILO.md", "Sistema de diseño"),
                                ("referencias_md", "REFERENCIAS.md", "Referencias de estilo")]:
        v = psql(f"""SELECT coalesce(pp.{campo},'') FROM contenido.negocios n
                      LEFT JOIN contenido.negocio_perfil pp ON pp.negocio_id=n.id WHERE n.slug='{slug}';""", cid)
        p = os.path.join(dest, arch)
        if v.strip():
            escribir(p, f"# {nombre} — {titulo}\n> Generado desde la base. Editar en el panel → Identidad.\n\n" + v.strip())
        elif os.path.exists(p):
            # Si se vació en el panel, el archivo no puede quedar con el contenido viejo: el
            # agente seguiría leyendo algo que el negocio ya borró.
            os.remove(p)
            print(f"  {arch}: vacío en la base, se elimina")
    return 0


def escribir(path, texto):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(texto.rstrip() + "\n")
    os.replace(tmp, path)
    print(f"  {os.path.basename(path)}: {len(texto)} chars")


if __name__ == "__main__":
    sys.exit(main())
