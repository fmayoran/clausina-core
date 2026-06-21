"""Constantes compartidas del subsistema de workers.

Arquitectura: cola Redis + worker(s) reemplazan el poll por cron de los procesos batch.
El trabajo real (cola de tareas) sigue viviendo en Postgres (contenido.*); Redis es solo el
canal de despacho evento -> worker. Ver plataforma/workers/README.md.
"""
import os

# Cola de jobs (lista Redis; LPUSH al encolar, BLPOP al consumir).
# Puerto 6380: el 6379 lo usa el Redis del POC. Ligado solo a 127.0.0.1 (ver deploy/redis-run.sh).
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6380/0")
QUEUE = "cf:jobs"

# Prefijo de los locks "en vuelo" (un job por (tipo, slug) a la vez; mismo criterio que el
# flock de los scripts batch). TTL de seguridad para que un worker caído no deje un deadlock.
INFLIGHT_PREFIX = "cf:inflight"
INFLIGHT_TTL = 1800  # segundos

# Rutas del motor / cápsulas de marca.
MOTOR = os.environ.get("MOTOR", "/root/claudefolder/plataforma")
MARCAS = os.environ.get("MARCAS", "/root/claudefolder/marcas")

# Base de n8n (chequeos baratos cf-*).
N = os.environ.get("N", "https://crm-n8n.dhmtev.easypanel.host")

# Backend de ejecución del agente: "headless" (claude -p, suscripción, gratis) o "api" (Opus 4.8, pago).
AGENT_BACKEND = os.environ.get("AGENT_BACKEND", "headless")

# Filtro del contenedor Postgres (servicio Swarm en el VPS).
PG_NAME_FILTER = os.environ.get("PG_NAME_FILTER", "crm_pgvector.1.")
