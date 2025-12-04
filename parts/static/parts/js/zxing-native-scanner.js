/**
 * ZXing Native Scanner Plugin Wrapper
 * Plugin custom que usa ZXing + CameraX para escaneo continuo
 * con overlay del WebView (la cámara se ve DETRÁS de tu UI)
 */

class ZxingNativeScanner {
  constructor() {
    this.isScanning = false;
    this.onBarcodeDetected = null;
    this.plugin = null;
    
    console.log('[ZXing] Constructor called');
    
    if (window.Capacitor?.Plugins?.ZxingScanner) {
      this.plugin = window.Capacitor.Plugins.ZxingScanner;
      console.log('[ZXing] Plugin found and ready');
      
      // Escuchar eventos de detección
      this.plugin.addListener('barcodeDetected', (result) => {
        console.log('[ZXing] Barcode detected:', result);
        if (this.onBarcodeDetected) {
          this.onBarcodeDetected(result);
        }
      });
    } else {
      console.warn('[ZXing] Plugin not found');
    }
  }
  
  isSupported() {
    return !!this.plugin;
  }
  
  async startScan(callback) {
    if (!this.plugin) {
      throw new Error('ZXing plugin not available');
    }
    
    if (this.isScanning) {
      console.warn('[ZXing] Already scanning');
      return;
    }
    
    this.onBarcodeDetected = callback;
    this.isScanning = true;
    
    console.log('[ZXing] Starting continuous scan...');
    
    try {
      await this.plugin.startScan();
      console.log('[ZXing] Scan started successfully');
    } catch (error) {
      this.isScanning = false;
      console.error('[ZXing] Failed to start scan:', error);
      throw error;
    }
  }
  
  async stopScan() {
    if (!this.plugin || !this.isScanning) {
      return;
    }
    
    console.log('[ZXing] Stopping scan...');
    
    try {
      await this.plugin.stopScan();
      this.isScanning = false;
      this.onBarcodeDetected = null;
      console.log('[ZXing] Scan stopped');
    } catch (error) {
      console.error('[ZXing] Error stopping scan:', error);
    }
  }
}

// Exportar instancia global
window.ZxingNativeScanner = ZxingNativeScanner;
