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
        console.error('[MLKitScanner] Capacitor not available');
        return;
      }
      
      console.log('[MLKitScanner] Capacitor available, platform:', window.Capacitor.getPlatform());
      console.log('[MLKitScanner] Available plugins:', Object.keys(window.Capacitor.Plugins || {}));
      
      // Obtener plugin desde Capacitor.Plugins
      this.plugin = window.Capacitor.Plugins.MLKitScanner;
      
      if (!this.plugin) {
        console.error('[MLKitScanner] Plugin NOT found in Capacitor.Plugins');
        console.error('[MLKitScanner] This means the native plugin was not compiled or registered');
        console.error('[MLKitScanner] Available plugins are:', Object.keys(window.Capacitor.Plugins || {}));
        return;
      }
      
      this.isInitialized = true;
      console.log('[MLKitScanner] ✅ Plugin initialized successfully');
      
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
      this.eventListener = await this.plugin.addListener('barcodeScanned', (data) => {
        console.log('[MLKitScanner] Barcode scanned:', data);
        if (this.onBarcodeDetected) {
          this.onBarcodeDetected(data);
        }
      });
      console.log('[MLKitScanner] Event listener registered for barcodeScanned');
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
