#!/usr/bin/env python3
"""Corre el verificador y deja el resultado en la base, para que el panel lo muestre.
Separado del job de aviso porque el escapado de JSON en bash es una fuente de errores."""
import json
import os
import secrets
import subprocess
import sys

MOTOR = os.path.dirname(os.path.abspath(__file__))
r = subprocess.run([sys.executable, f"{MOTOR}/verificar_sistema.py", "--json"],
                   capture_output=True, text=True, timeout=300)
try:
    datos = json.loads(r.stdout)
except Exception:
    sys.exit(1)

cid = subprocess.run(["docker", "ps", "-q", "-f", "name=crm_pgvector.1."],
                     capture_output=True, text=True).stdout.strip()
if not cid:
    sys.exit(1)

t = "x" + secrets.token_hex(8)
val = json.dumps(datos, ensure_ascii=False)
sql = (f"INSERT INTO contenido.plataforma_config (clave, valor, descripcion, actualizado_en) "
       f"VALUES ('verificacion', ${t}${val}${t}$, 'Última verificación de integridad', now()) "
       f"ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor, actualizado_en=now();")
subprocess.run(["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude", "-q", "-c", sql],
               capture_output=True, text=True)
