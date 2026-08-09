#!/usr/bin/env python3
"""Regenera los archivos de skills desde la base — ClaUsina.

La DB es la fuente de verdad; el .md es una copia derivada, igual que la credencial de n8n.
Claude lee archivos del disco y no puede consultar la base, así que alguien tiene que
escribirlos: este script, en el host, disparado cuando se guarda un skill en el panel.

Se pide UNA skill por consulta y no todas juntas: el contenido es markdown con saltos de línea,
y separar varias filas de texto libre en una sola salida es una fuente de errores silenciosos
—dos skills pegadas producen un archivo que parece válido y no lo es—.

Uso:  skills_sync.py [slug ...]      (sin argumentos: todos los activos)
"""
import os
import subprocess
import sys

DESTINO = "/root/.claude/skills"


def _cid():
    return subprocess.run(["docker", "ps", "-q", "-f", "name=crm_pgvector.1."],
                          capture_output=True, text=True).stdout.strip()


def psql(sql, cid):
    r = subprocess.run(["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude",
                        "-t", "-A", "-q", "-c", sql], capture_output=True, text=True, timeout=60)
    return r.stdout


def main():
    cid = _cid()
    if not cid:
        print("sin contenedor de base", file=sys.stderr)
        return 1

    solo = [s for s in sys.argv[1:] if s.replace("-", "").isalnum()]
    filtro = ""
    if solo:
        filtro = " AND slug IN (" + ",".join("'" + s + "'" for s in solo) + ")"
    slugs = [s for s in psql(f"SELECT slug FROM contenido.skill WHERE activo{filtro};", cid).split() if s]
    if not slugs:
        print("sin skills que regenerar")
        return 0

    for slug in slugs:
        desc = psql(f"SELECT descripcion FROM contenido.skill WHERE slug='{slug}';", cid).strip()
        cuerpo = psql(f"SELECT contenido_md FROM contenido.skill WHERE slug='{slug}';", cid)
        if not cuerpo.strip():
            print(f"  {slug}: vacío, no se escribe")
            continue
        d = os.path.join(DESTINO, slug)
        os.makedirs(d, exist_ok=True)
        # El frontmatter se arma acá y no se guarda en la base: es lo que hace invocable a la
        # skill y lo que le dice a Claude cuándo usarla. Fuera del cuerpo, no se puede romper
        # editando el texto.
        cab = f"---\nname: {slug}\ndescription: {desc}\n---\n\n"
        destino = os.path.join(d, "SKILL.md")
        # Se escribe completo y de una: un .md a medio actualizar es peor que uno viejo, porque
        # nadie sabe qué versión está leyendo.
        tmp = destino + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(cab + cuerpo.strip() + "\n")
        os.replace(tmp, destino)
        print(f"  {slug}: {len(cuerpo.strip())} chars -> {destino}")
    print(f"{len(slugs)} skill(s) regenerado(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
