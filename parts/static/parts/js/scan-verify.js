(function () {
  'use strict';

  // Detectar si estamos en app móvil nativa (Capacitor)
  const isNativePlatform = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
  const isAndroid = isNativePlatform && window.Capacitor.getPlatform() === 'android';
  
  console.log('[scanner] Platform:', isNativePlatform ? 'Native Mobile' : 'Web Browser');
  if (isNativePlatform) {
    console.log('[scanner] Platform Details:', window.Capacitor.getPlatform());
  }

  // Inicializar ML Kit Native Scanner si estamos en plataforma nativa
  let mlKitScanner = null;
  if (isNativePlatform && window.MLKitNativeScanner) {
    mlKitScanner = new window.MLKitNativeScanner();
    console.log('[scanner] ML Kit Native Scanner initialized');
  }

  const LOW_LIGHT_THRESHOLD = 0.24;
  const LOW_LIGHT_SUSTAIN_FRAMES = 3;
  const MLKIT_FAILURE_COOLDOWN = 4000;
  const HIRES_SNAPSHOT_COOLDOWN = 3500;
  const HIRES_PADDING_RATIO = 0.2;
  const MLKIT_ENDPOINT = '/parts/scan-verify/mlkit/';

  const initialPartsScript = document.getElementById('scan-initial-parts');
  const initialParts = initialPartsScript ? JSON.parse(initialPartsScript.textContent || '[]') : [];

  const CAMERA_GRANTED_KEY = 'scanner:camera-granted';
  const rememberedCameraPermission = (() => {
    try {
      return localStorage.getItem(CAMERA_GRANTED_KEY) === 'true';
    } catch (_err) {
      return false;
    }
  })();

  const state = {
    filtered: [],
    selectedPart: null,
    stream: null,
    overlayCtx: null,
    highlightTimer: null,
    audioCtx: null,
    lastMismatch: null,
    lastDetectionValue: null,
    lastDetectionAt: 0,
    recordingVoice: false,
    voiceRecorder: null,
    voiceChunks: [],
    voiceTimeout: null,
    voiceGesture: null,
    voiceMimeType: null,
    searchAbort: null,
    searchTimer: null,
    cameraRemembered: rememberedCameraPermission,
    scanning: false,
    frameRequest: null,
    detecting: false,
    barcodeDetector: null,
    captureCanvas: null,
    captureCtx: null,
    lastFrameTs: 0,
    frameCount: 0,
    barcodeFetchCache: new Map(),
    debugLog: [],
    videoTrack: null,
    imageCapture: null,
    snapshotInFlight: false,
    lastStillAttempt: 0,
    zoomSupport: null,
    zxingReader: null,
    zxingContinuousReader: null,
    zxingContinuousActive: false,
    failedDetections: 0,
    lowLightFrames: 0,
    lowLightAlerted: false,
    lastLuminance: null,
    mlKitEnabled: false,
    mlKitInFlight: false,
    mlKitLastInvocation: 0,
    torchSupported: false,
    torchEnabled: false,
    hiResSnapshotInFlight: false,
    lastHiResSnapshot: 0,
    lastSuccessfulDetection: 0,
    detectionCooldown: 2000, // 2 segundos de pausa después de detectar
  };

  let viewportListenersBound = false;

  const els = {
    page: document.getElementById('scanner-page'),
    searchShell: document.getElementById('scanner-search-shell'),
    workspace: document.getElementById('scanner-workspace'),
    searchInput: document.getElementById('scanner-search-input'),
    results: document.getElementById('scanner-results'),
    resultsStatus: document.getElementById('scanner-results-status'),
    voiceBtn: document.getElementById('scanner-voice-btn'),
    voiceStatus: document.getElementById('scanner-voice-status'),
    video: document.getElementById('scanner-video'),
    overlay: document.getElementById('scanner-overlay'),
    flash: document.getElementById('scanner-flash'),
    statusBanner: document.getElementById('scanner-status-banner'),
    detailCard: document.getElementById('scanner-detail-card'),
    pieceName: document.getElementById('scanner-piece-name'),
    photoPlaceholder: document.getElementById('scanner-photo-placeholder'),
    photoThumbs: document.getElementById('scanner-photo-thumbs'),
    changePiece: document.getElementById('scanner-change-piece-btn'),
    toggleCameraBtn: document.getElementById('scanner-toggle-camera-btn'),
    stopCameraBtn: document.getElementById('scanner-stop-camera-btn'),
    torchBtn: document.getElementById('scanner-toggle-torch-btn'),
    cameraStatus: document.getElementById('scanner-camera-status'),
    toastStack: document.getElementById('scanner-toast-stack'),
    debugExportBtn: document.getElementById('scanner-debug-export-btn'),
    exitModeFloatingBtn: document.getElementById('scanner-exit-mode-floating'),
    zoomSlider: document.getElementById('scanner-zoom-slider'),
    zoomValue: document.getElementById('scanner-zoom-value'),
    captureBtn: document.getElementById('scanner-capture-btn'),
  };

  function syncViewportUnit() {
    const viewport = window.visualViewport?.height || window.innerHeight || 0;
    if (!viewport) {
      return;
    }
    const unit = (viewport / 100).toFixed(4);
    document.documentElement.style.setProperty('--scanner-safe-vh', `${unit}px`);
  }

  function bindViewportListeners() {
    if (viewportListenersBound) return;
    viewportListenersBound = true;
    syncViewportUnit();
    window.addEventListener('resize', syncViewportUnit);
    window.addEventListener('orientationchange', syncViewportUnit);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', syncViewportUnit);
    }
  }

  function readCsrfToken() {
    try {
      if (typeof window.getCsrfToken === 'function') {
        const token = window.getCsrfToken();
        if (token && token !== 'NOTPROVIDED') {
          return token;
        }
      }
    } catch (_err) { /* ignore */ }
    return '';
  }

  function requireCsrfToken(onError) {
    const token = readCsrfToken();
    if (!token || token.length < 24) {
      if (typeof onError === 'function') {
        onError();
      }
      return null;
    }
    return token;
  }

  function renderResults(items) {
    if (!els.results) return;
    if (!items || !items.length) {
      els.results.innerHTML = '<div class="text-muted small py-3 px-2">Sin resultados con código de barras.</div>';
      return;
    }
    const content = items.map((item) => {
      const photo = item.photos && item.photos.length
        ? `<div class="scanner-result-thumb"><img src="${escapeHtml(item.photos[0])}" alt="Foto ${escapeHtml(item.name)}"></div>`
        : '<div class="scanner-result-thumb empty"><i class="fas fa-camera"></i></div>';
      return `
        <div class="scanner-result-item" data-id="${item.id}" role="option">
          <div class="scanner-result-main">
            <div class="scanner-result-title">${escapeHtml(item.name)}</div>
            <div class="scanner-result-meta">
              ${item.auto ? `<span class="badge bg-light text-body"><i class="fas fa-car-side me-1"></i>${escapeHtml(item.auto)}</span>` : ''}
              ${item.barcode ? `<span class="badge bg-body-secondary text-body"><i class="bi bi-upc me-1"></i>${escapeHtml(item.barcode)}</span>` : ''}
              ${item.photos && item.photos.length ? `<span class="badge bg-success-subtle text-success"><i class="fas fa-image me-1"></i>${item.photos.length} foto${item.photos.length > 1 ? 's' : ''}</span>` : ''}
            </div>
          </div>
          ${photo}
        </div>
      `;
    }).join('');
    els.results.innerHTML = content;
  }

  function normalizeText(value) {
    return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return ch;
      }
    });
  }

  function normalizeBarcode(value) {
    return String(value || '').replace(/\s+/g, '').toLowerCase();
  }

  function writeDebugStorage() {
    try {
      sessionStorage.setItem('scanner:last-log', JSON.stringify(state.debugLog));
    } catch (_err) { /* ignore */ }
  }

  function readDebugStorage() {
    try {
      const raw = sessionStorage.getItem('scanner:last-log');
      return raw ? JSON.parse(raw) : [];
    } catch (_err) {
      return [];
    }
  }

function appendDebugLog(event, payload = {}) {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...payload,
    };
    state.debugLog.push(entry);
    if (state.debugLog.length > 200) {
      state.debugLog.shift();
    }
    writeDebugStorage();
    return entry;
}

function setupZxingReader(retries = 5) {
  if (state.zxingReader || typeof window.ZXingBrowser === 'undefined') {
    if (!state.zxingReader && typeof window.ZXingBrowser === 'undefined' && retries > 0) {
      window.setTimeout(() => setupZxingReader(retries - 1), 400);
    }
    return;
  }
  try {
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
    const hints = new Map();
    hints.set(window.ZXingBrowser.DecodeHintType.POSSIBLE_FORMATS, formats);
    // Enable advanced options for low-quality barcodes (thermal printers)
    hints.set(window.ZXingBrowser.DecodeHintType.TRY_HARDER, true);
    hints.set(window.ZXingBrowser.DecodeHintType.PURE_BARCODE, false); // Allow non-perfect barcodes
    state.zxingReader = new window.ZXingBrowser.BrowserMultiFormatReader(hints, 500); // Increased timeout for harder tries
    state.zxingContinuousReader = new window.ZXingBrowser.BrowserMultiFormatContinuousReader(hints, 500);
    state.zxingContinuousActive = false;
    appendDebugLog('zxing:ready');
    if (state.scanning) {
      startZxingContinuous();
    }
  } catch (error) {
    console.warn('[scanner] zxing-init-error', error);
    appendDebugLog('zxing:error', { message: error?.message || String(error) });
  }
}

  function resetDebugLog() {
    state.debugLog = [];
    appendDebugLog('session:start', {
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  }

  function buildDebugBundle() {
    const scannerLog = state.debugLog.slice();
    const storedSnapshot = readDebugStorage();
    
    // Obtener bootlog actual
    const bootLog = typeof window.__getBootLog === 'function' ? window.__getBootLog() : [];
    
    // Obtener diagnóstico completo de ML Kit
    let mlkitDiagnostics = null;
    if (mlKitScanner && typeof mlKitScanner.getDiagnostics === 'function') {
      mlkitDiagnostics = mlKitScanner.getDiagnostics();
    }
    
    // Limpiar bootlog en memoria para la próxima exportación
    if (typeof window.__clearBootLog === 'function') {
      window.__clearBootLog();
    }
    
    return {
      meta: {
        exported_at: new Date().toISOString(),
        href: window.location.href,
        user_agent: navigator.userAgent,
        viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
        mlkit_enabled: state.mlKitEnabled,
        torch_supported: state.torchSupported,
        torch_enabled: state.torchEnabled,
        low_light_frames: state.lowLightFrames,
      },
      scanner_log: scannerLog,
      session_log_snapshot: storedSnapshot,
      bootlog: bootLog,
      mlkit_diagnostics: mlkitDiagnostics,
    };
  }

  async function copyLogPayload(payload) {
    if (!payload) {
      return false;
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(payload);
        return true;
      } catch (_err) { /* ignore */ }
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = payload;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'absolute';
      textarea.style.left = '-9999px';
      textarea.style.top = `${window.scrollY || 0}px`;
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const execResult = document.execCommand && document.execCommand('copy');
      document.body.removeChild(textarea);
      if (execResult) {
        return true;
      }
    } catch (_err) { /* ignore */ }
    return false;
  }

  async function exportDebugLog() {
    const logBundle = typeof window.getScannerDebugLog === 'function'
      ? window.getScannerDebugLog()
      : buildDebugBundle();
    const payload = JSON.stringify(logBundle, null, 2);
    const copied = await copyLogPayload(payload);
    if (copied) {
      setStatusBanner('Log copiado al portapapeles.', 'success');
      return;
    }
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scanner-log-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setStatusBanner('Log descargado como archivo.', 'info');
  }

  function clamp01(value) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function ensureCaptureCanvas(width, height) {
    if (!width || !height) return null;
    if (!state.captureCanvas) {
      state.captureCanvas = document.createElement('canvas');
      state.captureCtx = state.captureCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (state.captureCanvas.width !== width || state.captureCanvas.height !== height) {
      state.captureCanvas.width = width;
      state.captureCanvas.height = height;
    }
    return state.captureCtx;
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

  let fetchController = null;

  function rememberCameraGrant(granted) {
    state.cameraRemembered = Boolean(granted);
    try {
      if (granted) {
        localStorage.setItem(CAMERA_GRANTED_KEY, 'true');
      } else {
        localStorage.removeItem(CAMERA_GRANTED_KEY);
      }
    } catch (_err) {
      /* ignore */
    }
  }

  function setResultsStatus(message, variant = 'muted') {
    if (!els.resultsStatus) return;
    const classes = ['text-muted', 'text-success', 'text-danger', 'text-warning', 'text-info'];
    classes.forEach((cls) => els.resultsStatus.classList.remove(cls));
    const map = {
      success: 'text-success',
      danger: 'text-danger',
      warning: 'text-warning',
      info: 'text-info',
      muted: 'text-muted'
    };
    els.resultsStatus.classList.add(map[variant] || 'text-muted');
    els.resultsStatus.textContent = message;
  }


  function appendLog(message, variant = 'muted', details = null) {
    if (!els.toastStack) return;
    const toast = document.createElement('div');
    toast.className = `scanner-toast scanner-toast--${variant}`;
    const badge = (details && details.badge) || formatFeedBadge(variant);
    const title = (details && details.title) || message;
    const subtitle = details?.subtitle || '';
    const description = details?.description || '';
    const barcode = details?.barcode || '';
    toast.innerHTML = `
      <div class="scanner-toast-head">
        <span>${escapeHtml(badge)}</span>
        <span>${escapeHtml(details?.time || formatFeedTime())}</span>
      </div>
      <div class="scanner-toast-title">${escapeHtml(title)}</div>
      ${subtitle ? `<div class="scanner-toast-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      ${description ? `<div class="scanner-toast-subtitle">${escapeHtml(description)}</div>` : ''}
      ${barcode ? `<div class="scanner-toast-code"><span>${escapeHtml(barcode)}</span></div>` : ''}
    `;
    els.toastStack.prepend(toast);
    while (els.toastStack.children.length > 4) {
      const last = els.toastStack.lastElementChild;
      if (last) {
        last.remove();
      } else {
        break;
      }
    }
    window.setTimeout(() => {
      toast.classList.add('scanner-toast-leave');
    }, 2700);
    window.setTimeout(() => {
      toast.remove();
    }, 3200);
  }

  function formatFeedTime(date = new Date()) {
    try {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_err) {
      return '';
    }
  }

  function formatFeedBadge(variant) {
    const map = {
      success: 'Confirmada',
      danger: 'Alerta',
      warning: 'Revisar',
      info: 'Actualización',
      muted: 'Actividad'
    };
    return map[variant] || 'Actividad';
  }

  function logDetectionEvent(payload) {
    try {
      console.info('[scanner] detección', payload);
    } catch (_err) {}
  }

  function applyLocalResults(query, freshData) {
    // Si se pasan datos frescos (navegación Turbo), reindexar
    if (freshData && Array.isArray(freshData)) {
      SearchIndex.bootstrap(freshData);
    }
    state.filtered = SearchIndex.search(query, 25);
    renderResults(state.filtered);
    if (state.selectedPart) {
      highlightResult(state.selectedPart.id);
    }
    if (state.filtered.length) {
      setResultsStatus(`${state.filtered.length} coincidencias locales · ${SearchIndex.count()} piezas indexadas`, 'muted');
    } else if (query && query.trim()) {
      setResultsStatus('Sin coincidencias locales. Buscando en el servidor…', 'warning');
    } else if (SearchIndex.count() === 0) {
      setResultsStatus('No hay piezas con código de barras registradas.', 'warning');
    } else {
      setResultsStatus('Selecciona una pieza para comenzar a escanear.', 'muted');
    }
  }

  async function fetchResults(query) {
    if (fetchController) {
      fetchController.abort();
    }
    const controller = new AbortController();
    fetchController = controller;
    const params = new URLSearchParams();
    if (query) {
      params.set('q', query);
      params.set('limit', '180');
    } else {
      params.set('limit', '120');
      params.set('prefetch', '1');
    }
    try {
      appendDebugLog('catalog:fetch', { query, params: params.toString() });
      setResultsStatus('Sincronizando catálogo…', 'info');
      const resp = await fetch(`/parts/scan-verify/search/?${params.toString()}`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (resp.status === 403) {
        setResultsStatus('Sesión expirada. Recarga para continuar.', 'danger');
        return;
      }
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.success) {
        throw new Error(data?.error || `Error ${resp.status}`);
      }
      SearchIndex.upsert(data.results || []);
      appendDebugLog('catalog:updated', { count: data.results?.length || 0 });
      applyLocalResults(query);
      const fetched = data.results?.length || 0;
      if (!fetched && query) {
        setResultsStatus('Sin coincidencias en el servidor para esta búsqueda.', 'warning');
      } else {
        setResultsStatus(`Índice actualizado (${SearchIndex.count()} piezas disponibles).`, 'success');
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      console.error('scan-search', error);
      appendDebugLog('catalog:error', { message: error?.message || String(error) });
      setResultsStatus(error?.message || 'No se pudo consultar el catálogo.', 'danger');
    } finally {
      if (fetchController === controller) {
        fetchController = null;
      }
    }
  }

  function scheduleSearchFetch(query) {
    if (state.searchTimer) {
      clearTimeout(state.searchTimer);
    }
    state.searchTimer = window.setTimeout(() => {
      fetchResults(query);
    }, 220);
  }

  const BARCODE_SYNC_TTL = 8000;

  function ensureBarcodeIndexed(rawBarcode) {
    const normalized = normalizeBarcode(rawBarcode);
    if (!normalized) return;
    if (SearchIndex.findByBarcode(normalized)) {
      return;
    }
    const now = Date.now();
    const lastEntry = state.barcodeFetchCache.get(normalized);
    if (lastEntry && (now - lastEntry.timestamp) < BARCODE_SYNC_TTL) {
      return;
    }
    state.barcodeFetchCache.set(normalized, { timestamp: now, inflight: true });
    const params = new URLSearchParams();
    params.set('q', rawBarcode);
    params.set('limit', '40');
    fetch(`/parts/scan-verify/search/?${params.toString()}`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin'
    })
      .then((resp) => resp.json().then((data) => ({ ok: resp.ok, status: resp.status, data })).catch(() => ({ ok: resp.ok, status: resp.status, data: null })))
      .then((result) => {
        if (!result.ok || !result.data?.success) {
          throw new Error(result.data?.error || `Error ${result.status}`);
        }
        if (Array.isArray(result.data.results)) {
          SearchIndex.upsert(result.data.results);
          appendDebugLog('barcode:sync', { barcode: rawBarcode, added: result.data.results.length });
        }
      })
      .catch((error) => {
        console.warn('[scanner] barcode-sync-error', error);
        appendDebugLog('barcode:sync-error', { barcode: rawBarcode, message: error?.message || String(error) });
        state.barcodeFetchCache.delete(normalized);
      })
      .finally(() => {
        const entry = state.barcodeFetchCache.get(normalized);
        if (entry) {
          entry.timestamp = Date.now();
          entry.inflight = false;
          state.barcodeFetchCache.set(normalized, entry);
        }
      });
  }

  function resolvePartById(partId) {
    const id = String(partId || '');
    if (!id) return null;
    return SearchIndex.get(id)
      || state.filtered.find((item) => String(item.id) === id)
      || SearchIndex.all().find((item) => String(item.id) === id)
      || null;
  }

  function selectPart(partId) {
    const part = resolvePartById(partId);
    if (!part) {
      setResultsStatus('No pudimos cargar la pieza seleccionada. Actualiza el listado.', 'danger');
      return;
    }
    state.selectedPart = part;
    state.lastDetectionValue = null;
    state.lastDetectionAt = 0;
    updateInfoPanel();
    highlightResult(partId);
    enterActiveMode();
  }

  function updateInfoPanel() {
    if (!state.selectedPart) {
      els.pieceName.textContent = 'Sin seleccionar';
      renderPhotoGallery();
      return;
    }
    const part = state.selectedPart;
    els.pieceName.textContent = part.name;
    renderPhotoGallery();
    setInfoState('ready');
  }

  function renderPhotoGallery() {
    if (!els.photoThumbs || !els.photoPlaceholder) return;
    const photos = state.selectedPart?.photos || [];
    if (!photos.length) {
      els.photoThumbs.innerHTML = '';
      els.photoPlaceholder.classList.remove('d-none');
      return;
    }
    const visible = photos.slice(0, 3);
    const html = visible.map((url, index) => (
      `<div class="scanner-photo-thumb"><img src="${escapeHtml(url)}" alt="Foto ${index + 1} de ${escapeHtml(state.selectedPart?.name || '')}"></div>`
    )).join('');
    els.photoThumbs.innerHTML = html;
    els.photoPlaceholder.classList.add('d-none');
  }

  function highlightResult(partId) {
    if (!els.results) return;
    els.results.querySelectorAll('.scanner-result-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === String(partId));
    });
  }

  function setCameraStatus(text) {
    if (els.cameraStatus) {
      els.cameraStatus.textContent = text;
    }
    state.cameraStatus = text;
  }

  async function startCamera() {
    // Diagnóstico detallado PRE-inicio
    console.log('═══════════════════════════════════════════════════════');
    console.log('[scanner:startCamera] INICIO DE DIAGNÓSTICO COMPLETO');
    console.log('═══════════════════════════════════════════════════════');
    console.log('1. PLATAFORMA:');
    console.log('   - isNativePlatform:', isNativePlatform);
    console.log('   - window.Capacitor exists:', typeof window.Capacitor !== 'undefined');
    console.log('   - window.Capacitor.isNativePlatform():', window.Capacitor?.isNativePlatform?.());
    console.log('   - window.Capacitor.getPlatform():', window.Capacitor?.getPlatform?.());
    console.log('');
    console.log('2. MLKIT:');
    console.log('   - window.MLKitNativeScanner class exists:', typeof window.MLKitNativeScanner !== 'undefined');
    console.log('   - mlKitScanner instance:', mlKitScanner);
    console.log('   - mlKitScanner.isSupported (BEFORE ensureReady):', mlKitScanner?.isSupported);
    console.log('   - mlKitScanner._initPromise exists:', mlKitScanner?._initPromise ? 'YES' : 'NO');
    console.log('');
    
    appendDebugLog('camera:start-debug', {
      isNativePlatform,
      hasCapacitor: typeof window.Capacitor !== 'undefined',
      hasMLKitClass: typeof window.MLKitNativeScanner !== 'undefined',
      hasMLKitInstance: !!mlKitScanner,
      mlkitIsSupportedBeforeReady: mlKitScanner?.isSupported || false
    });
    
    // Si estamos en app móvil nativa, usar ML Kit directamente
    if (isNativePlatform && mlKitScanner) {
      console.log('3. ESPERANDO INICIALIZACIÓN DE MLKIT:');
      console.log('   - Calling mlKitScanner.ensureReady()...');
      
      // Esperar a que ML Kit termine de inicializarse
      const isReady = await mlKitScanner.ensureReady();
      
      console.log('   - ensureReady() returned:', isReady);
      console.log('   - mlKitScanner.isSupported (AFTER ensureReady):', mlKitScanner.isSupported);
      console.log('');
      
      if (isReady) {
        console.log('4. MLKIT LISTO - INICIANDO ESCÁNER NATIVO');
        console.log('═══════════════════════════════════════════════════════');
        console.log('[scanner] Using ML Kit Native Scanner');
        setCameraStatus('Preparando escáner nativo...');
      
      if (els.toggleCameraBtn) {
        els.toggleCameraBtn.disabled = true;
        els.toggleCameraBtn.setAttribute('aria-busy', 'true');
      }
      
      try {
        // Verificar que hay una pieza seleccionada
        if (!state.selectedPart) {
          setCameraStatus('Selecciona una pieza antes de escanear');
          appendLog('Selecciona una pieza primero', 'warning', {
            title: 'Sin pieza seleccionada',
            description: 'Debes seleccionar una pieza para verificar su código de barras'
          });
          if (els.toggleCameraBtn) {
            els.toggleCameraBtn.disabled = false;
            els.toggleCameraBtn.removeAttribute('aria-busy');
          }
          return;
        }
        
        setCameraStatus('Escáner nativo activo - Apunta al código de barras');
        
        // Iniciar escáner nativo (bloquea UI hasta detectar o cancelar)
        const result = await mlKitScanner.startScan();
        
        if (result && result.value) {
          console.log('[scanner] ML Kit detected:', result);
          // Procesar el código detectado usando el flujo existente
          handleDecodedValue(result.value, null, 'mlkit-native', result.cornerPoints || null);
        } else {
          setCameraStatus('Escaneo cancelado');
          appendLog('Escaneo cancelado', 'info', {
            title: 'Escaneo cancelado',
            description: 'No se detectó ningún código'
          });
        }
      } catch (error) {
        console.error('════════════════════════════════════════════════════════');
        console.error('[scanner] ❌ ERROR EN MLKIT NATIVE SCANNER');
        console.error('════════════════════════════════════════════════════════');
        console.error('Error object:', error);
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error code:', error.code);
        console.error('Error stack:', error.stack);
        console.error('════════════════════════════════════════════════════════');
        
        appendDebugLog('camera:mlkit-error', {
          errorName: error.name,
          errorMessage: error.message,
          errorCode: error.code,
          errorStack: error.stack
        });
        
        setCameraStatus('Error en escáner nativo: ' + error.message);
        appendLog('Error en escáner nativo', 'danger', {
          title: 'Error',
          description: error.message
        });
        // Fallback a escáner web si ML Kit falla
        console.warn('[scanner] Falling back to web scanner');
        await startWebCamera();
      }
      
      if (els.toggleCameraBtn) {
        els.toggleCameraBtn.disabled = false;
        els.toggleCameraBtn.removeAttribute('aria-busy');
      }
      return;
      } else {
        console.log('════════════════════════════════════════════════════════');
        console.log('[scanner] ⚠️  MLKIT NO ESTÁ LISTO');
        console.log('════════════════════════════════════════════════════════');
        console.log('   - isReady:', false);
        console.log('   - Falling back to web camera');
        console.log('════════════════════════════════════════════════════════');
        
        appendDebugLog('camera:mlkit-not-ready', {
          isReady: false,
          fallbackToWeb: true
        });
      }
    } else {
      console.log('════════════════════════════════════════════════════════');
      console.log('[scanner] ℹ️  CONDICIÓN NO CUMPLIDA PARA MLKIT');
      console.log('════════════════════════════════════════════════════════');
      console.log('   - isNativePlatform:', isNativePlatform);
      console.log('   - mlKitScanner:', !!mlKitScanner);
      console.log('   - Usando escáner web tradicional');
      console.log('════════════════════════════════════════════════════════');
    }
    
    // Navegador web: usar escáner web tradicional
    console.log('');
    console.log('5. INICIANDO ESCÁNER WEB (FALLBACK O DEFAULT)');
    console.log('════════════════════════════════════════════════════════');
    await startWebCamera();
  }

  async function startWebCamera() {
    setupZxingReader();
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus('Tu navegador no soporta acceso a la cámara.');
      if (els.toggleCameraBtn) {
        els.toggleCameraBtn.disabled = false;
        els.toggleCameraBtn.removeAttribute('aria-busy');
      }
      console.warn('[scanner] getUserMedia no soportado');
      return;
    }
    if (state.stream) {
      setCameraStatus('Cámara activa. Escaneando…');
      startScanLoop();
      return;
    }
    if (els.toggleCameraBtn) {
      els.toggleCameraBtn.disabled = true;
      els.toggleCameraBtn.setAttribute('aria-busy', 'true');
    }
    setCameraStatus('Solicitando acceso a la cámara…');
    try {
      // Constraints con resolución mínima para códigos de baja calidad (impresora térmica)
      // Prioridad: 1024px mínimo → 768px fallback → sin restricción
      const videoConstraints = [
        {
          facingMode: { ideal: 'environment' },
          width: { min: 1024, ideal: 1280 },
          height: { min: 720, ideal: 720 },
          focusMode: { ideal: 'continuous' },
          exposureMode: { ideal: 'continuous' }
        },
        {
          facingMode: { ideal: 'environment' },
          width: { min: 768, ideal: 1280 },
          height: { min: 576, ideal: 720 },
          focusMode: { ideal: 'continuous' },
          exposureMode: { ideal: 'continuous' }
        },
        {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          focusMode: { ideal: 'continuous' },
          exposureMode: { ideal: 'continuous' }
        }
      ];
      
      let stream = null;
      for (const constraints of videoConstraints) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: constraints,
            audio: false
          });
          console.log('[scanner] Camera resolution obtained:', 
            stream.getVideoTracks()[0].getSettings().width + 'x' + 
            stream.getVideoTracks()[0].getSettings().height);
          break;
        } catch (err) {
          console.warn('[scanner] Failed with constraints:', constraints, err.message);
        }
      }
      
      if (!stream) {
        throw new Error('No se pudo obtener acceso a la cámara con ninguna configuración');
      }
      
      state.stream = stream;
      if (els.video) {
        els.video.srcObject = state.stream;
        try {
          await els.video.play();
        } catch (_err) { /* ignore autoplay issues */ }
      }
      rememberCameraGrant(true);
      state.videoTrack = (state.stream && typeof state.stream.getVideoTracks === 'function')
        ? (state.stream.getVideoTracks()[0] || null)
        : null;
      const videoTrack = state.videoTrack;
      if (videoTrack && typeof window.ImageCapture === 'function') {
        try {
          state.imageCapture = new window.ImageCapture(videoTrack);
        } catch (error) {
          console.warn('[scanner] imageCapture-init-error', error);
          state.imageCapture = null;
        }
      } else {
        state.imageCapture = null;
      }
      updateCaptureButton(Boolean(state.imageCapture));
      setupZoomControls(videoTrack);
      setupTorchCapability(videoTrack);
      state.snapshotInFlight = false;
      state.lastStillAttempt = 0;
      appendDebugLog('camera:started', { trackLabel: videoTrack?.label || 'unknown' });
      try {
        console.info('[scanner] Cámara activada', {
          label: videoTrack?.label || 'unknown',
          settings: videoTrack?.getSettings ? videoTrack.getSettings() : null
        });
      } catch (_err) {}
      if (typeof window.BarcodeDetector === 'function') {
        try {
          state.barcodeDetector = new window.BarcodeDetector({
            formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'codabar', 'upc_a', 'upc_e', 'itf', 'qr_code']
          });
        } catch (error) {
          state.barcodeDetector = null;
          console.warn('[scanner] BarcodeDetector init error', error);
        }
      } else {
        state.barcodeDetector = null;
      }
      setCameraStatus('Cámara activa. Escaneando…');
      if (els.stopCameraBtn) {
        els.stopCameraBtn.disabled = false;
      }
      startScanLoop();
      startZxingContinuous();
    } catch (error) {
      console.error('[scanner] camera-error', error);
      appendDebugLog('camera:error', { message: error?.message || String(error) });
      rememberCameraGrant(false);
      const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      setCameraStatus(denied
        ? 'Permiso denegado. Revisa los ajustes del navegador y vuelve a intentarlo.'
        : 'No se pudo acceder a la cámara. Intenta nuevamente.');
      if (els.toggleCameraBtn) {
        els.toggleCameraBtn.disabled = false;
      }
    } finally {
      if (els.toggleCameraBtn) {
        els.toggleCameraBtn.removeAttribute('aria-busy');
      }
    }
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    state.videoTrack = null;
    state.imageCapture = null;
    state.snapshotInFlight = false;
    state.zoomSupport = null;
    state.torchSupported = false;
    state.torchEnabled = false;
    updateCaptureButton(false);
    updateTorchButton();
    if (els.zoomSlider) {
      els.zoomSlider.disabled = true;
      els.zoomSlider.value = '100';
    }
    if (els.zoomValue) {
      els.zoomValue.textContent = '1.0x';
    }
    if (els.video) {
      els.video.srcObject = null;
    }
    stopScanLoop();
    stopZxingContinuous();
    state.barcodeDetector = null;
    state.lastFrameTs = 0;
    setCameraStatus('Cámara detenida. Pulsa “Activar cámara” para reanudar.');
    if (els.toggleCameraBtn) {
      els.toggleCameraBtn.disabled = false;
    }
    if (els.stopCameraBtn) {
      els.stopCameraBtn.disabled = true;
    }
    console.info('[scanner] Cámara detenida');
    appendDebugLog('camera:stopped');
  }

  function clearOverlay() {
    if (state.overlayCtx) {
      state.overlayCtx.clearRect(0, 0, state.overlayCtx.canvas.width, state.overlayCtx.canvas.height);
    }
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

  function ensureOverlayContext() {
    if (!els.overlay || !els.video) return;
    if (!state.overlayCtx || els.overlay.width !== els.video.videoWidth) {
      els.overlay.width = els.video.videoWidth || els.overlay.clientWidth;
      els.overlay.height = els.video.videoHeight || els.overlay.clientHeight;
      state.overlayCtx = els.overlay.getContext('2d');
    }
  }
  function renderDetectionOutline(location) {
    ensureOverlayContext();
    clearOverlay();
    if (!state.overlayCtx || !location) return;
    const ctx = state.overlayCtx;
    const points = [
      location.topLeftCorner,
      location.topRightCorner,
      location.bottomRightCorner,
      location.bottomLeftCorner
    ].filter(Boolean);
    if (!points.length) return;
    ctx.strokeStyle = '#00ffb2';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  function scaleBoundingBox(box, width, height) {
    if (!box || !width || !height) return null;
    const overlayWidth = els.overlay?.width || els.video?.videoWidth || width;
    const overlayHeight = els.overlay?.height || els.video?.videoHeight || height;
    const scaleX = overlayWidth / width;
    const scaleY = overlayHeight / height;
    return {
      x: box.x * scaleX,
      y: box.y * scaleY,
      width: box.width * scaleX,
      height: box.height * scaleY
    };
  }

  function renderBoundingBox(box) {
    ensureOverlayContext();
    clearOverlay();
    if (!state.overlayCtx || !box) return;
    const ctx = state.overlayCtx;
    ctx.strokeStyle = '#00ffb2';
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
  }

  function scalePoint(point, scaleX, scaleY) {
    if (!point) return null;
    return {
      x: point.x * scaleX,
      y: point.y * scaleY
    };
  }

  function scaleLocation(location, scaleX, scaleY) {
    if (!location || (!scaleX && !scaleY)) {
      return location;
    }
    const sx = scaleX || 1;
    const sy = scaleY || 1;
    return {
      topLeftCorner: scalePoint(location.topLeftCorner, sx, sy),
      topRightCorner: scalePoint(location.topRightCorner, sx, sy),
      bottomLeftCorner: scalePoint(location.bottomLeftCorner, sx, sy),
      bottomRightCorner: scalePoint(location.bottomRightCorner, sx, sy),
    };
  }

  function locationToBoundingBox(location) {
    if (!location) return null;
    const points = [
      location.topLeftCorner,
      location.topRightCorner,
      location.bottomRightCorner,
      location.bottomLeftCorner
    ].filter(Boolean);
    if (!points.length) return null;
    const xs = points.map((pt) => pt.x);
    const ys = points.map((pt) => pt.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX,
      y: minY,
      width: Math.max(2, maxX - minX),
      height: Math.max(2, maxY - minY)
    };
  }

  function normalizeBoundingBox(box) {
    if (!box) return null;
    const x = box.x ?? box.left ?? 0;
    const y = box.y ?? box.top ?? 0;
    const width = box.width ?? Math.max(0, (box.right ?? 0) - x);
    const height = box.height ?? Math.max(0, (box.bottom ?? 0) - y);
    if (!width || !height) return null;
    return { x, y, width, height };
  }

  function clamp(value, min, max) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  function normalizeBoxRelative(box, frame) {
    if (!box || !frame?.width || !frame?.height) return null;
    return {
      x: clamp(box.x / frame.width, 0, 1),
      y: clamp(box.y / frame.height, 0, 1),
      width: clamp(box.width / frame.width, 0.02, 1),
      height: clamp(box.height / frame.height, 0.02, 1),
    };
  }

  function getVideoDimensions() {
    if (!els.video) return null;
    const width = els.video.videoWidth || 0;
    const height = els.video.videoHeight || 0;
    if (!width || !height) return null;
    return { width, height };
  }

  function updateLowLightGuidance(isLowLight, luminanceScore) {
    if (isLowLight && !state.lowLightAlerted) {
      state.lowLightAlerted = true;
      setStatusBanner('Iluminación baja: activa la linterna o acerca el código al centro.', 'warning');
      appendDebugLog('lighting:low', { luminance: luminanceScore });
    } else if (!isLowLight && state.lowLightAlerted) {
      state.lowLightAlerted = false;
      appendDebugLog('lighting:recover', { luminance: luminanceScore });
    }
  }

  function computeLuminance(buffer) {
    if (!buffer || !buffer.length) return null;
    let acc = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const r = buffer[i];
      const g = buffer[i + 1];
      const b = buffer[i + 2];
      acc += (0.299 * r) + (0.587 * g) + (0.114 * b);
    }
    const pixels = buffer.length / 4;
    if (!pixels) return null;
    return (acc / (pixels * 255));
  }

  function recordLuminance(score) {
    if (typeof score !== 'number' || Number.isNaN(score)) {
      return;
    }
    state.lastLuminance = score;
    if (score < LOW_LIGHT_THRESHOLD) {
      state.lowLightFrames = Math.min(LOW_LIGHT_SUSTAIN_FRAMES + 1, state.lowLightFrames + 1);
    } else {
      state.lowLightFrames = Math.max(0, state.lowLightFrames - 1);
    }
    updateLowLightGuidance(state.lowLightFrames >= LOW_LIGHT_SUSTAIN_FRAMES, score);
  }

  function handleBitmapDetections(detections, frameWidth, frameHeight, source = 'photo') {
    if (!detections || !detections.length) {
      return false;
    }
    for (const entry of detections) {
      const value = entry.rawValue || '';
      if (!value) continue;
      const box = normalizeBoundingBox(entry.boundingBox || null);
      const scaled = scaleBoundingBox(box, frameWidth, frameHeight);
      handleDecodedValue(value, null, source, scaled);
      return true;
    }
    return false;
  }

  function enhanceImageBuffer(buffer, options = {}) {
    if (!buffer) return;
    
    // Adaptive enhancement based on luminance
    const luminance = state.lastLuminance ?? 0.5;
    const isLowLight = luminance < LOW_LIGHT_THRESHOLD;
    
    // AGRESIVO: Contrast/brightness más fuerte para códigos térmicos dañados
    // Apps nativas (TeaCapps, Google Lens) tienen acceso directo a hardware
    // Navegador necesita compensar con procesamiento más intenso
    let contrast = typeof options.contrast === 'number' ? options.contrast : (isLowLight ? 1.8 : 1.5);
    let brightness = typeof options.brightness === 'number' ? options.brightness : (isLowLight ? 25 : 15);
    
    // First pass: contrast/brightness (fast)
    for (let i = 0; i < buffer.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const idx = i + c;
        const value = buffer[idx] * contrast + brightness;
        buffer[idx] = value < 0 ? 0 : value > 255 ? 255 : value;
      }
    }
    
    // Second pass: Sharpening filter (realza bordes borrosos de códigos térmicos)
    // Kernel 3x3: [-1,-1,-1] [-1, 9,-1] [-1,-1,-1]
    // CRÍTICO: Apps nativas procesan frames de alta resolución sin compresión
    // Navegador reduce resolución → necesita sharpening para compensar
    const width = Math.sqrt(buffer.length / 4);
    const height = width;
    if (width === Math.floor(width)) {
      applySharpenFilter(buffer, Math.floor(width), Math.floor(height));
    }
    
    // Third pass: histogram equalization for better edge detection
    // Build histogram
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < buffer.length; i += 4) {
      // Use grayscale approximation (R channel is good enough after enhancement)
      histogram[buffer[i]]++;
    }
    
    // Compute CDF (cumulative distribution function)
    const cdf = new Array(256);
    cdf[0] = histogram[0];
    for (let i = 1; i < 256; i++) {
      cdf[i] = cdf[i - 1] + histogram[i];
    }
    
    // Normalize CDF
    const totalPixels = buffer.length / 4;
    const cdfMin = cdf.find(v => v > 0) || 0;
    const lookupTable = new Array(256);
    for (let i = 0; i < 256; i++) {
      lookupTable[i] = Math.round(((cdf[i] - cdfMin) / (totalPixels - cdfMin)) * 255);
    }
    
    // Apply histogram equalization
    for (let i = 0; i < buffer.length; i += 4) {
      for (let c = 0; c < 3; c += 1) {
        const idx = i + c;
        buffer[idx] = lookupTable[buffer[idx]] || buffer[idx];
      }
    }
    
    // Third pass: Simple threshold only for very low quality (every 3rd frame to save CPU)
    if (options.applyBinarization && state.frameCount % 3 === 0) {
      applySimpleBinarization(buffer);
    }
  }

function startZxingContinuous() {
  if (!state.zxingContinuousReader || !els.video || state.zxingContinuousActive) return;
  try {
    state.zxingContinuousReader.decodeFromVideoElementContinuously(els.video, (result, err) => {
      if (result) {
        const location = locationFromPoints(result.getResultPoints?.(), 'zxing');
        handleDecodedValue(result.getText?.() || '', location, 'zxing');
      } else if (err && !(err instanceof window.ZXingBrowser.NotFoundException)) {
        appendDebugLog('zxing:continuous-error', { message: String(err) });
      }
    });
    state.zxingContinuousActive = true;
    appendDebugLog('zxing:continuous-start');
  } catch (error) {
    console.warn('[scanner] zxing-continuous-error', error);
    appendDebugLog('zxing:continuous-fail', { message: error?.message || String(error) });
  }
}

function stopZxingContinuous() {
  if (state.zxingContinuousReader) {
    try {
      state.zxingContinuousReader.stopContinuousDecode();
    } catch (_err) {}
    appendDebugLog('zxing:continuous-stop');
  }
  state.zxingContinuousActive = false;
}

function locationFromPoints(points, source, overrideScaleX = null, overrideScaleY = null) {
  if (!points || !points.length) return null;
  const overlayWidth = els.overlay?.width || els.video?.videoWidth || 1;
  const overlayHeight = els.overlay?.height || els.video?.videoHeight || 1;
  const videoWidth = els.video?.videoWidth || overlayWidth;
  const videoHeight = els.video?.videoHeight || overlayHeight;
  const scaleX = overrideScaleX || (overlayWidth / videoWidth);
  const scaleY = overrideScaleY || (overlayHeight / videoHeight);
  const getCoord = (point) => {
    if (!point) return null;
    const x = typeof point.getX === 'function' ? point.getX() : point.x || 0;
    const y = typeof point.getY === 'function' ? point.getY() : point.y || 0;
    return { x: x * scaleX, y: y * scaleY };
  };
  return {
    topLeftCorner: getCoord(points[0]),
    topRightCorner: getCoord(points[1]),
    bottomRightCorner: getCoord(points[2]),
    bottomLeftCorner: getCoord(points[3]),
  };
}

async function decodeCanvasWithZxing(scaleX = 1, scaleY = 1, source = 'camera') {
  if (!state.zxingReader || !window.ZXingBrowser || !state.captureCanvas) return false;
  
  // CRÍTICO: Apps nativas (TeaCapps, Google Lens) usan ML Kit nativo
  // Navegador necesita compensar con multi-escala + inversión
  // Basado en nimiq/qr-scanner modo 'both' + Dynamsoft scan-from-distance
  
  // Estrategia: Intentar con imagen normal primero, luego invertida
  const attempts = [
    { invert: false, name: 'normal' },
    { invert: true, name: 'inverted' }
  ];
  
  for (const attempt of attempts) {
    try {
      // Si necesitamos invertir, crear canvas temporal
      let canvasToUse = state.captureCanvas;
      let cleanup = null;
      
      if (attempt.invert) {
        const ctx = state.captureCanvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, state.captureCanvas.width, state.captureCanvas.height);
        
        // Invertir colores (255 - valor)
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] = 255 - imageData.data[i];       // R
          imageData.data[i + 1] = 255 - imageData.data[i + 1]; // G
          imageData.data[i + 2] = 255 - imageData.data[i + 2]; // B
        }
        
        ctx.putImageData(imageData, 0, 0);
        cleanup = () => {
          // Restaurar imagen original invirtiendo de nuevo
          ctx.putImageData(imageData, 0, 0);
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] = 255 - imageData.data[i];
            imageData.data[i + 1] = 255 - imageData.data[i + 1];
            imageData.data[i + 2] = 255 - imageData.data[i + 2];
          }
          ctx.putImageData(imageData, 0, 0);
        };
      }
      
      const result = await state.zxingReader.decodeFromCanvas(canvasToUse);
      
      if (cleanup) cleanup();
      state.zxingReader.reset?.();
      
      if (result) {
        const location = locationFromPoints(result.getResultPoints?.(), source, scaleX, scaleY);
        handleDecodedValue(result.getText?.() || '', location, source);
        appendDebugLog('zxing:success', { mode: attempt.name });
        return true;
      }
    } catch (error) {
      state.zxingReader?.reset?.();
      if (error && error.name !== 'NotFoundException') {
        appendDebugLog('zxing:frame-error', { 
          mode: attempt.name,
          message: error?.message || String(error) 
        });
      }
    }
  }
  
  return false;
}

function detectBitmapWithJsQR(bitmap, source = 'photo') {
    if (!window.jsQR || !bitmap) return false;
    const width = bitmap.width || bitmap.codedWidth || 0;
    const height = bitmap.height || bitmap.codedHeight || 0;
    if (!width || !height) return false;
    const ctx = ensureCaptureCanvas(width, height);
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0, width, height);
    let imageData = null;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch (error) {
      console.warn('[scanner] bitmap-getImageData-error', error);
      return false;
    }
    enhanceImageBuffer(imageData.data);
    let detection = null;
    try {
      detection = window.jsQR(imageData.data, width, height, {
        inversionAttempts: 'attemptBoth',
        tryHarder: true,
        canOverwriteImage: true
      });
    } catch (error) {
      console.warn('[scanner] bitmap-jsQR-error', error);
      return false;
    }
    if (detection && detection.data) {
      const overlayWidth = els.overlay?.width || els.video?.videoWidth || width;
      const overlayHeight = els.overlay?.height || els.video?.videoHeight || height;
      const scaleX = overlayWidth / width;
      const scaleY = overlayHeight / height;
      const scaledLocation = scaleLocation(detection.location || null, scaleX, scaleY);
      handleDecodedValue(detection.data, scaledLocation, source);
      return true;
    }
    return false;
  }

  function handleDecodedValue(rawValue, location = null, source = 'camera', boundingBox = null) {
    const value = String(rawValue || '').trim();
    if (!value) return;
    if (!state.selectedPart) {
      setResultsStatus('Selecciona una pieza antes de validar un código.', 'warning');
      clearOverlay();
      return;
    }
    const normalizedValue = normalizeBarcode(value);
    const normalizedKey = normalizedValue;
    const expectedNormalized = normalizeBarcode(state.selectedPart?.barcode || '');
    const isMatch = Boolean(expectedNormalized && normalizedKey === expectedNormalized);
    if (!SearchIndex.findByBarcode(normalizedKey)) {
      ensureBarcodeIndexed(value);
    }
    console.info('[scanner] detection', {
      value,
      normalizedKey,
      expected: expectedNormalized,
      source
    });
    appendDebugLog('detection', {
      value,
      normalizedKey,
      expected: expectedNormalized,
      source,
      partId: state.selectedPart?.id || null,
    });
    if (location) {
      renderDetectionOutline(location);
    } else if (boundingBox) {
      renderBoundingBox(boundingBox);
    } else {
      clearOverlay();
    }
    setStatusBanner(`Escaneando… Código leído: ${value}`, 'info');
    announceDetection(value, normalizedKey, isMatch);
    state.failedDetections = 0;
    
    // Activar cooldown de 2s después de detección exitosa
    state.lastSuccessfulDetection = Date.now();
    
    const resolvedBox = location ? locationToBoundingBox(location) : boundingBox;
    if (resolvedBox && source !== 'mlkit') {
      maybeTriggerHiResSnapshot(resolvedBox, { source, value });
    }
    if (isMatch) {
      handleMatch(value, resolvedBox, { source });
    } else if (state.selectedPart?.barcode) {
      handleMismatch(value, { source });
    }
  }

  function handleBarcodeDetections(detections) {
    if (!detections || !detections.length) {
      return false;
    }
    let handled = false;
    for (const entry of detections) {
      const value = entry.rawValue || '';
      if (!value) continue;
      const box = normalizeBoundingBox(entry.boundingBox || null);
      handleDecodedValue(value, null, 'camera', box);
      handled = true;
      break; // process first detection per frame
    }
    if (!handled) {
      clearOverlay();
    }
    return handled;
  }

  function captureVideoFrame() {
    if (!els.video || els.video.readyState < 2) {
      return null;
    }
    const width = els.video.videoWidth || 0;
    const height = els.video.videoHeight || 0;
    if (!width || !height) {
      return null;
    }
    
    // ROI optimizado para códigos 1D (rectángulo horizontal)
    // Basado en Dynamsoft scan-1D-Industrial: 20-80% width, 37-63% height
    const roiLeft = 0.20;
    const roiRight = 0.80;
    const roiTop = 0.37;
    const roiBottom = 0.63;
    
    const roiX = width * roiLeft;
    const roiY = height * roiTop;
    const roiWidth = width * (roiRight - roiLeft);
    const roiHeight = height * (roiBottom - roiTop);
    
    // Reduced resolution for low-quality barcodes (thermal printers)
    // Lower resolution = more real pixels per bar = better edge detection
    const maxCaptureWidth = 320;
    const scaleFactor = roiWidth > maxCaptureWidth ? (maxCaptureWidth / roiWidth) : 1;
    const targetWidth = Math.max(160, Math.round(roiWidth * scaleFactor));
    const targetHeight = Math.max(120, Math.round(roiHeight * scaleFactor));
    const ctx = ensureCaptureCanvas(targetWidth, targetHeight);
    if (!ctx) return null;
    
    // Draw only ROI region from video
    ctx.drawImage(els.video, roiX, roiY, roiWidth, roiHeight, 0, 0, targetWidth, targetHeight);
    
    let imageData = null;
    try {
      imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    } catch (error) {
      console.warn('[scanner] getImageData-error', error);
      return null;
    }
    const luminance = computeLuminance(imageData.data);
    if (luminance !== null) {
      recordLuminance(luminance);
    }
    enhanceImageBuffer(imageData.data);
    return {
      width: targetWidth,
      height: targetHeight,
      data: imageData.data,
      imageData,
      luminance,
      scaleX: roiWidth / targetWidth,
      scaleY: roiHeight / targetHeight
    };
  }

  function shouldTriggerHiResSnapshot() {
    if (!state.imageCapture || state.hiResSnapshotInFlight) return false;
    const now = Date.now();
    if (state.lastHiResSnapshot && (now - state.lastHiResSnapshot) < HIRES_SNAPSHOT_COOLDOWN) {
      return false;
    }
    return true;
  }

  function maybeTriggerHiResSnapshot(box, context = {}) {
    if (!state.imageCapture || !box) return;
    const videoDims = getVideoDimensions();
    const normalized = normalizeBoxRelative(box, videoDims);
    if (!normalized || !shouldTriggerHiResSnapshot()) {
      return;
    }
    captureHiResCropAndSend(normalized, context).catch((error) => {
      console.warn('[scanner] hires-crop-capture-error', error);
    });
  }

  async function captureHiResCropAndSend(normalizedBox, context = {}) {
    if (!state.imageCapture) return;
    state.hiResSnapshotInFlight = true;
    state.lastHiResSnapshot = Date.now();
    appendDebugLog('hires:snapshot:start', {
      source: context.source || 'camera',
      value: context.value || null
    });
    try {
      const photoBlob = await state.imageCapture.takePhoto();
      if (!photoBlob) {
        appendDebugLog('hires:snapshot:error', { message: 'Empty blob' });
        return;
      }
      const bitmap = await createImageBitmap(photoBlob);
      const cropResult = extractCropCanvasFromBitmap(bitmap, normalizedBox, HIRES_PADDING_RATIO);
      bitmap.close?.();
      if (!cropResult?.canvas) {
        appendDebugLog('hires:snapshot:error', { message: 'Crop failed' });
        return;
      }
      appendDebugLog('hires:snapshot:ready', {
        cropWidth: cropResult.canvas.width,
        cropHeight: cropResult.canvas.height
      });
      await triggerMlKitScan('hires-crop', {
        customCanvas: cropResult.canvas,
        profile: 'hires',
        luminance: state.lastLuminance,
        extraFields: {
          crop_box_x: String(Math.round(cropResult.cropBox.x)),
          crop_box_y: String(Math.round(cropResult.cropBox.y)),
          crop_box_width: String(Math.round(cropResult.cropBox.width)),
          crop_box_height: String(Math.round(cropResult.cropBox.height)),
          source_width: String(cropResult.sourceWidth),
          source_height: String(cropResult.sourceHeight),
          detection_value: context.value || '',
          detection_source: context.source || ''
        },
        jpegQuality: 0.96,
        force: true
      });
      appendDebugLog('hires:snapshot:sent', {});
    } catch (error) {
      console.warn('[scanner] hires-crop-upload-error', error);
      appendDebugLog('hires:snapshot:error', { message: error?.message || String(error) });
    } finally {
      state.hiResSnapshotInFlight = false;
    }
  }

  function extractCropCanvasFromBitmap(bitmap, normalizedBox, paddingRatio = HIRES_PADDING_RATIO) {
    const width = bitmap?.width || bitmap?.codedWidth || 0;
    const height = bitmap?.height || bitmap?.codedHeight || 0;
    if (!width || !height || !normalizedBox) {
      return null;
    }
    const baseWidth = clamp(normalizedBox.width, 0.05, 1) * width;
    const baseHeight = clamp(normalizedBox.height, 0.05, 1) * height;
    const padX = baseWidth * (paddingRatio || 0);
    const padY = baseHeight * (paddingRatio || 0);
    const originX = clamp((normalizedBox.x * width) - padX, 0, width - 1);
    const originY = clamp((normalizedBox.y * height) - padY, 0, height - 1);
    const cropWidth = clamp(baseWidth + (padX * 2), 20, width - originX);
    const cropHeight = clamp(baseHeight + (padY * 2), 20, height - originY);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cropWidth);
    canvas.height = Math.round(cropHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    ctx.drawImage(
      bitmap,
      originX,
      originY,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    return {
      canvas,
      cropBox: { x: originX, y: originY, width: cropWidth, height: cropHeight },
      sourceWidth: width,
      sourceHeight: height
    };
  }

  async function processQrFrame() {
    const frame = captureVideoFrame();
    if (!frame) {
      return false;
    }
    if (window.jsQR) {
      try {
        // Intento 1: Imagen normal
        const detection = window.jsQR(frame.data, frame.width, frame.height, {
          inversionAttempts: 'attemptBoth',
          tryHarder: true,
          canOverwriteImage: true
        });
        if (detection && detection.data) {
          const scaledLocation = scaleLocation(detection.location || null, frame.scaleX || 1, frame.scaleY || 1);
          handleDecodedValue(detection.data, scaledLocation);
          return true;
        }
      } catch (error) {
        console.warn('[scanner] jsQR-error', error);
      }
    }
    if (state.zxingReader && state.captureCanvas) {
      const handled = await decodeCanvasWithZxing(frame.scaleX || 1, frame.scaleY || 1, 'camera');
      if (handled) {
        return true;
      }
    }
    clearOverlay();
    return false;
  }

  async function captureStillAndDetect(reason = 'no-frame-detection') {
    if (!state.imageCapture || state.snapshotInFlight) {
      if (reason === 'manual-button' && !state.imageCapture) {
        setStatusBanner('Tu navegador no permite capturar fotos.', 'warning');
      }
      return;
    }
    const minInterval = 1500;
    const now = Date.now();
    if (state.lastStillAttempt && (now - state.lastStillAttempt) < minInterval) {
      return;
    }
    state.snapshotInFlight = true;
    state.lastStillAttempt = now;
    appendDebugLog('capture:still:start', { reason });
    if (reason === 'manual-button') {
      setStatusBanner('Tomando foto…', 'info');
    }
    try {
      const blob = await state.imageCapture.takePhoto();
      if (!blob) {
        appendDebugLog('capture:still-error', { message: 'Empty blob' });
        return;
      }
      const bitmap = await createImageBitmap(blob);
      let handled = false;
      const width = bitmap.width || bitmap.codedWidth || 0;
      const height = bitmap.height || bitmap.codedHeight || 0;
      if (state.barcodeDetector) {
        try {
          const detections = await state.barcodeDetector.detect(bitmap);
          handled = handleBitmapDetections(detections, width, height, 'photo');
        } catch (error) {
          console.warn('[scanner] still-barcode-error', error);
          appendDebugLog('capture:still-barcode-error', { message: error?.message || String(error) });
        }
      }
      if (!handled) {
        handled = detectBitmapWithJsQR(bitmap, 'photo');
      }
      const overlayWidth = els.overlay?.width || els.video?.videoWidth || width;
      const overlayHeight = els.overlay?.height || els.video?.videoHeight || height;
      const scaleX = overlayWidth / width;
      const scaleY = overlayHeight / height;
      if (!handled) {
        handled = await decodeCanvasWithZxing(scaleX, scaleY, 'photo');
      }
      if (handled) {
        appendDebugLog('capture:still:match', {});
      } else {
        appendDebugLog('capture:still:none', {});
      }
      bitmap.close?.();
    } catch (error) {
      console.warn('[scanner] capture-still-error', error);
      appendDebugLog('capture:still-error', { message: error?.message || String(error) });
    } finally {
      state.snapshotInFlight = false;
    }
  }

  function shouldTriggerMlKit(reason, force = false) {
    if (!state.mlKitEnabled || state.mlKitInFlight) return false;
    const now = Date.now();
    if (!force && state.mlKitLastInvocation && (now - state.mlKitLastInvocation) < MLKIT_FAILURE_COOLDOWN) {
      return false;
    }
    if (!force && reason === 'low-light' && state.lowLightFrames < LOW_LIGHT_SUSTAIN_FRAMES) {
      return false;
    }
    return true;
  }

  function canvasToBlob(canvas, mimeType = 'image/jpeg', quality = 0.92) {
    return new Promise((resolve, reject) => {
      if (!canvas?.toBlob) {
        resolve(null);
        return;
      }
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Blob vacío'));
          return;
        }
        resolve(blob);
      }, mimeType, quality);
    });
  }

  function applyCanvasPreprocessing(frame, profile = 'default') {
    if (!frame?.imageData || !state.captureCtx) {
      return null;
    }
    try {
      const clone = state.captureCtx.createImageData(frame.width, frame.height);
      clone.data.set(frame.imageData.data);
      const presets = profile === 'low-light'
        ? { contrast: 1.58, brightness: 28 }
        : { contrast: 1.18, brightness: 10 };
      enhanceImageBuffer(clone.data, presets);
      state.captureCtx.putImageData(clone, 0, 0);
      return () => {
        try {
          state.captureCtx.putImageData(frame.imageData, 0, 0);
        } catch (error) {
          console.warn('[scanner] mlkit-restore-error', error);
        }
      };
    } catch (error) {
      console.warn('[scanner] mlkit-preprocess-error', error);
      return null;
    }
  }

  function scaleRemoteBox(box, scaleX, scaleY) {
    if (!box) return null;
    const normalized = normalizeBoundingBox(box);
    if (!normalized) return null;
    return {
      x: normalized.x * scaleX,
      y: normalized.y * scaleY,
      width: normalized.width * scaleX,
      height: normalized.height * scaleY,
    };
  }

  async function triggerMlKitScan(reason = 'fallback', options = {}) {
    const {
      customCanvas = null,
      profile: profileOverride = null,
      luminance: luminanceOverride = null,
      extraFields = {},
      jpegQuality = null,
      force = false,
      frameDims = null,
    } = options;
    if (!shouldTriggerMlKit(reason, force)) {
      return;
    }
    let frame = null;
    let canvas = customCanvas;
    let restoreCanvas = null;
    let profile = profileOverride || 'default';
    let luminance = typeof luminanceOverride === 'number' ? luminanceOverride : null;
    let frameWidth = 0;
    let frameHeight = 0;
    if (!canvas) {
      frame = captureVideoFrame();
      if (!frame || !state.captureCanvas) {
        return;
      }
      const lowLightProfile = reason === 'low-light' || (frame.luminance !== null && frame.luminance < LOW_LIGHT_THRESHOLD);
      profile = lowLightProfile ? 'low-light' : 'default';
      luminance = frame.luminance;
      canvas = state.captureCanvas;
      restoreCanvas = applyCanvasPreprocessing(frame, profile);
      frameWidth = canvas.width || frame.width;
      frameHeight = canvas.height || frame.height;
    } else {
      frameWidth = canvas.width || 0;
      frameHeight = canvas.height || 0;
    }
    try {
      const blob = await canvasToBlob(canvas, 'image/jpeg', jpegQuality ?? (profile === 'low-light' ? 0.88 : 0.92));
      if (!blob) {
        return;
      }
      appendDebugLog('mlkit:frame', {
        profile,
        reason,
        luminance
      });
      const formData = new FormData();
      formData.append('image', blob, `scanner-mlkit-${Date.now()}.jpg`);
      formData.append('reason', reason);
      if (state.selectedPart?.id) {
        formData.append('part_id', String(state.selectedPart.id));
      }
      if (luminance !== null) {
        formData.append('brightness', String(luminance));
      }
      const videoDims = frameDims || getVideoDimensions();
      if (videoDims?.width && videoDims?.height) {
        formData.append('video_width', String(videoDims.width));
        formData.append('video_height', String(videoDims.height));
      }
      if (frameWidth) {
        formData.append('frame_width', String(frameWidth));
      }
      if (frameHeight) {
        formData.append('frame_height', String(frameHeight));
      }
      Object.entries(extraFields || {}).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        formData.append(key, String(value));
      });
      const csrfToken = requireCsrfToken(() => setStatusBanner('Sesión vencida. Refresca la página.', 'warning'));
      if (!csrfToken) {
        return;
      }
      state.mlKitInFlight = true;
      state.mlKitLastInvocation = Date.now();
      setStatusBanner('Escaneando con ML Kit…', 'info');
      const response = await fetch(MLKIT_ENDPOINT, {
        method: 'POST',
        body: formData,
        credentials: 'same-origin',
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': csrfToken,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload?.results || !payload.results.length) {
        appendDebugLog('mlkit:empty', { reason });
        return;
      }
      const renderedVideoDims = getVideoDimensions();
      const scaleX = renderedVideoDims?.width && frameWidth
        ? (renderedVideoDims.width / frameWidth)
        : 1;
      const scaleY = renderedVideoDims?.height && frameHeight
        ? (renderedVideoDims.height / frameHeight)
        : 1;
      payload.results.forEach((item) => {
        const raw = item.raw_value || item.rawValue || '';
        if (!raw) return;
        const box = scaleRemoteBox(item.bounding_box || item.boundingBox, scaleX, scaleY);
        handleDecodedValue(raw, null, 'mlkit', box);
      });
    } catch (error) {
      console.warn('[scanner] mlkit-error', error);
      appendDebugLog('mlkit:error', { message: error?.message || String(error), reason });
      setStatusBanner('No pudimos leer con ML Kit.', 'warning');
    } finally {
      if (typeof restoreCanvas === 'function') {
        restoreCanvas();
      }
      state.mlKitInFlight = false;
    }
  }

function setupZoomControls(track) {
  if (!els.zoomSlider || !els.zoomValue) return;
  const slider = els.zoomSlider;
  const display = els.zoomValue;
    const capabilities = track?.getCapabilities ? track.getCapabilities() : null;
    const zoomCap = capabilities?.zoom;
    if (!track || !zoomCap) {
      slider.disabled = true;
      display.textContent = '1.0x';
      state.zoomSupport = null;
      return;
    }
    const min = typeof zoomCap.min === 'number' ? zoomCap.min : 1;
    const max = typeof zoomCap.max === 'number' ? zoomCap.max : zoomCap;
    const step = typeof zoomCap.step === 'number' ? zoomCap.step : 0.05;
    state.zoomSupport = { min, max, step };
    slider.min = Math.round(min * 100);
    slider.max = Math.round(max * 100);
    slider.step = Math.max(1, Math.round(step * 100));
    const current = track.getSettings?.().zoom || min;
    slider.value = Math.round(current * 100);
  slider.disabled = false;
  updateZoomDisplay(current);
  updateCaptureButton(Boolean(state.imageCapture));
}

function updateZoomDisplay(zoomValue) {
  if (!els.zoomValue) return;
  const value = Number.isFinite(zoomValue) ? zoomValue : 1;
  els.zoomValue.textContent = `${value.toFixed(1)}x`;
}

function updateCaptureButton(enabled) {
  if (!els.captureBtn) return;
  els.captureBtn.disabled = !enabled;
}

  function setupTorchCapability(track) {
    const capabilities = track?.getCapabilities ? track.getCapabilities() : null;
    state.torchSupported = Boolean(capabilities?.torch);
    if (!state.torchSupported) {
      state.torchEnabled = false;
    }
    updateTorchButton();
  }

  async function toggleTorch(forceState) {
    if (!state.torchSupported || !state.videoTrack?.applyConstraints) {
      setStatusBanner('La linterna no está disponible en este dispositivo.', 'warning');
      return;
    }
    const desired = typeof forceState === 'boolean' ? forceState : !state.torchEnabled;
    try {
      await state.videoTrack.applyConstraints({ advanced: [{ torch: desired }] });
      state.torchEnabled = desired;
      updateTorchButton();
      setStatusBanner(desired ? 'Linterna activada.' : 'Linterna desactivada.', 'info');
    } catch (error) {
      console.warn('[scanner] torch-error', error);
      setStatusBanner('No se pudo controlar la linterna.', 'warning');
    }
  }

  function updateTorchButton() {
    if (!els.torchBtn) return;
    els.torchBtn.disabled = !state.torchSupported;
    if (state.torchSupported) {
      els.torchBtn.classList.toggle('btn-warning', !state.torchEnabled);
      els.torchBtn.classList.toggle('btn-success', state.torchEnabled);
      els.torchBtn.setAttribute('aria-pressed', state.torchEnabled ? 'true' : 'false');
      els.torchBtn.title = state.torchEnabled ? 'Apagar linterna' : 'Activar linterna';
    } else {
      els.torchBtn.classList.remove('btn-success');
      els.torchBtn.classList.add('btn-outline-warning');
      els.torchBtn.removeAttribute('aria-pressed');
      els.torchBtn.title = 'Activar linterna';
    }
  }

  let zoomApplyTimer = null;

  function handleZoomSliderInput(event) {
    const targetZoom = Number(event.target.value) / 100;
    updateZoomDisplay(targetZoom);
    if (!state.zoomSupport || !state.videoTrack?.applyConstraints) {
      return;
    }
    if (zoomApplyTimer) {
      clearTimeout(zoomApplyTimer);
    }
    zoomApplyTimer = window.setTimeout(async () => {
      try {
        await state.videoTrack.applyConstraints({ advanced: [{ zoom: targetZoom }] });
        appendDebugLog('camera:zoom', { value: targetZoom });
      } catch (error) {
        console.warn('[scanner] zoom-apply-error', error);
        appendDebugLog('camera:zoom-error', { message: error?.message || String(error) });
      }
    }, 120);
  }

  function applySharpenFilter(buffer, width, height) {
    // Sharpen kernel para realzar bordes borrosos (códigos térmicos de mala calidad)
    // TeaCapps/Google Lens usan ML Kit nativo con acceso directo a hardware
    // Navegador necesita compensar con filtros de imagen agresivos
    // Kernel: [-1,-1,-1] [-1,9,-1] [-1,-1,-1]
    const tempBuffer = new Uint8ClampedArray(buffer);
    const kernel = [-1,-1,-1, -1,9,-1, -1,-1,-1];
    
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let r = 0, g = 0, b = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * width + (x + kx)) * 4;
            const kernelIdx = (ky + 1) * 3 + (kx + 1);
            r += tempBuffer[idx] * kernel[kernelIdx];
            g += tempBuffer[idx + 1] * kernel[kernelIdx];
            b += tempBuffer[idx + 2] * kernel[kernelIdx];
          }
        }
        const idx = (y * width + x) * 4;
        buffer[idx] = Math.max(0, Math.min(255, r));
        buffer[idx + 1] = Math.max(0, Math.min(255, g));
        buffer[idx + 2] = Math.max(0, Math.min(255, b));
      }
    }
  }

  function applySimpleBinarization(buffer) {
    // Fast simple threshold (mean-based) for low-quality thermal barcodes
    // Much faster than Otsu, good enough for real-time
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      sum += buffer[i]; // R channel
    }
    const threshold = sum / (buffer.length / 4);
    
    // Apply threshold
    for (let i = 0; i < buffer.length; i += 4) {
      const val = buffer[i] > threshold ? 255 : 0;
      buffer[i] = buffer[i + 1] = buffer[i + 2] = val;
    }
  }

  const MIN_FRAME_INTERVAL = 80; // ms (balanced for performance)

  function drawROIGuide() {
    ensureOverlayContext();
    if (!state.overlayCtx) return;
    const ctx = state.overlayCtx;
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    
    // ROI optimizado para códigos 1D (CODE_128, térmica)
    // Rectángulo horizontal: 20-80% width, 37-63% height
    // Basado en ejemplos de Dynamsoft scan-1D-Industrial
    const roiLeft = 0.20;   // 20% desde la izquierda
    const roiRight = 0.80;  // 80% desde la izquierda (60% de ancho)
    const roiTop = 0.37;    // 37% desde arriba
    const roiBottom = 0.63; // 63% desde arriba (26% de altura)
    
    const roiX = width * roiLeft;
    const roiY = height * roiTop;
    const roiWidth = width * (roiRight - roiLeft);
    const roiHeight = height * (roiBottom - roiTop);
    
    // Semi-transparent overlay outside ROI
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, width, height);
    
    // Clear ROI area
    ctx.clearRect(roiX, roiY, roiWidth, roiHeight);
    
    // Draw ROI border
    ctx.strokeStyle = '#00ffb2';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 5]);
    ctx.strokeRect(roiX, roiY, roiWidth, roiHeight);
    ctx.setLineDash([]);
    
    // Draw corner markers for better visibility
    const cornerLength = 30;
    ctx.strokeStyle = '#00ffb2';
    ctx.lineWidth = 4;
    ctx.setLineDash([]);
    
    // Top-left
    ctx.beginPath();
    ctx.moveTo(roiX, roiY + cornerLength);
    ctx.lineTo(roiX, roiY);
    ctx.lineTo(roiX + cornerLength, roiY);
    ctx.stroke();
    
    // Top-right
    ctx.beginPath();
    ctx.moveTo(roiX + roiWidth - cornerLength, roiY);
    ctx.lineTo(roiX + roiWidth, roiY);
    ctx.lineTo(roiX + roiWidth, roiY + cornerLength);
    ctx.stroke();
    
    // Bottom-left
    ctx.beginPath();
    ctx.moveTo(roiX, roiY + roiHeight - cornerLength);
    ctx.lineTo(roiX, roiY + roiHeight);
    ctx.lineTo(roiX + cornerLength, roiY + roiHeight);
    ctx.stroke();
    
    // Bottom-right
    ctx.beginPath();
    ctx.moveTo(roiX + roiWidth - cornerLength, roiY + roiHeight);
    ctx.lineTo(roiX + roiWidth, roiY + roiHeight);
    ctx.lineTo(roiX + roiWidth, roiY + roiHeight - cornerLength);
    ctx.stroke();
  }

  function scanFrame(timestamp = 0) {
    if (!state.scanning) {
      state.frameRequest = null;
      return;
    }
    if (state.detecting) {
      // Usar requestVideoFrameCallback si está disponible (mejor para video)
      const requestFrame = ('requestVideoFrameCallback' in els.video)
        ? (callback) => els.video.requestVideoFrameCallback(callback)
        : requestAnimationFrame;
      state.frameRequest = requestFrame(scanFrame);
      return;
    }
    if (state.lastFrameTs && timestamp && (timestamp - state.lastFrameTs) < MIN_FRAME_INTERVAL) {
      const requestFrame = ('requestVideoFrameCallback' in els.video)
        ? (callback) => els.video.requestVideoFrameCallback(callback)
        : requestAnimationFrame;
      state.frameRequest = requestFrame(scanFrame);
      return;
    }
    state.lastFrameTs = timestamp;
    state.frameCount = (state.frameCount || 0) + 1;
    state.detecting = true;

    const finalize = () => {
      state.detecting = false;
      // requestVideoFrameCallback evita escanear el mismo frame múltiples veces
      // cuando el FPS de la cámara < refresh rate de pantalla (mejor detección 2-3x)
      const requestFrame = ('requestVideoFrameCallback' in els.video)
        ? (callback) => els.video.requestVideoFrameCallback(callback)
        : requestAnimationFrame;
      state.frameRequest = requestFrame(scanFrame);
    };

    const run = async () => {
      let handled = false;
      
      // Draw ROI guide before detection
      drawROIGuide();
      
      // Verificar cooldown de 2s después de detección exitosa
      const now = Date.now();
      const timeSinceLastDetection = now - state.lastSuccessfulDetection;
      if (state.lastSuccessfulDetection > 0 && timeSinceLastDetection < state.detectionCooldown) {
        // Mostrar tiempo restante durante cooldown
        const remainingSeconds = Math.ceil((state.detectionCooldown - timeSinceLastDetection) / 1000);
        setStatusBanner(`Esperando ${remainingSeconds}s antes de continuar…`, 'info');
        finalize();
        return;
      }
      
      // SIEMPRE usar BarcodeDetector nativo primero (rápido, procesamiento en GPU/CPU nativo)
      if (state.barcodeDetector) {
        try {
          const detections = await state.barcodeDetector.detect(els.video);
          if (detections && detections.length > 0) {
            // Código detectado con BarcodeDetector nativo - hacer procesamiento completo
            handled = handleBarcodeDetections(detections);
            
            // Si se detectó algo, también ejecutar procesamiento pesado para confirmar
            if (handled) {
              // Captura hi-res ya se dispara desde handleDecodedValue
              // También ejecutar jsQR/ZXing para doble confirmación en códigos difíciles
              const confirmedWithJsQR = await processQrFrame();
              if (!confirmedWithJsQR) {
                // Si jsQR no confirmó, intentar con captura de alta resolución
                captureStillAndDetect('barcode-detected-confirmation');
              }
            }
          }
        } catch (error) {
          console.warn('[scanner] barcode-detect-error', error);
          appendDebugLog('barcode:frame-error', { message: error?.message || String(error) });
        }
      }
      
      // Si BarcodeDetector no detectó nada, NO hacer procesamiento pesado en cada frame
      // Solo hacer procesamiento pesado ocasionalmente cuando falla repetidamente
      if (!handled && state.failedDetections > 5) {
        // Después de 5 fallos consecutivos, intentar métodos alternativos
        handled = await processQrFrame();
        if (!handled) {
          noteDetectionMiss(state.barcodeDetector ? 'frame-miss' : 'no-barcode-detector');
          captureStillAndDetect(state.barcodeDetector ? 'frame-miss' : 'no-barcode-detector');
        }
      } else if (!handled) {
        // Solo incrementar contador de fallos, no hacer procesamiento pesado
        state.failedDetections = Math.min(10, state.failedDetections + 1);
      }
      
      finalize();
    };

    run();
  }

  function startScanLoop() {
    if (state.scanning) return;
    state.scanning = true;
    state.lastFrameTs = 0;
    setStatusBanner('Escaneando…', 'info');
    state.frameRequest = requestAnimationFrame(scanFrame);
    appendDebugLog('scanloop:start');
  }

  function stopScanLoop() {
    state.scanning = false;
    state.detecting = false;
    if (state.frameRequest) {
      cancelAnimationFrame(state.frameRequest);
      state.frameRequest = null;
    }
    clearOverlay();
    appendDebugLog('scanloop:stop');
  }

  function handleMismatch(value, options = {}) {
    const { force = false, source = 'camera' } = options;
    if (!force && state.lastMismatch === value) return;
    state.lastMismatch = value;
    setStatusBanner(`Detectado: ${value}`, 'warning');
    setInfoState('mismatch');
    console.warn('[scanner] mismatch', {
      expected: state.selectedPart?.barcode,
      detected: value
    });
    appendDebugLog('mismatch', {
      expected: state.selectedPart?.barcode,
      detected: value,
      partId: state.selectedPart?.id || null,
      source
    });
    logScanEvent('mismatch', value, { source });
    setResultsStatus(`Código detectado (${value}) no coincide con la pieza (${state.selectedPart?.barcode || 'N/A'}).`, 'warning');
  }

  function noteDetectionMiss(reason = 'unknown') {
    state.failedDetections = Math.min(6, state.failedDetections + 1);
    appendDebugLog('detection:miss', { reason, streak: state.failedDetections });
    if (state.lowLightFrames >= LOW_LIGHT_SUSTAIN_FRAMES) {
      if (!state.torchEnabled && state.torchSupported) {
        toggleTorch(true).catch((error) => console.warn('[scanner] torch-auto-error', error));
      }
      triggerMlKitScan('low-light');
    } else if (state.failedDetections >= 3) {
      triggerMlKitScan(reason);
    }
  }

  function shouldAnnounceDetection(normalizedValue) {
    if (!normalizedValue) return false;
    const now = Date.now();
    if (state.lastDetectionValue === normalizedValue && (now - state.lastDetectionAt) < 1200) {
      return false;
    }
    state.lastDetectionValue = normalizedValue;
    state.lastDetectionAt = now;
    return true;
  }

  function announceDetection(rawValue, normalizedValue, matched) {
    if (!rawValue || !normalizedValue) {
      return;
    }
    const resolved = SearchIndex.findByBarcode(normalizedValue);
    logDetectionEvent({
      raw: rawValue,
      normalized: normalizedValue,
      resolvedId: resolved?.id || null,
      resolvedName: resolved?.name || '',
      matchedSelected: matched,
      selectedPartId: state.selectedPart?.id || null,
      selectedBarcode: state.selectedPart?.barcode || ''
    });
    if (!shouldAnnounceDetection(normalizedValue)) {
      return;
    }
    if (resolved) {
      const subtitleParts = [];
      if (resolved.auto) {
        subtitleParts.push(resolved.auto);
      }
      if (resolved.auto_year) {
        subtitleParts.push(resolved.auto_year);
      }
      appendLog(matched ? 'Pieza encontrada' : 'Lectura detectada', matched ? 'success' : 'info', {
        title: resolved.name,
        subtitle: subtitleParts.join(' · '),
        barcode: rawValue,
        badge: matched ? 'Coincidencia' : 'Detectada'
      });
      return;
    }
    appendLog('Código sin registro', 'warning', {
      title: 'Código sin registro',
      subtitle: 'No se encontró esta pieza en el catálogo local.',
      barcode: rawValue,
      badge: 'Sin registro'
    });
  }

  function handleMatch(detectedValue, boundingBox = null, options = {}) {
    const { source = 'camera' } = options;
    state.lastMismatch = null;
    setStatusBanner('¡Pieza encontrada!', 'success');
    setInfoState('success');
    playBeep();
    flashScreen();
    showHighlight(boundingBox);
    logScanEvent('match', detectedValue, { source });
    setResultsStatus('Coincidencia confirmada con este código.', 'success');
    console.info('[scanner] match confirmado', {
      partId: state.selectedPart?.id || null,
      barcode: state.selectedPart?.barcode,
      detected: detectedValue,
      source
    });
    appendDebugLog('match', {
      partId: state.selectedPart?.id || null,
      barcode: state.selectedPart?.barcode,
      detected: detectedValue,
      source
    });
    if (source === 'manual' && state.selectedPart) {
      const subtitleParts = [];
      if (state.selectedPart.auto) subtitleParts.push(state.selectedPart.auto);
      if (state.selectedPart.auto_year) subtitleParts.push(state.selectedPart.auto_year);
      appendLog('Coincidencia confirmada (manual)', 'success', {
        title: state.selectedPart.name,
        subtitle: subtitleParts.join(' · '),
        barcode: state.selectedPart.barcode,
        badge: 'Manual'
      });
    }
    setTimeout(() => {
      hideStatusBanner();
      setInfoState('ready');
    }, 1600);
  }

  function showHighlight(box) {
    if (els.flash) {
      els.flash.classList.remove('d-none');
      els.flash.classList.add('active');
      clearTimeout(state.highlightTimer);
      state.highlightTimer = setTimeout(() => {
        els.flash.classList.remove('active');
        els.flash.classList.add('d-none');
      }, 400);
    }
  }

  function playBeep() {
    try {
      if (!state.audioCtx) {
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = state.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.stop(ctx.currentTime + 0.3);
    } catch (error) {
      console.warn('beep-error', error);
    }
  }

  function flashScreen() {
    document.body.classList.add('scanner-flash-overlay');
    setTimeout(() => document.body.classList.remove('scanner-flash-overlay'), 320);
  }

  async function logScanEvent(status, detected, options = {}) {
    if (!state.selectedPart) return;
    const csrfToken = requireCsrfToken(() => {
      setStatusBanner('Sesión no válida. Refresca para seguir escaneando.', 'warning');
    });
    if (!csrfToken) {
      return;
    }
    try {
      appendDebugLog('scan-log:request', {
        partId: state.selectedPart.id,
        detected,
        status,
        source: options.source || 'camera',
      });
      await fetch('/parts/scan-verify/log/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRFToken': csrfToken,
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          part_id: state.selectedPart.id,
          detected_barcode: detected,
          status,
          source: options.source || 'camera'
        })
      });
    } catch (error) {
      console.error('scan-log', error);
      appendDebugLog('scan-log:error', { message: error?.message || String(error) });
    }
  }

  function setInfoState(stateName) {
    if (!els.detailCard) return;
    els.detailCard.classList.remove('success', 'mismatch');
    if (stateName === 'success') {
      els.detailCard.classList.add('success');
    } else if (stateName === 'mismatch') {
      els.detailCard.classList.add('mismatch');
    }
  }

  function handleChangePiece() {
    state.selectedPart = null;
    state.lastMismatch = null;
    state.lastDetectionValue = null;
    state.lastDetectionAt = 0;
    highlightResult(null);
    hideStatusBanner();
    setInfoState('ready');
    updateInfoPanel();
    exitActiveMode();
  }

  function handleExitMode() {
    handleChangePiece();
  }

  function enterActiveMode() {
    if (!els.page || !els.workspace || !els.searchShell) return;
    els.page.classList.add('scanner-page--active');
    els.workspace.classList.remove('d-none');
    els.searchShell.classList.add('d-none');
    document.body.classList.add('scanner-fullscreen-active');
    clearOverlay();
    startCamera();
  }

  function exitActiveMode() {
    stopCamera();
    if (!els.page || !els.workspace || !els.searchShell) return;
    els.page.classList.remove('scanner-page--active');
    els.workspace.classList.add('d-none');
    els.searchShell.classList.remove('d-none');
    document.body.classList.remove('scanner-fullscreen-active');
    if (els.detailCard) {
      els.detailCard.classList.remove('success');
    }
  }

  // Voice search (local Vosk endpoint)
  function initVoiceSearch() {
    if (!els.voiceBtn) return;
    const btn = els.voiceBtn;

    function cancelVoiceGesture(keepRecording) {
      const gesture = state.voiceGesture;
      if (!gesture) return;
      if (gesture.timer) clearTimeout(gesture.timer);
      if (gesture.scrollHandler) {
        window.removeEventListener('scroll', gesture.scrollHandler);
      }
      if (!keepRecording && gesture.started) {
        stopVoiceRecording(false);
      }
      state.voiceGesture = null;
      try {
        if (gesture.pointerId !== undefined) {
          els.voiceBtn.releasePointerCapture?.(gesture.pointerId);
        }
      } catch (_err) {}
    }

    const pointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      btn.setPointerCapture?.(event.pointerId);
      const gesture = {
        pointerId: event.pointerId,
        startScroll: window.scrollY || window.pageYOffset || 0,
        started: false,
        aborted: false,
        timer: null,
        scrollHandler: () => {
          if (!gesture.started && Math.abs((window.scrollY || window.pageYOffset || 0) - gesture.startScroll) > 6) {
            gesture.aborted = true;
            cancelVoiceGesture(false);
          }
        }
      };
      state.voiceGesture = gesture;
      window.addEventListener('scroll', gesture.scrollHandler, { passive: true });
      gesture.timer = setTimeout(() => {
        if (!gesture.aborted) {
          startVoiceRecording();
          gesture.started = true;
        }
      }, 300);
    };

    const pointerUp = (event) => {
      const gesture = state.voiceGesture;
      if (!gesture || (gesture.pointerId !== undefined && event.pointerId !== gesture.pointerId)) return;
      if (gesture.started) {
        stopVoiceRecording(true);
      }
      cancelVoiceGesture(true);
    };

    const pointerCancel = () => cancelVoiceGesture(false);

    const keyDown = (event) => {
      if (event.code !== 'Space' && event.code !== 'Enter') return;
      if (state.recordingVoice) return;
      event.preventDefault();
      startVoiceRecording();
      state.voiceGesture = { keyboard: true };
    };

    const keyUp = (event) => {
      if ((event.code !== 'Space' && event.code !== 'Enter') || !state.voiceGesture?.keyboard) return;
      event.preventDefault();
      stopVoiceRecording(true);
      state.voiceGesture = null;
    };

    btn.addEventListener('pointerdown', pointerDown);
    btn.addEventListener('pointerup', pointerUp);
    btn.addEventListener('pointercancel', pointerCancel);
    btn.addEventListener('keydown', keyDown);
    btn.addEventListener('keyup', keyUp);
  }

  const VOICE_MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/mpeg'
  ];
  const DEFAULT_VOICE_MIME = 'audio/webm';

  function pickVoiceMimeType() {
    if (!window.MediaRecorder || typeof window.MediaRecorder.isTypeSupported !== 'function') {
      return null;
    }
    for (const mime of VOICE_MIME_CANDIDATES) {
      try {
        if (window.MediaRecorder.isTypeSupported(mime)) {
          return mime;
        }
      } catch (_err) { /* ignore */ }
    }
    return null;
  }

  function guessExtension(mime) {
    if (!mime) return 'webm';
    if (mime.includes('mp4')) return 'mp4';
    if (mime.includes('mpeg')) return 'mp3';
    return mime.includes('webm') ? 'webm' : 'webm';
  }

  function startVoiceRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === 'undefined') {
      setVoiceStatus('Tu navegador no soporta dictado.', 'danger');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      state.voiceChunks = [];
      const mimeType = pickVoiceMimeType();
      state.voiceMimeType = mimeType || DEFAULT_VOICE_MIME;
      let options = mimeType ? { mimeType } : undefined;
      try {
        state.voiceRecorder = options ? new MediaRecorder(stream, options) : new MediaRecorder(stream);
      } catch (err) {
        console.warn('voice-recorder fallback', err);
        state.voiceRecorder = new MediaRecorder(stream);
        state.voiceMimeType = DEFAULT_VOICE_MIME;
      }
      state.voiceRecorder.addEventListener('dataavailable', (evt) => {
        if (evt.data && evt.data.size) state.voiceChunks.push(evt.data);
      });
      state.voiceRecorder.addEventListener('stop', handleVoiceStop);
      state.voiceRecorder.start();
      state.recordingVoice = true;
      setVoiceStatus('Grabando… suelta para buscar.', 'info');
      state.voiceTimeout = setTimeout(() => stopVoiceRecording(true), 4500);
    }).catch((err) => {
      console.error('voice-search', err);
      setVoiceStatus('Permiso de micrófono denegado.', 'danger');
    });
  }

  function stopVoiceRecording(upload) {
    if (!state.recordingVoice) return;
    state.recordingVoice = false;
    clearTimeout(state.voiceTimeout);
    state.voiceTimeout = null;
    if (state.voiceRecorder) {
      const recorder = state.voiceRecorder;
      state.voiceRecorder = null;
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
      recorder.stream.getTracks().forEach((track) => track.stop());
    }
    if (!upload) {
      state.voiceChunks = [];
      state.voiceMimeType = null;
    }
  }

  function handleVoiceStop() {
    if (!state.voiceChunks.length) {
      setVoiceStatus('No se capturó audio.', 'warning');
      return;
    }
    setVoiceStatus('Procesando dictado…', 'info');
    const mimeType = state.voiceMimeType || DEFAULT_VOICE_MIME;
    const extension = guessExtension(mimeType);
    const blob = new Blob(state.voiceChunks, { type: mimeType });
    state.voiceChunks = [];
    state.voiceMimeType = null;
    const formData = new FormData();
    formData.append('audio', blob, `scanner-search.${extension}`);
    const csrfToken = requireCsrfToken(() => {
      setVoiceStatus('Sesión inválida. Refresca para seguir dictando.', 'danger');
    });
    if (!csrfToken) {
      return;
    }
    fetch('/parts/voice-search/transcribe/', {
      method: 'POST',
      headers: {
        'X-CSRFToken': csrfToken,
        'X-Requested-With': 'XMLHttpRequest'
      },
      credentials: 'same-origin',
      body: formData
    })
      .then(async (resp) => {
        if (resp.status === 403) {
          throw new Error('Sesión expirada. Vuelve a ingresar para dictar.');
        }
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data?.success) {
          throw new Error(data?.error || `Error ${resp.status}`);
        }
        const transcript = data.transcript || data.normalized || '';
        els.searchInput.value = transcript;
        setVoiceStatus(`Búsqueda: “${transcript}”`, 'success');
        applyLocalResults(transcript);
        scheduleSearchFetch(transcript);
      })
      .catch((err) => {
        console.error('voice-transcribe', err);
        setVoiceStatus(err?.message || 'No se pudo transcribir el audio.', 'danger');
      });
  }

  function setVoiceStatus(text, variant) {
    if (!els.voiceStatus) return;
    const map = {
      info: 'text-info',
      success: 'text-success',
      danger: 'text-danger',
      warning: 'text-warning',
      muted: 'text-muted'
    };
    els.voiceStatus.textContent = text;
    els.voiceStatus.className = `small ${map[variant] || 'text-muted'} mt-1`;
  }

  function bindEvents() {
    els.searchInput?.addEventListener('input', (event) => {
      const value = event.target.value;
      applyLocalResults(value);
      scheduleSearchFetch(value);
    });

    els.results?.addEventListener('click', (event) => {
      const row = event.target.closest('.scanner-result-item');
      if (!row) return;
      selectPart(row.dataset.id);
    });

    els.changePiece?.addEventListener('click', handleChangePiece);
    els.toggleCameraBtn?.addEventListener('click', () => {
      if (!state.selectedPart) {
        setResultsStatus('Selecciona una pieza antes de activar la cámara.', 'warning');
        return;
      }
      startCamera();
    });
    els.torchBtn?.addEventListener('click', () => toggleTorch());
    els.debugExportBtn?.addEventListener('click', exportDebugLog);
    els.stopCameraBtn?.addEventListener('click', stopCamera);
    els.exitModeFloatingBtn?.addEventListener('click', handleExitMode);
    els.zoomSlider?.addEventListener('input', handleZoomSliderInput);
    els.captureBtn?.addEventListener('click', () => captureStillAndDetect('manual-button'));
    window.addEventListener('beforeunload', stopCamera);
  }

  function init() {
    // Re-obtener elementos del DOM por si Turbo navegó
    els.page = document.getElementById('scanner-page');
    els.searchShell = document.getElementById('scanner-search-shell');
    els.workspace = document.getElementById('scanner-workspace');
    els.searchInput = document.getElementById('scanner-search-input');
    els.results = document.getElementById('scanner-results');
    els.resultsStatus = document.getElementById('scanner-results-status');
    els.voiceBtn = document.getElementById('scanner-voice-btn');
    els.voiceStatus = document.getElementById('scanner-voice-status');
    els.video = document.getElementById('scanner-video');
    els.overlay = document.getElementById('scanner-overlay');
    els.flash = document.getElementById('scanner-flash');
    els.statusBanner = document.getElementById('scanner-status-banner');
    els.detailCard = document.getElementById('scanner-detail-card');
    els.pieceName = document.getElementById('scanner-piece-name');
    els.photoPlaceholder = document.getElementById('scanner-photo-placeholder');
    els.photoThumbs = document.getElementById('scanner-photo-thumbs');
    els.changePiece = document.getElementById('scanner-change-piece-btn');
    els.toggleCameraBtn = document.getElementById('scanner-toggle-camera-btn');
    els.stopCameraBtn = document.getElementById('scanner-stop-camera-btn');
    els.cameraStatus = document.getElementById('scanner-camera-status');
    els.toastStack = document.getElementById('scanner-toast-stack');
    els.debugExportBtn = document.getElementById('scanner-debug-export-btn');
    els.exitModeFloatingBtn = document.getElementById('scanner-exit-mode-floating');
    els.zoomSlider = document.getElementById('scanner-zoom-slider');
    els.zoomValue = document.getElementById('scanner-zoom-value');
    els.captureBtn = document.getElementById('scanner-capture-btn');
    state.mlKitEnabled = (els.page?.dataset?.mlkitEnabled || '').toLowerCase() === 'true';

    // Solo inicializar si estamos en la página del scanner
    if (!els.page) {
      return;
    }

    if (els.page.dataset.scannerBound === 'true') {
      return;
    }
    els.page.dataset.scannerBound = 'true';

    // Re-leer initial parts por si navegamos con Turbo
    const initialPartsScript = document.getElementById('scan-initial-parts');
    const freshInitialParts = initialPartsScript ? JSON.parse(initialPartsScript.textContent || '[]') : [];
    
    resetDebugLog();
    appendDebugLog('init', { initialParts: freshInitialParts.length });
    setupZxingReader();
    bindViewportListeners();
    updateInfoPanel();
    applyLocalResults('', freshInitialParts);
    bindEvents();
    initVoiceSearch();
    fetchResults('');
  }

  window.getScannerDebugLog = () => buildDebugBundle();

  // Inicializar en DOMContentLoaded Y en Turbo frame-load
  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('turbo:frame-load', init);
  document.addEventListener('turbo:load', init);

  if (document.readyState !== 'loading') {
    window.requestAnimationFrame(init);
  }
})();
