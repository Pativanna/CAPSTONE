/**
 * Controla la ventana del hub Bluetooth utilizado para mantener la conexión.
 */
(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  function initHub() {
    if (typeof window.BroadcastChannel === 'undefined' || typeof window.BluetoothPrinterClient === 'undefined') {
      console.warn('BroadcastChannel o BluetoothPrinterClient no disponible en este navegador.');
      return;
    }

    const channel = new BroadcastChannel('canal_impresora_bt');
    const estadoEl = $('estado');
    const logEl = $('log');
    const btnConectar = $('btn-conectar');
    const btnDesconectar = $('btn-desconectar');
    let printerClient = null;

    function log(message) {
      if (!logEl) return;
      const ts = new Date().toISOString().substring(11, 19);
      logEl.textContent += `[${ts}] ${message}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }

    function actualizarEstado(tipo, detalle) {
      if (!estadoEl) return;
      switch (tipo) {
        case 'conectando':
          estadoEl.innerHTML = '<span class="warn">Conectando...</span>';
          break;
        case 'conectado':
          estadoEl.innerHTML = `<span class="ok">Conectado a ${detalle || 'impresora'}</span>`;
          break;
        case 'desconectado':
          estadoEl.innerHTML = '<span class="err">Desconectado</span>';
          break;
        case 'error':
          estadoEl.innerHTML = `<span class="err">Error: ${detalle}</span>`;
          break;
        default:
          estadoEl.textContent = detalle || tipo;
      }
    }

    channel.onmessage = async (event) => {
      const data = event.data || {};
      if (data.tipo === 'imprimir' && printerClient && printerClient.isConnected) {
        log(`Solicitud de impresión recibida: ${data.url}`);
        try {
          await printerClient.printImage(data.url);
          channel.postMessage({ tipo: 'impreso', exito: true });
          log('Impresión completada');
        } catch (error) {
          channel.postMessage({ tipo: 'impreso', exito: false, error: error.message });
          log(`Error imprimiendo: ${error.message}`);
        }
      } else if (data.tipo === 'solicitar_estado') {
        channel.postMessage({ tipo: 'estado', conectado: Boolean(printerClient && printerClient.isConnected) });
      }
    };

    async function conectar() {
      try {
        if (!printerClient) printerClient = new BluetoothPrinterClient();
        actualizarEstado('conectando');
        if (btnConectar) btnConectar.disabled = true;
        const resultado = await printerClient.connect();
        actualizarEstado('conectado', resultado.deviceName);
        if (btnDesconectar) btnDesconectar.disabled = false;
        channel.postMessage({ tipo: 'estado', conectado: true, deviceName: resultado.deviceName });
        log(`Conectado a ${resultado.deviceName}`);
      } catch (error) {
        actualizarEstado('error', error.message);
        if (btnConectar) btnConectar.disabled = false;
        log(`Error conexión: ${error.message}`);
        channel.postMessage({ tipo: 'estado', conectado: false, error: error.message });
      }
    }

    function desconectar() {
      if (printerClient) {
        printerClient.disconnect();
      }
      actualizarEstado('desconectado');
      if (btnConectar) btnConectar.disabled = false;
      if (btnDesconectar) btnDesconectar.disabled = true;
      channel.postMessage({ tipo: 'estado', conectado: false });
      log('Desconectado manualmente');
    }

    if (btnConectar) btnConectar.addEventListener('click', conectar);
    if (btnDesconectar) btnDesconectar.addEventListener('click', desconectar);

    channel.postMessage({ tipo: 'hub_listo' });
    log('Hub listo, esperando acción de conexión');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHub, { once: true });
  } else {
    initHub();
  }
})();
