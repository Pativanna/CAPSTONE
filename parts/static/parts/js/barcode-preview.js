/**
 * Controla la experiencia de preview e impresión de etiquetas.
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

  function getCsrfToken() {
    if (typeof window.getCsrfToken === 'function') {
      const value = window.getCsrfToken();
      if (value) return value;
    }
    const input = document.querySelector('input[name=csrfmiddlewaretoken]');
    if (input) return input.value;
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function toggleDevicePath() {
    const select = document.getElementById('connection-type');
    const group = document.getElementById('device-path-group');
    if (!select || !group) return;
    group.style.display = select.value === 'serial' ? 'block' : 'none';
  }

  function showMessage(type, title, message) {
    const area = document.getElementById('status-messages');
    if (!area) return;
    const alert = document.createElement('div');
    alert.className = `alert alert-${type} alert-dismissible fade show`;
    alert.innerHTML = `<strong>${title}</strong> ${message} <button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
    area.innerHTML = '';
    area.appendChild(alert);
    window.setTimeout(() => alert.remove(), 10000);
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Error ${response.status}`);
    }
    return response.json();
  }

  function initBarcodePreview() {
    const root = document.querySelector('[data-barcode-preview]');
    if (!root) return;
    const config = {
      partId: root.dataset.partId,
      labelUrl: root.dataset.labelUrl,
      printUrl: root.dataset.printUrl,
      testUrl: root.dataset.testUrl,
      detectUrl: root.dataset.detectUrl
    };
    const csrfToken = getCsrfToken();
    const modalEl = document.getElementById('loading-modal');
    const loadingModal = modalEl && typeof bootstrap !== 'undefined'
      ? new bootstrap.Modal(modalEl)
      : null;
    const loadingTextEl = document.getElementById('loading-text');
    const btnPrint = document.getElementById('btn-imprimir');
    const btnTest = document.getElementById('btn-test');
    const btnDetect = document.getElementById('btn-detectar');
    const methodInfo = document.getElementById('method-info');
    const btnText = document.getElementById('btn-text');
    const form = document.getElementById('print-form');
    let bluetoothClient = null;

    function setLoading(message) {
      if (!loadingModal) return () => {};
      if (loadingTextEl && message) loadingTextEl.textContent = message;
      loadingModal.show();
      return () => loadingModal.hide();
    }

    function updateMethodInfo(method) {
      if (!methodInfo || !btnText || !btnPrint) return;
      const bluetoothSupported = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
      if (method === 'bluetooth') {
        if (!bluetoothSupported) {
          methodInfo.innerHTML = '<span class="text-danger"><strong>Bluetooth Directo:</strong> No soportado en este navegador. Usa Chrome o Edge.</span>';
          btnText.textContent = 'Bluetooth no disponible';
          btnPrint.disabled = true;
          return;
        }
        methodInfo.innerHTML = '<strong>Bluetooth Directo:</strong> Imprime desde tu dispositivo (requiere Chrome/Edge)';
        btnText.textContent = 'Conectar e Imprimir por Bluetooth';
      } else {
        methodInfo.innerHTML = '<strong>Servidor:</strong> Imprime desde el servidor (funciona en todos los navegadores)';
        btnText.textContent = 'Imprimir Etiqueta en GOOJPRT PT210';
      }
      btnPrint.disabled = false;
    }

    async function printBluetooth() {
      if (!config.labelUrl) {
        showMessage('danger', 'Error', 'URL de etiqueta no disponible.');
        return;
      }
      const stop = setLoading('Conectando a impresora Bluetooth...');
      try {
        if (!bluetoothClient) bluetoothClient = new BluetoothPrinterClient();
        await bluetoothClient.connect();
        if (loadingTextEl) loadingTextEl.textContent = 'Descargando etiqueta...';
        await bluetoothClient.printImageFromUrl(config.labelUrl);
        stop();
        showMessage('success', '¡Éxito!', 'Etiqueta impresa correctamente por Bluetooth.');
        window.setTimeout(() => bluetoothClient?.disconnect(), 2000);
      } catch (error) {
        stop();
        showMessage('danger', 'Error Bluetooth', error.message || 'No se pudo imprimir.');
      }
    }

    async function runServerPrint() {
      if (!form) return;
      const requiresTest = document.getElementById('test-first')?.checked;
      if (requiresTest) {
        const ok = await runPrinterTest();
        if (!ok) {
          showMessage('warning', 'Prueba fallida', 'Verifica la impresora antes de continuar.');
          return;
        }
      }
      const stop = setLoading('Imprimiendo etiqueta...');
      try {
        const response = await fetch(config.printUrl || `/parts/${config.partId}/imprimir/`, {
          method: 'POST',
          headers: { 'X-CSRFToken': csrfToken },
          body: new FormData(form)
        });
        const data = await response.json();
        stop();
        if (data.success) {
          showMessage('success', '¡Éxito!', data.mensaje || 'Etiqueta enviada a impresión.');
        } else {
          showMessage('danger', 'Error', data.detalle || 'Error desconocido.');
        }
      } catch (error) {
        stop();
        showMessage('danger', 'Error de conexión', error.message);
      }
    }

    async function runPrinterTest() {
      if (!form) return false;
      const stop = setLoading('Probando impresora...');
      try {
        const data = await requestJson(config.testUrl || '/parts/impresora/test/', {
          method: 'POST',
          headers: { 'X-CSRFToken': csrfToken },
          body: new FormData(form)
        });
        stop();
        if (data.success) {
          showMessage('success', '¡Prueba exitosa!', `Impresora ${data.impresora} funcionando correctamente.`);
          return true;
        }
        showMessage('danger', 'Prueba fallida', data.detalle || 'Error desconocido.');
        if (data.solucion) {
          showMessage('info', 'Sugerencia', data.solucion);
        }
        return false;
      } catch (error) {
        stop();
        showMessage('danger', 'Error de conexión', error.message);
        return false;
      }
    }

    async function detectPrinter() {
      const stop = setLoading('Detectando impresora...');
      try {
        const data = await requestJson(config.detectUrl || '/parts/impresora/detectar/', {
          method: 'GET',
          headers: { 'X-CSRFToken': csrfToken }
        });
        stop();
        if (data.dispositivo_detectado) {
          showMessage('success', 'Impresora detectada', `Dispositivo: ${data.dispositivo_detectado}`);
          const input = document.getElementById('device-path');
          if (input) input.value = data.dispositivo_detectado;
        } else {
          showMessage('warning', 'Sin resultados', data.mensaje || 'No se detectó impresora.');
        }
      } catch (error) {
        stop();
        showMessage('danger', 'Error', error.message);
      }
    }

    document.querySelectorAll('input[name="print-method"]').forEach((radio) => {
      radio.addEventListener('change', () => updateMethodInfo(radio.value));
    });
    updateMethodInfo(document.querySelector('input[name="print-method"]:checked')?.value || 'server');
    toggleDevicePath();
    document.getElementById('connection-type')?.addEventListener('change', toggleDevicePath);
    btnPrint?.addEventListener('click', () => {
      const method = document.querySelector('input[name="print-method"]:checked')?.value || 'server';
      if (method === 'bluetooth') {
        printBluetooth();
      } else {
        runServerPrint();
      }
    });
    btnTest?.addEventListener('click', runPrinterTest);
    btnDetect?.addEventListener('click', detectPrinter);
  }

  onReady(initBarcodePreview);
})();
