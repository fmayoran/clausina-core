"""Cola de jobs sobre Redis + locks 'en vuelo' (dedup por tipo/slug).

Nombre `jobqueue` (no `queue`) a propósito: evitar ensombrecer el módulo `queue` de la stdlib,
que usa redis-py internamente.
"""
import json

import redis

from config import REDIS_URL, QUEUE, INFLIGHT_PREFIX, INFLIGHT_TTL

_client = redis.Redis.from_url(REDIS_URL)


def client():
    return _client


def _inflight_key(tipo, slug):
    return f"{INFLIGHT_PREFIX}:{tipo}:{slug}"


def acquire_inflight(tipo, slug):
    """SETNX con TTL. Devuelve True si tomó el lock (no había job de ese (tipo,slug) en vuelo)."""
    return bool(_client.set(_inflight_key(tipo, slug), "1", nx=True, ex=INFLIGHT_TTL))


def release_inflight(tipo, slug):
    _client.delete(_inflight_key(tipo, slug))


def enqueue(job):
    """job = {tipo, proyecto_slug, payload}. Encola al final de la cola."""
    _client.rpush(QUEUE, json.dumps(job, ensure_ascii=False))


def dequeue(timeout=10):
    """BLPOP bloqueante. Devuelve el job (dict) o None si venció el timeout."""
    res = _client.blpop(QUEUE, timeout=timeout)
    if not res:
        return None
    _, payload = res
    return json.loads(payload)
