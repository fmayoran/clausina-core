-- Agencia Virtual: registro del proyecto en la base (perfil que consume el creativo). 2026-06-12
-- Secciones estructuradas + brief narrativo. Fuente de verdad del contexto de marca.

BEGIN;

CREATE TABLE IF NOT EXISTS contenido.proyecto_perfil (
  proyecto_id uuid PRIMARY KEY REFERENCES contenido.proyectos(id) ON DELETE CASCADE,
  propuesta_valor       text,
  publico               text,
  tono                  text,
  lineamientos_visuales text,
  hacer                 text,   -- do's
  evitar                text,   -- don'ts
  productos_servicios   text,
  datos_clave           text,
  brief_md              text,   -- narrativa libre / contexto profundo
  actualizado_en        timestamptz DEFAULT now()
);

-- ===== Cortafuego =====
INSERT INTO contenido.proyecto_perfil (proyecto_id, propuesta_valor, publico, tono, lineamientos_visuales, hacer, evitar, productos_servicios, datos_clave, brief_md)
SELECT id,
$pv$No es una parrilla de barrio: un punto de recarga urbano que fusiona el asado criollo con la eficiencia. Funcionalismo radical: toda decisión (diseño, operación, comunicación) está subordinada a la conversión. Tres pilares: Diseño crudo (hormigón, hierro y fuego como protagonistas); Transparencia total (cocina abierta, se ve la leña y la cocción); Servicio ágil (despacho en menos de 10 minutos al mediodía).$pv$,
$pu$1) Tráfico vehicular de Av. Valentín Vergara (20.000-30.000 vehículos/día) — canal #1. 2) Vecinos de Ranelagh y Berazategui. 3) Usuarios de Ardora Sport (flujo nocturno desde las 18 h). 4) Visitantes del Paseo Ardora.$pu$,
$to$Voz directa, contundente, sin adornos. Frases cortas, imperativas, de alto impacto. Voseo rioplatense. SIN emojis. Tildes y ñ correctos. "Av. Valentín Vergara" SIEMPRE completa (nunca "Av. Vergara" suelto). El slogan "Pará. Comé. Seguí." es del mediodía express / público de paso, NO una bajada genérica para toda pieza. Ejemplos de copy: "El show del fuego.", "El fuego te espera.", "El mediodía que te merecés.".$to$,
$lv$Paleta: gris cemento, negro hierro, naranja vibrante (fuego), blanco. Tipografía sans-serif condensed de gran peso visual (legible a 60 km/h). Estética cruda, industrial, nocturna; fuego protagonista; textura real sin filtros suavizantes. Logo: SOLO el archivo oficial (interior-graficas/entregables/Logo.png; transparentes cortafuego_logo_blanco.png para fondos oscuros / cortafuego_logo_negro.png para claros). NUNCA inventar, redibujar ni regenerar el logo con IA.$lv$,
$ha$Fuego como protagonista. Tipografía enorme y contraste máximo (DOOH legible de un vistazo). Mostrar producto real: costra Maillard, grasa del vacío, leña, manos del parrillero. Componer SOLO el logo oficial. Nombrar la avenida completa.$ha$,
$ev$Emojis. Inventar o regenerar el logo. "Av. Vergara" suelto. Usar el slogan como bajada genérica. Filtros que suavicen la textura. Culto a la persona / pintoresquismo.$ev$,
$ps$Modelo híbrido. MEDIODÍA EXPRESS: menú fijo + take away + delivery; vacío o entraña al plato + bebida; despacho <10 min (volumen y rotación del tráfico). NOCHE A LA CARTA: ritual del fuego, cortes premium (vacío y asado al asador, bife de chorizo, provoleta) + vinos y postres (ticket alto). PRODUCTO: proteínas ~60% (vacío del fino, entraña, bife de chorizo, achuras; origen Sur de La Pampa, Frigorífico Pilotti, estándar cuota Hilton, envasado al vacío). Leña: piquillín + chañar (Río Colorado). Bebidas: Quilmes (partner visible en fachada). Cocción: jugoso (recomendación de la casa), a punto, cocido (a pedido).$ps$,
$dc$Ubicación: Paseo Ardora — Av. Valentín Vergara 3200 y Calle 32, Ranelagh, Berazategui, Buenos Aires. Apertura: julio 2026. IG: @cortafuego.ar. La ochava: esquina estratégica con visibilidad en dos frentes. El fogonero exento: faro sensorial en la ochava (calor, llamas, aroma a leña), se enciende 60 min antes de cada apertura. Aliados: @ardora.ar (difusión) y @ardora.sport (público nocturno).$dc$,
$bm$## Contexto físico
Paseo Ardora (complejo comercial/gastronómico en Berazategui). Ardora Sport (fútbol y pádel) contiguo, flujo propio desde las 18 h. Salón ~80 asientos (salón + terraza), terraza con vista a la avenida y a Ardora Sport, pantalla grande para eventos deportivos, zona de fuegos en galería lateral (el parrillero nunca entra al salón), barra lateral de 8 m en madera.

## Figura de marca — El Oso (Adrián Sandoval)
Cofundador y alma del proyecto; aporta el conocimiento de producto y oficio (cortes de La Pampa, leña del norte patagónico, secreto de la cocción). Rol potencial: personaje protagónico del relato de marca, a activar si se decide. Es figura de marca y maestro del fuego, NO el parrillero de línea. Tono al mostrarlo: el saber y el oficio, no el culto a la persona.

## Ecosistema digital y estrategia
@cortafuego.ar canal principal; @ardora.ar y @ardora.sport como aliados. Prioridad de inversión: vía pública (capturar el tráfico vehicular). Redes orgánicas con soporte de cuentas aliadas; sin pauta digital activa aún.$bm$
FROM contenido.proyectos WHERE slug='cortafuego'
ON CONFLICT (proyecto_id) DO NOTHING;

-- ===== Ardora (Distrito) =====
INSERT INTO contenido.proyecto_perfil (proyecto_id, propuesta_valor, publico, tono, lineamientos_visuales, hacer, evitar, productos_servicios, datos_clave, brief_md)
SELECT id,
$pv$DISTRITO ARDORA: marca paraguas / master plan en Ranelagh, Berazategui (Av. Valentín Vergara), con sub-marcas que tienen su propio canal: Paseo de Compras (@ardora.ar), Complejo Deportivo (@ardora.sport) y residencial/oficinas a futuro. La sub-marca conectada hoy, Paseo de Compras, es un destino familiar lifestyle: "todo en un solo lugar" (compras, gastronomía, entretenimiento, familia). Claim: "Una nueva forma de vivir Ranelagh".$pv$,
$pu$Familias y vecinos de Ranelagh/Berazategui; visitantes del paseo; (B2B: locatarios y comercios del paseo).$pu$,
$to$Cálido, cercano, alegre, entusiasta. Voseo rioplatense. USA EMOJIS (a diferencia de Cortafuego, que es sin emojis). Interpela al lector con preguntas ("¿de qué team sos?", "¿ya viniste?") y CTAs de visita ("Vení", "Pasá a descubrir", "Te esperamos"). Habla en primera persona del paseo ("nuestro predio", "tenemos"). Frases recurrentes: "todo en un solo lugar", "para los más peques". "Av. Valentín Vergara" completa.$to$,
$lv$Isotipo: cuatro líneas que convergen al centro en mostaza/dorado, azul marino, verde y rojo sobre blanco. Paleta multicolor + blanco dominante; luminoso, limpio, amable (opuesto al negro/fuego de Cortafuego). Fotografía real de los locales y productos, vertical (~4:5), luz cálida. PENDIENTE: conseguir el archivo oficial del logo y los códigos exactos de paleta/tipografía.$lv$,
$ha$Destacar locales por rubro con foto real; tono cálido y familiar; CTA de visita; usar emojis; mostrar la variedad ("todo en un solo lugar").$ha$,
$ev$La estética negro/fuego de Cortafuego; inventar o regenerar el logo; registro frío o institucional duro.$ev$,
$ps$Motor de contenido = spotlight rotativo de los locales (cada pieza destaca un comercio, lo etiqueta y dice su rubro). Rubros y locales: gastronomía (diciucio, daleopizzeriaitaliana, viacosenza, lodetitibodegon, kiosco.uva 24 h), indumentaria/accesorios (isabella.moda.kids, onlyshinebags, gattasaccesorios, dealerhouse), servicios (thebarber.ardora, avantispadeunas, aquaexpress4d, farmanobel, biloba.neurodesarrollo, centroenuar gym, tattoo&piercing), entretenimiento/familia (cityjump, nazareno.jugueteria, villa_mascot), super (Lusitano), dietética (greenbalancenatural), aromas/hogar (tocciessenza). Reels "recorrido por Ardora" = los de mayor alcance.$ps$,
$dc$DISTRITO ARDORA — Av. Valentín Vergara 3200, Berazategui. IG: @ardora.ar (Paseo de Compras, ~23.100 seguidores) y @ardora.sport (Complejo Deportivo, pendiente de conectar). Web: ardora.ar. Cortafuego es un local del paseo.$dc$,
$bm$## Estructura de marca
DISTRITO ARDORA es el paraguas; las sub-marcas (Paseo @ardora.ar, Sport @ardora.sport, futuras) tienen identidad y canal propios. Objetivo actual: posicionar DISTRITO ARDORA como idea paraguas y trabajar su identidad visual.

## Relación con Cortafuego
Cortafuego es un local del paseo; etiqueta e invita a Collab a @ardora.ar en sus posts. Recíproco a definir.$bm$
FROM contenido.proyectos WHERE slug='ardora'
ON CONFLICT (proyecto_id) DO NOTHING;

COMMIT;
