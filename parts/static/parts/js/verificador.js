/**
 * Verificador de Código de Barras
 * 
 * Integra con el plugin nativo MLKitScanner para escanear códigos
 * y verificar piezas del inventario.
 * 
 * Sigue patrón de carga compatible con Turbo (ISO 25010 - Mantenibilidad)
 */
(function() {
  'use strict';

  // Evitar múltiples inicializaciones
  let initialized = false;
  
  // Estado del verificador
  const state = {
    selectedPart: null,
    isScanning: false,
    lastScannedCode: null,
    searchDebounceTimer: null,
    barcodeListener: null,
  };
  
  // Elementos del DOM
  let elements = {};

  /**
   * Patrón onReady compatible con Turbo
   * Escucha múltiples eventos para asegurar inicialización correcta
   */
  function onReady(callback) {
    const fire = () => {
      // Solo inicializar si estamos en la página del verificador
      if (!document.getElementById('verificadorContainer')) {
        return;
      }
      callback();
    };
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fire, { once: true });
    } else {
      fire();
    }
    document.addEventListener('page:ready', fire);
    document.addEventListener('turbo:load', fire);
    document.addEventListener('turbo:render', fire);
    document.addEventListener('turbo:frame-load', fire);
  }
  
  // Inicializar cuando el DOM esté listo
  function init() {
    // Evitar doble inicialización
    if (initialized && elements.container) {
      console.log('[Verificador] Ya inicializado, omitiendo');
      return;
    }
    
    console.log('[Verificador] Inicializando...');
    
    // Cachear elementos
    elements = {
      container: document.getElementById('verificadorContainer'),
      btnOpenScanner: document.getElementById('btnOpenScanner'),
      btnCloseScanner: document.getElementById('btnCloseScanner'),
      btnClearSelection: document.getElementById('btnClearSelection'),
      searchInput: document.getElementById('searchInput'),
      searchResults: document.getElementById('searchResults'),
      selectedPartCard: document.getElementById('selectedPartCard'),
      selectedPartInfo: document.getElementById('selectedPartInfo'),
      webOnlyMessage: document.getElementById('webOnlyMessage'),
      noBarcodeAlert: document.getElementById('noBarcodeAlert'),
      scannerPanel: document.getElementById('scannerPanel'),
      scannerVideo: document.getElementById('scannerVideo'),
      scannerFlash: document.getElementById('scannerFlash'),
      scannerTargetName: document.getElementById('scannerTargetName'),
      scannerTargetCode: document.getElementById('scannerTargetCode'),
      scannerLastRead: document.getElementById('scannerLastRead'),
    };
    
    if (!elements.container) {
      console.log('[Verificador] Container no encontrado, no es página del verificador');
      return;
    }
    
    initialized = true;
    
    // Verificar si estamos en contexto nativo
    checkNativeContext();
    
    // Event listeners
    setupEventListeners();
    
    // Cargar resultados iniciales
    searchParts('');
    
    console.log('[Verificador] Inicializado correctamente');
  }
  
  /**
   * Verifica si estamos en la app nativa o en web
   */
  function checkNativeContext() {
    const isNative = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
    
    console.log('[Verificador] Contexto nativo:', isNative);
    
    if (!isNative) {
      // Mostrar mensaje de que solo funciona en app
      if (elements.webOnlyMessage) {
        elements.webOnlyMessage.classList.remove('d-none');
      }
      if (elements.btnOpenScanner) {
        elements.btnOpenScanner.disabled = true;
        elements.btnOpenScanner.innerHTML = '<i class="bi bi-phone"></i> Solo en app móvil';
      }
    }
  }
  
  /**
   * Configura los event listeners
   */
  function setupEventListeners() {
    // Botón abrir escáner
    if (elements.btnOpenScanner) {
      elements.btnOpenScanner.addEventListener('click', openScanner);
    }
    
    // Botón cerrar escáner
    if (elements.btnCloseScanner) {
      elements.btnCloseScanner.addEventListener('click', closeScanner);
    }
    
    // Botón quitar selección
    if (elements.btnClearSelection) {
      elements.btnClearSelection.addEventListener('click', clearSelection);
    }
    
    // Input de búsqueda
    if (elements.searchInput) {
      elements.searchInput.addEventListener('input', function(e) {
        clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = setTimeout(() => {
          searchParts(e.target.value);
        }, 300);
      });
    }
    
    // Delegación de clicks en resultados
    if (elements.searchResults) {
      elements.searchResults.addEventListener('click', function(e) {
        const item = e.target.closest('.search-result-item');
        if (item && !item.classList.contains('no-barcode')) {
          const partId = item.dataset.partId;
          const partData = JSON.parse(item.dataset.part || '{}');
          selectPart(partData);
        }
      });
    }
  }
  
  /**
   * Busca piezas en el backend
   */
  async function searchParts(query) {
    try {
      const url = new URL('/verificador/search/', window.location.origin);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '50');
      
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      
      if (!response.ok) throw new Error('Error en búsqueda');
      
      const data = await response.json();
      renderSearchResults(data.results || []);
      
    } catch (error) {
      console.error('[Verificador] Error buscando piezas:', error);
      if (elements.searchResults) {
        elements.searchResults.innerHTML = `
          <div class="alert alert-danger">
            <i class="bi bi-exclamation-triangle"></i> Error al buscar piezas
          </div>
        `;
      }
    }
  }
  
  /**
   * Renderiza los resultados de búsqueda
   */
  function renderSearchResults(results) {
    if (!elements.searchResults) return;
    
    if (results.length === 0) {
      elements.searchResults.innerHTML = `
        <div class="text-center text-muted py-4">
          <i class="bi bi-search fs-1"></i>
          <p class="mt-2">No se encontraron piezas con código de barras</p>
        </div>
      `;
      return;
    }
    
    let hasNoBarcodeItems = false;
    
    const html = results.map(part => {
      const hasBarcode = part.barcode && part.barcode.trim() !== '';
      if (!hasBarcode) hasNoBarcodeItems = true;
      
      const isSelected = state.selectedPart && state.selectedPart.id === part.id;
      const photoUrl = part.foto_url || '/static/parts/img/no-photo.svg';
      
      return `
        <div class="search-result-item ${!hasBarcode ? 'no-barcode' : ''} ${isSelected ? 'selected' : ''}"
             data-part-id="${part.id}"
             data-part='${JSON.stringify(part).replace(/'/g, "&#39;")}'>
          <img src="${photoUrl}" 
               alt="${part.name}" 
               class="result-photo"
               onerror="this.src='/static/parts/img/no-photo.svg'">
          <div class="result-info">
            <div class="result-name">${escapeHtml(part.name)}</div>
            <div class="result-meta">
              ${escapeHtml(part.auto)} • ${escapeHtml(part.workshop)}
            </div>
            ${hasBarcode 
              ? `<span class="result-barcode">${escapeHtml(part.barcode)}</span>` 
              : '<span class="text-muted small"><i class="bi bi-exclamation-circle"></i> Sin código</span>'
            }
          </div>
          ${part.sold ? '<span class="badge bg-secondary">Vendida</span>' : ''}
        </div>
      `;
    }).join('');
    
    elements.searchResults.innerHTML = html;
    
    // Mostrar alerta si hay items sin código
    if (elements.noBarcodeAlert) {
      elements.noBarcodeAlert.classList.toggle('d-none', !hasNoBarcodeItems);
    }
  }
  
  /**
   * Selecciona una pieza para buscar
   */
  function selectPart(part) {
    state.selectedPart = part;
    console.log('[Verificador] Pieza seleccionada:', part);
    
    // Mostrar card de pieza seleccionada
    if (elements.selectedPartCard) {
      elements.selectedPartCard.classList.remove('d-none');
    }
    
    if (elements.selectedPartInfo) {
      elements.selectedPartInfo.innerHTML = `
        <div class="d-flex align-items-center">
          <strong>${escapeHtml(part.name)}</strong>
        </div>
        <div class="small text-muted">${escapeHtml(part.auto)}</div>
        <div class="mt-1">
          <span class="badge bg-primary">
            <i class="bi bi-upc"></i> ${escapeHtml(part.barcode)}
          </span>
        </div>
      `;
    }
    
    // Re-renderizar resultados para mostrar selección
    searchParts(elements.searchInput?.value || '');
  }
  
  /**
   * Quita la selección actual
   */
  function clearSelection() {
    state.selectedPart = null;
    
    if (elements.selectedPartCard) {
      elements.selectedPartCard.classList.add('d-none');
    }
    
    // Re-renderizar resultados
    searchParts(elements.searchInput?.value || '');
  }
  
  /**
   * Abre el escáner nativo
   */
  async function openScanner() {
    console.log('[Verificador] Abriendo escáner...');
    
    // Verificar que tenemos Capacitor
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) {
      alert('El escáner solo está disponible en la app móvil.');
      return;
    }
    
    // Registrar el plugin si no existe
    if (!window.Capacitor.Plugins.MLKitScanner) {
      if (window.Capacitor.registerPlugin) {
        window.Capacitor.registerPlugin('MLKitScanner');
      }
    }
    
    const MLKitScanner = window.Capacitor.Plugins.MLKitScanner;
    
    if (!MLKitScanner) {
      alert('El plugin de escáner no está disponible.');
      return;
    }
    
    try {
      // Preparar parámetros
      const options = {
        continuous: true // Modo continuo para escanear múltiples códigos
      };
      
      if (state.selectedPart) {
        options.targetBarcode = state.selectedPart.barcode;
        options.targetName = state.selectedPart.name;
      }
      
      console.log('[Verificador] Opciones de escaneo:', options);
      
      // Listener para códigos escaneados (modo continuo)
      state.barcodeListener = await MLKitScanner.addListener(
        'barcodeScanned',
        handleBarcodeScanned
      );
      
      // Iniciar escaneo (lanza Activity nativa)
      state.isScanning = true;
      const result = await MLKitScanner.startScan(options);
      
      console.log('[Verificador] Resultado del escáner:', result);
      
      // Remover listener cuando se cierra
      if (state.barcodeListener) {
        state.barcodeListener.remove();
        state.barcodeListener = null;
      }
      
      state.isScanning = false;
      
      // Si no fue cancelado, procesar el resultado final
      if (result && !result.cancelled && result.barcode) {
        await processScannedBarcode(result.barcode, result.format, result.isMatch);
      }
      
    } catch (error) {
      console.error('[Verificador] Error abriendo escáner:', error);
      state.isScanning = false;
      if (state.barcodeListener) {
        state.barcodeListener.remove();
        state.barcodeListener = null;
      }
      alert('Error al abrir el escáner: ' + (error.message || error));
    }
  }
  
  /**
   * Cierra el escáner (ya no necesitamos esto porque la Activity se cierra sola)
   */
  async function closeScanner() {
    console.log('[Verificador] Cerrando escáner...');
    
    state.isScanning = false;
    
    // Remover listener
    if (state.barcodeListener) {
      state.barcodeListener.remove();
      state.barcodeListener = null;
    }
    
    // Llamar stopScan por si acaso
    try {
      if (window.Capacitor?.Plugins?.MLKitScanner) {
        await window.Capacitor.Plugins.MLKitScanner.stopScan();
      }
    } catch (error) {
      console.warn('[Verificador] Error deteniendo escáner:', error);
    }
  }
  
  /**
   * Actualiza la info mostrada en el escáner (ya no se usa con Activity separada)
   */
  function updateScannerInfo() {
    // Ya no necesario - la Activity maneja su propia UI
  }
  
  /**
   * Maneja un código escaneado (evento desde broadcast en modo continuo)
   */
  async function handleBarcodeScanned(event) {
    const { barcode, format, isMatch } = event;
    console.log('[Verificador] Código escaneado (broadcast):', barcode, format, isMatch);
    
    await processScannedBarcode(barcode, format, isMatch);
  }
  
  /**
   * Procesa un código de barras escaneado
   */
  async function processScannedBarcode(barcode, format, matchFromNative) {
    // Evitar procesar el mismo código repetidamente
    if (barcode === state.lastScannedCode) return;
    state.lastScannedCode = barcode;
    
    // Limpiar después de un tiempo para permitir re-escaneo
    setTimeout(() => {
      if (state.lastScannedCode === barcode) {
        state.lastScannedCode = null;
      }
    }, 2000);
    
    // Verificar si hay match (usar resultado nativo o calcular)
    const isMatch = matchFromNative || (state.selectedPart && state.selectedPart.barcode === barcode);
    
    console.log('[Verificador] Procesando código:', barcode, 'Match:', isMatch);
    
    // Registrar en el backend
    try {
      await logVerification(barcode, format, isMatch);
    } catch (error) {
      console.error('[Verificador] Error registrando verificación:', error);
    }
  }
  
  /**
   * Activa el feedback visual/háptico de match
   */
  function triggerMatchFeedback() {
    console.log('[Verificador] ¡MATCH!');
    
    // Flash verde
    if (elements.scannerFlash) {
      elements.scannerFlash.classList.add('active');
      setTimeout(() => {
        elements.scannerFlash.classList.remove('active');
      }, 500);
    }
    
    // Vibración (si está disponible)
    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100, 50, 100]);
    }
    
    // Sonido (opcional - comentado por ahora)
    // playMatchSound();
    
    // Actualizar texto
    if (elements.scannerLastRead) {
      elements.scannerLastRead.innerHTML = `
        <i class="bi bi-check-circle-fill text-success"></i>
        ¡COINCIDE! ${state.selectedPart.barcode}
      `;
    }
  }
  
  /**
   * Registra la verificación en el backend
   */
  async function logVerification(barcode, format, isMatch) {
    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content 
                     || document.querySelector('[name=csrfmiddlewaretoken]')?.value;
      
      const response = await fetch('/verificador/log/', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          codigo_escaneado: barcode,
          formato_codigo: format,
          pieza_buscada_id: state.selectedPart?.id || null,
          codigo_esperado: state.selectedPart?.barcode || '',
        }),
      });
      
      if (!response.ok) {
        throw new Error('Error registrando verificación');
      }
      
      const data = await response.json();
      console.log('[Verificador] Verificación registrada:', data);
      
      return data;
      
    } catch (error) {
      console.error('[Verificador] Error en logVerification:', error);
      throw error;
    }
  }
  
  /**
   * Escapa HTML para prevenir XSS
   */
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * Cleanup al salir de la página
   */
  function cleanup() {
    if (state.isScanning) {
      closeScanner();
    }
    initialized = false;
    elements = {};
  }

  // Usar patrón onReady compatible con Turbo
  onReady(init);
  
  // Limpiar al salir de la página
  document.addEventListener('turbo:before-render', cleanup);
  document.addEventListener('turbo:before-cache', cleanup);
  
})();
