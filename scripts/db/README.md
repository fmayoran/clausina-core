# Base de datos — migraciones de `contenido`

Este directorio contiene los scripts SQL para crear y actualizar el schema `contenido` de la base `claude`.

- `schema_contenido.sql`: modelo base multi-proyecto (`proyectos`, `piezas`, `revisiones`, `media`).
- `migration_20260610_multimarca.sql`: soporte multimarca y scope por proyecto en tablas clave.
- `migration_20260612_proyecto_perfil.sql`: perfil de proyecto con `brief_md`, `slogan` y `logo`.
- `migration_20260621_clausina.sql`: alta del proyecto `clausina` en `contenido.proyectos` y `contenido.proyecto_perfil`.

Ejecutar una migración en el VPS:

```bash
ssh root@72.60.166.136 \
  "docker exec -i $(docker ps -q -f name=crm_pgvector.1.) psql -U postgres -d claude -v ON_ERROR_STOP=1" \
  < migration_20260621_clausina.sql
```

Para dar de alta una nueva marca en la plataforma:

1. Verificar que exista la cápsula de marca en `marcas/<slug>/`.
2. Crear o actualizar el registro en `contenido.proyectos`.
3. Crear o actualizar el perfil en `contenido.proyecto_perfil`.
4. Ejecutar la migración desde el VPS.
