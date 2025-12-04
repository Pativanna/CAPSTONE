/**
 * ML Kit Native Scanner for Capacitor
 * Usa Google ML Kit nativo (como TeaCapps) cuando está en app móvil
 */

class MLKitNativeScanner {
  constructor() {
    this.diagnosticLog = [];
    this._log('Constructor called');
    this.BarcodeScanner = null;
    this.isSupported = false;
    this.isScanning = false;
    this._initPromise = null;
    this._checkNativePlatform();
  }

  _log(message, data = null) {
    const entry = {
      ts: new Date().toISOString(),
      msg: message,
      data: data
    };
    this.diagnosticLog.push(entry);
    console.log(`[MLKit] ${message}`, data || '');
  }

  _checkNativePlatform() {
    this._log('Checking native platform');
    
    const hasCapacitor = typeof window.Capacitor !== 'undefined';
    this._log('window.Capacitor exists', hasCapacitor);
    
    if (!hasCapacitor) {
      this._log('SKIP: No Capacitor found');
      return;
    }
    
    const hasIsNativePlatform = typeof window.Capacitor.isNativePlatform === 'function';
    this._log('Capacitor.isNativePlatform is function', hasIsNativePlatform);
    
    if (!hasIsNativePlatform) {
      this._log('SKIP: isNativePlatform not a function');
      return;
    }
    
    const isNative = window.Capacitor.isNativePlatform();
    this._log('Capacitor.isNativePlatform() result', isNative);
    
    if (!isNative) {
      this._log('SKIP: Not running in native platform');
      return;
    }
    
    const platform = window.Capacitor.getPlatform?.();
    this._log('Platform detected', platform);
    
    this._log('Starting async initialization...');
    this._initPromise = this._init();
  }

  async _init() {
    try {
      this._log('Step 1: Importing @capacitor-mlkit/barcode-scanning module');
      
      const importResult = await import('@capacitor-mlkit/barcode-scanning');
      this._log('Import successful', { keys: Object.keys(importResult) });
      
      const { BarcodeScanner } = importResult;
      this._log('BarcodeScanner extracted', typeof BarcodeScanner);
      
      if (!BarcodeScanner) {
        throw new Error('BarcodeScanner not found in import');
      }
      
      this.BarcodeScanner = BarcodeScanner;
      this._log('BarcodeScanner assigned to instance');
      
      this._log('Step 2: Checking if ML Kit is supported on this device');
      this.isSupported = await this.BarcodeScanner.isSupported();
      this._log('isSupported() result', this.isSupported);
      
      if (!this.isSupported) {
        this._log('WARNING: ML Kit not supported on this device');
        return;
      }
      
      this._log('Step 3: Requesting camera permissions');
      const permissionResult = await this.requestPermissions();
      this._log('Permission request completed', permissionResult);
      
      this._log('SUCCESS: ML Kit fully initialized and ready');
      
    } catch (error) {
      this._log('ERROR during initialization', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      this.isSupported = false;
    }
  }

  async ensureReady() {
    this._log('ensureReady() called');
    if (this._initPromise) {
      this._log('Waiting for initialization to complete...');
      await this._initPromise;
      this._log('Initialization complete, isSupported:', this.isSupported);
    } else {
      this._log('No initialization promise (not native platform)');
    }
    return this.isSupported;
  }

  getDiagnostics() {
    return {
      log: this.diagnosticLog,
      state: {
        isSupported: this.isSupported,
        isScanning: this.isScanning,
        hasBarcodeScanner: !!this.BarcodeScanner,
        hasInitPromise: !!this._initPromise
      }
    };
  }

  async requestPermissions() {
    this._log('requestPermissions() called');
    
    if (!this.BarcodeScanner) {
      this._log('ERROR: Cannot request permissions - BarcodeScanner not initialized');
      return false;
    }

    try {
      this._log('Calling BarcodeScanner.checkPermissions()');
      const currentPermissions = await this.BarcodeScanner.checkPermissions();
      this._log('Current permissions', currentPermissions);

      if (currentPermissions.camera === 'granted') {
        this._log('Camera permission already granted');
        return true;
      }

      this._log('Camera not granted, requesting permissions...');
      this._log('Calling BarcodeScanner.requestPermissions()');
      const { camera } = await this.BarcodeScanner.requestPermissions();
      this._log('Permission request result', { camera });

      if (camera === 'granted') {
        this._log('SUCCESS: Camera permission granted');
        return true;
      } else {
        this._log('WARNING: Camera permission denied', camera);
        return false;
      }
    } catch (error) {
      this._log('ERROR in requestPermissions()', {
        message: error.message,
        stack: error.stack
      });
      return false;
    }
  }

  async startScan(options = {}) {
    this._log('startScan() called', options);
    
    if (!this.isSupported || !this.BarcodeScanner) {
      this._log('ERROR: Cannot start scan - ML Kit not supported or not initialized');
      throw new Error('ML Kit not supported on this platform');
    }

    if (this.isScanning) {
      this._log('WARNING: Scan already in progress, ignoring duplicate call');
      return null;
    }

    try {
      this.isScanning = true;
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
