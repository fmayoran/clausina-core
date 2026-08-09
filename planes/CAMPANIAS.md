# Campañas — diseño (09/08/2026)

> Estado: **cerrado con Fer el 09/08/2026**. A construir.
>
> Decidido: (1) la campaña de Meta pasa a llamarse `pauta_campania`; (2) la campaña lleva fechas
> y meta numérica; (3) una acción pertenece a una sola campaña; (4) **el total de la campaña son
> todas las reservas del período**, atribuidas u orgánicas, con el desglose a la vista;
> (5) una campaña es de un solo negocio.

Fer: *"Una campaña son un conjunto de acciones que buscan un objetivo final y están compuestas por
distintas acciones de marketing, tanto físico como digital. Cada campaña tiene entidad y nos
gustaría hacer un seguimiento de la efectividad de la misma."*

Caso concreto: **Campaña Lanzamiento** de Cortafuego. Objetivo: que la gente venga a conocer el
local. Acciones medibles por separado que al final permitan decir si la campaña funcionó y, más
adelante, cuánto costó traer a cada cliente.

---

## 1. Lo que ya está construido (y por qué esto no arranca de cero)

Casi todo lo que una campaña necesita medir **ya existe**. Lo que falta es el hilo que lo ate.

| Ya existe | Qué mide hoy | Dónde |
|---|---|---|
| Publicaciones de Instagram | alcance, interacciones, guardados | `piezas` + `ig_metricas` (236 filas) |
| Avisos en pantalla de calle | qué se programó y en qué pantalla | `piezas` (canal=aviso), `programas` |
| Piezas gráficas impresas | la pieza y su PDF de imprenta | `grafica` |
| Invitaciones | emitida → tomada → **consumida** (vino) | `beneficio` → `invitacion` → `invitacion_uso` |
| Reservas | quién, cuándo, cuántos, si se cumplió | `reserva`, `cliente` |
| Pauta paga | gasto, impresiones, clics | `campanias` + `ads_daily` |
| **Links con token** | clic → **y si terminó en reserva** | `accion_link` + `accion_click.reserva_id` |
| Ticket del negocio | mínimo y máximo por persona | `negocio_identidad.ticket_min/max` |

Los dos últimos son los más importantes y los más subestimados: **la atribución ya está resuelta
dos veces**. `accion_click` guarda `reserva_id` cuando el clic terminó reservando, e
`invitacion_uso` ata un código a una reserva y sabe si la persona apareció. Lo que falta no es
cómo medir: es de qué campaña era cada cosa.

---

## 2. El problema de nombre que hay que resolver primero

**`contenido.campanias` ya existe y significa otra cosa**: es una campaña de **Meta Ads**
(`meta_campaign_id`, `meta_adset_id`, `meta_ad_id`, `presupuesto`, `audiencia`, `url_destino`,
`cta`). La usa la sección Pauta. Tiene 2 filas.

Si el concepto nuevo también se llama "campaña", el sistema pasa a tener dos cosas distintas con
el mismo nombre, y en un año nadie va a saber cuál es cuál al leer el código.

**Propuesta: renombrar la existente a `pauta_campania`** y dejar `campania` para el concepto de
Fer. Razones:

- Para una persona, "campaña" es lo grande: el lanzamiento. Lo de Meta es *"la pauta"*, un
  pedazo de esa campaña — de hecho **va a ser una acción adentro** de la campaña nueva.
- El nombre técnico correcto de lo que hoy hay es "campaña de pauta": está atado a Meta en cada
  columna. Renombrarlo lo hace más preciso, no menos.
- Es barato ahora (2 filas, una sección) y carísimo dentro de seis meses.

---

## 3. El modelo

Tres piezas nuevas. Todo lo demás se reutiliza.

### `campania` — el paraguas

```
id, negocio_id, nombre, objetivo (texto),
objetivo_tipo   -- clientes_nuevos | reservas | visitas | alcance
meta_valor      -- el número al que se apunta (ej. 120 clientes nuevos)
desde, hasta    -- la ventana; fuera de ella nada se atribuye
estado          -- borrador | activa | pausada | cerrada
presupuesto     -- lo previsto (numeric); el gasto real se deriva
creado_en, actualizado_en
```

**Por qué objetivo_tipo y meta_valor y no sólo un texto:** sin un número no hay "efectividad",
hay opinión. "Atraer clientes a conocer el local" se vuelve medible cuando dice *120 clientes
nuevos entre el 18/8 y el 30/9*.

### `campania_accion` — cada acción, atada a lo que ya existe

Una acción **no es una entidad nueva**: es una publicación, un aviso, un folleto, una tanda de
invitaciones o una pauta que ya viven en sus propias tablas. La acción es el vínculo con la
campaña, más lo que sólo tiene sentido en el contexto de la campaña (su costo, su rótulo).

```
id, campania_id, tipo, nombre, estado, orden,
-- exactamente UNA de estas, según el tipo:
pieza_id        -> piezas        (instagram | aviso en pantalla)
grafica_id      -> grafica       (impreso)
beneficio_id    -> beneficio     (tanda de invitaciones)
pauta_id        -> pauta_campania(pauta paga)
link_id         -> accion_link   (un link medible suelto)
-- lo que la campaña agrega:
costo_previsto, costo_real, costo_nota,
volumen_declarado   -- ej. 500 folletos repartidos: nadie lo mide, alguien lo carga
```

FKs reales y un CHECK de "exactamente una no nula". La alternativa —una columna `objeto_id` con
`tipo`— parece más elegante y es peor: pierde integridad referencial, y el día que se borra una
pieza la acción queda apuntando al vacío sin que nadie se entere.

**Una acción pertenece a UNA campaña.** Compartirla entre dos hace que la misma reserva se cuente
dos veces y las dos campañas mientan.

### `campania_atribucion` — no hace falta

Deliberadamente **no** se crea. La atribución sale de lo que ya se guarda:

- `accion_link.campania_accion_id` (columna nueva) → cada clic y cada reserva de ese link es de
  esa acción.
- `invitacion.campania_accion_id` (columna nueva) → cada uso de ese código es de esa acción.

Dos columnas contra una tabla nueva. Y el dato queda donde ya vive el hecho.

---

## 4. El embudo común

Cada acción mide cosas incomparables: un folleto no tiene alcance y una publicación no tiene
tirada. Para poder sumarlas hace falta un embudo de cuatro etapas donde **cada tipo llena lo que
puede**:

| Etapa | Instagram | Pantalla | Impreso | Invitaciones | Pauta |
|---|---|---|---|---|---|
| **1. Expuesto** | alcance | exposiciones estimadas | tirada *(declarada)* | emitidas | impresiones |
| **2. Interesado** | interacciones | — | escaneos del QR | — | clics |
| **3. Reservó** | link → reserva | link/QR → reserva | QR → reserva | uso `tomada` | link → reserva |
| **4. Vino** | reserva cumplida | reserva cumplida | reserva cumplida | uso `consumida` | reserva cumplida |

Las dos primeras filas son **incomparables entre canales** y sirven sólo para comparar una acción
con otra del mismo tipo. **Las dos últimas son la moneda común de la campaña**, y son justamente
las que ClaUsina ya sabe medir sin pedirle nada a nadie.

### Medido vs. declarado

Un folleto repartido en la calle no tiene métrica digital. La tirada la carga una persona. Eso
está bien —es el dato real del negocio— pero **tiene que verse distinto**: si "500 expuestos"
declarados se suman sin marca a "3.200 de alcance" medidos, el embudo miente con cara de dato
duro. En la pantalla: los declarados van en gris y con un rótulo.

---

## 5. Atribución: la regla más simple que funciona

**Última acción identificable, dentro de la ventana de la campaña.**

Una reserva se atribuye a una acción si llegó por su link, o si usó un código de sus invitaciones.
Si no tiene ninguna de las dos marcas, es **orgánica**: no se reparte entre las acciones "a ojo",
pero **sí suma al total de la campaña** (decisión de Fer, 09/08).

**Por qué el total incluye lo orgánico.** En un lanzamiento el efecto real no pasa por un clic:
la gente ve el cartel de la ochava, se entera por un vecino y viene. Contar sólo lo medible
escondería la mayor parte de lo que la campaña produjo. Y en el caso de Cortafuego no hay
ambigüedad posible: el local abre el 18/8 y no había negocio antes, así que toda reserva del
período es de la campaña.

**Dónde esto se vuelve engañoso, y qué se hace al respecto.** Sobre un negocio que ya funciona,
"todo lo del período" le regala a la campaña reservas que hubieran existido igual, y el costo por
cliente sale más barato de lo que fue. Por eso el desglose —*"75, de las cuales 45 medidas"*—
**no es decorativo y no se puede esconder**: es lo único que permite leer el número con criterio.
Y cuando un negocio tenga historia, el mismo dato permite mostrar la línea de base (qué pasaba
antes de la campaña) sin cambiar el modelo: ya está todo guardado.

Lo que **no** se hace ahora: atribución multi-toque (repartir una reserva entre la publicación que
la persona vio y el folleto que recibió). Suena mejor y es indefendible: no hay forma de saberlo,
y un número inventado es peor que un hueco honesto.

**Consecuencia de diseño:** para que una acción sea medible tiene que tener **un link propio o un
código propio**. Una publicación de Instagram sin link no puede atribuir nada — a lo sumo mide
alcance. Esto hay que decirlo en la pantalla al crear la acción, no descubrirlo al final.

---

## 6. Costos y costo de adquisición

Fer lo pone a futuro; el lugar se deja hecho ahora porque después es una migración.

| Tipo | Costo |
|---|---|
| Pauta | **real**, de `ads_daily.gasto` |
| Impreso | lo que salió la imprenta *(carga manual)* |
| Invitaciones | **derivable**: por cada uso `consumida`, el valor del beneficio × ticket del negocio |
| Instagram / pantalla | 0 directo (el costo es de producción, si se quiere cargar) |

El costo de las invitaciones es el más interesante y el único que ClaUsina puede calcular sola:
un 20% sobre un ticket de $30.000 son $6.000 por uso consumido. Con `ticket_min`/`ticket_max` ya
cargados sale un rango, no un número falsamente exacto.

**CAC = costo total de la campaña ÷ clientes nuevos del período.** "Cliente nuevo" = cliente cuya
**primera** reserva cayó dentro de la campaña. Ya se puede calcular con lo que hay.

Se muestran los dos: el CAC sobre todos los clientes nuevos —el número que pidió Fer— y el CAC
sobre los atribuidos, que es el techo. La distancia entre ambos dice cuánto de la campaña se está
midiendo de verdad: si son muy distintos, faltan links y códigos en las acciones.

---

## 7. Qué se construye y en qué orden

**F7a — la entidad y el hilo**
1. Renombrar `campanias` → `pauta_campania` (y sus usos en Pauta).
2. Tablas `campania` y `campania_accion`.
3. Columnas `campania_accion_id` en `accion_link` e `invitacion`.
4. Pantalla Campañas: crear, listar, agregar acciones desde lo que ya existe.

**F7b — la medición**
5. Vista de campaña con el embudo por acción y el total.
6. Orgánico vs. atribuido, medido vs. declarado.

**F7c — la plata**
7. Costos por acción, gasto real de pauta, costo estimado de invitaciones, CAC.

Cerrar F7a antes de empezar F7b: sin el hilo, la medición es una pantalla vacía.

---

## 8. Decisiones (cerradas el 09/08/2026)

1. ~~¿Renombramos la campaña de Meta?~~ → **sí**, `pauta_campania`.
2. ~~¿Fechas y meta numérica?~~ → **sí**.
3. ~~¿Una acción en dos campañas?~~ → **no**.
4. ~~¿Qué hacemos con las reservas orgánicas?~~ → **suman al total**, con el desglose siempre
   visible. Nunca se reparten entre acciones.
5. ~~¿Una campaña cruza negocios?~~ → **no**.
