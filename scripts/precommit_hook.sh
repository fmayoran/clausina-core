#!/usr/bin/env bash
# Hook PreToolUse (matcher Bash) para Cortafuego.
# Si el comando es un `git commit` que afecta al repo cortafuego, valida la
# calidad web de la landing. Si falla, bloquea el commit (exit 2) y devuelve el
# motivo a Claude. La detección usa el `cwd` del input (robusto) o el comando.
set -euo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)"
cwd="$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null || true)"

# ¿Es un git commit?
if printf '%s' "$cmd" | grep -Eq '(^|[^[:alnum:]])git([[:space:]]|$)' \
   && printf '%s' "$cmd" | grep -q 'commit'; then
  # ¿Afecta al repo cortafuego? (cwd dentro de cortafuego, o el comando lo menciona)
  if printf '%s' "$cwd" | grep -q '/cortafuego' \
     || printf '%s' "$cmd" | grep -q 'cortafuego'; then
    if ! out="$(python3 /root/claudefolder/plataforma/scripts/validate_web.py 2>&1)"; then
      {
        echo "Commit BLOQUEADO por el hook de calidad web de Cortafuego."
        echo "$out"
      } >&2
      exit 2
    fi
  fi
fi
exit 0
