-- ClaUsina — el encuadre de la foto se ajusta sin director de arte.
--
-- "Ensanchá la imagen para que ocupe todo el ancho" es UNA propiedad de CSS: background-size.
-- Pedírselo a un modelo que reescribe 350 líneas de HTML cuesta minutos, gasta cupo de sesión y
-- puede no acertar — en G-0003 hicieron falta ocho versiones para mover una foto, y las dos
-- últimas murieron sin cupo.
--
-- Con 'ajuste' cargado, el job saltea al director de arte: copia el diseño anterior, le aplica el
-- encuadre pedido y renderiza. Segundos en vez de minutos, y sin gastar modelo.
BEGIN;
ALTER TABLE contenido.grafica_version ADD COLUMN IF NOT EXISTS ajuste jsonb;
COMMENT ON COLUMN contenido.grafica_version.ajuste IS
  'Encuadre de la foto {cara,size,pos_x,pos_y,zoom}. Si está, no interviene el director de arte.';
COMMIT;
