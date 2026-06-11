# Organización de la plataforma (multi-marca)

> Contrato de dónde vive cada cosa. Cualquier desarrollo nuevo debe respetar esta separación.
> Restructure aplicado: 2026-06-11.

## Principio
**Motor agnóstico + cápsula de marca aislada.** El motor no sabe de ninguna marca en particular;
sabe operar *una marca cualquiera*. Cada marca es una cápsula independiente (contexto + assets + secretos).

## Árbol
```
/root/claudefolder/
├── CLAUDE.md                    # preferencias de Fer (usuario) + punteros de proyecto
├── infra/                       # infra compartida (INFRA_CONTEXTO.md)
├── .env                         # SOLO infra/ops: VPS, EasyPanel, GitHub, dominios, n8n
├── plataforma/                  # EL MOTOR (agnóstico de marca)
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
- **Plataforma** (DB, panel): `plataforma/plataforma.env`.
- **Marca** (IG token, Telegram, mail): `marcas/<slug>/<slug>.env`. Nunca en el `.env` raíz.
- **Infra/ops** (VPS, EasyPanel, GitHub, dominios, n8n): `.env` raíz.
- El panel carga los tres con `--env-file` (plataforma + cada marca). Los crons leen el token de la marca de su `<slug>.env`.

## Deploys
- **Landing de marca** (`cortafuego.ar`): EasyPanel buildea el repo de la marca **desde GitHub** (Dockerfile → nginx + assets/landing). Mover el working copy local NO afecta el deploy; solo importa lo que se pushea.
- **Panel** (`cf-panel`): `bash plataforma/panel/deploy.sh` (docker build local desde `plataforma/panel/`).
- **Crons**: en el crontab del VPS, apuntan a `plataforma/scripts/*.sh`. CWD de generación = la cápsula de la marca (`marcas/<slug>/`); playbooks/logs del motor por ruta absoluta (`$MOTOR=/root/claudefolder/plataforma`).

## Pendiente (no hecho en este restructure)
- El motor (`plataforma/`) todavía no tiene su propio repo git (queda respaldado por tar). Evaluar versionarlo.
- Des-hornear lo que aún asume "Cortafuego" en crons/n8n para que iteren por marca activa (Fase 2 resto).
- Conectar `@ardora.sport` y modelar el paraguas Distrito Ardora + sub-marcas.
