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
    console.log('[MLKitScanner] 🚀 initialize() called');
    try {
      console.log('[MLKitScanner] Checking window.Capacitor...');
      console.log('[MLKitScanner] window.Capacitor type:', typeof window.Capacitor);
      
      if (typeof window.Capacitor === 'undefined') {
        console.error('[MLKitScanner] ❌ Capacitor not available');
        return;
      }
      
      console.log('[MLKitScanner] Capacitor available');
      console.log('[MLKitScanner] Platform:', window.Capacitor.getPlatform());
      console.log('[MLKitScanner] isNativePlatform:', window.Capacitor.isNativePlatform());
      console.log('[MLKitScanner] Available plugins:', Object.keys(window.Capacitor.Plugins || {}));
      
      console.log('[MLKitScanner] Calling refreshPluginReference()...');
      if (this.refreshPluginReference()) {
        console.log('[MLKitScanner] ✅ Plugin initialized successfully');
      } else {
        console.warn('[MLKitScanner] ⚠️ Plugin not ready yet, will retry lazily');
      }
    } catch (error) {
      console.error('[MLKitScanner] ❌ Initialization error:', error);
      console.log('[MLKitScanner] Error stack:', error.stack);
    }
  }

  refreshPluginReference() {
    console.log('[MLKitScanner] 🔍 refreshPluginReference() called');
    console.log('[MLKitScanner] window.Capacitor exists:', typeof window.Capacitor !== 'undefined');
    
    if (typeof window.Capacitor === 'undefined') {
      console.log('[MLKitScanner] Capacitor not available, returning false');
      return false;
    }
    
    const plugins = window.Capacitor.Plugins || {};
    console.log('[MLKitScanner] Available plugins:', Object.keys(plugins));
    console.log('[MLKitScanner] MLKitScanner in plugins:', 'MLKitScanner' in plugins);
    console.log('[MLKitScanner] plugins.MLKitScanner exists:', plugins.MLKitScanner !== undefined);
    
    if (!plugins.MLKitScanner) {
      console.log('[MLKitScanner] ❌ MLKitScanner plugin not found in Capacitor.Plugins');
      return false;
    }
    
    if (!this.plugin) {
      console.log('[MLKitScanner] ✅ Attaching native plugin for first time');
      console.log('[MLKitScanner] Plugin object:', plugins.MLKitScanner);
      console.log('[MLKitScanner] Plugin methods:', Object.keys(plugins.MLKitScanner));
    }
    
    this.plugin = plugins.MLKitScanner;
    this.isInitialized = true;
    console.log('[MLKitScanner] Plugin attached, isInitialized:', this.isInitialized);
    return true;
  }
  
  async waitUntilReady(timeoutMs = 2000, pollMs = 75) {
    console.log('[MLKitScanner] ⏳ waitUntilReady() called, timeout:', timeoutMs, 'ms');
    console.log('[MLKitScanner] Checking if already supported...');
    
    if (this.isSupported()) {
      console.log('[MLKitScanner] ✅ Already supported, returning true');
      return true;
    }
    
    console.log('[MLKitScanner] Not yet supported, starting polling...');
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    
    while (Date.now() < deadline) {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, pollMs));
      console.log('[MLKitScanner] Poll attempt', attempts, '- refreshing plugin reference...');
      
      if (this.refreshPluginReference() && this.isSupported()) {
        console.log('[MLKitScanner] ✅ Plugin detected after', attempts, 'attempts');
        return true;
      }
    }
    
    console.log('[MLKitScanner] ❌ Timeout after', attempts, 'attempts');
    const finalCheck = this.isSupported();
    console.log('[MLKitScanner] Final isSupported check:', finalCheck);
    return finalCheck;
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
    console.log('[MLKitScanner] 🎬 startScan() called');
    console.log('[MLKitScanner] Checking if supported...');
    console.log('[MLKitScanner] this.isSupported():', this.isSupported());
    console.log('[MLKitScanner] this.isInitialized:', this.isInitialized);
    console.log('[MLKitScanner] this.plugin:', this.plugin !== null);
    
    if (!this.isSupported()) {
      console.error('[MLKitScanner] ❌ Plugin not supported');
      throw new Error('MLKit plugin not available');
    }
    
    console.log('[MLKitScanner] Validating callback...');
    if (typeof callback !== 'function') {
      console.error('[MLKitScanner] ❌ Callback is not a function:', typeof callback);
      throw new Error('Callback must be a function');
    }
    
    console.log('[MLKitScanner] Checking permissions...');
    const permissions = await this.checkPermissions();
    console.log('[MLKitScanner] Permissions:', permissions);
    
    if (permissions.camera !== 'granted') {
      console.log('[MLKitScanner] Camera not granted, requesting...');
      const result = await this.requestPermissions();
      console.log('[MLKitScanner] Permission result:', result);
      
      if (result.camera !== 'granted') {
        console.error('[MLKitScanner] ❌ Camera permission denied');
        throw new Error('Camera permission denied');
      }
    }
    
    console.log('[MLKitScanner] Saving callback...');
    this.onBarcodeDetected = callback;
    
    console.log('[MLKitScanner] Setting up event listener...');
    if (!this.eventListener) {
      console.log('[MLKitScanner] Adding listener for barcodeScanned event...');
      this.eventListener = await this.plugin.addListener('barcodeScanned', (data) => {
        console.log('[MLKitScanner] 📷 Barcode scanned event:', data);
        if (this.onBarcodeDetected) {
          this.onBarcodeDetected(data);
        }
      });
      console.log('[MLKitScanner] ✅ Event listener registered');
    } else {
      console.log('[MLKitScanner] Event listener already exists');
    }
    
    try {
      console.log('[MLKitScanner] Calling plugin.startScan()...');
      const result = await this.plugin.startScan();
      console.log('[MLKitScanner] ✅ plugin.startScan() returned:', result);
      return result;
      
    } catch (error) {
      console.error('[MLKitScanner] ❌ Start scan error:', error);
      console.log('[MLKitScanner] Error name:', error.name);
      console.log('[MLKitScanner] Error message:', error.message);
      console.log('[MLKitScanner] Error stack:', error.stack);
      
      console.log('[MLKitScanner] Cleaning up listener...');
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
