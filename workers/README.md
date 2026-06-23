# Workers — cola Redis (reemplazo de los procesos batch por cron)

Subsistema que reemplaza el **poll por cron** de los procesos batch por un esquema
**cola Redis + worker(s)** event-driven. Piloto: **corrección de rechazos**, **solo Cortafuego**.

## Por qué

Los scripts `scripts/*_local.sh` corrían por cron polleando Postgres cada pocos minutos. Esto
es la misma idea que probamos en `poc-multi-brand-agent/`, graduada al motor de producción:
desacopla el disparo del trabajo, permite paralelizar (N workers) y observar mejor.

**No aumenta el gasto de tokens:** el worker ejecuta el mismo `claude -p --model sonnet` headless
(sobre la suscripción, costo de API = 0). El seam `agent_backend.py` permite cambiar a la API
(Opus 4.8) por env (`AGENT_BACKEND=api`) el día que haya volumen — sin rediseñar.

## Flujo

```
rechazo en DB ──> dispatcher.py (chequeo barato + revids de cortafuego) ──LPUSH──> Redis "cf:jobs"
                                                                                       │ BLPOP
                                                       worker.py ──> handlers/correccion.py
                                                                       └─ agent_backend.run()
                                                                            └─ scripts/correccion_job.sh
                                                                                 └─ claude -p (suscripción)
                                                                          ──> Postgres + heartbeat batch_runs
```

Job: `{ "tipo": "correccion", "proyecto_slug": "cortafuego", "payload": {"revision_ids": "..."} }`

## Componentes

| archivo | rol |
|---|---|
| `config.py` | constantes (Redis, cola, rutas, n8n, backend) |
| `jobqueue.py` | enqueue/dequeue (BLPOP) + lock 'en vuelo' (dedup por tipo/slug) |
| `db.py` | psql vía `docker exec` + heartbeat a `contenido.batch_runs` |
| `agent_backend.py` | seam de ejecución: `headless` (claude -p) / `api` (futuro) |
| `worker.py` | daemon: BLPOP → dispatch por `tipo` → handler |
| `handlers/correccion.py` | invoca `scripts/correccion_job.sh` |
| `dispatcher.py` | single-shot: chequeo barato → encola (piloto: cortafuego) |
| `../scripts/correccion_job.sh` | cuerpo por-slug **verbatim** de `rutina_local.sh` (prompt idéntico) |

## Despliegue (en el VPS, como root)

```bash
# 1. Dependencias del host (el worker corre en el host, no en contenedor: usa /root/.claude)
pip3 install -r /root/clausina/core/workers/requirements.txt

# 2. Redis (contenedor, solo localhost)
bash /root/clausina/core/workers/deploy/redis-run.sh

# 3. Servicios systemd
cp /root/clausina/core/workers/deploy/cf-worker.service /etc/systemd/system/
cp /root/clausina/core/workers/deploy/cf-dispatcher.service /etc/systemd/system/
cp /root/clausina/core/workers/deploy/cf-dispatcher.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cf-worker.service
systemctl enable --now cf-dispatcher.timer
```

## Cutover (cuando se valida en seco)

Mientras `cf-worker` corre, el cron de `rutina_local` sigue activo: hay que **cortarlo** para que
no procese en paralelo. Editar el crontab de root y comentar SOLO esa línea:

```
# */5 * * * * /root/clausina/core/scripts/rutina_local.sh   # migrado a workers (cola Redis)
```

Las otras 3 líneas (brief/propuestas/landing) quedan **intactas** hasta migrarlas (ver backlog).

## Rollback inmediato

```bash
systemctl disable --now cf-worker.service cf-dispatcher.timer
# descomentar la línea */5 rutina_local.sh en el crontab
```

La cola real de trabajo vive en Postgres (revisiones `rechazada`), no en Redis: no se pierde nada.

## Verificación end-to-end

1. Con un rechazo real de Cortafuego en la base (`contenido.revisiones.estado='rechazada'`, vigente, `derivado_en IS NULL`):
2. `python3 dispatcher.py` → debe loguear `encolado correccion/cortafuego`.
3. `redis-cli -h 127.0.0.1 -p 6380 LRANGE cf:jobs 0 -1` → ver el job.
4. `cf-worker` (o `python3 worker.py`) lo toma, corre `claude -p`, la pieza vuelve a `pendiente`, y `contenido.batch_runs(proceso='correccion')` se actualiza (la barra del panel lo refleja).
5. Dedup: correr el dispatcher dos veces seguidas no debe encolar dos jobs del mismo slug.

## Backlog (rollout a toda la plataforma)

- Portar `briefs`, `propuestas`, `landings` (mismo patrón: `scripts/<tipo>_job.sh` + `handlers/<tipo>.py`).
- Quitar el filtro `cortafuego` del dispatcher → todas las marcas.
- Dispatcher event-driven: Postgres `LISTEN/NOTIFY` o push desde productores (elimina el poll).
- Escalar workers (N réplicas) + prioridades. Backend `api` opcional por proceso.
