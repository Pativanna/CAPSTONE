(function(){
  'use strict';

  // Logger simple hacia backend
  function logBluetooth(evento, datos={}){
    try {
      const payload = { evento, datos, ts: Date.now(), url: location.href, ua: navigator.userAgent };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      fetch('/parts/bluetooth/log/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true })
        .catch(() => navigator.sendBeacon && navigator.sendBeacon('/parts/bluetooth/log/', blob));
    } catch(_){ }
  }

  // UI mínima
  const $estado = document.getElementById('estado');
  const $log = document.getElementById('log');
  function uiEstado(texto){ $estado.textContent = texto; }
  function uiLog(msg){
    try {
      const linea = document.createElement('div');
      linea.textContent = new Date().toLocaleTimeString() + ' - ' + msg;
      $log.appendChild(linea);
      $log.scrollTop = $log.scrollHeight;
    } catch(_){ }
  }

  // Canal para comunicarse con páginas principales
  const canal = new BroadcastChannel('bt_printer');

  // Cliente Bluetooth (vive aquí, persistente mientras la ventana esté abierta)
  let cliente = null;
  let conectado = false;
  let nombre_dispositivo = null;
  let dispositivo_actual = null;
  let reintentos = 0;
  let timerHeartbeat = null;

  const SERVICE_UUID = '000018f0-0000-1000-8000-00805f9b34fb';
  const CHARACTERISTIC_UUID = '00002af1-0000-1000-8000-00805f9b34fb';

  function publicarEstado(){
    canal.postMessage({ tipo: 'host_status', conectado, nombre: nombre_dispositivo });
  }

  async function conectar(){
    try {
      if (!('bluetooth' in navigator)) throw new Error('Web Bluetooth no soportado');
      if (!cliente) cliente = new BluetoothPrinterClient();
      uiEstado('Conectando…');
      uiLog('connect_click (hub)');
      logBluetooth('hub_connect_click');

      // Seleccionar dispositivo y conectar
      const device = await navigator.bluetooth.requestDevice({
        filters: [ { services: [SERVICE_UUID] }, { name: 'GOOJPRT' }, { namePrefix: 'PT-' } ],
        optionalServices: [SERVICE_UUID]
      });
      uiLog('device_selected: ' + (device && device.name));
      logBluetooth('hub_device_selected', { deviceName: device && device.name, id: device && device.id });

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      cliente.device = device;
      cliente.server = server;
      cliente.characteristic = characteristic;
      cliente.isConnected = true;

      conectado = true;
      nombre_dispositivo = device.name;
      dispositivo_actual = device;
      try { localStorage.setItem('bt_device_info', JSON.stringify({ id: device.id, name: device.name })); } catch(_){ }
      uiEstado('Conectado a ' + nombre_dispositivo);
      uiLog('connected');
      logBluetooth('hub_connected', { deviceName: nombre_dispositivo, id: device.id });
      publicarEstado();

      device.addEventListener('gattserverdisconnected', () => {
        conectado = false;
        uiEstado('Desconectado');
        uiLog('gatt_disconnected');
        logBluetooth('hub_gatt_disconnected');
        publicarEstado();
        iniciarReconexion();
      });

      iniciarHeartbeat();
    } catch (e) {
      uiEstado('Error: ' + (e.message || e));
      uiLog('connect_error: ' + (e.message || e));
      logBluetooth('hub_connect_error', { error: e.message });
      publicarEstado();
      throw e;
    }
  }

  async function desconectar(){
    try {
      if (cliente && cliente.device && cliente.device.gatt && cliente.device.gatt.connected) {
        cliente.device.gatt.disconnect();
      }
    } finally {
      conectado = false;
      uiEstado('Desconectado');
      uiLog('manual_disconnect');
      logBluetooth('hub_manual_disconnect');
      publicarEstado();
    }
  }

  async function imprimirImagen(url){
    if (!conectado) throw new Error('No conectado');
    uiLog('print_start: ' + url);
    logBluetooth('hub_print_start', { url });
    try {
      await cliente.printImage(url);
      uiLog('print_ok');
      logBluetooth('hub_print_ok');
      canal.postMessage({ tipo: 'host_print_ok' });
    } catch (e) {
      uiLog('print_error: ' + (e.message || e));
      logBluetooth('hub_print_error', { error: e.message });
      canal.postMessage({ tipo: 'host_print_error', error: e.message });
      throw e;
    }
  }

  function iniciarHeartbeat(){
    try { if (timerHeartbeat) clearInterval(timerHeartbeat); } catch(_){ }
    timerHeartbeat = setInterval(async () => {
      try {
        if (!cliente || !cliente.device || !cliente.device.gatt) return;
        if (!cliente.device.gatt.connected) {
          uiLog('heartbeat: desconectado');
          iniciarReconexion();
        }
      } catch(_){ }
    }, 10000);
  }

  async function intentarReconectar(){
    if (!dispositivo_actual || !dispositivo_actual.gatt) return false;
    try {
      uiLog('reconnect_attempt #' + reintentos);
      const server = await dispositivo_actual.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      cliente.server = server;
      cliente.characteristic = characteristic;
      cliente.isConnected = true;
      conectado = true;
      uiEstado('Conectado a ' + (dispositivo_actual.name || 'Impresora'));
      uiLog('reconnect_ok');
      logBluetooth('hub_reconnect_ok');
      publicarEstado();
      iniciarHeartbeat();
      reintentos = 0;
      return true;
    } catch(e) {
      uiLog('reconnect_error: ' + (e.message||e));
      logBluetooth('hub_reconnect_error', { error: e.message });
      return false;
    }
  }

  function iniciarReconexion(){
    if (reintentos > 0) return; // ya hay rutina en curso
    (async function ciclo(){
      for (reintentos = 1; reintentos <= 5; reintentos++){
        const ok = await intentarReconectar();
        if (ok) return;
        const espera = Math.min(16000, Math.pow(2, reintentos) * 1000);
        await new Promise(r => setTimeout(r, espera));
      }
      // Intento silencioso con getDevices (si está disponible y hubo permiso previo)
      try {
        const info = JSON.parse(localStorage.getItem('bt_device_info')||'{}');
        if (info && info.name && 'bluetooth' in navigator && navigator.bluetooth.getDevices){
          const devs = await navigator.bluetooth.getDevices();
          const d = devs.find(x => x.id === info.id || x.name === info.name);
          if (d){ dispositivo_actual = d; reintentos = 0; await intentarReconectar(); return; }
        }
      } catch(_){ }
      reintentos = 0;
    })();
  }

  // Mensajería entrante desde las páginas principales
  canal.onmessage = (ev) => {
    const msg = ev.data || {};
    if (!msg || typeof msg !== 'object') return;
    switch (msg.tipo) {
      case 'connect':
        conectar().catch(()=>{});
        break;
      case 'disconnect':
        desconectar();
        break;
      case 'print':
        if (msg.url) imprimirImagen(msg.url).catch(()=>{});
        break;
      case 'status?':
        publicarEstado();
        break;
    }
  };

  // Controles manuales (útiles si el popup se abre en primer plano)
  document.getElementById('btnConectar').addEventListener('click', () => conectar().catch(()=>{}));
  document.getElementById('btnDesconectar').addEventListener('click', () => desconectar());

  // Anunciar presencia del hub
  uiEstado('Listo. Esperando comandos…');
  uiLog('hub_ready');
  logBluetooth('hub_ready');
  publicarEstado();
})();
