(function () {
  'use strict';

  console.log('[scanner] Initializing ML Kit native scanner...');

  // ============================================================================
  // PLATFORM DETECTION
  // ============================================================================
  
  console.log('[scanner] 🔍 Checking Capacitor availability...');
  console.log('[scanner] window.Capacitor exists:', typeof window.Capacitor !== 'undefined');
  
  if (typeof window.Capacitor !== 'undefined') {
    console.log('[scanner] Capacitor.isNativePlatform():', window.Capacitor.isNativePlatform());
    console.log('[scanner] Capacitor.getPlatform():', window.Capacitor.getPlatform());
    console.log('[scanner] Capacitor.Plugins:', window.Capacitor.Plugins ? Object.keys(window.Capacitor.Plugins) : 'undefined');
  }
  
  const isNativePlatform = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
  
  if (!isNativePlatform) {
    console.warn('[scanner] Not on native platform - scanner features disabled');
    document.getElementById('scanner-status-banner')?.classList.remove('d-none');
    document.getElementById('scanner-status-banner')?.classList.add('alert-warning');
    document.getElementById('scanner-status-banner').textContent = 'Esta función requiere la app móvil';
    return;
  }

  // ============================================================================
  // MLKIT SCANNER INITIALIZATION
  // ============================================================================
  
  let mlkitScanner = null;
  
  async function initMLKitScanner() {
    console.log('[scanner] 🔍 initMLKitScanner() called');
    console.log('[scanner] mlkitScanner already exists:', mlkitScanner !== null);
    
    if (mlkitScanner) return mlkitScanner;
    
    // Native scanner ONLY (requires updated APK)
    console.log('[scanner] Checking window.MLKitNativeScanner...');
    console.log('[scanner] window.MLKitNativeScanner exists:', typeof window.MLKitNativeScanner !== 'undefined');
    
    if (window.MLKitNativeScanner) {
      try {
        console.log('[scanner] Creating new MLKitNativeScanner instance...');
        const nativeScanner = new window.MLKitNativeScanner();
        console.log('[scanner] Instance created, calling waitUntilReady(2000)...');
        
        const ready = await nativeScanner.waitUntilReady(2000);
        console.log('[scanner] waitUntilReady() returned:', ready);
        
        if (ready && nativeScanner.isSupported()) {
          console.log('[scanner] ✅ Native ML Kit scanner ready');
          mlkitScanner = nativeScanner;
          mlkitScanner._isNative = true;
          return mlkitScanner;
        }
      } catch (error) {
        console.warn('[scanner] Native scanner not available:', error.message);
      }
    }
    
    // No fallback - native only
    console.error('[scanner] ❌ Native scanner not available. Requires updated APK.');
    return null;
  }

  // ============================================================================
  // SEARCH INDEX
  // ============================================================================
  
  const initialPartsScript = document.getElementById('scan-initial-parts');
  const initialParts = initialPartsScript ? JSON.parse(initialPartsScript.textContent || '[]') : [];

  function normalizeText(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function normalizeBarcode(code) {
    return String(code || '').replace(/\s+/g, '').toUpperCase();
  }

  const SearchIndex = (() => {
    const store = new Map();
    const barcodeMap = new Map();

    const enrich = (part) => {
      const clone = { ...part };
      clone.photos = Array.isArray(clone.photos) ? clone.photos : [];
      clone._normalized = normalizeText(`${clone.name || ''} ${clone.auto || ''}`);
      clone._barcode = normalizeBarcode(clone.barcode);
      return clone;
    };

    return {
      bootstrap: (list) => {
        list.forEach(item => {
          const enriched = enrich(item);
          store.set(String(enriched.id), enriched);
          if (enriched._barcode) {
            barcodeMap.set(enriched._barcode, enriched);
          }
        });
      },
      
      search: (query) => {
        const normalized = normalizeText(query);
        return Array.from(store.values()).filter(part =>
          part._normalized.includes(normalized)
        );
      },
      
      findByBarcode: (code) => {
        return barcodeMap.get(normalizeBarcode(code)) || null;
      },
      
      all: () => Array.from(store.values()),
      count: () => store.size
    };
  })();

  SearchIndex.bootstrap(initialParts);
  console.log(`[scanner] SearchIndex loaded with ${SearchIndex.count()} parts`);

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================
  
  const state = {
    selectedParts: new Set(),
    isScanning: false,
    lastDetection: 0
  };

  // ============================================================================
  // DOM ELEMENTS
  // ============================================================================
  
  const els = {
    searchInput: document.getElementById('scanner-search-input'),
    resultsContainer: document.getElementById('scanner-results'),
    resultsStatus: document.getElementById('scanner-results-status'),
    statusBanner: document.getElementById('scanner-status-banner'),
    cameraStatus: document.getElementById('scanner-camera-status')
  };

  // ============================================================================
  // UI HELPERS
  // ============================================================================
  
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function setStatusBanner(message, type = 'info') {
    if (!els.statusBanner) return;
    els.statusBanner.textContent = message;
    els.statusBanner.className = `alert alert-${type}`;
    els.statusBanner.classList.remove('d-none');
  }

  function hideStatusBanner() {
    els.statusBanner?.classList.add('d-none');
  }

  function setCameraStatus(message) {
    if (els.cameraStatus) {
      els.cameraStatus.textContent = message;
    }
  }

  function setResultsStatus(message) {
    if (els.resultsStatus) {
      els.resultsStatus.textContent = message;
    }
  }

  // ============================================================================
  // RENDER RESULTS
  // ============================================================================
  
  function renderResults(parts) {
    if (!els.resultsContainer) return;

    if (!parts || parts.length === 0) {
      els.resultsContainer.innerHTML = '<p class="text-muted text-center py-3">No hay resultados</p>';
      return;
    }

    const html = parts.map(part => {
      const isSelected = state.selectedParts.has(part.id);
      return `
        <div class="card mb-2 ${isSelected ? 'border-primary' : ''}" 
             data-part-id="${part.id}"
             style="cursor: pointer;">
          <div class="card-body">
            <div class="d-flex justify-content-between align-items-start">
              <div class="flex-grow-1">
                <h6 class="card-title mb-1">
                  ${isSelected ? '<i class="fas fa-check-circle text-primary me-2"></i>' : ''}
                  ${escapeHtml(part.name || 'Sin nombre')}
                </h6>
                <p class="card-text small text-muted mb-0">
                  ${part.barcode ? `<strong>Código:</strong> ${escapeHtml(part.barcode)}<br>` : ''}
                  ${part.auto ? `<strong>Auto:</strong> ${escapeHtml(part.auto)}` : ''}
                </p>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    els.resultsContainer.innerHTML = html;
  }

  // ============================================================================
  // SEARCH FUNCTIONALITY
  // ============================================================================
  
  function performSearch(query) {
    if (!query || query.trim() === '') {
      const initial = SearchIndex.all().slice(0, 25);
      renderResults(initial);
      setResultsStatus(`Mostrando 25 de ${SearchIndex.count()} piezas`);
      return;
    }

    const results = SearchIndex.search(query);
    renderResults(results);
    setResultsStatus(`${results.length} resultado(s) encontrado(s)`);
  }

  // ============================================================================
  // PART SELECTION
  // ============================================================================
  
  function togglePartSelection(partId) {
    if (state.selectedParts.has(partId)) {
      state.selectedParts.delete(partId);
    } else {
      // Solo permitir seleccionar 1 pieza a la vez
      state.selectedParts.clear();
      state.selectedParts.add(partId);
    }

    // Re-render para actualizar checkmarks
    const currentQuery = els.searchInput?.value || '';
    performSearch(currentQuery);

    // Si hay pieza seleccionada, auto-iniciar cámara
    if (state.selectedParts.size > 0) {
      console.log('[scanner] Part selected, auto-starting camera...');
      setTimeout(() => {
        startCamera();
      }, 300);
    }
  }

  // ============================================================================
  // CAMERA FUNCTIONS
  // ============================================================================
  
  async function startCamera() {
    console.log('[scanner] 🎥 startCamera() called');
    console.log('[scanner] state.isScanning:', state.isScanning);
    console.log('[scanner] state.selectedParts.size:', state.selectedParts.size);
    
    if (state.isScanning) {
      console.log('[scanner] Already scanning');
      return;
    }

    if (state.selectedParts.size === 0) {
      console.log('[scanner] No parts selected, showing warning');
      setStatusBanner('Selecciona al menos una pieza primero', 'warning');
      return;
    }

    console.log('[scanner] Calling initMLKitScanner()...');
    const scanner = await initMLKitScanner();
    console.log('[scanner] initMLKitScanner() returned:', scanner !== null);
    
    if (!scanner) {
      console.error('[scanner] Scanner is null, cannot proceed');
      setStatusBanner('Escáner no disponible', 'danger');
      return;
    }

    try {
      console.log('[scanner] Scanner available, setting status...');
      setCameraStatus('Iniciando escáner...');
      setStatusBanner('Escaneando... (toca aquí para cerrar)', 'info');
      
      // Make status banner clickable to close scanner
      if (els.statusBanner) {
        els.statusBanner.style.cursor = 'pointer';
        els.statusBanner.onclick = () => {
          console.log('[scanner] User clicked banner to close');
          stopCamera();
        };
      }

      console.log('[scanner] Activating fullscreen mode...');
      document.body.classList.add('scanner-fullscreen-active');
      
      // Safety timeout - if camera doesn't work in 5 seconds, show error
      const safetyTimeout = setTimeout(() => {
        console.warn('[scanner] ⚠️ Safety timeout reached - camera may not be working');
        setStatusBanner('⚠️ Cámara no responde. Toca para cerrar.', 'warning');
      }, 5000);

      console.log('[scanner] Calling scanner.startScan()...');
      await scanner.startScan((result) => {
        clearTimeout(safetyTimeout);
        console.log('[scanner] Detected:', result.value);
        handleDecodedValue(result.value);
      });
      
      clearTimeout(safetyTimeout);

      state.isScanning = true;
      setCameraStatus('Escáner activo');
      console.log('[scanner] ✅ Camera started successfully');

    } catch (error) {
      console.error('[scanner] ❌ Error starting camera:', error);
      console.log('[scanner] Error name:', error.name);
      console.log('[scanner] Error message:', error.message);
      console.log('[scanner] Error stack:', error.stack);
      setStatusBanner('Error al iniciar cámara: ' + error.message, 'danger');
      document.body.classList.remove('scanner-fullscreen-active');
    }
  }

  function stopCamera() {
    if (mlkitScanner) {
      mlkitScanner.stopScan().catch(err => {
        console.warn('[scanner] Error stopping:', err);
      });
    }

    state.isScanning = false;
    document.body.classList.remove('scanner-fullscreen-active');
    setCameraStatus('Cámara detenida');
    hideStatusBanner();
    console.log('[scanner] Camera stopped');
  }

  // ============================================================================
  // BARCODE HANDLING
  // ============================================================================
  
  function handleDecodedValue(rawValue) {
    const now = Date.now();
    
    // Debounce: evitar procesar el mismo código muy rápido
    if (now - state.lastDetection < 2000) {
      return;
    }
    state.lastDetection = now;

    const part = SearchIndex.findByBarcode(rawValue);
    
    if (part && state.selectedParts.has(part.id)) {
      // ✅ CÓDIGO CORRECTO
      console.log('[scanner] ✅ CORRECT barcode:', rawValue, part.name);
      
      // Feedback
      if (window.ScannerFeedback) {
        window.ScannerFeedback.success();
      }
      
      setStatusBanner(`✅ ¡CORRECTO! ${part.name}`, 'success');
      
      // Detener cámara después de 1.5 segundos
      setTimeout(() => {
        stopCamera();
        state.selectedParts.clear();
        performSearch('');
      }, 1500);
      
    } else if (part) {
      // ⚠️ CÓDIGO ENCONTRADO PERO NO ES EL SELECCIONADO
      console.log('[scanner] ⚠️ Wrong part:', rawValue, part.name);
      
      if (window.ScannerFeedback) {
        window.ScannerFeedback.warning();
      }
      
      setStatusBanner(`⚠️ Ese es: ${part.name} (no es el seleccionado)`, 'warning');
      
    } else {
      // ❌ CÓDIGO NO ENCONTRADO
      console.log('[scanner] ❌ Unknown barcode:', rawValue);
      
      if (window.ScannerFeedback) {
        window.ScannerFeedback.error();
      }
      
      setStatusBanner(`❌ Código no encontrado: ${rawValue}`, 'danger');
    }
  }

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================
  
  if (els.searchInput) {
    els.searchInput.addEventListener('input', (e) => {
      performSearch(e.target.value);
    });
  }

  // Event delegation para clicks en piezas
  if (els.resultsContainer) {
    els.resultsContainer.addEventListener('click', (e) => {
      const card = e.target.closest('[data-part-id]');
      if (card) {
        const partId = parseInt(card.dataset.partId, 10);
        togglePartSelection(partId);
      }
    });
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  
  if (SearchIndex.count() > 0) {
    const initial = SearchIndex.all().slice(0, 25);
    renderResults(initial);
    setResultsStatus(`Mostrando 25 de ${SearchIndex.count()} piezas disponibles`);
  }

  console.log('[scanner] ML Kit native scanner initialized');

})();
