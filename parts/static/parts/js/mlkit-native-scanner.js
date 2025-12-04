/**
 * ML Kit Native Scanner for Capacitor
 * Usa Google ML Kit nativo (como TeaCapps) cuando está en app móvil
 */

class MLKitNativeScanner {
  constructor() {
    console.log('[MLKit] Constructor called');
    this.BarcodeScanner = null;
    this.isSupported = false;
    this.isScanning = false;
    this._initPromise = null;
    this._checkNativePlatform();
  }

  _checkNativePlatform() {
    console.log('[MLKit] Checking native platform...');
    console.log('[MLKit] window.Capacitor:', typeof window.Capacitor);
    console.log('[MLKit] Capacitor.isNativePlatform:', window.Capacitor?.isNativePlatform?.());
    
    if (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform()) {
      console.log('[MLKit] Native platform detected, starting initialization');
      this._initPromise = this._init();
    } else {
      console.log('[MLKit] Not a native platform, skipping ML Kit');
    }
  }

  async _init() {
    try {
      console.log('[MLKit] Importing @capacitor-mlkit/barcode-scanning...');
      const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
      this.BarcodeScanner = BarcodeScanner;
      
      console.log('[MLKit] Checking if supported...');
      this.isSupported = await this.BarcodeScanner.isSupported();
      console.log('[MLKit] Native scanner supported:', this.isSupported);
      
      if (this.isSupported) {
        // Solicitar permisos inmediatamente
        console.log('[MLKit] Requesting camera permissions...');
        await this.requestPermissions();
      }
    } catch (error) {
      console.error('[MLKit] Initialization failed:', error);
      this.isSupported = false;
    }
  }

  async ensureReady() {
    if (this._initPromise) {
      await this._initPromise;
    }
    return this.isSupported;
  }

  async requestPermissions() {
    try {
      const { camera } = await this.BarcodeScanner.requestPermissions();
      console.log('[MLKit] Camera permission:', camera);
      return camera === 'granted';
    } catch (error) {
      console.warn('[MLKit] Permission error:', error);
      return false;
    }
  }

  async startScan(options = {}) {
    if (!this.isSupported || !this.BarcodeScanner) {
      throw new Error('ML Kit not supported on this platform');
    }

    if (this.isScanning) {
      console.warn('[MLKit] Scan already in progress');
      return null;
    }

    try {
      this.isScanning = true;

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

      console.log('[MLKit] Starting scan with options:', scanOptions);

      // Iniciar escaneo nativo - BLOQUEA UI hasta que detecte o usuario cancele
      const result = await this.BarcodeScanner.scan(scanOptions);

      console.log('[MLKit] Scan result:', result);

      if (result.barcodes && result.barcodes.length > 0) {
        const barcode = result.barcodes[0];
        return {
          value: barcode.displayValue || barcode.rawValue,
          format: barcode.format,
          rawValue: barcode.rawValue,
          cornerPoints: barcode.cornerPoints,
          source: 'mlkit-native'
        };
      }

      return null;
    } catch (error) {
      console.error('[MLKit] Scan error:', error);
      throw error;
    } finally {
      this.isScanning = false;
    }
  }

  async stopScan() {
    if (this.isSupported && this.BarcodeScanner) {
      try {
        await this.BarcodeScanner.stopScan();
        this.isScanning = false;
        console.log('[MLKit] Scan stopped');
      } catch (error) {
        console.warn('[MLKit] Stop scan error:', error);
      }
    }
  }

  async checkPermissions() {
    if (!this.isSupported || !this.BarcodeScanner) {
      return { camera: 'denied' };
    }

    try {
      return await this.BarcodeScanner.checkPermissions();
    } catch (error) {
      console.warn('[MLKit] Check permissions error:', error);
      return { camera: 'denied' };
    }
  }
}

// Exportar instancia global
window.MLKitNativeScanner = MLKitNativeScanner;
