#!/usr/bin/env bash
# Hook PreToolUse (matcher Bash) — calidad web de landings, agnóstico de marca.
# Si el comando es un `git commit` que afecta la cápsula de una marca
# (cwd o comando dentro de marcas/<slug>), valida la landing de ESA marca.
# Si falla, bloquea el commit (exit 2) y devuelve el motivo a Claude.
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)"
cwd="$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null || true)"

# ¿Es un git commit?
if printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]])git([[:space:]]|$)' \
   && printf '%s' "$cmd" | grep -q 'commit'; then
  # Resolver el slug de la marca afectada desde el cwd o el comando (marcas/<slug>).
  slug=""
  for src in "$cwd" "$cmd"; do
    if printf '%s' "$src" | grep -q '/marcas/'; then
      slug=$(printf '%s' "$src" | sed -E 's#.*/marcas/([^/ ]+).*#\1#'); break
    fi
  done
  if [ -n "$slug" ]; then
    LANDING="/root/clausina/marcas/$slug/assets/landing"
    # Solo valida marcas cuya landing vive en assets/landing (otras se ignoran).
    if [ -d "$LANDING" ]; then
      # Tope de 24 MB por archivo (límite de Cloudflare). La regla ya estaba escrita en los
      # prompts del creativo y del editor, pero no la verificaba nadie: un mp4 pasado de peso
      # se commitea, deploya, y la landing sirve un video roto sin que salte ningún error.
      GRANDES=$(find "$LANDING" -type f -size +24M -printf '%s %p\n' 2>/dev/null \
                | awk '{printf "    %.1f MB  %s\n", $1/1048576, $2}')
      if [ -n "$GRANDES" ]; then
        {
          echo "Commit BLOQUEADO ($slug): hay archivos que superan el tope de 24 MB de Cloudflare."
          echo "$GRANDES"
          echo "  Recomprimí el video (o bajá la resolución) antes de commitear."
        } >&2
        exit 2
      fi
      if ! out="$(python3 /root/clausina/core/scripts/validate_web.py "$LANDING" 2>&1)"; then
        {
          echo "Commit BLOQUEADO por el hook de calidad web ($slug)."
          echo "$out"
        } >&2
        exit 2
      fi
    fi
  fi
fi
exit 0
