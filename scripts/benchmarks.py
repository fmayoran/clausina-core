#!/usr/bin/env python3
"""Los benchmarks contra los que la auditoría compara, en UN solo lugar.

Por qué existe: estaban repartidos —un diccionario en auditoria_ig.py, números sueltos dentro del
prompt del creativo, y otros que el modelo ponía de memoria al redactar—. Repetidos se
contradicen, y un benchmark inventado en una recomendación se lee igual de convincente que uno
real. Acá cada valor lleva su `fuente` y su `nota`, y la pantalla los muestra: si no se puede
decir de dónde sale un número, no entra.

Son referencias de orden de magnitud para cuentas chicas de negocio local, NO una medición del
rubro ni una promesa. `evaluar()` devuelve dónde cae un valor medido, y devuelve 'sin_dato'
cuando falta el dato en vez de asumir que está mal: no medir algo no es lo mismo que medirlo mal.
"""

# rango: (piso, techo) del comportamiento típico. `mejor` dice para qué lado conviene desviarse.
BENCHMARKS = {
    # --- Instagram orgánico ---
    'er_alcance': {
        'etiqueta': 'Interacción sobre alcance', 'unidad': '%', 'rango': (1.0, 3.0), 'mejor': 'arriba',
        'fuente': 'referencia pública para cuentas chicas de negocio local',
        'nota': 'Interacciones sobre personas alcanzadas. Es el más honesto de los tres: no depende '
                'de cuántos seguidores haya.'},
    'er_seguidores': {
        'etiqueta': 'Interacción sobre seguidores', 'unidad': '%', 'rango': (1.0, 1.5), 'mejor': 'arriba',
        'fuente': 'referencia pública para cuentas chicas de negocio local',
        'nota': 'Cae naturalmente a medida que la cuenta crece; leerlo solo, sin el de alcance, engaña.'},
    'reach_rate': {
        'etiqueta': 'Alcance sobre seguidores', 'unidad': '%', 'rango': (20.0, 35.0), 'mejor': 'arriba',
        'fuente': 'referencia pública para cuentas chicas de negocio local',
        'nota': 'Arriba de 100% significa que el contenido sale del círculo de seguidores.'},
    'cadencia_semanal': {
        'etiqueta': 'Publicaciones por semana', 'unidad': '', 'rango': (3.0, 5.0), 'mejor': 'dentro',
        'fuente': 'recomendación de Instagram para cuentas de negocio',
        'nota': 'Acá más no es mejor: publicar de más compite consigo mismo por el mismo alcance.'},
    'crecimiento_mensual': {
        'etiqueta': 'Crecimiento de seguidores', 'unidad': '%/mes', 'rango': (2.0, 5.0), 'mejor': 'arriba',
        'fuente': 'referencia pública para cuentas locales en crecimiento',
        'nota': 'Sobre la base de seguidores del inicio del período.'},

    # --- Pauta en Meta ---
    # Los de plata son los más traicioneros: el CPM argentino es un orden de magnitud más barato
    # que el de los reportes internacionales, así que compararlo contra esos números da una
    # euforia falsa. El rango de acá es local y está declarado como tal.
    'ctr_link': {
        'etiqueta': 'CTR de link', 'unidad': '%', 'rango': (0.9, 1.7), 'mejor': 'arriba',
        'fuente': 'promedio Meta multi-industria (~0,9%) y gastronomía en la banda alta (~1,2-1,7%)',
        'nota': 'El comparable es el CTR DE LINK, no el total: el total cuenta cualquier clic '
                '—abrir el post, ver más— y da entre 1,5x y 2x más alto.'},
    'frecuencia': {
        'etiqueta': 'Frecuencia', 'unidad': '', 'rango': (1.0, 3.0), 'mejor': 'dentro',
        'fuente': 'práctica habitual de gestión de campañas',
        'nota': 'Veces que la misma persona vio el aviso. Arriba de 3 en público chico, el CTR cae '
                'por saturación y conviene rotar creativo.'},
    'cpm_ars': {
        'etiqueta': 'CPM', 'unidad': 'USD', 'rango': (0.5, 3.0), 'mejor': 'abajo',
        'fuente': 'observado en esta cuenta, mercado local — NO comparable con reportes internacionales',
        'nota': 'Referencia propia, no de industria: sirve para detectar un salto de costo, no para '
                'decir si es caro en abstracto.'},
}

ESTADOS = ('sin_dato', 'debajo', 'dentro', 'encima')


def evaluar(clave, valor):
    """Dónde cae un valor medido. Devuelve (estado, texto). Estado en ESTADOS.

    'debajo'/'encima' son descriptivos, no un juicio: si algo está encima del rango es bueno o
    malo según `mejor`. La lectura la arma `veredicto()`, que es lo que se muestra.
    """
    b = BENCHMARKS.get(clave)
    if not b:
        return ('sin_dato', 'sin benchmark definido')
    if valor is None:
        return ('sin_dato', 'sin dato medido')
    lo, hi = b['rango']
    if valor < lo:
        return ('debajo', f"{valor}{b['unidad']} — por debajo de {lo}-{hi}{b['unidad']}")
    if valor > hi:
        return ('encima', f"{valor}{b['unidad']} — por encima de {lo}-{hi}{b['unidad']}")
    return ('dentro', f"{valor}{b['unidad']} — dentro de {lo}-{hi}{b['unidad']}")


def veredicto(clave, valor):
    """bien | atencion | mal | sin_dato, según hacia dónde conviene desviarse."""
    estado, _ = evaluar(clave, valor)
    if estado == 'sin_dato':
        return 'sin_dato'
    mejor = BENCHMARKS[clave]['mejor']
    if estado == 'dentro':
        return 'bien'
    if mejor == 'dentro':
        return 'atencion'
    if mejor == 'arriba':
        return 'bien' if estado == 'encima' else 'mal'
    return 'bien' if estado == 'debajo' else 'mal'   # mejor == 'abajo'


def ficha(clave, valor):
    """Todo lo que la pantalla necesita para una métrica, benchmark y fuente incluidos."""
    b = BENCHMARKS.get(clave) or {}
    estado, texto = evaluar(clave, valor)
    lo, hi = b.get('rango', (None, None))
    return {'clave': clave, 'etiqueta': b.get('etiqueta', clave), 'valor': valor,
            'unidad': b.get('unidad', ''), 'rango': [lo, hi], 'mejor': b.get('mejor'),
            'estado': estado, 'veredicto': veredicto(clave, valor), 'texto': texto,
            'fuente': b.get('fuente'), 'nota': b.get('nota')}
