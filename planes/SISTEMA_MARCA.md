# Sistema de marca — ClaUsina

> Lineamiento de la identidad de ClaUsina en el cruce **Comunicación × Tecnología**.
> Fuente de verdad escrita; el styleguide vivo (renderizado) está en el panel: **panel.clausina.ar/estilo**.
> Aplica a la marca ClaUsina (@clausina.ar, clausina.ar) y a la piel del panel/motor. Las otras marcas conservan su propia identidad en sus cápsulas.

Estado: **v1 aplicado al panel** (2026-06-29). Sistema definido (logo "U en órbita" + favicon B, color lima/coral, Inter Tight/JetBrains Mono, componentes, estados, voz) y bajado a TODO el panel: shell reutilizable (`shell.js`), Tailwind compilado (`tw.css`), dual dark/light en dashboard/máquinas/arquitectura y dark en las páginas de contenido. Pendiente: clausina.ar (web pública) y refinamientos.

---

## 1. Principios

- **Sobrio pero vibrante.** Base neutra que respira; el color entra como acento, nunca como ruido.
- **Minimalista y moderno.** Menos elementos, mejor ejecutados. La jerarquía la hacen el peso tipográfico y el espacio, no el color.
- **Dual real.** Funciona en dark y sobre blanco; ningún recurso depende de un solo fondo.
- **Ingeniería con calidez.** Precisión técnica, datos claros, sin jerga vacía ni frialdad corporativa.
- **Soporte, no protagonista.** ClaUsina potencia a cada marca; no le roba el centro de la escena.
- **Sin sesgos default.** Cada decisión es para ESTE proyecto. Evitar los clichés de UI auto-generada.

---

## 2. Logo

Símbolo y logotipo se usan **por separado o juntos**, según contexto. No se usa siempre el lockup.

### Las tres formas
- **Símbolo — la U en órbita.** Monograma de la U con un punto de señal que la recorre de forma continua (sin huecos). La U queda siempre sólida; el punto orbita.
  Usos: favicon, app icon, avatar de redes, loader, marca de agua, sellos. Cuando la marca ya se reconoce.
- **Logotipo — la palabra sola.** `ClaUsina.` como **texto puro** (Inter Tight bold), con el punto final en lima. Kerning perfecto: la palabra NO lleva SVG embebido.
  Usos: headers densos, cuerpo, footers, menciones inline, contextos formales.
- **Lockup — símbolo + palabra.** El símbolo a la izquierda + el logotipo. Para hero, portadas, presentaciones; idealmente **en movimiento**.

### Reglas
- **Estático plano:** sin movimiento NO se usa el lockup apagado → usar **palabra sola** o **símbolo solo**. El lockup vive en contextos con animación.
- El punto del logotipo es **lima**, nunca coral.
- La animación de la U es **órbita** (punto recorriendo el trazo). **Prohibido** el movimiento por *dashes* (genera huecos). Respetar `prefers-reduced-motion`: en reposo, la U sólida con el punto en una posición fija.

### Favicon
**B — U oscura (#0A0B0D) sobre tile lima (#CCF24D)**, esquinas redondeadas, trazo grueso (~4.4). Elegido por su lectura a 16–32px.

---

## 3. Color

Base neutra + **lima** (marca/acción) + **coral** (exclusivo de lo vivo/alerta). **Sin lila/púrpura. Sin degradés protagonistas.**

### Tokens — dark
| token | hex | uso |
|---|---|---|
| `ink` | `#0A0B0D` | fondo |
| `surface` | `#111317` | tarjetas |
| `line` | `#20242B` | bordes |
| `muted` | `#8A8F98` | texto secundario |
| `fg` | `#ECEEF0` | texto principal |

### Tokens — light
| token | hex | uso |
|---|---|---|
| `paper` | `#FAFAF9` | fondo |
| `white` | `#FFFFFF` | tarjetas |
| `pline` | `#E8E8E2` | bordes |
| `pmuted` | `#646A72` | texto secundario |
| `pfg` | `#0A0B0D` | texto principal |

### Acentos (ambos modos)
| token | hex | uso |
|---|---|---|
| `acc` (lima) | `#CCF24D` | acción, marca, foco. Texto sobre lima: `#0A0B0D`. |
| `cor` (coral) | `#FF6A45` | **solo** lo vivo / alerta / lo que pide intervención. |

> Acento como texto: en light, el lima baja a `#5E7E00` (legibilidad); el coral, a `#DC451F`.

---

## 4. Tipografía

- **Display — Inter Tight** (700/800), tracking ajustado (`-0.03em`), interlineado corto en titulares. Técnica, compacta, moderna.
- **Cuerpo — Inter** (400/450/500). Legible, neutro; no compite con el titular.
- **Datos/UI — JetBrains Mono** (400/500). Etiquetas, métricas, IDs, estados.

Jerarquía por **peso y espacio**, no por color.

---

## 5. Layout

- Pantallas **partidas asimétricas** o contenido **alineado a la izquierda**.
- **Retículas bento asimétricas** (inspiración Apple): spans distintos, aire generoso.
- `min-h-[100dvh]` — nunca `h-screen` (evita parpadeo en móviles).
- Política de estilo **tipo Tailwind** (utilidades; tokens arriba como theme).

---

## 6. Iconografía

- Íconos de línea de **Lucide** o **Phosphor** (una sola familia, coherente). **Nunca emojis.**
- Tamaño y peso combinados con el estilo (line icons finos, alineados a la tipografía).

---

## 7. Motion

- **Movimiento perpetuo sutil** (en producción: **Framer Motion**): pulso vivo, símbolo en órbita, flotación leve, barridos suaves.
- **Sin huecos**: nada de dashes que cortan. Preferir relleno, órbita, glow, sweep.
- El movimiento **sirve a la información** (señal viva, flujo de datos), no decora.
- Respetar SIEMPRE `prefers-reduced-motion`.

---

## 8. Componentes

- **Botón primario:** fondo lima, texto ink. Acción principal.
- **Botón secundario:** borde + texto neutro, hover a lima.
- **Botón alerta:** borde/texto coral (solo cuando corresponde a lo vivo).
- **Chips:** pill con borde fino; "en vivo" lleva punto coral pulsante; "aprobado" en lima tenue.
- **Tarjetas:** `surface`/`white`, borde `line`/`pline`, radios generosos (rounded-2xl), ícono en recuadro.

---

## 9. Estados

- **Carga:** **skeleton shimmer** (no spinners). Bloques que imitan el contenido final.
- **Vacío:** **vacío elegante** — ícono, una línea, y una invitación a actuar (no un mensaje muerto).
- **Vivo / requiere intervención:** acento **coral** + punto pulsante. Es el único lugar donde aparece el coral.

---

## 10. Voz

- **Directo:** verbo activo, sin vueltas. "Aprobá", no "Proceder con la aprobación".
- **Técnico, no frío:** precisión con calidez; datos claros, cero jerga vacía.
- **Soporte, no protagonista:** ClaUsina habla para potenciar a la marca, no para lucirse.
- Reglas heredadas: español, sin emojis, tildes/ñ correctas.

---

## Pendientes
- [x] Bajar el sistema al panel (HECHO 2026-06-29: todas las páginas migradas; shell.js + tw.css compilado).
- [ ] Logo definitivo como assets exportables (SVG símbolo animado + estático, favicon, lockup).
- [ ] Self-hostear fuentes (Inter Tight/Inter/JetBrains Mono) e íconos (Lucide) para no depender de Google Fonts/unpkg.
- [ ] Aplicar el sistema a clausina.ar (web pública).
- [ ] Páginas de contenido en dual dark/light (hoy dark-only) + cablear el switcher en el flujo de marca completo.
- [ ] Skill de sistema de diseño (agnóstico, ClaUsina piloto) que cargue este manual + reglas y aplique con checklist.
