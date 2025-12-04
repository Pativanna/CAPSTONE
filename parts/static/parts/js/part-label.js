/**
 * Lógica de impresión simple para etiquetas - estilo manos libres
 */
(function () {
  'use strict';

  function onReady(cb) {
    const run = () => cb();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
    document.addEventListener('page:ready', run);
    document.addEventListener('turbo:load', run);
  }

  function showMessage(type, title, message) {
    const area = document.getElementById('status-messages');
    if (!area) return;
    const alert = document.createElement('div');
    alert.className = `alert alert-${type} alert-dismissible fade show`;
    alert.innerHTML = `<strong>${title}</strong> ${message} <button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    area.innerHTML = '';
    area.appendChild(alert);
    window.setTimeout(() => alert.remove(), 8000);
  }

  function setLoading(message) {
    const modalEl = document.getElementById('loading-modal');
    const loadingTextEl = document.getElementById('loading-text');
    if (!modalEl) return () => {};
    if (loadingTextEl && message) loadingTextEl.textContent = message;
    const modal = typeof bootstrap !== 'undefined' ? new bootstrap.Modal(modalEl) : null;
    if (modal) modal.show();
    return () => { if (modal) modal.hide(); };
  }

  async function printLabelBluetooth(labelUrl) {
    const stop = setLoading('Conectando a impresora Bluetooth...');
    try {
      // Solicitar dispositivo Bluetooth
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['000018f0-0000-1000-8000-00805f9b34fb'] }],
        optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb']
      });

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService('000018f0-0000-1000-8000-00805f9b34fb');
      const characteristic = await service.getCharacteristic('00002af1-0000-1000-8000-00805f9b34fb');

      if (document.getElementById('loading-text')) {
        document.getElementById('loading-text').textContent = 'Descargando imagen...';
      }

      // Descargar imagen
      const response = await fetch(labelUrl);
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      
      if (document.getElementById('loading-text')) {
        document.getElementById('loading-text').textContent = 'Imprimiendo...';
      }

      // Enviar a impresora (chunk por chunk si es necesario)
      const chunkSize = 512;
      const data = new Uint8Array(arrayBuffer);
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        await characteristic.writeValue(chunk);
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      await device.gatt.disconnect();
      stop();
      showMessage('success', '¡Éxito!', 'Etiqueta impresa correctamente por Bluetooth.');
    } catch (error) {
      stop();
      if (error.name === 'NotFoundError') {
        showMessage('warning', 'Cancelado', 'No seleccionaste ninguna impresora.');
      } else {
        showMessage('danger', 'Error Bluetooth', error.message || 'No se pudo conectar a la impresora.');
      }
    }
  }

  async function printLabelRawBT(escposUrl) {
    const stop = setLoading('Preparando impresión RawBT...');
    try {
      console.log('Descargando ESC/POS desde:', escposUrl);
      
      // Descargar datos ESC/POS
      const response = await fetch(`${escposUrl}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Error HTTP ${response.status}: No se pudo obtener la etiqueta ESC/POS`);
      }
      
      const buffer = await response.arrayBuffer();
      console.log('ESC/POS descargado, tamaño:', buffer.byteLength, 'bytes');
      
      const bytes = new Uint8Array(buffer);
      
      // Convertir a base64
      const chunkSize = 0x8000;
      let binary = '';
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const subset = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, Array.from(subset));
      }
      const base64 = btoa(binary);
      
      console.log('Base64 generado, longitud:', base64.length);
      
      // Crear intent para RawBT
      const payload = `application/octet-stream;base64,${base64}`;
      const intent = `intent:${payload}#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;`;
      
      stop();
      console.log('Enviando a RawBT...');
      window.location.href = intent;
      
      showMessage('info', 'Enviado', 'Etiqueta enviada a RawBT Print Service.');
    } catch (error) {
      stop();
      console.error('Error en RawBT:', error);
      showMessage('danger', 'Error', `No se pudo preparar la impresión: ${error.message}`);
    }
  }

  function initLabelPrint() {
    const btn = document.getElementById('btn-print-label');
    if (!btn) {
      console.warn('Botón de impresión no encontrado');
      return;
    }

    const labelUrl = btn.dataset.labelUrl;
    const escposUrl = btn.dataset.escposUrl;
    const isAndroid = /Android/i.test(navigator.userAgent || '');
    const hasBluetoothAPI = typeof navigator !== 'undefined' && 'bluetooth' in navigator;

    console.log('Configuración de impresión:', { labelUrl, escposUrl, isAndroid, hasBluetoothAPI });

    btn.addEventListener('click', async () => {
      console.log('Botón de impresión clickeado');
      console.log('URLs disponibles:', { labelUrl, escposUrl });
      btn.disabled = true;
      
      try {
        // Detectar método de impresión
        if (isAndroid && escposUrl) {
          console.log('Usando método RawBT para Android');
          await printLabelRawBT(escposUrl);
        } else if (hasBluetoothAPI && escposUrl) {
          console.log('Usando método Web Bluetooth API con ESC/POS');
          // Para impresoras térmicas, usar ESC/POS en lugar de imagen PNG
          showMessage('info', 'Bluetooth', 'Use RawBT en Android para mejor compatibilidad.');
          await printLabelRawBT(escposUrl);
        } else {
          console.log('Usando método de impresión del sistema');
          showMessage('info', 'Imprimiendo', 'Abriendo diálogo de impresión del navegador...');
          window.print();
        }
      } catch (error) {
        console.error('Error en impresión:', error);
        showMessage('danger', 'Error', error.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  onReady(initLabelPrint);
})();
