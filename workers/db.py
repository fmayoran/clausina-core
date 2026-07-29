"""Acceso a Postgres reusando el patrón de los scripts batch: docker exec al contenedor
crm_pgvector. Evita credenciales nuevas y se mantiene consistente con el resto del motor."""
import base64
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


def _lit(txt):
    """Literal SQL a prueba de comillas, saltos de línea y dollar-quoting.

    El detalle de un job es stdout/stderr crudo: trae comillas, `$`, saltos de línea y acentos.
    Escaparlo a mano ya falló antes (los writes con dollar-quoting desde bash se rompían en
    silencio). base64 no tiene ningún carácter que psql interprete, así que el problema
    desaparece: mandamos base64 y Postgres lo decodifica.
    """
    if txt is None:
        return "NULL"
    b64 = base64.b64encode(str(txt).encode("utf-8")).decode("ascii")
    return f"convert_from(decode('{b64}','base64'),'UTF8')"


def registrar_job(tipo, negocio_slug, ok, detalle, duracion_ms=None):
    """Deja el resultado del job en contenido.job_runs. Best-effort: registrar nunca debe
    tumbar al worker. Lo lee el verificador (chequeo 'jobs fallados') y el panel."""
    sql = (
        "INSERT INTO contenido.job_runs(tipo,negocio_slug,ok,detalle,duracion_ms) VALUES("
        f"{_lit(tipo)},{_lit(negocio_slug)},{'true' if ok else 'false'},"
        f"{_lit((detalle or '')[:4000])},{int(duracion_ms) if duracion_ms is not None else 'NULL'});"
    )
    try:
        cid = _pg_container()
        subprocess.run(
            ["docker", "exec", "-i", cid, "psql", "-U", "postgres", "-d", "claude", "-q", "-c", sql],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        pass
