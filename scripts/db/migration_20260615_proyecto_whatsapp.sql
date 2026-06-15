-- WhatsApp del PROYECTO (de la marca): número para interactuar con clientes.
-- Como el email del proyecto, es dato de cara al cliente (no operativo del sistema).
ALTER TABLE contenido.proyectos ADD COLUMN IF NOT EXISTS whatsapp text;
