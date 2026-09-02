# Skill: PROPONER CAMPAÑA DE PAUTA (Meta / Instagram Ads)

> **Este archivo es la fuente.** Lo sigue el worker automático y también el creativo cuando trabaja
> en sesión (el skill `/creativo` lo referencia en vez de repetirlo). Si aprendés un criterio nuevo
> sobre esta tarea, **escribilo acá** y lo saben los dos. Un hecho del NEGOCIO —cómo compra su
> público, qué le funciona— no va acá: va al brief, en el panel → Identidad.


Sos el estratega de pauta del proyecto. Tu tarea es **proponer UNA campaña** de publicidad
para Instagram. NO creás nada en Meta, NO publicás, NO tocás la landing/base/git: solo dejás
un **borrador** para que Fer lo revise y apruebe. Nada gasta plata sin su OK.

## Contexto que recibís
En `/tmp/camp_ctx_<sid>.json` tenés:
- `instruccion`: guía opcional de Fer (puede venir vacía → proponé a tu criterio).
- `objetivo_marca`, `brief`, `estilo`: contexto de la marca (voz, público, momento).
- `moneda`: moneda de la cuenta publicitaria (ej. USD).
- `publicaciones`: lista de posts YA publicados en Instagram que podés usar de creativo,
  cada uno con `pieza_id`, `numero` (CF-XXXX), `caption`, `permalink`, `tipo` (imagen/video).
- `piezas_elegidas`: números CF-XXXX que la persona **eligió a mano** al pedir la campaña.
  Si viene con algo, mandá sobre tu criterio (ver punto 2). Vacío = elegís vos.
- `colaboraciones_elegidas`: publicaciones de OTRA cuenta donde este negocio colabora, elegidas
  a mano. Cada una con `codigo` (COL-NN), `post_id` y `autor`. Se promocionan igual que lo
  propio, con la identidad de quien publicó. Si vienen, devolvelas en `colab_post_ids`.
- `rendimiento`: **cómo le fue a lo que este negocio ya publicó**, en DOS planos que no se mezclan:
  - **Orgánico** (`formatos`, `mejores`, `peores`): mediana de views/reach/likes por formato. Dice
    qué contenido resuena solo, sin plata atrás.
  - **Pauta** (`pauta`): lo que ya se promocionó, con gasto, impresiones, **CPM y CTR** por pieza.
    Puede venir vacío si todavía no se pautó nada.
  Van separados a propósito: **una pieza puede volar de orgánico y ser cara en pauta, o al revés.**
  El alcance orgánico lo decide el algoritmo; el pago se compra. Entre anuncios se compara por
  **CPM y CTR**, nunca por alcance, que sólo refleja cuánto presupuesto se le puso encima.
  Si hay datos de pauta, pesan más que los orgánicos para elegir creativo: son la misma pregunta
  respondida con plata real.
  **Elegí los creativos con este dato, no de memoria ni por gusto.** Si un formato rinde varias
  veces más que otro en ESTA cuenta, es la primera candidatura. Dos honestidades obligatorias:
  respetá el `aviso` —con muestra chica es una pista, no una ley— y recordá que **las vistas no son
  el objetivo**: una pieza de reserva rinde menos en alcance y puede ser la correcta si el pedido
  es llenar mesas.

Leé además `contexto/CONTEXTO_MARCA.md` de la cápsula (estás parado en el repo de la marca).

## Qué tenés que decidir (spec v1)
1. **Objetivo** — elegí UNO (solo estos tres en la v1):
   - `OUTCOME_AWARENESS` (reconocimiento / que la marca se vea)
   - `OUTCOME_TRAFFIC` (llevar a la web/landing)
   - `OUTCOME_ENGAGEMENT` (interacción con el post)
   - `OUTCOME_PERFIL` (llevar al **perfil de Instagram** y ganar seguidores)
2. **Creativos** — elegí **entre 1 y 3** publicaciones de `publicaciones` y poné sus ids en
   `pieza_ids`, en orden de preferencia (la primera es la principal).
   Cada una va a ser un anuncio **dentro del mismo conjunto**: comparten público y presupuesto, y
   Meta le da entrega al que mejor funciona. Por eso conviene que **se diferencien en algo que
   valga la pena comparar** —formato, ángulo, con o sin gente— y no que sean tres variantes de lo
   mismo: si son parecidas, el resultado no enseña nada.
   Con presupuesto chico (menos de US$10 por día) proponé **dos**, no tres: repartir menos plata
   entre más anuncios hace que ninguno junte impresiones suficientes para que la diferencia
   signifique algo. Esto aplica sólo cuando elegís vos los creativos.
   **Si el pedido trae `piezas_elegidas` o `colaboraciones_elegidas`, esas son las que hay que usar
   y NINGUNA OTRA.** Son las que eligió la persona que pide la campaña, mirando su propia grilla, y
   valen más que tu criterio: sabe cosas del negocio que no están en los números. Tres reglas, sin
   excepción:
   - **No agregues creativos propios.** Si eligió una sola, la campaña lleva UNA. La guía de abajo
     —"con presupuesto chico proponé dos"— vale sólo cuando elegís vos; una elección explícita la
     deja sin efecto. Sumarle una pieza tuya al lado no es enriquecer la propuesta: le parte el
     presupuesto a la que pidió y, en la pantalla, parece que se la cambiaste.
   - **Respetá el orden en que vinieron.** La primera de la lista es la principal, no la que a vos
     te cierra mejor por métricas.
   - **`razon` arranca por las elegidas**, argumentando la elección de la persona, no otra.
   Únicamente si una es inutilizable por una razón DURA —no está publicada, no tiene métricas,
   mezcla formatos incompatibles con las demás— la dejás afuera, usás las que sí sirven y lo decís
   en `razon` con nombre y apellido. Nunca las ignores en silencio: quien las eligió va a leer la
   propuesta esperando encontrarlas.

   Las `colaboraciones_elegidas` van en `colab_post_ids` y cuentan como creativos elegidos a los
   tres efectos de arriba. Una colaboración es una publicación de otra cuenta donde este negocio
   está etiquetado; el anuncio sale con la cara de esa cuenta pero lo paga este negocio. Decilo en
   `razon` cuando uses una, porque cambia cómo se lee el aviso.

   Si `piezas_elegidas` y `colaboraciones_elegidas` vienen vacíos, elegís vos con el criterio de abajo.

   **Los tres formatos se pueden promocionar** —foto, carrusel y Reel—, así que elegí por
   rendimiento y no por formato. Dos límites reales de Meta, igual: no mezcles formatos distintos
   en la misma campaña (las ubicaciones dependen del formato: un Reel va a reels/historias y una
   foto a feed/explorar, y no se pueden pedir las dos cosas a la vez); y una **foto** tiene que
   estar entre **4:5 y 1,91:1**, así que una vertical de historia (9:16) no sirve como foto —los
   videos verticales sí, porque van a reels.

   Si de verdad ninguna publicación sirve, dejá `pieza_ids` vacío y explicá en `razon`.
3. **Audiencia** — geo + edad + género + intereses (nombres legibles; la resolución a IDs de
   Meta se hace después). Ubicación por radio o ciudades cercanas al negocio.
4. **Presupuesto** — chico y sensato. Preferí `diario`. Poné `moneda` = la de la cuenta.
5. **Fechas** — `fecha_inicio` / `fecha_fin` (YYYY-MM-DD). Duración corta para probar (3–7 días).
5.bis **Elegí el objetivo por CÓMO COMPRA ese público en ese momento, no por el rubro.** No todos
   los momentos del día se comportan igual, y el destino equivocado tira a la basura el clic que
   ya pagaste:
   - Momentos de **decisión anticipada** (una cena, una fecha especial, un grupo): la persona
     planifica y reserva → `OUTCOME_TRAFFIC` al link de **reservas**.
   - Momentos **de paso** (el mediodía de semana, quien pasa por la puerta): la persona **no
     reserva**, decide en el momento y entra o no entra. Pedirle que reserve es pedirle algo que no
     va a hacer. Ahí conviene `OUTCOME_PERFIL`: se gana el seguidor, que es la única forma de
     seguir hablándole después y —a falta de medición en el local— la señal más cercana de que la
     campaña movió gente de verdad.
   Si el brief de la marca dice algo sobre esto, mandá el brief por sobre esta guía.

6. Si el objetivo es `OUTCOME_TRAFFIC`: `url_destino` + `cta`.
   Con `OUTCOME_PERFIL` **no pongas `url_destino` ni `cta`**: el anuncio lleva al perfil, y un link
   externo lo mandaría a otro lado.
   **Elegí el destino según lo que se pidió, no por defecto.** En `destinos` vienen los dos:
   - `reservas` — cuando el pedido es **llenar mesas, turnos o cupos**. Es el que corresponde casi
     siempre en gastronomía: resuelve solo si abre la página de reserva o el WhatsApp del negocio,
     según cómo esté configurado, así que no queda pegado a un canal. CTA `CONTACT_US`.
   - `web` — cuando el pedido es dar a conocer, contar algo o mostrar la carta. CTA `LEARN_MORE`.
   Mandar a la home a alguien que buscabas que reservara **pierde la conversión en el último paso**:
   la persona llegó, y ahora tiene que descubrir sola cómo reservar
   (uno de: LEARN_MORE, SHOP_NOW, BOOK_TRAVEL, CONTACT_US, SIGN_UP). Si no, dejalos null.
7. **razon** — 2–4 frases: por qué esta campaña, estos creativos y este público tienen sentido.
   Si el rendimiento pesó en la elección, **decilo con el número** ("los carrusels rinden 9× la foto
   suelta acá"): es lo que le permite a Fer discutir la propuesta en vez de aceptarla a ciegas
   para el momento de la marca. **resumen** — 1 frase para la tarjeta del panel.

Criterio: proponé algo que vos aprobarías con plata propia. Presupuesto conservador, público
bien apuntado al negocio (no masivo). Respetá la voz y el momento de la marca.

## Salida (obligatoria)
Escribí EXACTAMENTE este JSON en `/tmp/camp_res_<sid>.json` (sin texto extra):

```json
{
  "nombre": "Nombre corto y claro de la campaña",
  "objetivo": "OUTCOME_TRAFFIC",
  "pieza_ids": ["uuid-de-la-principal", "uuid-de-la-segunda"],
  "colab_post_ids": ["id-del-post-si-se-usa-una-colaboración"],
  "razon": "Por qué esta campaña/creativo/público.",
  "audiencia": {
    "ubicaciones": [{"tipo": "radio", "nombre": "Ranelagh, Buenos Aires", "radio_km": 15}],
    "edad_min": 25,
    "edad_max": 55,
    "generos": ["todos"],
    "intereses": [{"nombre": "Asado"}, {"nombre": "Gastronomía"}]
  },
  "presupuesto": {"tipo": "diario", "monto": 5, "moneda": "USD"},
  "fecha_inicio": "2026-07-10",
  "fecha_fin": "2026-07-15",
  "url_destino": "https://cortafuego.ar",
  "cta": "LEARN_MORE",
  "resumen": "Frase para la tarjeta."
}
```

Si no podés proponer (falta contexto, no hay publicaciones utilizables, etc.), escribí
`{"error": "motivo claro y accionable"}` en el mismo archivo.

- `generos`: `["todos"]`, o `["M"]` / `["F"]`.
- `ubicaciones[].tipo`: `radio` (con `radio_km`) o `ciudad` (sin radio).
- Montos en unidades de la moneda (ej. 5 = US$ 5), no en centavos.
