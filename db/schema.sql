-- Transacciones del POS Autoservicio IM30 (Transbank)
-- Una fila por operación enviada al POS (venta, anulación, cierre).
-- La fila se crea en estado 'pendiente' ANTES de enviar el comando, así una caída a mitad
-- de una venta queda registrada y se puede conciliar con "última venta" (0250).

CREATE TABLE IF NOT EXISTS transacciones (
  id                 BIGSERIAL PRIMARY KEY,
  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  tipo               TEXT        NOT NULL CHECK (tipo IN ('venta', 'anulacion', 'cierre')),
  origen             TEXT        NOT NULL DEFAULT 'caja' CHECK (origen IN ('caja', 'pos_0911', 'importado')),
  estado             TEXT        NOT NULL DEFAULT 'pendiente'
                                 CHECK (estado IN ('pendiente', 'aprobada', 'rechazada', 'error')),
  monto              INTEGER     CHECK (monto IS NULL OR monto > 0),
  ticket             VARCHAR(20),
  comando            TEXT,                -- trama enviada, ej. 0200|000001500|ANGEL|0|1

  -- Respuesta del POS (0210 / 1210 / 0510)
  response_code      SMALLINT,
  response_message   TEXT,
  authorization_code VARCHAR(6),
  operation_number   VARCHAR(6),          -- necesario para anular (1200)
  last4              VARCHAR(4),
  card_type          VARCHAR(2),          -- CR / DB
  card_brand         VARCHAR(2),          -- VI, MC, ...
  commerce_code      VARCHAR(12),
  terminal_id        VARCHAR(8),
  accounting_date    VARCHAR(6),
  pos_fecha_hora     TIMESTAMP,           -- fecha y hora informadas por el POS
  voucher            TEXT,
  respuesta_raw      TEXT,
  error              TEXT,                -- error de comunicación (sin ACK, timeout, etc.)

  anula_a            BIGINT REFERENCES transacciones(id)  -- para anulaciones: venta anulada
);

-- Descripción libre enviada por el backend (no viaja al POS; el POS solo recibe monto y ticket)
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS descripcion TEXT;
-- Referencia externa del sistema que pidió el pago (idempotencia: no cobrar dos veces el mismo pedido)
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS referencia TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS transacciones_referencia_uq
  ON transacciones (referencia) WHERE referencia IS NOT NULL AND estado IN ('pendiente', 'aprobada');

-- Tipo 'carga_llaves': carga de llaves (0800) al conectar o a pedido
ALTER TABLE transacciones DROP CONSTRAINT IF EXISTS transacciones_tipo_check;
ALTER TABLE transacciones ADD CONSTRAINT transacciones_tipo_check
  CHECK (tipo IN ('venta', 'anulacion', 'cierre', 'carga_llaves'));

-- RUT del beneficiario enviado por hcfach_ws (endpoint compatible /tbk/pos/pago/simple)
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS rut_beneficiario TEXT;
-- Origen 'hcfach': pagos pedidos por hcfach_ws a través de los endpoints /tbk/pos
ALTER TABLE transacciones DROP CONSTRAINT IF EXISTS transacciones_origen_check;
ALTER TABLE transacciones ADD CONSTRAINT transacciones_origen_check
  CHECK (origen IN ('caja', 'pos_0911', 'importado', 'hcfach'));

-- Marca de la tarjeta en texto legible: Visa, Mastercard, American Express, Diners Club, Magna, Redcompra, Otra...
-- (card_brand guarda la abreviación tal como la envía el POS: VI, MC, AX, DC, MG, DB)
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS marca_tarjeta TEXT;
CREATE INDEX IF NOT EXISTS transacciones_marca_idx ON transacciones (marca_tarjeta);

-- Cuotas de la venta: con_cuotas = false para débito y crédito sin cuotas;
-- numero_cuotas / monto_cuota / tipo_cuota solo cuando hay cuotas (ej. 6, 4336, 'CUOTAS SIN INTERES')
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS con_cuotas BOOLEAN;
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS numero_cuotas SMALLINT;
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS monto_cuota INTEGER;
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS tipo_cuota TEXT;

-- Ruta del PDF del voucher generado (y enviado a la impresora) tras una venta aprobada
ALTER TABLE transacciones ADD COLUMN IF NOT EXISTS voucher_pdf TEXT;

CREATE INDEX IF NOT EXISTS transacciones_creado_en_idx ON transacciones (creado_en DESC);
CREATE INDEX IF NOT EXISTS transacciones_ticket_idx    ON transacciones (ticket);
CREATE INDEX IF NOT EXISTS transacciones_operacion_idx ON transacciones (operation_number);
CREATE INDEX IF NOT EXISTS transacciones_estado_idx    ON transacciones (estado);

-- Mensajes intermedios (0900) recibidos durante la operación: 78 leer tarjeta, 84 opere tarjeta, etc.
CREATE TABLE IF NOT EXISTS transaccion_eventos (
  id             BIGSERIAL PRIMARY KEY,
  transaccion_id BIGINT      NOT NULL REFERENCES transacciones(id) ON DELETE CASCADE,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  codigo         SMALLINT    NOT NULL,
  mensaje        TEXT
);

CREATE INDEX IF NOT EXISTS transaccion_eventos_tx_idx ON transaccion_eventos (transaccion_id);

-- Vista con las mismas columnas que la tabla MySQL tbk_transacciones de transbank_ws:
-- ventas aprobadas con voucher, para reportes y conciliación. Los datos viven en "transacciones".
CREATE OR REPLACE VIEW tbk_transacciones AS
SELECT
  id,
  ticket,
  monto::text                      AS amount,
  authorization_code,
  last4                            AS card_number,
  pos_fecha_hora::date             AS real_date,
  pos_fecha_hora::time             AS real_time,
  terminal_id,
  voucher                          AS voucher_text,
  rut_beneficiario                 AS rut,
  operation_number,
  card_type,
  card_brand,
  origen,
  voucher_pdf,
  creado_en,
  marca_tarjeta,
  con_cuotas,
  numero_cuotas,
  monto_cuota,
  tipo_cuota
FROM transacciones
WHERE tipo = 'venta' AND estado = 'aprobada';
