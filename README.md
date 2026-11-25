# Backend de pagos IM30

Backend en Node.js (Express + PostgreSQL) para cobrar con el **POS Autoservicio Transbank IM30** conectado por serial RS232 (cable RJ45 + adaptador USB-serie). Registra cada operación en Postgres, genera el voucher en PDF y avisa a la caja en vivo cada cambio de un pago.

## Requisitos

- Node.js 22 o superior
- PostgreSQL 16 (local o remoto)
- POS IM30 conectado por serial a 19200 bps (por defecto)

## Instalación

```bash
npm install
cp .env.example .env      # completar DATABASE_URL con la clave de Postgres
npm run seed              # crea la base "im30" y sus tablas si no existen
npm start                 # levanta el backend en http://127.0.0.1:3000
```

## Comandos

### Backend

| Comando | Qué hace |
|---|---|
| `npm start` / `node server.js` | Levanta el backend. Al arrancar: crea o actualiza la base, se conecta al POS (poll + carga de llaves) y verifica los pagos pendientes |
| `npm run seed` / `node db setup` | Crea la base y la estructura si no existen. Se puede repetir sin perder datos |

### Base de datos

| Comando | Qué hace |
|---|---|
| `node db list [n]` | Últimas `n` transacciones (por defecto 20) |
| `node db show <id>` | Detalle de una transacción con sus mensajes del POS |

### POS desde la terminal (`pos-serial.js`)

Abre el puerto directamente: **detén el backend antes** de usarlo, porque el puerto COM no se puede compartir.

| Comando | Qué hace |
|---|---|
| `node pos-serial.js ports` | Lista los puertos serie del PC |
| `node pos-serial.js poll` | Verifica la comunicación con el POS (0100) |
| `node pos-serial.js keys` | Carga de llaves (0800) |
| `node pos-serial.js sale <monto> [ticket]` | Venta (0200) |
| `node pos-serial.js last` | Última venta (0250) |
| `node pos-serial.js refund <operacion>` | Anulación (1200) |
| `node pos-serial.js close` | Cierre del día (0500) |
| `node pos-serial.js init` | Inicialización (0070 + 0080) |
| `node pos-serial.js raw "<comando>"` | Envía un comando tal cual, ej. `"0250\|0"` |

Con `POS_DEBUG=1` muestra los bytes enviados y recibidos.

### Cliente de ejemplo (`cliente.js`)

Simula una caja: crea el pago y lo sigue en vivo (con el backend corriendo).

```bash
node cliente.js 1500                              # cobra $1.500
node cliente.js 1500 ANGEL "Pago de prueba" PED-1 # monto, ticket, descripción, referencia
node cliente.js --watch 52                        # solo sigue un pago ya creado
```

## API

Base: `http://127.0.0.1:3000`. Si `API_KEY` está definida, enviar el header `x-api-key`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del POS (puerto, llaves) y de la base |
| POST | `/pagos` | Crea un cobro: `{"monto": 1500, "ticket": "ABC", "descripcion": "...", "referencia": "PED-1"}`. Responde `202` con el `id`. Con `"esperar": true` responde al terminar |
| GET | `/pagos/:id` | Detalle del pago, con voucher y mensajes del POS |
| GET | `/pagos/:id/watch` | Sigue el pago en vivo (Server-Sent Events): `estado` en cada cambio y `fin` al terminar |
| GET | `/pagos` | Lista pagos. Filtros: `limite`, `estado`, `desde`, `hasta` (AAAA-MM-DD) |
| GET | `/pagos/:id/voucher` | PDF del voucher de una venta aprobada |
| POST | `/pagos/:id/voucher/imprimir` | Imprime el voucher |
| POST | `/pagos/:id/anular` | Anula una venta aprobada |
| POST | `/pos/llaves` | Carga de llaves a pedido |
| POST | `/pos/cierre` | Cierre del día |
| GET | `/pos/ultima-venta` | Última venta guardada en el POS |
| GET | `/eventos` | Todos los cambios de transacciones en vivo (SSE) |
| GET | `/transacciones` | Vista web de transacciones con filtros y actualización en vivo |

Las colecciones de Postman están en `IM30-Backend-Pagos.postman_collection.json` y `IM30-Local.postman_environment.json`.

## Configuración (`.env`)

| Variable | Por defecto | Descripción |
|---|---|---|
| `DATABASE_URL` | — | `postgres://usuario:clave@localhost:5432/im30` (obligatoria) |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Dirección del backend |
| `API_KEY` | vacía | Si se define, la API exige el header `x-api-key` |
| `POS_PORT` | `auto` | Puerto COM (ej. `COM16`) o `auto`: busca el adaptador USB-serie donde responde el POS |
| `POS_BAUD` | `19200` | Velocidad del serial |
| `POS_VOUCHER` | `0` | `1` = el POS devuelve el voucher para guardarlo y generar el PDF |
| `POS_RESP_TIMEOUT` | `75000` | Máximo (ms) para esperar la respuesta de una venta |
| `POS_RECONEXION_MS` | `10000` | Tras un corte del puerto, cada cuánto reintentar la conexión |
| `POS_LLAVES_AL_CONECTAR` | `1` | Carga de llaves al conectar con el POS |
| `POS_LLAVES_TIMEOUT` | `70000` | Máximo (ms) para la carga de llaves |
| `VOUCHER_IMPRIMIR` | `0` | `1` = imprime el voucher tras cada venta aprobada |
| `VOUCHER_IMPRESORA` | predeterminada | Nombre exacto de la impresora en Windows |
| `VOUCHER_DIR` | `vouchers` | Carpeta de los PDF |
| `CIERRE_DIARIO` | vacío | Hora `HH:MM` del cierre automático (el manual pide cierre diario o mínimo semanal) |

## Problemas frecuentes

| Mensaje | Causa y solución |
|---|---|
| `EADDRINUSE ... 127.0.0.1:3000` | Ya hay otro backend corriendo en el puerto 3000: detenerlo o cambiar `PORT` |
| `Opening COM16: Access denied` | Otro programa tiene abierto el puerto COM (otro backend, `pos-serial.js` o un servicio): cerrarlo |
| `No hay un adaptador USB-serie conectado` | Revisar el cable USB del adaptador |
| `Carga de llaves: FALLÓ ... Sin respuesta 0810` | El POS no logra comunicarse con Transbank: revisar su red (WiFi/LAN) |
| Pago `pendiente` con error "se verificará con la última venta" | Se cortó la conexión a mitad del cobro: el backend lo verifica solo al reconectar el POS |
