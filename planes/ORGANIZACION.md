# Organización de la plataforma (multi-marca)

> Contrato de dónde vive cada cosa. Cualquier desarrollo nuevo debe respetar esta separación.
> Restructure aplicado: 2026-06-11. Monorepo contenedor `clausina` (raíz como submodules): 2026-06-22.

## Principio
**Motor agnóstico + cápsula de marca aislada.** El motor no sabe de ninguna marca en particular;
sabe operar *una marca cualquiera*. Cada marca es una cápsula independiente (contexto + assets + secretos).

## Árbol
```
/root/claudefolder/
├── CLAUDE.md                    # preferencias de Fer (usuario) + punteros de proyecto
├── infra/                       # infra compartida (INFRA_CONTEXTO.md)
├── .env                         # SOLO infra/ops: VPS, EasyPanel, GitHub, dominios, n8n
├── core/                  # EL MOTOR (agnóstico de marca)
│   ├── panel/                   # app del panel (contenedor cf-panel; deploy.sh)
│   ├── scripts/                 # crons (brief/rutina/propuestas), db/, n8n/, higgsfield/, validate_web, send_mail
│   ├── planes/                  # arquitectura (este doc, ARQUITECTURA_*, CALENDARIO)
│   └── plataforma.env           # secretos de plataforma: PG* (DB), PANEL_*
└── marcas/                      # una cápsula por marca (tenant)
    ├── cortafuego/              # = repo git cortafuego.git → deploya cortafuego.ar
    │   ├── Dockerfile nginx.conf assets/landing/   # la landing
    │   ├── contexto/ pantalla/ interior-graficas/  # marca
    │   ├── CLAUDE.md            # instrucciones de la marca
    │   └── cortafuego.env       # secretos de la marca (IG/TG/mail) — gitignored (*.env)
    └── ardora/
        ├── CONTEXTO_MARCA.md    # (Distrito Ardora: paraguas; sub-marcas paseo/sport)
        └── ardora.env           # ARDORA_IG_* (System User, permanente)
```

## Reglas de secretos
- **Plataforma** (DB, panel): `core/plataforma.env`.
- **Marca** (IG token, Telegram, mail): `marcas/<slug>/<slug>.env`. Nunca en el `.env` raíz.
- **Infra/ops** (VPS, EasyPanel, GitHub, dominios, n8n): `.env` raíz.
- El panel carga los tres con `--env-file` (plataforma + cada marca). Los crons leen el token de la marca de su `<slug>.env`.

## Deploys
- **Landing de marca** (`cortafuego.ar`): EasyPanel buildea el repo de la marca **desde GitHub** (Dockerfile → nginx + assets/landing). Mover el working copy local NO afecta el deploy; solo importa lo que se pushea.
- **Panel** (`cf-panel`): `bash core/panel/deploy.sh` (docker build local desde `core/panel/`).
- **Crons**: en el crontab del VPS, apuntan a `core/scripts/*.sh`. CWD de generación = la cápsula de la marca (`marcas/<slug>/`); playbooks/logs del motor por ruta absoluta (`$MOTOR=/root/claudefolder/core`).

## Repos git (monorepo contenedor, 2026-06-22)
La raíz `/root/claudefolder/` es el repo contenedor `fmayoran/clausina` (monorepo). Todo lo que deploya a un servicio externo es un submodule con su propio repo:
- `core/` → `fmayoran/clausina-core` (motor; el panel buildea desde acá en EasyPanel).
- `marcas/cortafuego/` → `fmayoran/cortafuego` (Cloudflare Worker).
- `marcas/ardora/` → `fmayoran/ardora` (Cloudflare Pages).
- `marcas/clausina/` → `fmayoran/clausina-web` (Cloudflare Worker; `wrangler.jsonc` listo, falta conectar el proyecto en Cloudflare).
- Huérfanos versionados dentro del contenedor: `infra/`, `tools/`, archivos raíz (`CLAUDE.md`, `.mcp.json`). Secretos (`.env`, `*.env`) gitignored.

Flujo con submodules: editar landing → commit+push DENTRO del submodule (dispara Cloudflare) → commit en el contenedor para actualizar el puntero (solo registro, no afecta deploy).

## Pendiente
- Des-hornear los workflows n8n `cf-*` (rebrand a identidad ClaUsina + iterar por marca). Los crons/handlers (brief/propuestas/rutina/landing) ya son agnósticos: rutean por `proyecto_id` y, sin proyecto resoluble, marcan error en vez de asumir una marca.
- Conectar `@ardora.sport` y modelar el paraguas Distrito Ardora + sub-marcas.
