// Protocolo del POS Autoservicio IM30 (Transbank / PAX) sobre puerto serial RS232.
// Referencia: ManualIntegracion-IM30-v5.pdf (Transbank Developers).
// Trama: <STX>DATA<ETX><LRC>, ACK 0x06 / NAK 0x15. Serial 19200 8N1 por defecto.

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

const STX = 0x02;
const ETX = 0x03;
const ACK = 0x06;
const NAK = 0x15;

const RESPUESTAS = {
  0: 'Aprobado', 1: 'Rechazado', 2: 'Host no Responde', 3: 'Conexión Falló',
  4: 'Transacción ya fue Anulada', 5: 'No existe Transacción para Anular', 6: 'Tarjeta no Soportada',
  7: 'Transacción Cancelada desde el POS', 8: 'No puede Anular Transacción Débito', 9: 'Error Lectura Tarjeta',
  10: 'Monto menor al mínimo permitido', 11: 'No existe venta', 12: 'Transacción No Soportada',
  13: 'Debe ejecutar cierre', 14: 'No hay Tono', 15: 'Archivo BITMAP.DAT no encontrado',
  16: 'Error Formato Respuesta del HOST', 17: 'Error en los 4 últimos dígitos', 18: 'Menú inválido',
  19: 'ERROR_TARJ_DIST', 20: 'Tarjeta Inválida', 21: 'Anulación no Permitida', 22: 'TIMEOUT',
  24: 'Impresora Sin Papel', 25: 'Fecha Inválida', 26: 'Debe Cargar Llaves', 27: 'Debe Actualizar',
  60: 'Error en Número de Cuotas', 61: 'Error en Armado de Solicitud', 62: 'Problema con el Pinpad interno',
  65: 'Error al Procesar la Respuesta del Host', 67: 'Superó Número Máximo de Ventas, Debe Ejecutar Cierre',
  68: 'Error Genérico, Falla al Ingresar Montos', 70: 'Error de formato Campo de Boleta',
  71: 'Error de Largo Campo de Impresión', 72: 'Error de Monto Venta, Debe ser Mayor que 0',
  73: 'Terminal ID no configurado', 74: 'Debe Ejecutar CIERRE', 75: 'Comercio no tiene Tarjetas Configuradas',
  76: 'Superó Número Máximo de Ventas, Debe Ejecutar CIERRE', 77: 'Debe Ejecutar Cierre',
  78: 'Esperando Leer Tarjeta', 79: 'Solicitando Confirmar Monto', 80: 'Selección de Cuotas',
  81: 'Solicitando Ingreso de Clave', 82: 'Enviando transacción al Host', 83: 'Selección menú crédito/redcompra',
  84: 'Opere tarjeta', 85: 'Selección de cuotas', 86: 'Ingreso de cuotas', 87: 'Confirmación de cuotas',
  88: 'Error Cantidad Cuotas', 93: 'Declinada', 94: 'Error al Procesar Respuesta', 95: 'Error al Imprimir TASA',
};
const mensaje = (code) => RESPUESTAS[code] || `Código ${code}`;

// Respuesta esperada para cada comando (los que no están aquí solo esperan ACK)
const RESPUESTA_DE = { '0200': '0210', '0250': '0260', '0500': '0510', '0800': '0810', '1200': '1210', '0080': '0090' };

// VID de adaptadores USB-serie: 1A86 CH340 (WCH), 0403 FTDI, 067B Prolific, 10C4 Silicon Labs CP210x
const VID_ADAPTADORES = ['1A86', '0403', '067B', '10C4'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xor = (buf) => buf.reduce((l, b) => l ^ b, 0);
const visible = (buf) => [...buf].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : `{0x${b.toString(16).padStart(2, '0')}}`)).join('');

class PosSerial extends EventEmitter {
  constructor({ debug = false, ackTimeout = 3000, responseTimeout = 75000 } = {}) {
    super();
    this.debugOn = debug;
    this.ackTimeout = ackTimeout;
    this.responseTimeout = responseTimeout;
    this.port = null;
    this.buf = Buffer.alloc(0);
    this.esperaAck = null;       // { resolve, reject }
    this.esperaRespuesta = null; // { codigo, resolve, onIntermedio }
    this.cola = Promise.resolve();
  }

  log(...a) { if (this.debugOn) console.log(...a); }

  static listar() { return SerialPort.list(); }

  // Adaptadores USB-serie conectados (CH340, FTDI, Prolific, Silicon Labs), con "preferido" primero
  static async adaptadores(preferido) {
    const todos = await SerialPort.list();
    const usb = todos.filter((p) => VID_ADAPTADORES.includes(String(p.vendorId || '').toUpperCase()));
    usb.sort((a, b) => (b.path === preferido) - (a.path === preferido));
    return { usb, todos };
  }

  // POS_PORT=auto: Windows cambia el número COM si el adaptador se conecta en otro puerto USB.
  // Prueba cada adaptador USB-serie (el último usado primero) y se queda con el que responde al poll.
  // Devuelve el puerto encontrado (ej. "COM16").
  async abrirAuto(baudRate = 19200, preferido) {
    const { usb, todos } = await PosSerial.adaptadores(preferido);
    if (!usb.length) {
      throw new Error(`No hay un adaptador USB-serie conectado (puertos: ${todos.map((p) => p.path).join(', ') || 'ninguno'})`);
    }
    const fallas = [];
    for (const { path } of usb) {
      try {
        await this.abrir(path, baudRate);
        await this.poll();
        return path;
      } catch (e) {
        fallas.push(`${path}: ${e.message}`);
        await this.cerrar().catch(() => {});
      }
    }
    throw new Error(`El POS no respondió en ningún adaptador (${fallas.join('; ')})`);
  }

  // Abre el puerto indicado o, con "auto", lo detecta. Devuelve el puerto abierto.
  async conectarA(puerto, baudRate, preferido) {
    if (String(puerto || 'auto').toLowerCase() === 'auto') return this.abrirAuto(baudRate, preferido);
    await this.abrir(puerto, baudRate);
    return puerto;
  }

  // Abre a 9600 y luego cambia a la velocidad pedida: los adaptadores CH340 con driver WCH 3.9
  // fallan (error 31) si se abren directo a 19200/115200. Si eso falla, intenta la apertura directa.
  async abrir(path, baudRate = 19200) {
    const abrirCon = (baud) => new Promise((resolve, reject) => {
      const p = new SerialPort({ path, baudRate: baud, autoOpen: false });
      p.open((e) => (e ? reject(e) : resolve(p)));
    });
    let port;
    try {
      port = await abrirCon(9600);
      if (baudRate !== 9600) await new Promise((res, rej) => port.update({ baudRate }, (e) => (e ? rej(e) : res())));
    } catch (e) {
      if (port?.isOpen) await new Promise((r) => port.close(() => r()));
      port = await abrirCon(baudRate);
    }
    // RTS/DTR activos (el IM30 usa control de flujo por hardware en RS232)
    await new Promise((r) => port.set({ rts: true, dtr: true }, () => r()));
    this.buf = Buffer.alloc(0); // descartar restos de otro puerto
    port.on('data', (d) => this.alRecibir(d));
    port.on('error', (e) => this.emit('error', e));
    port.on('close', () => this.alCerrar(port));
    this.port = port;
    this.path = path;
    this.log(`Puerto ${path} abierto @${baudRate}`);
  }

  cerrar() {
    if (!this.port?.isOpen) return Promise.resolve();
    this.port.cerradoAProposito = true;
    return new Promise((r) => this.port.close(() => r()));
  }

  // El puerto se cerró (cable USB desconectado, adaptador retirado, POS reiniciado por USB...):
  // la operación en curso falla al instante en vez de esperar el límite de tiempo.
  alCerrar(port) {
    if (port !== this.port) return;
    const e = new Error(`Puerto ${this.path} desconectado`);
    e.desconectado = true;
    const ack = this.esperaAck;
    const resp = this.esperaRespuesta;
    this.esperaAck = null;
    this.esperaRespuesta = null;
    ack?.reject(e);
    resp?.reject(e);
    if (!port.cerradoAProposito) this.emit('desconectado', e);
  }

  trama(texto) {
    const data = Buffer.from(`${texto}\x03`, 'latin1');
    return Buffer.concat([Buffer.from([STX]), data, Buffer.from([xor(data)])]);
  }

  escribir(buf) {
    this.log(`OUT --> ${visible(buf)}`);
    return new Promise((res, rej) => this.port.write(buf, (e) => (e ? rej(e) : this.port.drain(res))));
  }

  alRecibir(chunk) {
    this.log(`IN  <-- ${visible(chunk)}`);
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length) {
      const b = this.buf[0];
      if (b === ACK || b === NAK) {
        this.buf = this.buf.subarray(1);
        const espera = this.esperaAck;
        this.esperaAck = null;
        if (espera) (b === ACK ? espera.resolve() : espera.reject(new Error('NAK del POS')));
        continue;
      }
      if (b !== STX) { this.buf = this.buf.subarray(1); continue; } // basura: descartar
      const fin = this.buf.indexOf(ETX);
      if (fin < 0 || this.buf.length < fin + 2) return; // trama incompleta: esperar más datos
      const trama = this.buf.subarray(0, fin + 2);
      this.buf = this.buf.subarray(fin + 2);
      const lrc = trama[fin + 1];
      // El POS calcula el LRC incluyendo el STX (manual); se acepta también sin STX
      const ok = lrc === xor(trama.subarray(0, fin + 1)) || lrc === xor(trama.subarray(1, fin + 1));
      const avisarFalla = (e) => this.emit('error', e);
      if (!ok) { this.log('LRC inválido -> NAK'); this.escribir(Buffer.from([NAK])).catch(avisarFalla); continue; }
      this.escribir(Buffer.from([ACK])).catch(avisarFalla);
      this.alMensaje(trama.subarray(1, fin).toString('latin1'));
    }
  }

  alMensaje(texto) {
    const codigo = texto.split('|')[0];
    const espera = this.esperaRespuesta;
    if (espera && codigo === '0900') {
      const [, c] = texto.split('|');
      espera.onIntermedio?.({ responseCode: parseInt(c, 10), responseMessage: mensaje(parseInt(c, 10)) });
      return;
    }
    if (espera && codigo === espera.codigo) {
      this.esperaRespuesta = null;
      espera.resolve(texto);
      return;
    }
    // Mensaje que la caja no pidió (ej. 0911 cuando el cliente toca "Paga con tarjeta")
    this.emit('mensaje', texto);
  }

  // Envía un comando: reintenta hasta 3 veces si no llega ACK y espera la respuesta si corresponde.
  comando(texto, { onIntermedio, timeout } = {}) {
    const tarea = this.cola.then(() => this.ejecutar(texto, onIntermedio, timeout));
    this.cola = tarea.catch(() => {});
    return tarea;
  }

  async ejecutar(texto, onIntermedio, timeout = this.responseTimeout) {
    if (!this.port?.isOpen) throw new Error('Puerto no abierto');
    const codigoResp = RESPUESTA_DE[texto.split('|')[0]];
    let respuesta;
    if (codigoResp) {
      respuesta = new Promise((resolve, reject) => { this.esperaRespuesta = { codigo: codigoResp, resolve, reject, onIntermedio }; });
      respuesta.catch(() => {}); // si se desconecta antes del ACK, el error lo informa el ACK
    }
    try {
      let ackOk = false;
      for (let intento = 1; intento <= 3 && !ackOk; intento++) {
        let timerAck;
        const ack = new Promise((resolve, reject) => {
          this.esperaAck = { resolve, reject };
          timerAck = setTimeout(() => reject(new Error(`Sin ACK en ${this.ackTimeout} ms`)), this.ackTimeout);
        });
        ack.catch(() => {}); // el error se maneja abajo; sin esto, si la escritura tarda más que el
        // límite del ACK (POS apagado, cable suelto), el rechazo queda sin manejar y Node cierra el proceso
        const envio = this.escribir(this.trama(texto));
        envio.catch(() => {});
        try {
          // Si la escritura se queda bloqueada, el límite del ACK también la corta
          await Promise.race([envio.then(() => ack), ack]);
          ackOk = true;
        } catch (e) {
          this.esperaAck = null;
          this.log(`Intento ${intento}: ${e.message}`);
          if (intento === 3 || e.desconectado) throw e;
        } finally {
          clearTimeout(timerAck);
        }
      }
      if (!respuesta) return true;
      let timer;
      const limite = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Sin respuesta ${codigoResp} en ${timeout} ms`)), timeout); });
      try { return await Promise.race([respuesta, limite]); } finally { clearTimeout(timer); }
    } finally {
      this.esperaRespuesta = null;
    }
  }

  // ---- Comandos del protocolo ----

  poll() { return this.comando('0100'); }

  async inicializar() {
    await this.comando('0070');
    // El POS se reinicia la aplicación tras 0070: hacer poll hasta que responda
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      try { await this.poll(); break; } catch { /* aún no responde */ }
    }
    const f = (await this.comando('0080')).split('|');
    return { functionCode: f[0], responseCode: parseInt(f[1], 10), responseMessage: mensaje(parseInt(f[1], 10)), transactionDate: f[2], transactionTime: f[3] };
  }

  async cargarLlaves(timeout) { return this.respuestaSimple(await this.comando('0800', { timeout })); }

  // 0200|monto(9)|ticket(hasta 20)|impresión(1=voucher formateado)|enviar mensajes(1)
  static comandoVenta(monto, ticket, { voucher = false, mensajes = true } = {}) {
    const amount = parseInt(monto, 10);
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Monto inválido');
    const tk = String(ticket ?? Date.now().toString().slice(-6)).slice(0, 20);
    return { amount, ticket: tk, cmd: `0200|${String(amount).padStart(9, '0')}|${tk}|${voucher ? 1 : 0}|${mensajes ? 1 : 0}` };
  }

  async venta(monto, ticket, opciones = {}) {
    const { cmd } = PosSerial.comandoVenta(monto, ticket, opciones);
    return this.respuestaVenta(await this.comando(cmd, { onIntermedio: opciones.onIntermedio }));
  }

  async ultimaVenta(voucher = false) { return this.respuestaVenta(await this.comando(`0250|${voucher ? 1 : 0}`)); }

  async anular(operacion) {
    if (!operacion) throw new Error('Debes indicar el número de operación');
    const f = (await this.comando(`1200|${String(operacion).padStart(6, '0').slice(-6)}`)).split('|');
    return { ...this.respuestaSimple(f.join('|')), authorizationCode: f[4]?.trim(), operationNumber: f[5] };
  }

  async cierre(voucher = false) {
    const f = (await this.comando(`0500|${voucher ? 1 : 0}`)).split('|');
    return { ...this.respuestaSimple(f.join('|')), voucher: f[4]?.match(/.{1,40}/g) };
  }

  respuestaSimple(texto) {
    const f = texto.split('|');
    const rc = parseInt(f[1], 10);
    return { functionCode: f[0], responseCode: rc, responseMessage: mensaje(rc), successful: rc === 0, commerceCode: f[2], terminalId: f[3] };
  }

  respuestaVenta(texto) {
    const f = texto.split('|');
    const rc = parseInt(f[1], 10);
    return {
      functionCode: f[0], responseCode: rc, responseMessage: mensaje(rc), successful: rc === 0,
      commerceCode: f[2], terminalId: f[3], ticket: f[4], authorizationCode: f[5]?.trim() || null,
      amount: f[6] ? parseInt(f[6], 10) : null, last4Digits: f[7] || null, operationNumber: f[8],
      cardType: f[9], accountingDate: f[10], accountNumber: f[11], cardBrand: f[12],
      realDate: f[13], realTime: f[14], voucher: f[15]?.match(/.{1,40}/g),
      // Cuotas (opcionales; solo si el comercio tiene el producto Cuotas): tipo, número, monto, glosa
      sharesType: f[16] || null, sharesNumber: f[17] || null, sharesAmount: f[18] || null, sharesTypeComment: f[19]?.trim() || null,
      raw: texto,
    };
  }
}

module.exports = { PosSerial, RESPUESTAS, mensaje };
