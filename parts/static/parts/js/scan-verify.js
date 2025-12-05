(function () {
  'use strict';

  // ============================================================================
  // DEBUG LOGGING
  // ============================================================================
  
  const debugLogs = [];
  const maxLogs = 50;
  
  function debugLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    
    debugLogs.push(logEntry);
    if (debugLogs.length > maxLogs) {
      debugLogs.shift();
    }
    
    // Actualizar panel de logs
    const logsPanel = document.getElementById('debug-logs');
    if (logsPanel) {
      logsPanel.innerHTML = debugLogs.map(log => `<div>${log}</div>`).join('');
      logsPanel.scrollTop = logsPanel.scrollHeight;
    }
    
    // También log a consola
    console.log(`[scanner-debug] ${message}`);
  }

  // ============================================================================
  // PLATFORM DETECTION
  // ============================================================================
  
  const isNativePlatform = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
  const isAndroid = isNativePlatform && window.Capacitor.getPlatform() === 'android';
  const HAVE_ENOUGH_DATA = typeof HTMLMediaElement !== 'undefined'
    ? HTMLMediaElement.HAVE_ENOUGH_DATA
    : 4;
  
  debugLog(`Platform: ${isNativePlatform ? 'Native Mobile' : 'Web Browser'}`);
  console.log('[scanner] Platform:', isNativePlatform ? 'Native Mobile' : 'Web Browser');
  if (isNativePlatform) {
    debugLog(`Platform Details: ${window.Capacitor.getPlatform()}`);
    console.log('[scanner] Platform Details:', window.Capacitor.getPlatform());
  }

  // ============================================================================
  // ML KIT SCANNER INITIALIZATION
  // ============================================================================
  
  let mlKitScanner = null;
  
  async function initMLKitScanner() {
    if (mlKitScanner !== null) {
      const ready = await mlKitScanner.waitUntilReady();
      if (ready) {
        debugLog('Scanner ya inicializado previamente');
        return mlKitScanner;  // Ya inicializado
      }
      debugLog('Instancia previa encontrada pero todavía no está lista, reintentando');
    }
    
    if (!isNativePlatform) {
      debugLog('No es plataforma nativa');
      console.log('[scanner] Not on native platform, skipping ML Kit');
      return null;
    }
    
    debugLog('Verificando window.MLKitNativeScanner...');
    if (!window.MLKitNativeScanner) {
      debugLog('ERROR: window.MLKitNativeScanner NO existe');
      debugLog('Script mlkit-native-scanner.js no cargó correctamente');
      console.error('[scanner] ❌ MLKitNativeScanner class not found');
      console.error('[scanner] Check that mlkit-native-scanner.js loaded correctly');
      return null;
    }
    
    debugLog('window.MLKitNativeScanner existe ✓');
    
    try {
      debugLog('Creando instancia de MLKitNativeScanner...');
      mlKitScanner = new window.MLKitNativeScanner();
      debugLog('Instancia creada ✓');
      
      debugLog('Esperando a que el plugin nativo esté disponible...');
      const supported = await mlKitScanner.waitUntilReady();
      debugLog(`isSupported() = ${supported}`);
      
      if (supported) {
        debugLog('ML Kit Scanner DISPONIBLE y listo ✓✓✓');
        console.log('[scanner] ✅ ML Kit BUNDLED Native Scanner initialized and ready');
        return mlKitScanner;
      } else {
        debugLog('ERROR: isSupported() retornó false');
        debugLog('El plugin NO está compilado en esta APK');
        console.error('[scanner] ❌ ML Kit plugin initialized but NOT supported');
        console.error('[scanner] This APK does NOT have MLKitScannerPlugin compiled');
        mlKitScanner = null;
        return null;
      }
    } catch (error) {
      debugLog(`ERROR al inicializar: ${error.message}`);
      debugLog(`Stack: ${error.stack}`);
      console.error('[scanner] ❌ Error initializing ML Kit:', error);
      mlKitScanner = null;
      return null;
    }
  }

  // ============================================================================
  // INITIAL DATA & SEARCH INDEX
  // ============================================================================
  
  const initialPartsScript = document.getElementById('scan-initial-parts');
  let initialParts = [];
  
  if (initialPartsScript) {
    try {
      initialParts = JSON.parse(initialPartsScript.textContent || '[]');
      console.log('[scanner] Loaded', initialParts.length, 'initial parts from script tag');
    } catch (e) {
      console.error('[scanner] Failed to parse initial parts:', e);
      initialParts = [];
    }
  } else {
    console.warn('[scanner] #scan-initial-parts script tag not found');
  }

  function normalizeText(text) {
    if (!text) return '';
    return String(text)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function normalizeBarcode(code) {
    if (!code) return '';
    return String(code).replace(/\s+/g, '').toUpperCase();
  }

  const SearchIndex = (() => {
    const store = new Map();
    const barcodeMap = new Map();

    const enrich = (part) => {
      if (!part) return null;
      const clone = { ...part };
      clone.photos = Array.isArray(clone.photos) ? clone.photos : [];
      clone._normalized = normalizeText(`${clone.name || ''} ${clone.auto || ''}`);
      clone._barcode = normalizeBarcode(clone.barcode);
      clone._hasPhoto = clone.photos.length > 0;
      return clone;
    };

    const upsert = (list) => {
      if (!Array.isArray(list)) return;
      list.forEach((item) => {
        const enriched = enrich(item);
        if (!enriched) return;
        store.set(String(enriched.id), enriched);
        if (enriched._barcode) {
          barcodeMap.set(enriched._barcode, enriched);
        }
      });
    };

    const all = () => Array.from(store.values());

    const compareUpdated = (a, b) => {
      const aTs = Date.parse(a.updated_at || '') || 0;
      const bTs = Date.parse(b.updated_at || '') || 0;
      return aTs - bTs;
    };

    const search = (term, limit = 25) => {
      const normalized = normalizeText(term);
      if (!normalized) {
        return all().slice(0, limit);
      }
      const stripped = normalized.replace(/\s+/g, '');
      const tokens = normalized.split(/\s+/).filter(Boolean);
      const scored = [];
      store.forEach((part) => {
        let score = 0;
        if (stripped && part._barcode && part._barcode.startsWith(stripped)) {
          score += 15;
        }
        if (normalized && part._normalized.includes(normalized)) {
          score += 8;
        }
        tokens.forEach((tok) => {
          if (tok && part._normalized.includes(tok)) {
            score += 2;
          }
        });
        if (score > 0) {
          scored.push({ part, score });
        }
      });
      scored.sort((a, b) => (b.score - a.score) || compareUpdated(b.part, a.part));
      return scored.slice(0, limit).map((entry) => entry.part);
    };

    return {
      bootstrap(list) {
        upsert(list);
      },
      upsert,
      search,
      get(partId) {
        return store.get(String(partId)) || null;
      },
      findByBarcode(barcode) {
        if (!barcode) return null;
        const normalized = normalizeBarcode(barcode);
        return barcodeMap.get(normalized) || null;
      },
      count() {
        return store.size;
      },
      all,
    };
  })();

  SearchIndex.bootstrap(initialParts || []);

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================
  
  const state = {
    lastSuccessfulDetection: 0,
    detectionCooldown: 2000, // 2 segundos de pausa después de detectar
    lastDetectedCode: null,
    scannerState: 'SCANNING', // SCANNING | DETECTED | CONFIRMED
    cameraStatus: 'Esperando...',
    filtered: [],
    searchQuery: '',
    selectedParts: new Set(), // IDs de piezas seleccionadas para búsqueda
    webScannerActive: false,
    mediaStream: null,
    frameRequestId: null,
    barcodeDetector: null,
    webDetectionInFlight: false,
    detectorFormats: [
      'ean_13',
      'ean_8',
      'code_128',
      'code_39',
      'codabar',
      'upc_a',
      'upc_e',
      'itf',
      'qr_code',
    ],
    overlayCtx: null,
    captureCanvas: null,
    captureCtx: null,
    zxingReader: null,
    zxingContinuousReader: null,
    zxingContinuousActive: false,
  };

  // ============================================================================
  // DOM ELEMENTS
  // ============================================================================
  
  const els = {
    toggleCameraBtn: document.getElementById('scanner-toggle-camera-btn'),
    stopCameraBtn: document.getElementById('scanner-stop-camera-btn'),
    cameraStatus: document.getElementById('camera-status'),
    statusBanner: document.querySelector('.scanner-status-banner'),
    resultsContainer: document.getElementById('scanner-results'),
    resultsStatus: document.getElementById('scanner-results-status'),
    searchInput: document.getElementById('scanner-search-input'),
    voiceBtn: document.getElementById('scanner-voice-btn'),
    voiceStatus: document.getElementById('scanner-voice-status'),
    workspace: document.getElementById('scanner-workspace'),
    searchShell: document.getElementById('scanner-search-shell'),
    pieceName: document.getElementById('scanner-piece-name'),
    video: document.getElementById('scanner-video'),
    overlay: document.getElementById('scanner-overlay'),
  };

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================
  
  function setCameraStatus(text) {
    if (els.cameraStatus) {
      els.cameraStatus.textContent = text;
    }
    state.cameraStatus = text;
  }

  function setStatusBanner(message, variant = 'info') {
    if (!els.statusBanner) return;
    els.statusBanner.textContent = message;
    els.statusBanner.classList.remove('d-none', 'scanner-status-success', 'scanner-status-warning');
    if (variant === 'success') {
      els.statusBanner.classList.add('scanner-status-success');
    } else if (variant === 'warning') {
      els.statusBanner.classList.add('scanner-status-warning');
    }
  }

  function hideStatusBanner() {
    if (els.statusBanner) {
      els.statusBanner.classList.add('d-none');
    }
  }

  function setResultsStatus(message, variant = 'muted') {
    if (!els.resultsStatus) return;
    els.resultsStatus.textContent = message;
    els.resultsStatus.classList.remove('text-muted', 'text-success', 'text-danger');
    if (variant === 'success') {
      els.resultsStatus.classList.add('text-success');
    } else if (variant === 'danger') {
      els.resultsStatus.classList.add('text-danger');
    } else {
      els.resultsStatus.classList.add('text-muted');
    }
  }

  function getSelectedPartInfo() {
    const selectedPartId = Array.from(state.selectedParts)[0];
    const selectedPart = selectedPartId ? SearchIndex.get(selectedPartId) : null;
    return {
      id: selectedPartId || null,
      name: selectedPart ? selectedPart.name : 'Sin seleccionar',
    };
  }

  function enterScannerUi(partName) {
    if (els.workspace) {
      els.workspace.classList.remove('d-none');
      debugLog('Workspace mostrado ✓');
      console.log('[scanner] Workspace shown');
    } else {
      debugLog('ERROR: workspace element no encontrado');
    }

    if (els.searchShell) {
      els.searchShell.classList.add('d-none');
      debugLog('Search shell ocultado ✓');
      console.log('[scanner] Search shell hidden');
    } else {
      debugLog('ERROR: searchShell element no encontrado');
    }

    if (els.pieceName) {
      els.pieceName.textContent = partName;
      debugLog('Nombre de pieza actualizado ✓');
      console.log('[scanner] Piece name set to:', partName);
    }

    if (document.body) {
      document.body.classList.add('scanner-fullscreen-active');
      debugLog('Modo pantalla completa activado ✓');
      console.log('[scanner] Fullscreen mode activated');
    }

    if (els.toggleCameraBtn) {
      els.toggleCameraBtn.disabled = true;
      els.toggleCameraBtn.setAttribute('aria-busy', 'true');
    }
  }

  function leaveScannerUi() {
    if (els.workspace) {
      els.workspace.classList.add('d-none');
    }
    if (els.searchShell) {
      els.searchShell.classList.remove('d-none');
    }
    if (document.body) {
      document.body.classList.remove('scanner-fullscreen-active');
    }
    if (els.toggleCameraBtn) {
      els.toggleCameraBtn.disabled = false;
      els.toggleCameraBtn.removeAttribute('aria-busy');
    }
  }

  function ensureOverlayContext() {
    if (!els.overlay) return null;
    const width = els.video?.videoWidth || els.overlay.clientWidth || 0;
    const height = els.video?.videoHeight || els.overlay.clientHeight || 0;
    if (!width || !height) {
      return null;
    }
    if (!state.overlayCtx) {
      state.overlayCtx = els.overlay.getContext('2d');
    }
    if (els.overlay.width !== width || els.overlay.height !== height) {
      els.overlay.width = width;
      els.overlay.height = height;
    }
    return state.overlayCtx;
  }

  function clearOverlay() {
    const ctx = ensureOverlayContext();
    if (!ctx) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  function drawBoundingBox(box) {
    const ctx = ensureOverlayContext();
    if (!ctx || !box) return;
    clearOverlay();
    ctx.strokeStyle = '#00ffb2';
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
  }

  function getCaptureContext(videoElement) {
    if (!state.captureCanvas) {
      state.captureCanvas = document.createElement('canvas');
      state.captureCtx = state.captureCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!state.captureCanvas || !state.captureCtx || !videoElement) {
      return null;
    }
    const width = videoElement.videoWidth || 0;
    const height = videoElement.videoHeight || 0;
    if (!width || !height) {
      return null;
    }
    if (state.captureCanvas.width !== width || state.captureCanvas.height !== height) {
      state.captureCanvas.width = width;
      state.captureCanvas.height = height;
    }
    return state.captureCtx;
  }

  function scaleBoundingBox(box) {
    if (!box) return null;
    const overlayWidth = els.overlay?.width || els.video?.videoWidth || 1;
    const overlayHeight = els.overlay?.height || els.video?.videoHeight || 1;
    const videoWidth = els.video?.videoWidth || overlayWidth;
    const videoHeight = els.video?.videoHeight || overlayHeight;
    const scaleX = overlayWidth / videoWidth;
    const scaleY = overlayHeight / videoHeight;
    return {
      x: box.x * scaleX,
      y: box.y * scaleY,
      width: Math.max(2, box.width * scaleX),
      height: Math.max(2, box.height * scaleY),
    };
  }

  function setupZxingReaders() {
    if (state.zxingReader) {
      return true;
    }
    if (typeof window.ZXingBrowser === 'undefined') {
      debugLog('ZXingBrowser no está disponible en esta build');
      return false;
    }
    try {
      const hints = new Map();
      const formats = [
        window.ZXingBrowser.BarcodeFormat.CODE_128,
        window.ZXingBrowser.BarcodeFormat.CODE_39,
        window.ZXingBrowser.BarcodeFormat.EAN_13,
        window.ZXingBrowser.BarcodeFormat.EAN_8,
        window.ZXingBrowser.BarcodeFormat.UPC_A,
        window.ZXingBrowser.BarcodeFormat.UPC_E,
        window.ZXingBrowser.BarcodeFormat.ITF,
        window.ZXingBrowser.BarcodeFormat.QR_CODE,
      ];
      hints.set(window.ZXingBrowser.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(window.ZXingBrowser.DecodeHintType.TRY_HARDER, true);
      hints.set(window.ZXingBrowser.DecodeHintType.PURE_BARCODE, false);
      state.zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader(hints, 400);
      state.zxingContinuousReader = new window.ZXingBrowser.BrowserMultiFormatContinuousReader(hints, 400);
      debugLog('ZXing JS inicializado ✓');
      return true;
    } catch (error) {
      console.warn('[scanner] Error inicializando ZXingBrowser', error);
      debugLog(`ZXing JS no se pudo inicializar: ${error.message}`);
      state.zxingReader = null;
      state.zxingContinuousReader = null;
      return false;
    }
  }

  function startZxingContinuous() {
    if (!setupZxingReaders() || !els.video || state.zxingContinuousActive) {
      return;
    }
    try {
      state.zxingContinuousReader.decodeFromVideoElementContinuously(els.video, (result, err) => {
        if (result) {
          const points = typeof result.getResultPoints === 'function' ? result.getResultPoints() : null;
          const bbox = bboxFromPoints(points);
          if (bbox) {
            drawBoundingBox(bbox);
          }
          handleDecodedValue(
            (typeof result.getText === 'function' && result.getText()) || result.text || '',
            bbox,
            'zxing-js',
            points || null
          );
        } else if (err && !(err instanceof window.ZXingBrowser.NotFoundException)) {
          console.warn('[scanner] ZXing continuous error:', err);
        }
      });
      state.zxingContinuousActive = true;
      debugLog('ZXing continuo iniciado');
    } catch (error) {
      console.warn('[scanner] No se pudo iniciar ZXing continuo', error);
      debugLog(`ZXing continuo falló: ${error.message}`);
    }
  }

  function stopZxingContinuous() {
    if (state.zxingContinuousReader && state.zxingContinuousActive) {
      try {
        state.zxingContinuousReader.stopContinuousDecode();
      } catch (_err) {
        /* ignore */
      }
    }
    state.zxingContinuousActive = false;
  }

  function bboxFromPoints(points) {
    if (!points || !points.length) {
      return null;
    }
    const getCoord = (point) => {
      if (!point) return { x: 0, y: 0 };
      const x = typeof point.getX === 'function' ? point.getX() : point.x || 0;
      const y = typeof point.getY === 'function' ? point.getY() : point.y || 0;
      return { x, y };
    };
    const scaled = points.map(getCoord);
    const xs = scaled.map((p) => p.x);
    const ys = scaled.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const overlayWidth = els.overlay?.width || els.video?.videoWidth || 1;
    const overlayHeight = els.overlay?.height || els.video?.videoHeight || 1;
    const videoWidth = els.video?.videoWidth || overlayWidth;
    const videoHeight = els.video?.videoHeight || overlayHeight;
    const scaleX = overlayWidth / videoWidth;
    const scaleY = overlayHeight / videoHeight;
    return {
      x: minX * scaleX,
      y: minY * scaleY,
      width: Math.max(2, (maxX - minX) * scaleX),
      height: Math.max(2, (maxY - minY) * scaleY),
    };
  }

  // ============================================================================
  // BARCODE PROCESSING
  // ============================================================================
  
  async function handleDecodedValue(rawValue, bbox, source, cornerPoints) {
    if (!rawValue) return;

    const now = Date.now();
    const timeSinceLastDetection = now - state.lastSuccessfulDetection;

    // Cooldown de 2 segundos
    if (state.lastSuccessfulDetection > 0 && timeSinceLastDetection < state.detectionCooldown) {
      const remainingSeconds = Math.ceil((state.detectionCooldown - timeSinceLastDetection) / 1000);
      setStatusBanner(`Esperando ${remainingSeconds}s antes de continuar…`, 'info');
      return;
    }

    // Evitar duplicados del mismo código
    if (rawValue === state.lastDetectedCode && timeSinceLastDetection < 5000) {
      console.log('[scanner] Duplicate code ignored:', rawValue);
      return;
    }

    console.log('[scanner] Processing barcode:', rawValue, 'from', source);

    state.lastDetectedCode = rawValue;
    state.lastSuccessfulDetection = now;
    state.scannerState = 'DETECTED';

    // Feedback visual/sonoro
    if (window.scannerFeedback) {
      window.scannerFeedback.onBarcodeDetected();
    }

    setStatusBanner('✓ Código detectado', 'success');

    // Si hay una pieza seleccionada, verificar que el código coincida
    if (state.selectedParts.size > 0) {
      const part = SearchIndex.findByBarcode(rawValue);
      
      if (part && state.selectedParts.has(part.id)) {
        state.scannerState = 'CONFIRMED';
        setStatusBanner(`✅ ¡CORRECTO! ${part.name}`, 'success');
        setResultsStatus(`✓ Código correcto`, 'success');
        
        if (window.scannerFeedback) {
          window.scannerFeedback.onSuccess();
        }
        
        displayPartResult(part);
        console.log('[scanner] ✓ Barcode matches selected part:', part);
        return;
      } else {
        setStatusBanner('❌ Este código NO es el de la pieza buscada', 'warning');
        setResultsStatus('Código incorrecto - Sigue escaneando', 'danger');
        
        if (window.scannerFeedback) {
          window.scannerFeedback.onError();
        }
        
        setTimeout(() => {
          state.scannerState = 'SCANNING';
          hideStatusBanner();
        }, 1500);
        return;
      }
    }

    // Buscar en SearchIndex completo si no hay selección
    const localPart = SearchIndex.findByBarcode(rawValue);
    if (localPart) {
      state.scannerState = 'CONFIRMED';
      setStatusBanner(`✓ ${localPart.name}`, 'success');
      setResultsStatus(`Encontrado: ${localPart.name}`, 'success');
      
      if (window.scannerFeedback) {
        window.scannerFeedback.onSuccess();
      }
      
      displayPartResult(localPart);
      console.log('[scanner] Found in SearchIndex:', localPart);
      
      setTimeout(() => {
        state.scannerState = 'SCANNING';
        hideStatusBanner();
      }, 2000);
      return;
    }

    // Buscar en backend como último recurso
    try {
      const response = await fetch(`/parts/scan-verify/barcode/?barcode=${encodeURIComponent(rawValue)}`, {
        method: 'GET',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.found) {
        state.scannerState = 'CONFIRMED';
        setStatusBanner(`✓ ${data.part.name}`, 'success');
        setResultsStatus(`Encontrado: ${data.part.name}`, 'success');
        
        // Feedback de éxito
        if (window.scannerFeedback) {
          window.scannerFeedback.onSuccess();
        }

        // Mostrar resultado en UI
        displayPartResult(data.part);
      } else {
        setStatusBanner('⚠ Código no encontrado en inventario', 'warning');
        setResultsStatus('No encontrado', 'danger');
        
        if (window.scannerFeedback) {
          window.scannerFeedback.onError();
        }
      }
    } catch (error) {
      console.error('[scanner] Error fetching barcode:', error);
      setStatusBanner('Error al buscar código', 'warning');
      setResultsStatus('Error de conexión', 'danger');
    }

    // Resetear a SCANNING después de 2s
    setTimeout(() => {
      state.scannerState = 'SCANNING';
      hideStatusBanner();
    }, 2000);
  }

  function displayPartResult(part) {
    if (!els.resultsContainer) return;

    const resultHTML = `
      <div class="card mb-2">
        <div class="card-body">
          <h6 class="card-title">${escapeHtml(part.name)}</h6>
          <p class="card-text">
            <strong>Código:</strong> ${escapeHtml(part.barcode)}<br>
            ${part.stock_quantity !== undefined ? `<strong>Stock:</strong> ${part.stock_quantity}<br>` : ''}
            ${part.location ? `<strong>Ubicación:</strong> ${escapeHtml(part.location)}<br>` : ''}
          </p>
        </div>
      </div>
    `;

    els.resultsContainer.innerHTML = resultHTML;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================================================
  // SEARCH FUNCTIONALITY
  // ============================================================================
  
  function performSearch(query) {
    state.searchQuery = query;
    
    if (!query || query.trim().length === 0) {
      state.filtered = [];
      renderResults([]);
      setResultsStatus(`${SearchIndex.count()} piezas disponibles`, 'muted');
      return;
    }

    const results = SearchIndex.search(query, 25);
    state.filtered = results;
    renderResults(results);
    
    if (results.length > 0) {
      setResultsStatus(`${results.length} coincidencia${results.length !== 1 ? 's' : ''}`, 'success');
    } else {
      setResultsStatus('No se encontraron resultados', 'muted');
    }
  }

  function renderResults(parts) {
    if (!els.resultsContainer) return;

    if (!parts || parts.length === 0) {
      els.resultsContainer.innerHTML = '<p class="text-muted text-center p-3">No hay resultados</p>';
      return;
    }

    const html = parts.map(part => {
      const isSelected = state.selectedParts.has(part.id);
      return `
      <div class="scanner-result-item ${isSelected ? 'active' : ''}" 
           data-part-id="${part.id}"
           data-barcode="${escapeHtml(part.barcode || '')}"
           role="option"
           aria-selected="${isSelected}"
           tabindex="0">
        <div class="scanner-result-main">
          <div class="scanner-result-title">${escapeHtml(part.name || 'Sin nombre')}</div>
          <div class="scanner-result-meta">
            ${part.barcode ? `<span class="badge bg-primary">${escapeHtml(part.barcode)}</span>` : ''}
            ${part.auto ? `<span class="badge bg-secondary">${escapeHtml(part.auto)}</span>` : ''}
            ${part.stock_quantity !== undefined ? `<span class="badge bg-info">Stock: ${part.stock_quantity}</span>` : ''}
          </div>
        </div>
        <div class="scanner-result-action">
          <i class="fas ${isSelected ? 'fa-check-circle text-primary' : 'fa-circle text-muted'}"></i>
        </div>
      </div>
      `;
    }).join('');

    els.resultsContainer.innerHTML = html;
    console.log('[scanner:renderResults] Rendered', parts.length, 'parts');
  }

  function togglePartSelection(itemElement) {
    const partId = parseInt(itemElement.dataset.partId);
    const barcode = itemElement.dataset.barcode;
    const partName = itemElement.querySelector('.scanner-result-title')?.textContent || 'pieza';
    
    debugLog(`Click en pieza: ${partName} (ID: ${partId})`);
    
    if (!partId) {
      debugLog('ERROR: partId inválido');
      return;
    }
    
    console.log('[scanner:togglePartSelection] Clicked part:', partId, barcode, partName);
    
    // Limpiar selección anterior
    state.selectedParts.clear();
    document.querySelectorAll('.scanner-result-item.active').forEach(item => {
      item.classList.remove('active');
      item.setAttribute('aria-selected', 'false');
      item.querySelector('.scanner-result-action i').className = 'fas fa-circle text-muted';
    });
    
    // Seleccionar solo esta pieza
    state.selectedParts.add(partId);
    itemElement.classList.add('active');
    itemElement.setAttribute('aria-selected', 'true');
    itemElement.querySelector('.scanner-result-action i').className = 'fas fa-check-circle text-primary';
    
    debugLog(`Pieza seleccionada: ${partName}`);
    debugLog('Iniciando cámara en 300ms...');
    
    console.log('[scanner:togglePartSelection] Part selected, selectedParts:', Array.from(state.selectedParts));
    console.log('[scanner:togglePartSelection] Starting camera in 300ms...');
    
    // Iniciar cámara automáticamente
    setStatusBanner(`🎯 Buscando: ${partName}`, 'info');
    setTimeout(() => {
      debugLog('Timeout cumplido, llamando startCamera()');
      console.log('[scanner:togglePartSelection] Timeout elapsed, calling startCamera()');
      startCamera();
    }, 300);
  }

  function updateSelectionStatus() {
    if (state.selectedParts.size > 0) {
      setResultsStatus('Pieza seleccionada - Iniciando escáner...', 'success');
    } else {
      const totalParts = state.filtered.length || SearchIndex.count();
      setResultsStatus(`Mostrando ${Math.min(25, totalParts)} de ${totalParts} piezas disponibles`, 'muted');
    }
  }

  // ============================================================================
  // CAMERA CONTROL
  // ============================================================================
  
  async function startCamera() {
    debugLog('--- startCamera() INICIADO ---');
    console.log('[scanner:startCamera] Starting...');
    
    const { name: partName } = getSelectedPartInfo();
    
    try {
      if (!isNativePlatform) {
        debugLog('No es plataforma nativa, activando fallback web');
        await startWebScanner(partName);
        return;
      }
      
      debugLog('Plataforma nativa detectada ✓');
      debugLog('Inicializando scanner...');
      
      const scanner = await initMLKitScanner();
      if (scanner) {
        await startNativeScannerFlow(scanner, partName);
        return;
      }
      
      debugLog('Scanner nativo no disponible. Activando fallback web.');
      await startWebScanner(partName);
    } catch (error) {
      debugLog(`ERROR general en startCamera: ${error.message}`);
      console.error('[scanner] startCamera error:', error);
      setCameraStatus('No se pudo iniciar el escáner: ' + error.message);
      setStatusBanner('Error al iniciar escáner', 'warning');
      leaveScannerUi();
    }
  }

  async function startNativeScannerFlow(scanner, partName) {
    enterScannerUi(partName);
    debugLog('Scanner inicializado ✓');
    console.log('[scanner] Using ML Kit BUNDLED Native Scanner (continuous mode)');
    
    try {
      setCameraStatus('Iniciando escáner ML Kit...');
      debugLog('Solicitando permisos y iniciando scan...');
      console.log('[scanner] Requesting camera permissions and starting scan...');
      
      await scanner.startScan((result) => {
        debugLog(`Código detectado: ${result.value}`);
        console.log('[scanner] ML Kit detected:', result);
        handleDecodedValue(result.value, null, 'mlkit-native', result.cornerPoints || null);
      });
      
      setCameraStatus('Escáner activo - Apunta al código de barras');
      setStatusBanner('Escaneando...', 'info');
      debugLog('Scanner nativo iniciado exitosamente ✓');
      if (els.stopCameraBtn) {
        els.stopCameraBtn.disabled = false;
      }
    } catch (error) {
      debugLog(`ERROR al iniciar nativo: ${error.message}`);
      console.error('[scanner] ML Kit error:', error);
      setCameraStatus('Error en escáner nativo: ' + error.message);
      setStatusBanner('Error al iniciar escáner', 'warning');
      leaveScannerUi();
      throw error;
    } finally {
      if (els.toggleCameraBtn) {
        els.toggleCameraBtn.disabled = false;
        els.toggleCameraBtn.removeAttribute('aria-busy');
      }
    }
  }

  async function startWebScanner(partName) {
    enterScannerUi(partName);
    
    if (state.webScannerActive) {
      debugLog('Scanner web ya estaba activo');
      return;
    }
    
    if (!navigator.mediaDevices?.getUserMedia) {
      debugLog('navigator.mediaDevices no disponible para fallback web');
      setCameraStatus('Tu dispositivo no permite abrir la cámara desde el navegador.');
      setStatusBanner('Actualiza la app con el plugin nativo para escanear', 'warning');
      leaveScannerUi();
      return;
    }
    
    if (!els.video) {
      debugLog('ERROR: Elemento de video no encontrado para fallback web');
      setCameraStatus('No se encontró el contenedor de video.');
      setStatusBanner('Contacta al equipo de desarrollo', 'warning');
      leaveScannerUi();
      return;
    }
    
    try {
      setCameraStatus('Activando cámara web...');
      debugLog('Solicitando cámara via getUserMedia');
      
      const constraints = {
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.mediaStream = stream;
      state.webScannerActive = true;
      
      if (els.video) {
        els.video.srcObject = stream;
        try {
          await els.video.play();
        } catch (_err) {
          // Algunos navegadores bloquean autoplay; ignorar
        }
      }
      
      const detectorReady = ensureBarcodeDetector();
      const zxingReady = setupZxingReaders();
      if (!detectorReady) {
        debugLog('BarcodeDetector no soportado, usando ZXing JS si está disponible');
      } else {
        debugLog('BarcodeDetector inicializado ✓');
      }
      
      startWebScanLoop(detectorReady);
      if (zxingReady) {
        startZxingContinuous();
      }
      
      if (!detectorReady && !zxingReady) {
        setStatusBanner('Tu WebView no soporta el lector. Usa la app actualizada.', 'warning');
      }
      
      if (els.stopCameraBtn) {
        els.stopCameraBtn.disabled = false;
      }
      
      setCameraStatus('Cámara activa. Escaneando…');
      setStatusBanner('Escaneando...', 'info');
      debugLog('Fallback web activo ✓');
    } catch (error) {
      debugLog(`ERROR fallback web: ${error.message}`);
      console.error('[scanner] Web scanner error:', error);
      setCameraStatus('No se pudo iniciar la cámara web: ' + error.message);
      setStatusBanner('Error al iniciar escáner', 'warning');
      stopWebScanner();
      leaveScannerUi();
      throw error;
    } finally {
      if (els.toggleCameraBtn) {
        els.toggleCameraBtn.disabled = false;
        els.toggleCameraBtn.removeAttribute('aria-busy');
      }
    }
  }

  function ensureBarcodeDetector() {
    if (state.barcodeDetector) {
      return true;
    }
    if (typeof window.BarcodeDetector !== 'function') {
      return false;
    }
    try {
      state.barcodeDetector = new window.BarcodeDetector({ formats: state.detectorFormats });
      return true;
    } catch (error) {
      console.warn('[scanner] BarcodeDetector init error:', error);
      state.barcodeDetector = null;
      return false;
    }
  }

  function startWebScanLoop(detectorReady) {
    if (state.frameRequestId) {
      cancelAnimationFrame(state.frameRequestId);
      state.frameRequestId = null;
    }
    
    const loop = async () => {
      if (!state.webScannerActive) {
        clearOverlay();
        return;
      }
      
      if (!els.video || els.video.readyState < HAVE_ENOUGH_DATA) {
        state.frameRequestId = requestAnimationFrame(loop);
        return;
      }
      
      if (state.barcodeDetector && !state.webDetectionInFlight) {
        state.webDetectionInFlight = true;
        try {
          const detections = await state.barcodeDetector.detect(els.video);
          if (detections && detections.length > 0) {
            const detection = detections[0];
            const value = detection.rawValue || detection.displayValue || '';
            const bbox = scaleBoundingBox(detection.boundingBox || null);
            if (bbox) {
              drawBoundingBox(bbox);
            }
            if (value) {
              handleDecodedValue(value, bbox, 'barcode-detector', detection.cornerPoints || null);
            }
          } else {
            clearOverlay();
          }
        } catch (error) {
          console.warn('[scanner] BarcodeDetector detect error:', error);
        } finally {
          state.webDetectionInFlight = false;
        }
      } else if (!state.barcodeDetector && !detectorReady) {
        // Si no hay BarcodeDetector, intentamos ZXing si aún no corre
        startZxingContinuous();
      }
      
      state.frameRequestId = requestAnimationFrame(loop);
    };
    
    state.frameRequestId = requestAnimationFrame(loop);
  }

  function stopWebScanner() {
    state.webScannerActive = false;
    if (state.frameRequestId) {
      cancelAnimationFrame(state.frameRequestId);
      state.frameRequestId = null;
    }
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((track) => track.stop());
      state.mediaStream = null;
    }
    if (els.video) {
      els.video.srcObject = null;
    }
    state.barcodeDetector = null;
    state.webDetectionInFlight = false;
    stopZxingContinuous();
    clearOverlay();
  }

  function stopCamera() {
    // Detener escáner nativo ML Kit
    if (mlKitScanner) {
      mlKitScanner.stopScan().catch(err => {
        console.warn('[scanner] Error stopping ML Kit:', err);
      });
    }
    
    stopWebScanner();
    
    // Restaurar UI
    if (els.workspace) {
      els.workspace.classList.add('d-none');
    }
    if (els.searchShell) {
      els.searchShell.classList.remove('d-none');
    }
    if (document.body) {
      document.body.classList.remove('scanner-fullscreen-active');
    }
    
    setCameraStatus('Escáner detenido');
    hideStatusBanner();
    
    if (els.toggleCameraBtn) {
      els.toggleCameraBtn.disabled = false;
    }
    if (els.stopCameraBtn) {
      els.stopCameraBtn.disabled = true;
    }
    
    console.info('[scanner] Escáner ML Kit detenido');
  }

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================
  
  if (els.toggleCameraBtn) {
    els.toggleCameraBtn.addEventListener('click', startCamera);
  }

  if (els.stopCameraBtn) {
    els.stopCameraBtn.addEventListener('click', stopCamera);
  }

  // Búsqueda de piezas
  if (els.searchInput) {
    els.searchInput.addEventListener('input', (e) => {
      performSearch(e.target.value);
    });
    
    els.searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        performSearch(els.searchInput.value);
      }
    });
  }

  // Delegación de eventos para selección de piezas
  if (els.resultsContainer) {
    els.resultsContainer.addEventListener('click', (e) => {
      debugLog('Click detectado en resultsContainer');
      const item = e.target.closest('.scanner-result-item');
      if (item) {
        debugLog('Item encontrado, llamando togglePartSelection');
        console.log('[scanner:click] Result item clicked');
        togglePartSelection(item);
      } else {
        debugLog('Click fuera de item');
      }
    });
  } else {
    debugLog('ERROR: resultsContainer no encontrado en DOM');
  }

  // Búsqueda por voz
  if (els.voiceBtn && 'webkitSpeechRecognition' in window) {
    const recognition = new webkitSpeechRecognition();
    recognition.lang = 'es-CL';
    recognition.continuous = false;
    recognition.interimResults = false;

    els.voiceBtn.addEventListener('click', () => {
      recognition.start();
      if (els.voiceStatus) {
        els.voiceStatus.textContent = '🎤 Escuchando...';
      }
      els.voiceBtn.classList.add('btn-danger');
      els.voiceBtn.classList.remove('btn-outline-primary');
    });

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      console.log('[scanner] Voice input:', transcript);
      if (els.searchInput) {
        els.searchInput.value = transcript;
        performSearch(transcript);
      }
      if (els.voiceStatus) {
        els.voiceStatus.textContent = 'Toca el micrófono para dictar el nombre de la pieza.';
      }
      els.voiceBtn.classList.remove('btn-danger');
      els.voiceBtn.classList.add('btn-outline-primary');
    };

    recognition.onerror = (event) => {
      console.error('[scanner] Voice recognition error:', event.error);
      if (els.voiceStatus) {
        els.voiceStatus.textContent = 'Error al reconocer voz. Intenta de nuevo.';
      }
      els.voiceBtn.classList.remove('btn-danger');
      els.voiceBtn.classList.add('btn-outline-primary');
    };

    recognition.onend = () => {
      els.voiceBtn.classList.remove('btn-danger');
      els.voiceBtn.classList.add('btn-outline-primary');
    };
  } else if (els.voiceBtn) {
    // Ocultar botón de voz si no hay soporte
    els.voiceBtn.style.display = 'none';
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  
  console.log('[scanner] MLKit-only scanner module initialized');
  console.log(`[scanner] SearchIndex loaded with ${SearchIndex.count()} parts`);
  
  // Mostrar 25 piezas iniciales
  if (SearchIndex.count() > 0) {
    const initialParts = SearchIndex.all().slice(0, 25);
    renderResults(initialParts);
    setResultsStatus(`Mostrando 25 de ${SearchIndex.count()} piezas disponibles`, 'muted');
    console.log('[scanner] Displaying initial 25 parts');
  }
  
  // Auto-start en plataforma nativa
  if (isNativePlatform) {
    console.log('[scanner] Native platform detected, auto-starting scanner');
    // Esperar un momento para que el DOM esté listo
    setTimeout(() => {
      startCamera();
    }, 500);
  } else {
    setCameraStatus('Usa la aplicación móvil para escanear');
    setStatusBanner('Esta función requiere la app móvil', 'info');
  }

})();
