/**
 * ZXing Scanner Plugin Registration for Capacitor 7+
 * 
 * In Capacitor 7+, local plugins must be registered on both sides:
 * 1. Java: registerPlugin(ZXingScannerPlugin.class) in MainActivity
 * 2. JavaScript: registerPlugin() to create the bridge proxy
 * 
 * This file MUST be loaded BEFORE zxing-native-scanner.js
 */

(function() {
  'use strict';
  
  // Only run on native platform
  if (typeof window.Capacitor === 'undefined') {
    console.log('[ZXingPluginRegister] Not on Capacitor platform, skipping');
    return;
  }
  
  if (!window.Capacitor.isNativePlatform()) {
    console.log('[ZXingPluginRegister] Not on native platform, skipping');
    return;
  }
  
  console.log('[ZXingPluginRegister] Registering ZXingScanner plugin...');
  
  // Check if already registered
  if (window.Capacitor.Plugins && window.Capacitor.Plugins.ZXingScanner) {
    console.log('[ZXingPluginRegister] Plugin already registered');
    return;
  }
  
  try {
    // In Capacitor 7+, use registerPlugin from @capacitor/core
    // This creates a proxy that communicates with the native side
    const { registerPlugin } = window.Capacitor;
    
    if (typeof registerPlugin === 'function') {
      const ZXingScanner = registerPlugin('ZXingScanner', {
        web: () => Promise.reject(new Error('ZXingScanner not available on web')),
      });
      
      // Expose to global Plugins object
      if (!window.Capacitor.Plugins) {
        window.Capacitor.Plugins = {};
      }
      window.Capacitor.Plugins.ZXingScanner = ZXingScanner;
      
      console.log('[ZXingPluginRegister] ✅ ZXingScanner registered successfully');
      console.log('[ZXingPluginRegister] Available methods:', Object.keys(ZXingScanner));
    } else {
      // Fallback: Try direct access (older Capacitor style)
      console.log('[ZXingPluginRegister] registerPlugin not found, trying direct access');
      
      // The plugin should already be in Capacitor.Plugins if registered in Java
      if (window.Capacitor.Plugins && window.Capacitor.Plugins.ZXingScanner) {
        console.log('[ZXingPluginRegister] ✅ Plugin found in Capacitor.Plugins');
      } else {
        console.error('[ZXingPluginRegister] ❌ Plugin not found and cannot register');
      }
    }
  } catch (error) {
    console.error('[ZXingPluginRegister] ❌ Error registering plugin:', error);
  }
})();
