(function () {
  'use strict';

  // ============================================================================
  // PLATFORM DETECTION
  // ============================================================================
  
  const isNativePlatform = typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform();
  const isAndroid = isNativePlatform && window.Capacitor.getPlatform() === 'android';
  
  console.log('[scanner] Platform:', isNativePlatform ? 'Native Mobile' : 'Web Browser');
  if (isNativePlatform) {
    console.log('[scanner] Platform Details:', window.Capacitor.getPlatform());
  }

  // ============================================================================
  // ML KIT SCANNER INITIALIZATION
  // ============================================================================
  
  let mlKitScanner = null;
  
  function initMLKitScanner() {
    if (mlKitScanner !== null) {
      return mlKitScanner;  // Ya inicializado
    }
    
    if (!isNativePlatform) {
      console.log('[scanner] Not on native platform, skipping ML Kit');
      return null;
    }
    
    if (!window.MLKitNativeScanner) {
      console.error('[scanner] ❌ MLKitNativeScanner class not found');
      console.error('[scanner] Check that mlkit-native-scanner.js loaded correctly');
      return null;
    }
    
    try {
      mlKitScanner = new window.MLKitNativeScanner();
      if (mlKitScanner.isSupported()) {
        console.log('[scanner] ✅ ML Kit BUNDLED Native Scanner initialized and ready');
        return mlKitScanner;
      } else {
        console.error('[scanner] ❌ ML Kit plugin initialized but NOT supported');
        console.error('[scanner] This APK does NOT have MLKitScannerPlugin compiled');
        mlKitScanner = null;
        return null;
      }
    } catch (error) {
      console.error('[scanner] ❌ Error initializing ML Kit:', error);
      mlKitScanner = null;
      return null;
    }
  }

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================
  
  const state = {
    lastSuccessfulDetection: 0,
    detectionCooldown: 2000, // 2 segundos de pausa después de detectar
    lastDetectedCode: null,
    scannerState: 'SCANNING', // SCANNING | DETECTED | CONFIRMED
    cameraStatus: 'Esperando...',
  };

  // ============================================================================
  // DOM ELEMENTS
  // ============================================================================
  
  const els = {
    toggleCameraBtn: document.getElementById('toggle-camera-btn'),
    stopCameraBtn: document.getElementById('stop-camera-btn'),
    cameraStatus: document.getElementById('camera-status'),
    statusBanner: document.querySelector('.scanner-status-banner'),
    resultsContainer: document.getElementById('results-container'),
    resultsStatus: document.getElementById('results-status'),
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

    // Buscar en backend
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
  // CAMERA CONTROL
  // ============================================================================
  
  async function startCamera() {
    console.log('[scanner:startCamera] Starting...');
    
    // Solo ML Kit nativo - sin fallback web
    if (!isNativePlatform) {
      console.error('[scanner] Esta app solo funciona en plataforma nativa (Android/iOS)');
      setCameraStatus('Esta función solo está disponible en la aplicación móvil');
      setStatusBanner('Usa la aplicación móvil para escanear', 'warning');
      return;
    }
    
    const scanner = initMLKitScanner();
    if (!scanner) {
      console.error('[scanner] ML Kit scanner not available');
      setCameraStatus('Escáner no disponible. Verifica que estás usando la app correcta.');
      setStatusBanner('Escáner no disponible', 'warning');
      return;
    }
    
    console.log('[scanner] Using ML Kit BUNDLED Native Scanner (continuous mode)');
    
    if (els.toggleCameraBtn) {
      els.toggleCameraBtn.disabled = true;
      els.toggleCameraBtn.setAttribute('aria-busy', 'true');
    }
    
    try {
      setCameraStatus('Iniciando escáner ML Kit...');
      
      // Iniciar escaneo continuo con callback
      await scanner.startScan((result) => {
        console.log('[scanner] ML Kit detected:', result);
        // Procesar código detectado inmediatamente y continuar escaneando
        handleDecodedValue(result.value, null, 'mlkit-native', result.cornerPoints || null);
      });
      
      setCameraStatus('Escáner activo - Apunta al código de barras');
      setStatusBanner('Escaneando...', 'info');
      
      if (els.stopCameraBtn) {
        els.stopCameraBtn.disabled = false;
      }
      
    } catch (error) {
      console.error('[scanner] ML Kit error:', error);
      setCameraStatus('Error en escáner nativo: ' + error.message);
      setStatusBanner('Error al iniciar escáner', 'warning');
    }
    
    if (els.toggleCameraBtn) {
      els.toggleCameraBtn.disabled = false;
      els.toggleCameraBtn.removeAttribute('aria-busy');
    }
  }

  function stopCamera() {
    // Detener escáner nativo ML Kit
    if (mlKitScanner) {
      mlKitScanner.stopScan().catch(err => {
        console.warn('[scanner] Error stopping ML Kit:', err);
      });
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

  // ============================================================================
  // INITIALIZATION
  // ============================================================================
  
  console.log('[scanner] MLKit-only scanner module initialized');
  
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
