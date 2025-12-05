/**
 * ML Kit Native Scanner Wrapper
 * Escaneo continuo de códigos de barras con Google ML Kit
 * Integrado en la app (no full-screen)
 */

// Prevenir doble inicialización (Turbo puede cargar el script múltiples veces)
if (typeof window.MLKitNativeScanner === 'undefined') {

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
      if (typeof window.Capacitor === 'undefined') {
        console.error('[MLKitScanner] Capacitor not available');
        return;
      }
      
      console.log('[MLKitScanner] Capacitor available, platform:', window.Capacitor.getPlatform());
      console.log('[MLKitScanner] Available plugins:', Object.keys(window.Capacitor.Plugins || {}));
      
      if (this.refreshPluginReference()) {
        console.log('[MLKitScanner] ✅ Plugin initialized successfully');
      } else {
        console.warn('[MLKitScanner] Plugin not ready yet, will retry lazily');
      }
    } catch (error) {
      console.error('[MLKitScanner] Initialization error:', error);
    }
  }

  refreshPluginReference() {
    if (typeof window.Capacitor === 'undefined') {
      return false;
    }
    
    const plugins = window.Capacitor.Plugins || {};
    if (!plugins.MLKitScanner) {
      return false;
    }
    
    if (!this.plugin) {
      console.log(
        '[MLKitScanner] Attaching native plugin. Available plugins:',
        Object.keys(plugins)
      );
    }
    
    this.plugin = plugins.MLKitScanner;
    this.isInitialized = true;
    return true;
  }
  
  async waitUntilReady(timeoutMs = 2000, pollMs = 75) {
    if (this.isSupported()) {
      return true;
    }
    
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      if (this.refreshPluginReference() && this.isSupported()) {
        console.log('[MLKitScanner] Plugin detected after delay');
        return true;
      }
    }
    return this.isSupported();
  }
  
  isSupported() {
    if (!this.plugin) {
      this.refreshPluginReference();
    }
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

} // Fin de prevención de doble inicialización
