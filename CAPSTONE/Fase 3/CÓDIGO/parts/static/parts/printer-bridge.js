(function(){
  'use strict';

  // Logger centralizado hacia Django vía beacon/fetch
  function logBluetooth(evento, datos={}){
    try {
      const payload = {
        evento,
        datos,
        ts: Date.now(),
        url: location.href,
        ua: navigator.userAgent
      };
      // Usar sendBeacon si está disponible para no bloquear flujo
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      // Intentar fetch primero para ver errores en consola si falla
      fetch('/parts/bluetooth/log/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true })
        .catch(err => {
          console.warn('BT log fetch fallo, probando sendBeacon:', err?.message);
          if (navigator.sendBeacon) {
            navigator.sendBeacon('/parts/bluetooth/log/', blob);
          }
        });
    } catch(_){ }
  }

  // Puente unificado para impresión por Bluetooth
  // - Web: usa Web Bluetooth (BluetoothPrinterClient)
  // - Futuro móvil/escritorio: reemplazar internals por plugin nativo (Capacitor/Electron)
  
  class EventBus {
    constructor(){ this._cbs = []; }
    on(cb){ if (typeof cb === 'function') this._cbs.push(cb); }
    emit(status){ for (const cb of this._cbs){ try{ cb(status); } catch(e){ console.error('Error en callback de estado:', e); } } }
  }

  class PrinterBridge {
    constructor(){
      this._eventoEstado = new EventBus();
      this._cliente = null; // BluetoothPrinterClient en web
      this._dispositivo = null; // navigator.bluetooth device
      this._modo_host = false; // true si se usa ventana dedicada
      this._canal = null; // BroadcastChannel hacia host
      this._hostVentana = null; // Referencia a popup
  this._cola = this._cargarCola();

      // UUIDs BLE de GOOJPRT/escpos BLE
      this.SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
      this.CHARACTERISTIC_UUID = '00002af1-0000-1000-8000-00805f9b34fb';

      this._initWebLayer();
      logBluetooth('bridge_init', { soporte_web_bluetooth: 'bluetooth' in navigator });

      // No desconectar en unload en la ventana principal para preservar la sesión entre vistas.
      // Solo limpiar cuando se trate de la ventana host dedicada.
      if (window.name === 'bt_printer_host') {
        const onUnload = () => {
          try {
            if (this._cliente && this._cliente.device && this._cliente.device.gatt && this._cliente.device.gatt.connected) {
              this._cliente.device.gatt.disconnect();
              logBluetooth('page_unload_disconnect_host');
            }
          } catch(_){ }
        };
        window.addEventListener('pagehide', onUnload);
        window.addEventListener('beforeunload', onUnload);
      } else {
        logBluetooth('skip_unload_disconnect_main');
      }

      // Supervisión periódica para reconectar si se perdió conexión sin acción del usuario (p.ej. cambio de frame)
      setInterval(() => {
        try {
          if (!this.isConnected()) {
            const info = JSON.parse(localStorage.getItem('bluetoothPrinterDevice') || '{}');
            if (info && info.name) {
              logBluetooth('autowatch_disconnected', { name: info.name });
              // Intentar reconectar de forma silenciosa si getDevices está disponible
              if ('getDevices' in navigator.bluetooth) {
                navigator.bluetooth.getDevices()
                  .then(devs => {
                    const target = devs.find(d => d.id === info.id || d.name === info.name);
                    if (target) {
                      logBluetooth('autowatch_retry_attempt', { deviceName: target.name });
                      this._conectarDispositivo(target, { silencioso: true }).catch(err => {
                        logBluetooth('autowatch_retry_error', { error: err.message });
                      });
                    }
                  })
                  .catch(err => logBluetooth('autowatch_getdevices_error', { error: err.message }));
              }
            }
          }
        } catch(_){ }
      }, 15000); // cada 15s

      // Log de visibilidad (para diagnosticar pérdidas de foco)
      document.addEventListener('visibilitychange', () => {
        logBluetooth('visibility_change', { hidden: document.hidden });
      });

      // Inicializar modo host SOLO si está explícitamente habilitado por configuración
      // Evitar ventanas/pestañas nuevas por defecto (mejor UX en Android/iOS)
      try {
        const hostHabilitado = localStorage.getItem('bt_host_enabled') === 'true';
        if (hostHabilitado && (!window.name || window.name !== 'bt_printer_host')) {
          this._iniciarModoHost();
        } else {
          // Modo directo en la misma ventana (sin host)
          this._modo_host = false;
          logBluetooth('bridge_host_disabled');
        }
      } catch(_) {
        this._modo_host = false;
      }
    }

    // Capa Web (actual). En futuro móvil/escritorio, estas funciones serán proxys a nativo
    _initWebLayer(){
      if (!('bluetooth' in navigator)) {
        console.warn('Web Bluetooth no soportado en este navegador');
        logBluetooth('unsupported');
        return;
      }

      // Intentar restaurar conexión previa UNA sola vez al cargar con page:ready
      if (!this._restoreIntentado) {
        this._restoreIntentado = true;
        document.addEventListener('page:ready', () => this._restaurarConexionPrevia());
        if (document.readyState !== 'loading') {
          this._restaurarConexionPrevia();
        }
      }
    }

    async _restaurarConexionPrevia(){
      try {
        // Si ya estamos conectados, no tocar el estado ni emitir eventos
        if (this.isConnected && this.isConnected()) {
          logBluetooth('restore_skip_already_connected');
          return;
        }
        const wasConnected = localStorage.getItem('bluetoothPrinterConnected') === 'true';
        const info = JSON.parse(localStorage.getItem('bluetoothPrinterDevice') || '{}');
        if (!wasConnected || !info.name) return;
        if (!('getDevices' in navigator.bluetooth)) {
          console.log('getDevices() no soportado; conexión manual requerida');
          logBluetooth('restore_skipped_no_getdevices');
          // No emitir "desconectado" aquí para evitar falso negativo visual durante navegación interna
          return;
        }
        const devices = await navigator.bluetooth.getDevices();
        const target = devices.find(d => d.id === info.id || d.name === info.name);
        if (!target) { logBluetooth('restore_device_not_found', {info}); return; }
        logBluetooth('restore_attempt', { deviceName: target.name, id: target.id });
        await this._conectarDispositivo(target, { silencioso: true });
      } catch (e) {
        console.warn('No se pudo restaurar conexión previa:', e.message);
        logBluetooth('restore_error', { error: e.message });
      }
    }

    async connect(){
      if (this._modo_host) {
        // Delegar al host
        if (!this._hostVentana || this._hostVentana.closed) {
          this._abrirHost();
        }
        this._canal && this._canal.postMessage({ tipo: 'connect' });
        this._emit({ type: 'connecting', message: 'Solicitado al host...' });
        logBluetooth('bridge_host_connect_request');
        return;
      }
      // Conexión manual (diálogo nativo)
      if (!this._cliente) this._cliente = new BluetoothPrinterClient();
      try {
        this._emit({ type: 'connecting', message: 'Conectando...' });
        logBluetooth('connect_click');
        // requestDevice con filtros conocidos
        const device = await navigator.bluetooth.requestDevice({
          filters: [ { services: [this.SERVICE_UUID] }, { name: 'GOOJPRT' }, { namePrefix: 'PT-' } ],
          optionalServices: [this.SERVICE_UUID]
        });
        logBluetooth('device_selected', { deviceName: device && device.name, id: device && device.id });
        await this._conectarDispositivo(device, { silencioso: false });
      } catch (e) {
        this._emit({ type: 'error', message: e.message || 'Error al conectar' });
        logBluetooth('connect_error', { error: e.message });
        throw e;
      }
    }

    async _conectarDispositivo(device, { silencioso }){
      if (!this._cliente) this._cliente = new BluetoothPrinterClient();

      // Listener de desconexión (una sola vez)
      try {
        device.removeEventListener('gattserverdisconnected', this._onGattDisc);
      } catch(_){}
      this._onGattDisc = () => {
        this._emit({ type: 'disconnected', message: 'Desconectado' });
        logBluetooth('gatt_disconnected');
        // Un solo intento automático con timeout de 8s; si falla, usuario reconecta
        setTimeout(() => this._reintentoAuto(device), 500);
      };
      device.addEventListener('gattserverdisconnected', this._onGattDisc);

      // Conectar GATT con timeouts en pasos
      this._cliente.device = device;
      this._dispositivo = device;

  logBluetooth('gatt_connect_attempt');
  const server = await this._carrera(device.gatt.connect(), 8000, 'Timeout al conectar');
  logBluetooth('gatt_connect_ok');
  const service = await this._carrera(server.getPrimaryService(this.SERVICE_UUID), 5000, 'Timeout al obtener servicio');
  logBluetooth('service_ok');
  const characteristic = await this._carrera(service.getCharacteristic(this.CHARACTERISTIC_UUID), 5000, 'Timeout al obtener característica');
  logBluetooth('characteristic_ok');

      this._cliente.server = server;
      this._cliente.characteristic = characteristic;
      this._cliente.isConnected = true;

      // Persistir
      localStorage.setItem('bluetoothPrinterConnected', 'true');
      localStorage.setItem('bluetoothPrinterDevice', JSON.stringify({ name: device.name, id: device.id }));

      this._emit({ type: 'connected', deviceName: device.name, message: 'Conectado' });
      logBluetooth('connected', { deviceName: device.name, id: device.id });
      if (!silencioso) console.log('Conectado a', device.name);
    }

    async _reintentoAuto(device){
      try {
        if (!device || !device.gatt) { logBluetooth('retry_skipped'); return; }
        logBluetooth('retry_attempt');
        await this._conectarDispositivo(device, { silencioso: true });
      } catch (e) {
        // Notificación temporal 3s
        this._emit({ type: 'disconnected', message: 'Impresora desconectada. Conecta manualmente.' });
        this._notificarTemporal('Impresora desconectada', device && device.name ? device.name : '');
        logBluetooth('retry_failed', { error: e.message });
      }
    }

    _notificarTemporal(titulo, detalle){
      try {
        const id = 'bluetooth-disconnect-notification';
        const prev = document.getElementById(id);
        if (prev) prev.remove();
        const html = `
          <div id="${id}" class="alert alert-warning alert-dismissible fade show" role="alert"
               style="position: fixed; top: 70px; right: 20px; z-index: 9999; max-width: 350px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
            <strong>${titulo}</strong><br>
            <span style="font-size: 0.9em;">${detalle}<br>
              Usa el botón "Conectar Impresora" en la barra superior.
            </span>
            <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
          </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
        setTimeout(() => {
          const el = document.getElementById(id);
          if (!el) return;
          el.classList.remove('show');
          setTimeout(() => el.remove(), 150);
        }, 3000);
      } catch(_){}
    }

    async disconnect(){
      try {
        if (this._cliente && this._cliente.device && this._cliente.device.gatt && this._cliente.device.gatt.connected) {
          this._cliente.device.gatt.disconnect();
        }
      } finally {
        this._cliente && (this._cliente.isConnected = false);
        this._emit({ type: 'disconnected', message: 'Desconectado' });
        logBluetooth('manual_disconnect');
      }
    }

    async printLabel(...args){
      if (this._modo_host) {
        if (!this.isConnected()) {
          // Encolar trabajo y salir
          if (args.length >= 1 && typeof args[0] === 'string') {
            this._encolarTrabajo({ tipo: 'print', url: args[0] });
            this._emit({ type: 'reconnecting', message: 'Trabajo encolado. Esperando conexión...' });
            logBluetooth('bridge_host_queued_job');
            // Intentar conectar el host si no está
            if (!this._hostVentana || this._hostVentana.closed) this._abrirHost();
            this._canal && this._canal.postMessage({ tipo: 'connect' });
            return;
          }
          throw new Error('Impresora no conectada (host)');
        }
        if (args.length >= 1 && typeof args[0] === 'string') {
          const url = args[0];
          this._canal && this._canal.postMessage({ tipo: 'print', url });
          this._emit({ type: 'printing', message: 'Delegado al host...' });
          logBluetooth('bridge_host_print_request', { url });
          return;
        } else {
          throw new Error('Modo de impresión inválido en host');
        }
      }
      // Compatibilidad:
      // - Modo 1: printLabel(urlEtiqueta[, _flag]) -> usa printImage(url)
      // - Modo 2: printLabel(vehicle, part, make, model, year, size, price, barcode) -> reservado futuro
      if (!this.isConnected()) throw new Error('Impresora no conectada');
      this._emit({ type: 'printing', message: 'Imprimiendo...' });
      logBluetooth('print_start', { url: args.length ? args[0] : undefined });
      try {
        let printResult = null;
        if (args.length >= 1 && typeof args[0] === 'string') {
          const url = args[0];
          if (!this._cliente || typeof this._cliente.printImage !== 'function') {
            throw new Error('Cliente Bluetooth no disponible para imprimir imagen');
          }
          printResult = await this._cliente.printImage(url);
        } else {
          // Firma detallada reservada para futuras integraciones nativas
          throw new Error('Modo de impresión no soportado en Web: use printLabel(url)');
        }
        if (printResult && printResult.resumed) {
          logBluetooth('print_resume', {
            attempts: printResult.attempts,
            bytesSent: printResult.bytesSent,
            totalBytes: printResult.totalBytes
          });
        }
        this._emit({ type: 'printed', message: 'Impreso' });
        logBluetooth('print_ok', {
          bytesSent: printResult && printResult.bytesSent,
          totalBytes: printResult && printResult.totalBytes,
          resumed: printResult && printResult.resumed,
          attempts: printResult && printResult.attempts,
          transport: printResult && printResult.transport
        });
      } catch (e) {
        this._emit({ type: 'error', message: 'Error al imprimir' });
        logBluetooth('print_error', {
          error: e.message,
          bytesSent: e.bytesSent,
          totalBytes: e.totalBytes
        });
        throw e;
      }
    }

    isConnected(){
      if (this._modo_host) {
        return this._estado_host_conectado === true;
      }
      if (!this._cliente || !this._cliente.device || !this._cliente.device.gatt) return false;
      return this._cliente.device.gatt.connected === true;
    }

    getDeviceName(){
      if (this._cliente && this._cliente.device) return this._cliente.device.name;
      try {
        const info = JSON.parse(localStorage.getItem('bluetoothPrinterDevice') || '{}');
        return info.name || null;
      } catch(_){ return null; }
    }

    onStatusChange(cb){ this._eventoEstado.on(cb); }
    _emit(status){ this._eventoEstado.emit(status); }

    _carrera(promesa, timeoutMs, mensajeTimeout){
      return Promise.race([
        promesa,
        new Promise((_, reject) => setTimeout(() => reject(new Error(mensajeTimeout)), timeoutMs))
      ]);
    }

    _iniciarModoHost(){
      try {
        this._canal = new BroadcastChannel('bt_printer');
        this._canal.onmessage = (ev) => {
          const msg = ev.data || {};
          if (!msg || typeof msg !== 'object') return;
          switch (msg.tipo) {
            case 'host_status':
              this._estado_host_conectado = !!msg.conectado;
              this._host_nombre = msg.nombre || null;
              if (this._estado_host_conectado) {
                this._emit({ type: 'connected', deviceName: this._host_nombre, message: 'Conectado (host)' });
                this._drenarCola();
              } else {
                this._emit({ type: 'disconnected', message: 'Desconectado (host)' });
              }
              break;
            case 'host_print_ok':
              this._emit({ type: 'printed', message: 'Impreso' });
              break;
            case 'host_print_error':
              this._emit({ type: 'error', message: 'Error al imprimir (host)' });
              break;
          }
        };
        // Abrir ventana host si no existe y registrar modo
        this._abrirHost();
      } catch(e){
        logBluetooth('bridge_host_init_error', { error: e.message });
      }
    }

    _abrirHost(){
      try {
        if (this._hostVentana && !this._hostVentana.closed) return;
        const ancho = 400, alto = 500;
        const left = screen.width - ancho - 20;
        const top = 60;
        // Respeto a UX: no abrir ventanas a menos que el usuario lo haya habilitado (bt_host_enabled)
        const hostHabilitado = localStorage.getItem('bt_host_enabled') === 'true';
        if (!hostHabilitado) {
          this._modo_host = false;
          logBluetooth('bridge_host_open_skipped');
          return;
        }
        this._hostVentana = window.open('/parts/impresora/hub/', 'bt_printer_host', `width=${ancho},height=${alto},left=${left},top=${top}`);
        if (this._hostVentana) {
          this._modo_host = true;
          logBluetooth('bridge_host_opened');
          // Consultar estado inicial del host
          setTimeout(() => this._canal && this._canal.postMessage({ tipo: 'status?' }), 800);
        } else {
          logBluetooth('bridge_host_popup_blocked');
          this._modo_host = false; // fallback
        }
      } catch(e){
        logBluetooth('bridge_host_open_error', { error: e.message });
        this._modo_host = false;
      }
    }

    _encolarTrabajo(job){
      try {
        this._cola.push(job);
        localStorage.setItem('bt_print_jobs', JSON.stringify(this._cola.slice(-10))); // limitar a 10
      } catch(_){ }
    }

    _drenarCola(){
      if (!this._estado_host_conectado || !this._cola.length) return;
      const trabajos = this._cola.splice(0, this._cola.length);
      try { localStorage.setItem('bt_print_jobs', JSON.stringify(this._cola)); } catch(_){ }
      for (const t of trabajos){
        if (t && t.tipo === 'print' && t.url){
          this._canal && this._canal.postMessage({ tipo: 'print', url: t.url });
          logBluetooth('bridge_host_print_from_queue', { url: t.url });
        }
      }
    }

    _cargarCola(){
      try {
        const s = localStorage.getItem('bt_print_jobs');
        if (!s) return [];
        const v = JSON.parse(s);
        return Array.isArray(v) ? v : [];
      } catch(_){ return []; }
    }
  }

  // Exponer bridge global
  if (!window.printerManager) {
    window.printerManager = new PrinterBridge();
  }
})();
