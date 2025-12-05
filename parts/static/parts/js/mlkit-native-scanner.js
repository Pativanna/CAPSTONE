/**
 * ML Kit Native Scanner Wrapper
 * Escaneo continuo de códigos de barras con Google ML Kit
 * Integrado en la app (no full-screen)
 */

class MLKitNativeScanner {
  constructor() {
    this.plugin = null;
    this.onBarcodeDetected = null;
    this.isInitialized = false;
    this.eventListener = null;
    
    this.initialize();
  }
  
  initialize() {
    try {
      // Verificar que Capacitor esté disponible
      if (typeof window.Capacitor === 'undefined') {
        console.warn('[MLKitScanner] Capacitor not available');
        return;
      }
      
      // Obtener plugin desde Capacitor.Plugins
      this.plugin = window.Capacitor.Plugins.MLKitScanner;
      
      if (!this.plugin) {
        console.warn('[MLKitScanner] Plugin not found in Capacitor.Plugins');
        return;
      }
      
      this.isInitialized = true;
      console.log('[MLKitScanner] Plugin initialized successfully');
      
    } catch (error) {
      console.error('[MLKitScanner] Initialization error:', error);
    }
  }
  
  isSupported() {
    return this.isInitialized && this.plugin !== null;
  }
  
  async checkPermissions() {
    if (!this.isSupported()) {
      throw new Error('MLKit plugin not available');
    }
    
    try {
      const result = await this.plugin.checkPermissions();
      console.log('[MLKitScanner] Permissions status:', result);
      return result;
    } catch (error) {
      console.error('[MLKitScanner] Check permissions error:', error);
      throw error;
    }
  }
  
  async requestPermissions() {
    if (!this.isSupported()) {
      throw new Error('MLKit plugin not available');
    }
    
    try {
      const result = await this.plugin.requestPermissions();
      console.log('[MLKitScanner] Permissions result:', result);
      return result;
    } catch (error) {
      console.error('[MLKitScanner] Request permissions error:', error);
      throw error;
    }
  }
  
  /**
   * Iniciar escaneo continuo
   * @param {Function} callback - Función que recibe {value, format, cornerPoints}
   */
  async startScan(callback) {
    if (!this.isSupported()) {
      throw new Error('MLKit plugin not available');
    }
    
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    
    // Verificar permisos primero
    const permissions = await this.checkPermissions();
    
    if (permissions.camera !== 'granted') {
      console.log('[MLKitScanner] Requesting camera permission...');
      const result = await this.requestPermissions();
      
      if (result.camera !== 'granted') {
        throw new Error('Camera permission denied');
      }
    }
    
    // Guardar callback
    this.onBarcodeDetected = callback;
    
    // Registrar event listener para detecciones continuas
    if (!this.eventListener) {
      this.eventListener = await this.plugin.addListener('barcodeDetected', (data) => {
        console.log('[MLKitScanner] Barcode detected:', data);
        if (this.onBarcodeDetected) {
          this.onBarcodeDetected(data);
        }
      });
      console.log('[MLKitScanner] Event listener registered');
    }
    
    try {
      // Iniciar escáner
      const result = await this.plugin.startScan();
      console.log('[MLKitScanner] Scan started:', result);
      return result;
      
    } catch (error) {
      console.error('[MLKitScanner] Start scan error:', error);
      // Limpiar listener si falla
      if (this.eventListener) {
        this.eventListener.remove();
        this.eventListener = null;
      }
      throw error;
    }
  }
  
  async stopScan() {
    if (!this.isSupported()) {
      return;
    }
    
    try {
      // Detener escáner
      await this.plugin.stopScan();
      console.log('[MLKitScanner] Scan stopped');
      
      // Remover event listener
      if (this.eventListener) {
        this.eventListener.remove();
        this.eventListener = null;
        console.log('[MLKitScanner] Event listener removed');
      }
      
      this.onBarcodeDetected = null;
      
    } catch (error) {
      console.error('[MLKitScanner] Stop scan error:', error);
    }
  }
}

// Exponer globalmente
window.MLKitNativeScanner = MLKitNativeScanner;

// Auto-inicializar si Capacitor ya está listo
if (typeof window.Capacitor !== 'undefined') {
  console.log('[MLKitScanner] Auto-initializing...');
  window.mlKitScanner = new MLKitNativeScanner();
} else {
  // Esperar a que Capacitor esté listo
  document.addEventListener('deviceready', () => {
    console.log('[MLKitScanner] Initializing on deviceready...');
    window.mlKitScanner = new MLKitNativeScanner();
  });
}
      this._log('Setting isScanning = true');

      // Configuración para escaneo de códigos 1D (CODE_128, etc.)
      const scanOptions = {
        formats: [
          'CODE_128',
          'CODE_39',
          'CODE_93',
          'EAN_13',
          'EAN_8',
          'UPC_A',
          'UPC_E',
          'QR_CODE',
          'DATA_MATRIX',
          'ITF'
        ],
        // Optimizaciones para códigos térmicos de baja calidad
        lensFacing: 'back',  // Cámara trasera
      };

      this._log('Starting native scan with options', scanOptions);
      this._log('Calling BarcodeScanner.scan() - UI will block until scan completes');

      // Iniciar escaneo nativo - BLOQUEA UI hasta que detecte o usuario cancele
      const result = await this.BarcodeScanner.scan(scanOptions);

      this._log('Scan completed', {
        hasResult: !!result,
        hasBarcodes: !!result?.barcodes,
        barcodeCount: result?.barcodes?.length || 0
      });

      if (result.barcodes && result.barcodes.length > 0) {
        const barcode = result.barcodes[0];
        this._log('Barcode detected', {
          value: barcode.displayValue || barcode.rawValue,
          format: barcode.format,
          hasCornerPoints: !!barcode.cornerPoints
        });
        
        return {
          value: barcode.displayValue || barcode.rawValue,
          format: barcode.format,
          rawValue: barcode.rawValue,
          cornerPoints: barcode.cornerPoints,
          source: 'mlkit-native'
        };
      }

      this._log('No barcode detected in scan result');
      return null;
    } catch (error) {
      this._log('ERROR during scan', {
        message: error.message,
        code: error.code,
        name: error.name,
        stack: error.stack
      });
      throw error;
    } finally {
      this.isScanning = false;
      this._log('Setting isScanning = false');
    }
  }

  async stopScan() {
    this._log('stopScan() called');
    if (this.isSupported && this.BarcodeScanner) {
      try {
        this._log('Calling BarcodeScanner.stopScan()');
        await this.BarcodeScanner.stopScan();
        this.isScanning = false;
        this._log('Scan stopped successfully');
      } catch (error) {
        this._log('ERROR in stopScan()', {
          message: error.message
        });
      }
    } else {
      this._log('stopScan() skipped', {
        isSupported: this.isSupported,
        hasBarcodeScanner: !!this.BarcodeScanner
      });
    }
  }

  async checkPermissions() {
    this._log('checkPermissions() called');
    if (!this.isSupported || !this.BarcodeScanner) {
      this._log('Cannot check permissions - not supported or not initialized');
      return { camera: 'denied' };
    }

    try {
      this._log('Calling BarcodeScanner.checkPermissions()');
      const result = await this.BarcodeScanner.checkPermissions();
      this._log('checkPermissions() result', result);
      return result;
    } catch (error) {
      this._log('ERROR in checkPermissions()', {
        message: error.message
      });
      return { camera: 'denied' };
    }
  }
}

// Exportar instancia global
window.MLKitNativeScanner = MLKitNativeScanner;
