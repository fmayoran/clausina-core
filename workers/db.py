"""Acceso a Postgres reusando el patrón de los scripts batch: docker exec al contenedor
crm_pgvector. Evita credenciales nuevas y se mantiene consistente con el resto del motor."""
import subprocess

from config import PG_NAME_FILTER


def _pg_container():
    cid = subprocess.run(
        ["docker", "ps", "-q", "-f", f"name={PG_NAME_FILTER}"],
        capture_output=True, text=True,
    ).stdout.strip()
    if not cid:
        raise RuntimeError("No se encontró el contenedor Postgres (crm_pgvector).")
    return cid


def psql(sql):
    """Ejecuta SQL y devuelve stdout en formato -t -A (tuplas sin formato). Lanza si falla."""
    cid = _pg_container()
    out = subprocess.run(
        ["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude", "-t", "-A", "-c", sql],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql falló: {out.stderr.strip()}")
    return out.stdout.strip()


def heartbeat(proceso, msg):
    """Latido a contenido.batch_runs (lo lee la barra de status del panel). Best-effort."""
    sql = (
        "INSERT INTO contenido.batch_runs(proceso,last_run,last_msg) "
        f"VALUES('{proceso}',now(),$m${msg}$m$) "
        "ON CONFLICT(proceso) DO UPDATE SET last_run=now(), last_msg=EXCLUDED.last_msg;"
    )
    try:
        cid = _pg_container()
        subprocess.run(
            ["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude", "-q", "-c", sql],
            capture_output=True, text=True,
        )
    except Exception:
        pass
