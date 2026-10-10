-- El informe descargable de una auditoría: un PDF (y su HTML) por PEDIDO, no por canal.
-- Va en auditoria_req y no en contenido.auditorias porque el informe es cruzado —web, Instagram y
-- pauta en un solo documento— y lo que lo identifica es la corrida que lo produjo. Un pedido, un
-- informe; la auditoría anterior conserva el suyo.
ALTER TABLE contenido.auditoria_req
  ADD COLUMN IF NOT EXISTS informe_pdf_url  text,
  ADD COLUMN IF NOT EXISTS informe_html_url text;
