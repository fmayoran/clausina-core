-- Email del PROYECTO (de la marca): para email marketing u otras acciones de cara al cliente.
-- NO es el mail operativo del sistema: los avisos salen de ClaUsina (AGENCIA_MAIL_* en plataforma.env).
ALTER TABLE contenido.proyectos ADD COLUMN IF NOT EXISTS email text;
