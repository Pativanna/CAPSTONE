/**
 * Cliente de Impresora Bluetooth usando Web Bluetooth API
 * Maneja la conexión persistente con impresoras térmicas Bluetooth
 * 
 * Se expone una única instancia global en window.BluetoothPrinterClient
 * para evitar errores de "Identifier already been declared" cuando
 * Turbo recarga los scripts múltiples veces.
 */

if (!window.BluetoothPrinterClient) {
class BluetoothPrinterClient {
  constructor() {
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.isConnected = false;
    this.MAX_CHUNK_SIZE = 180; // BLE MTU realista en impresoras PT210
    this.MAX_WRITE_ATTEMPTS = 3;
    this.DEFAULT_WRITE_DELAY = 15;
    this.ANDROID_WRITE_DELAY = 45;
    
    // UUIDs para impresoras térmicas (Serial Port Profile)
    this.SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb'; // Servicio común de impresoras
    this.CHARACTERISTIC_UUID = '00002af1-0000-1000-8000-00805f9b34fb'; // Característica de escritura
    
    // Opciones de búsqueda
    this.REQUEST_OPTIONS = {
      filters: [
        { namePrefix: 'GOOJPRT' },
        { namePrefix: 'PT-' },
        { namePrefix: 'BlueTooth Printer' },
        { services: [this.SERVICE_UUID] }
      ],
      optionalServices: [this.SERVICE_UUID]
    };
  }
  
  /**
   * Conectar a la impresora Bluetooth
   * Muestra el diálogo nativo del navegador para seleccionar dispositivo
   */
  async connect() {
    try {
      console.log('Solicitando dispositivo Bluetooth...');
      
      // Verificar soporte
      if (!navigator.bluetooth) {
        throw new Error('Web Bluetooth API no soportada en este navegador');
      }
      
      // Solicitar dispositivo (muestra diálogo)
      this.device = await navigator.bluetooth.requestDevice(this.REQUEST_OPTIONS);
      
      console.log(`Dispositivo seleccionado: ${this.device.name}`);
      
      // Manejar desconexión inesperada
      this.device.addEventListener('gattserverdisconnected', () => {
        console.warn('Impresora desconectada inesperadamente');
        this.handleDisconnection();
      });
      
      // Conectar al servidor GATT
      console.log('Conectando al servidor GATT...');
      this.server = await this.device.gatt.connect();
      
      // Obtener servicio
      console.log('Obteniendo servicio...');
      const service = await this.server.getPrimaryService(this.SERVICE_UUID);
      
      // Obtener característica de escritura
      console.log('Obteniendo característica...');
      this.characteristic = await service.getCharacteristic(this.CHARACTERISTIC_UUID);
      
      this.isConnected = true;
      console.log('Conexión Bluetooth establecida correctamente');
      
      return {
        success: true,
        deviceName: this.device.name,
        deviceId: this.device.id
      };
      
    } catch (error) {
      console.error('Error al conectar:', error);
      this.handleDisconnection();
      throw error;
    }
  }
  
  /**
   * Reconectar a dispositivo previamente emparejado
   */
  async reconnect() {
    if (!this.device) {
      throw new Error('No hay dispositivo previamente conectado');
    }
    
    try {
      console.log('Reconectando...');
      this.server = await this.device.gatt.connect();
      
      const service = await this.server.getPrimaryService(this.SERVICE_UUID);
      this.characteristic = await service.getCharacteristic(this.CHARACTERISTIC_UUID);
      
      this.isConnected = true;
      console.log('Reconexión exitosa');
      
      return { success: true, deviceName: this.device.name };
      
    } catch (error) {
      console.error('Error al reconectar:', error);
      this.handleDisconnection();
      throw error;
    }
  }
  
  /**
   * Desconectar de la impresora
   */
  disconnect() {
    if (this.server && this.server.connected) {
      this.server.disconnect();
    }
    this.handleDisconnection();
    console.log('Impresora desconectada');
  }
  
  /**
   * Manejar desconexión (limpia referencias)
   */
  handleDisconnection() {
    this.isConnected = false;
    this.characteristic = null;
    this.server = null;
    // No limpiar this.device para permitir reconexión
  }
  
  /**
   * Enviar datos RAW a la impresora
   */
  async sendRaw(data, options = {}) {
    if (!this.isConnected || !this.characteristic) {
      throw new Error('Impresora no conectada');
    }
    
    // Convertir a Uint8Array si es necesario (una sola vez)
    let bytes;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else {
      bytes = new Uint8Array(data);
    }
    
    return await this._sendBytes(bytes, {
      offset: options.offset || 0,
      attempt: options.attempt || 1,
      maxAttempts: options.maxAttempts || this.MAX_WRITE_ATTEMPTS
    });
  }
  
  /**
   * Imprimir imagen desde URL
   */
  async printImage(imageUrl) {
    try {
      // NUEVO: Intentar usar ESC/POS pre-generado del servidor primero (mejor calidad)
      // Reemplazar /etiqueta/ por /etiqueta/escpos/ en la URL
      const escposUrl = imageUrl.replace('/etiqueta/', '/etiqueta/escpos/');
      
      try {
        // Intentar obtener ESC/POS del servidor (óptimo para impresión)
        const escposResponse = await fetch(escposUrl);
        if (escposResponse.ok) {
          const escposBlob = await escposResponse.blob();
          const escposArrayBuffer = await escposBlob.arrayBuffer();
          const escposData = new Uint8Array(escposArrayBuffer);
          
          // Enviar a impresora
          const serverResult = await this.sendRaw(escposData);
          console.log('Imagen impresa correctamente (ESC/POS del servidor)');
          return { success: true, transport: 'server-escpos', ...serverResult };
        }
      } catch (escposError) {
        console.warn('No se pudo obtener ESC/POS del servidor, usando conversión local:', escposError.message);
      }
      
      // Fallback: Convertir imagen localmente (método anterior)
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      
      // Convertir a imagen
      const img = await createImageBitmap(blob);
      
      // Convertir a comandos ESC/POS
      const escposData = await this.imageToESCPOS(img);
      
      // Enviar a impresora
      const result = await this.sendRaw(escposData);
      
      console.log('Imagen impresa correctamente (conversión local)');
      return { success: true, transport: 'canvas', ...result };
      
    } catch (error) {
      console.error('Error al imprimir imagen:', error);
      throw error;
    }
  }
  
  /**
   * Convertir imagen a comandos ESC/POS
   * Optimizado para impresoras térmicas de 58mm (384px de ancho)
   */
  async imageToESCPOS(image) {
    // Crear canvas para procesar imagen
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Dimensiones para impresora térmica (58mm = 384 pixels a 168 DPI)
    const maxWidth = 384;
    
    // Calcular dimensiones manteniendo aspecto
    let targetWidth = maxWidth;
    let targetHeight = Math.floor(image.height * (maxWidth / image.width));
    
    // Si la imagen ya es muy pequeña, no escalarla hacia arriba
    if (image.width < maxWidth) {
      console.warn(`Imagen más pequeña que el ancho esperado: ${image.width}px < ${maxWidth}px`);
      targetWidth = image.width;
      targetHeight = image.height;
    }
    
    canvas.width = maxWidth; // Siempre usar 384px para la impresora
    canvas.height = targetHeight;
    
    // Fondo blanco
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Dibujar imagen centrada si es más pequeña
    const xOffset = (maxWidth - targetWidth) / 2;
    ctx.drawImage(image, xOffset, 0, targetWidth, targetHeight);
    
    // Obtener datos de píxeles
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Convertir a monocromo
    const monoData = this.convertToMonochrome(imageData);
    
    // Generar comandos ESC/POS
    const escpos = [];
    
    // Inicializar impresora
    escpos.push(0x1B, 0x40); // ESC @
    
    // Centrar
    escpos.push(0x1B, 0x61, 0x01); // ESC a 1
    
    // Comando de imagen raster
    const bytesPerLine = Math.ceil(canvas.width / 8);
    
    for (let y = 0; y < canvas.height; y++) {
      escpos.push(0x1D, 0x76, 0x30, 0x00); // GS v 0
      escpos.push(bytesPerLine & 0xFF, (bytesPerLine >> 8) & 0xFF); // xL xH
      escpos.push(0x01, 0x00); // yL yH (1 línea)
      
      // Datos de la línea
      for (let x = 0; x < bytesPerLine; x++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const px = x * 8 + bit;
          if (px < canvas.width) {
            const idx = (y * canvas.width + px) * 4;
            if (monoData[idx] === 0) { // Negro
              byte |= (1 << (7 - bit));
            }
          }
        }
        escpos.push(byte);
      }
    }
    
    // Feed y corte
    escpos.push(0x1B, 0x64, 0x03); // ESC d 3 (3 líneas)
    
    return new Uint8Array(escpos);
  }
  
  /**
   * Convertir imagen a monocromo (umbral)
   * Usar threshold=160 para coincidir con el servidor
   */
  convertToMonochrome(imageData) {
    const data = imageData.data;
    const threshold = 160; // Aumentado de 128 a 160 para coincidir con servidor
    
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      const mono = gray < threshold ? 0 : 255;
      data[i] = data[i + 1] = data[i + 2] = mono;
    }
    
    return data;
  }
  
  /**
   * Imprimir página de prueba
   */
  async testPrint() {
    const testData = [
      0x1B, 0x40, // Inicializar
      0x1B, 0x61, 0x01, // Centrar
      ...new TextEncoder().encode('PRUEBA DE IMPRESORA\n'),
      ...new TextEncoder().encode('==================\n'),
      0x1B, 0x61, 0x00, // Alinear izquierda
      ...new TextEncoder().encode('Sistema de inventario\n'),
      ...new TextEncoder().encode('Car Inventory\n'),
      ...new TextEncoder().encode(`Fecha: ${new Date().toLocaleString()}\n`),
      0x1B, 0x64, 0x03 // Feed 3 líneas
    ];
    
    await this.sendRaw(new Uint8Array(testData));
    console.log('Página de prueba enviada');
  }
  
  /**
   * Obtener estado de conexión
   */
  getStatus() {
    return {
      connected: this.isConnected,
      deviceName: this.device ? this.device.name : null,
      deviceId: this.device ? this.device.id : null
    };
  }

  _getChunkSize() {
    return this.MAX_CHUNK_SIZE;
  }

  _getWriteDelay() {
    try {
      if (typeof navigator !== 'undefined' && navigator.userAgent && /Android/i.test(navigator.userAgent)) {
        return this.ANDROID_WRITE_DELAY;
      }
    } catch (_){}
    return this.DEFAULT_WRITE_DELAY;
  }

  async _writeChunk(chunk) {
    if (!this.characteristic) {
      throw new Error('Característica Bluetooth no inicializada');
    }
    if (typeof this.characteristic.writeValueWithResponse === 'function') {
      await this.characteristic.writeValueWithResponse(chunk);
      return;
    }
    await this.characteristic.writeValue(chunk);
  }

  _isGattError(error) {
    if (!error || !error.message) return false;
    const msg = error.message.toLowerCase();
    return msg.includes('gatt') || msg.includes('disconnected') || msg.includes('not connected') || msg.includes('networkerror');
  }

  async _sendBytes(bytes, { offset = 0, attempt = 1, maxAttempts = 3 } = {}) {
    const totalBytes = bytes.length;
    const chunkSize = this._getChunkSize();
    const delay = this._getWriteDelay();
    let cursor = offset;
    let resumed = offset > 0;
    
    try {
      while (cursor < totalBytes) {
        const next = Math.min(cursor + chunkSize, totalBytes);
        const chunk = bytes.slice(cursor, next);
        await this._writeChunk(chunk);
        cursor = next;
        
        if (cursor < totalBytes) {
          await this._sleep(delay);
        }
      }
      
      console.log(`Enviados ${totalBytes} bytes a la impresora (intentos: ${attempt})`);
      return { success: true, bytesSent: totalBytes, totalBytes, attempts: attempt, resumed };
    } catch (error) {
      console.error('Error al enviar datos:', error);
      
      if (this._isGattError(error) && attempt < maxAttempts) {
        console.warn(`Intentando reconectar... (intento ${attempt + 1}/${maxAttempts})`);
        await this._sleep(200);
        await this.reconnect();
        return await this._sendBytes(bytes, {
          offset: cursor,
          attempt: attempt + 1,
          maxAttempts
        });
      }
      
      error.bytesSent = cursor;
      error.totalBytes = totalBytes;
      throw error;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Exponer clase e instancia singleton en window
window.BluetoothPrinterClient = BluetoothPrinterClient;
window.bluetoothPrinterClient = window.bluetoothPrinterClient || new BluetoothPrinterClient();
}

// Exportar para uso global
window.BluetoothPrinterClient = BluetoothPrinterClient;
