/**
 * ZXing Native Scanner Wrapper
 * Continuous barcode scanning with Google ZXing (native Android)
 * Integrated in the app (not full-screen)
 * 
 * Replaces MLKit with lighter alternative
 * ZXing: ~500 KB vs MLKit: ~8-10 MB
 * 
 * Compatible with Capacitor 7+
 * 
 * @see ANALISIS_MLKIT_ZXING.md
 * @see ZXingScannerPlugin.java
 */

// Prevent double initialization (Turbo may load script multiple times)
if (typeof window.ZXingNativeScanner === 'undefined') {

// Plugin registration is handled by capacitor-remote-bridge.js
// which creates window.Capacitor.Plugins.ZXingScanner
// See: templates/parts/base.html

class ZXingNativeScanner {
  constructor() {
    this.plugin = null;
    this.onBarcodeDetected = null;
    this.isInitialized = false;
    this.eventListener = null;
    
    this.initialize();
  }
  
  initialize() {
    console.log('[ZXingScanner] 🚀 initialize() called');
    try {
      console.log('[ZXingScanner] Checking window.Capacitor...');
      console.log('[ZXingScanner] window.Capacitor type:', typeof window.Capacitor);
      
      if (typeof window.Capacitor === 'undefined') {
        console.error('[ZXingScanner] ❌ Capacitor not available');
        return;
      }
      
      console.log('[ZXingScanner] Capacitor available');
      console.log('[ZXingScanner] Platform:', window.Capacitor.getPlatform());
      console.log('[ZXingScanner] isNativePlatform:', window.Capacitor.isNativePlatform());
      console.log('[ZXingScanner] Available plugins:', Object.keys(window.Capacitor.Plugins || {}));
      
      console.log('[ZXingScanner] Calling refreshPluginReference()...');
      if (this.refreshPluginReference()) {
        console.log('[ZXingScanner] ✅ Plugin initialized successfully');
      } else {
        console.warn('[ZXingScanner] ⚠️ Plugin not ready yet, will retry lazily');
      }
    } catch (error) {
      console.error('[ZXingScanner] ❌ Initialization error:', error);
      console.log('[ZXingScanner] Error stack:', error.stack);
    }
  }

  refreshPluginReference() {
    console.log('[ZXingScanner] 🔍 refreshPluginReference() called');
    console.log('[ZXingScanner] window.Capacitor exists:', typeof window.Capacitor !== 'undefined');
    
    if (typeof window.Capacitor === 'undefined') {
      console.log('[ZXingScanner] Capacitor not available, returning false');
      return false;
    }
    
    const plugins = window.Capacitor.Plugins || {};
    console.log('[ZXingScanner] Available plugins:', Object.keys(plugins));
    console.log('[ZXingScanner] ZXingScanner in plugins:', 'ZXingScanner' in plugins);
    console.log('[ZXingScanner] plugins.ZXingScanner exists:', plugins.ZXingScanner !== undefined);
    
    if (!plugins.ZXingScanner) {
      console.log('[ZXingScanner] ❌ ZXingScanner plugin not found in Capacitor.Plugins');
      return false;
    }
    
    if (!this.plugin) {
      console.log('[ZXingScanner] ✅ Attaching native plugin for first time');
      console.log('[ZXingScanner] Plugin object:', plugins.ZXingScanner);
      console.log('[ZXingScanner] Plugin methods:', Object.keys(plugins.ZXingScanner));
    }
    
    this.plugin = plugins.ZXingScanner;
    this.isInitialized = true;
    console.log('[ZXingScanner] Plugin attached, isInitialized:', this.isInitialized);
    return true;
  }
  
  async waitUntilReady(timeoutMs = 2000, pollMs = 75) {
    console.log('[ZXingScanner] ⏳ waitUntilReady() called, timeout:', timeoutMs, 'ms');
    console.log('[ZXingScanner] Checking if already supported...');
    
    if (this.isSupported()) {
      console.log('[ZXingScanner] ✅ Already supported, returning true');
      return true;
    }
    
    console.log('[ZXingScanner] Not yet supported, starting polling...');
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    
    while (Date.now() < deadline) {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, pollMs));
      console.log('[ZXingScanner] Poll attempt', attempts, '- refreshing plugin reference...');
      
      if (this.refreshPluginReference() && this.isSupported()) {
        console.log('[ZXingScanner] ✅ Plugin detected after', attempts, 'attempts');
        return true;
      }
    }
    
    console.log('[ZXingScanner] ❌ Timeout after', attempts, 'attempts');
    const finalCheck = this.isSupported();
    console.log('[ZXingScanner] Final isSupported check:', finalCheck);
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
      throw new Error('ZXing plugin not available');
    }
    
    try {
      const result = await this.plugin.checkPermissions();
      console.log('[ZXingScanner] Permissions status:', result);
      return result;
    } catch (error) {
      console.error('[ZXingScanner] Check permissions error:', error);
      throw error;
    }
  }
  
  async requestPermissions() {
    if (!this.isSupported()) {
      throw new Error('ZXing plugin not available');
    }
    
    try {
      const result = await this.plugin.requestPermissions();
      console.log('[ZXingScanner] Permissions result:', result);
      return result;
    } catch (error) {
      console.error('[ZXingScanner] Request permissions error:', error);
      throw error;
    }
  }
  
  /**
   * Start continuous scanning
   * @param {Function} callback - Function that receives {value, format, cornerPoints}
   */
  async startScan(callback) {
    console.log('[ZXingScanner] 🎬 startScan() called');
    console.log('[ZXingScanner] Checking if supported...');
    console.log('[ZXingScanner] this.isSupported():', this.isSupported());
    console.log('[ZXingScanner] this.isInitialized:', this.isInitialized);
    console.log('[ZXingScanner] this.plugin:', this.plugin !== null);
    
    if (!this.isSupported()) {
      console.error('[ZXingScanner] ❌ Plugin not supported');
      throw new Error('ZXing plugin not available');
    }
    
    console.log('[ZXingScanner] Validating callback...');
    if (typeof callback !== 'function') {
      console.error('[ZXingScanner] ❌ Callback is not a function:', typeof callback);
      throw new Error('Callback must be a function');
    }
    
    console.log('[ZXingScanner] Checking permissions...');
    const permissions = await this.checkPermissions();
    console.log('[ZXingScanner] Permissions:', permissions);
    
    if (permissions.camera !== 'granted') {
      console.log('[ZXingScanner] Camera not granted, requesting...');
      const result = await this.requestPermissions();
      console.log('[ZXingScanner] Permission result:', result);
      
      if (result.camera !== 'granted') {
        console.error('[ZXingScanner] ❌ Camera permission denied');
        throw new Error('Camera permission denied');
      }
    }
    
    console.log('[ZXingScanner] Saving callback...');
    this.onBarcodeDetected = callback;
    
    console.log('[ZXingScanner] Setting up event listener...');
    if (!this.eventListener) {
      console.log('[ZXingScanner] Adding listener for barcodeScanned event...');
      this.eventListener = await this.plugin.addListener('barcodeScanned', (data) => {
        console.log('[ZXingScanner] 📷 Barcode scanned event:', data);
        if (this.onBarcodeDetected) {
          this.onBarcodeDetected(data);
        }
      });
      console.log('[ZXingScanner] ✅ Event listener registered');
    } else {
      console.log('[ZXingScanner] Event listener already exists');
    }
    
    try {
      console.log('[ZXingScanner] Calling plugin.startScan()...');
      const result = await this.plugin.startScan();
      console.log('[ZXingScanner] ✅ plugin.startScan() returned:', result);
      return result;
      
    } catch (error) {
      console.error('[ZXingScanner] ❌ Start scan error:', error);
      console.log('[ZXingScanner] Error name:', error.name);
      console.log('[ZXingScanner] Error message:', error.message);
      console.log('[ZXingScanner] Error stack:', error.stack);
      
      console.log('[ZXingScanner] Cleaning up listener...');
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
      // Stop scanner
      await this.plugin.stopScan();
      console.log('[ZXingScanner] Scan stopped');
      
      // Remove event listener
      if (this.eventListener) {
        this.eventListener.remove();
        this.eventListener = null;
        console.log('[ZXingScanner] Event listener removed');
      }
      
      this.onBarcodeDetected = null;
      
    } catch (error) {
      console.error('[ZXingScanner] Stop scan error:', error);
    }
  }
}

// Expose globally
window.ZXingNativeScanner = ZXingNativeScanner;

} // End double initialization prevention
