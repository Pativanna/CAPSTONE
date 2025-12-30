/**
 * Capacitor Bridge for Remote Content
 * 
 * When Capacitor loads content from a remote server.url, it doesn't inject
 * the plugin JavaScript. This script provides that functionality.
 * 
 * It must be loaded BEFORE any plugin code.
 */
(function() {
  'use strict';
  
  console.log('[CapacitorBridge] Initializing remote bridge...');
  
  // Check if we're in a native app context - múltiples métodos de detección
  const isNativeAndroid = typeof window.androidBridge !== 'undefined' 
    || (navigator.userAgent.includes('Android') && navigator.userAgent.includes('wv'))
    || (navigator.userAgent.includes('Android') && typeof window.Capacitor !== 'undefined');
  const isNativeIOS = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge;
  const isCapacitor = typeof window.Capacitor !== 'undefined';
  const isNative = isNativeAndroid || isNativeIOS || isCapacitor;
  
  // Detectar si es móvil Android (incluso sin ser nativo) para aplicar safe areas
  const isAndroidMobile = /Android/i.test(navigator.userAgent);
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  console.log('[CapacitorBridge] Detection:', {
    isNativeAndroid,
    isNativeIOS,
    isCapacitor,
    isNative,
    isAndroidMobile,
    isMobileDevice,
    userAgent: navigator.userAgent.substring(0, 100)
  });

  // ===== SAFE AREA DETECTION =====
  // Detecta y aplica safe areas para Android.
  // Prioridad: 1) Valores inyectados desde Android nativo, 2) env() CSS, 3) estimación
  
  // Flag para saber si ya recibimos safe areas desde Android nativo
  let nativeSafeAreasReceived = false;
  
  // Escuchar safe areas inyectados desde MainActivity.java
  window.addEventListener('nativeSafeAreasReady', function(e) {
    console.log('[CapacitorBridge] Received native safe areas from Android:', e.detail);
    nativeSafeAreasReceived = true;
    
    const areas = e.detail || window.__NATIVE_SAFE_AREAS__;
    if (areas && (areas.top > 0 || areas.bottom > 0)) {
      applySafeAreaCSS(areas.top, areas.bottom, false);
    }
  });
  
  // Verificar si ya hay safe areas inyectados (puede haberse ejecutado antes de este script)
  function checkExistingNativeSafeAreas() {
    if (window.__NATIVE_SAFE_AREAS__) {
      console.log('[CapacitorBridge] Found pre-existing native safe areas:', window.__NATIVE_SAFE_AREAS__);
      nativeSafeAreasReceived = true;
      const areas = window.__NATIVE_SAFE_AREAS__;
      if (areas.top > 0 || areas.bottom > 0) {
        applySafeAreaCSS(areas.top, areas.bottom, false);
        return true;
      }
    }
    return false;
  }
  
  function initSafeAreas() {
    console.log('[CapacitorBridge] Initializing safe areas...');
    
    // Primero verificar si ya tenemos safe areas desde Android nativo
    if (checkExistingNativeSafeAreas()) {
      console.log('[CapacitorBridge] Using native Android safe areas');
      return;
    }
    
    // Datos del dispositivo (para fallback)
    const density = window.devicePixelRatio || 1;
    const screenHeight = window.screen.height;
    const screenWidth = window.screen.width;
    const innerHeight = window.innerHeight;
    const aspectRatio = screenHeight / screenWidth;
    const systemBarsHeight = screenHeight - innerHeight;
    
    console.log('[CapacitorBridge] Device info:', {
      density,
      screenHeight,
      screenWidth,
      innerHeight,
      aspectRatio: aspectRatio.toFixed(2),
      systemBarsHeight
    });
    
    // Verificar si env() ya funciona
    const testEl = document.createElement('div');
    testEl.style.cssText = 'position:fixed;bottom:env(safe-area-inset-bottom,0px);visibility:hidden;';
    document.body.appendChild(testEl);
    const computedBottom = getComputedStyle(testEl).bottom;
    const envWorks = computedBottom !== '0px' && computedBottom !== 'auto';
    document.body.removeChild(testEl);
    
    if (envWorks) {
      console.log('[CapacitorBridge] CSS env() safe-area working natively');
      applySafeAreaCSS(0, 0, true);
      return;
    }
    
    const shouldApplySafeAreas = isNative || isAndroidMobile || isCapacitor;
    
    if (!shouldApplySafeAreas) {
      console.log('[CapacitorBridge] Not a mobile/native app, skipping safe areas');
      applySafeAreaCSS(0, 0, false);
      return;
    }
    
    // Esperar valores nativos de Android
    if ((isNativeAndroid || isAndroidMobile) && !nativeSafeAreasReceived) {
      console.log('[CapacitorBridge] Waiting for native safe areas...');
      setTimeout(() => {
        if (!nativeSafeAreasReceived) {
          console.log('[CapacitorBridge] Using fallback estimation');
          applyFallbackSafeAreas(aspectRatio, systemBarsHeight);
        }
      }, 300);
      return;
    }
    
    if (isNativeIOS && !envWorks) {
      applySafeAreaCSS(44, 34, false);
    }
  }
  
  function applyFallbackSafeAreas(aspectRatio, systemBarsHeight) {
    const isLikelyGestureNav = aspectRatio > 2.1;
    let statusBarDp = 32;
    let navBarDp = isLikelyGestureNav ? 24 : 48;
    
    if (systemBarsHeight > statusBarDp) {
      navBarDp = Math.min(56, systemBarsHeight - statusBarDp);
    }
    
    console.log('[CapacitorBridge] Fallback safe areas:', { statusBarDp, navBarDp });
    applySafeAreaCSS(statusBarDp, navBarDp, false);
  }
  
  function applySafeAreaCSS(topPx, bottomPx, useEnv) {
    const root = document.documentElement;
    
    if (useEnv) {
      // Usar env() con fallbacks
      root.style.setProperty('--safe-area-top', 'env(safe-area-inset-top, 32px)');
      root.style.setProperty('--safe-area-bottom', 'env(safe-area-inset-bottom, 24px)');
      root.style.setProperty('--safe-area-left', 'env(safe-area-inset-left, 0px)');
      root.style.setProperty('--safe-area-right', 'env(safe-area-inset-right, 0px)');
    } else {
      // Usar valores calculados
      root.style.setProperty('--safe-area-top', topPx + 'px');
      root.style.setProperty('--safe-area-bottom', bottomPx + 'px');
      root.style.setProperty('--safe-area-left', '0px');
      root.style.setProperty('--safe-area-right', '0px');
    }
    
    // Variables específicas para Android
    root.style.setProperty('--android-status-height', topPx + 'px');
    root.style.setProperty('--android-nav-height', bottomPx + 'px');
    
    // Aplicar directamente al bottom-nav si existe (igual que siempre)
    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav && bottomPx > 0) {
      const currentHeight = 64; // --bottom-nav-height
      bottomNav.style.height = (currentHeight + bottomPx) + 'px';
      bottomNav.style.paddingBottom = bottomPx + 'px';
      console.log('[CapacitorBridge] Applied safe area to bottom-nav:', bottomPx + 'px');
    }
    
    // Aplicar directamente al navbar superior con altura y padding
    const navbar = document.querySelector('.navbar.fixed-top');
    if (navbar && topPx > 0) {
      const navbarBaseHeight = 60;
      navbar.style.height = (navbarBaseHeight + topPx) + 'px';
      navbar.style.minHeight = (navbarBaseHeight + topPx) + 'px';
      navbar.style.maxHeight = (navbarBaseHeight + topPx) + 'px';
      navbar.style.paddingTop = topPx + 'px';
      navbar.style.alignItems = 'flex-end';
      console.log('[CapacitorBridge] Applied safe area to navbar:', topPx + 'px, total height:', (navbarBaseHeight + topPx) + 'px');
    }
    
    console.log('[CapacitorBridge] Safe area CSS applied:', { topPx, bottomPx, useEnv });
  }
  
  // Ejecutar detección de safe areas inmediatamente
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSafeAreas);
  } else {
    initSafeAreas();
  }

  // ===== ANDROID BACK BUTTON HANDLER =====
  // Este handler funciona tanto en nativo como en web (usando popstate)
  function initBackButtonHandler() {
    console.log('[CapacitorBridge] Initializing back button handler...');
    
    // Función para manejar el retroceso
    function handleBackAction() {
      console.log('[CapacitorBridge] Back action triggered');
      
      // 1. Cerrar panel móvil "Más" si está abierto
      if (typeof window.__isMobileMorePanelOpen === 'function' && window.__isMobileMorePanelOpen()) {
        console.log('[CapacitorBridge] Closing mobile more panel');
        if (typeof window.__closeMobileMorePanel === 'function') {
          window.__closeMobileMorePanel();
        }
        return true; // Handled
      }
      
      // 2. Cerrar cualquier modal de Bootstrap abierto
      var openModals = document.querySelectorAll('.modal.show');
      if (openModals.length > 0) {
        console.log('[CapacitorBridge] Closing open modal');
        var lastModal = openModals[openModals.length - 1];
        if (typeof bootstrap !== 'undefined' && bootstrap.Modal) {
          var bsModal = bootstrap.Modal.getInstance(lastModal);
          if (bsModal) {
            bsModal.hide();
            return true;
          }
        }
        // Fallback: click en el backdrop o close button
        var closeBtn = lastModal.querySelector('[data-bs-dismiss="modal"]');
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
      }
      
      // 3. Cerrar cualquier offcanvas abierto
      var openOffcanvas = document.querySelectorAll('.offcanvas.show');
      if (openOffcanvas.length > 0) {
        console.log('[CapacitorBridge] Closing open offcanvas');
        var lastOffcanvas = openOffcanvas[openOffcanvas.length - 1];
        if (typeof bootstrap !== 'undefined' && bootstrap.Offcanvas) {
          var bsOffcanvas = bootstrap.Offcanvas.getInstance(lastOffcanvas);
          if (bsOffcanvas) {
            bsOffcanvas.hide();
            return true;
          }
        }
      }
      
      // 4. Cerrar navbar colapsado
      var navbarCollapse = document.querySelector('.navbar-collapse.show');
      if (navbarCollapse) {
        console.log('[CapacitorBridge] Closing navbar collapse');
        if (typeof bootstrap !== 'undefined' && bootstrap.Collapse) {
          var bsCollapse = bootstrap.Collapse.getInstance(navbarCollapse);
          if (bsCollapse) {
            bsCollapse.hide();
            return true;
          }
        }
      }
      
      // 5. Si hay historial de navegación, retroceder
      if (window.history && window.history.length > 1) {
        console.log('[CapacitorBridge] Going back in history');
        window.history.back();
        return true;
      }
      
      // 6. Si no hay nada que cerrar ni historial, minimizar app (solo en Android nativo)
      console.log('[CapacitorBridge] No action to take, allowing default behavior');
      return false;
    }
    
    // Escuchar evento personalizado de back button (enviado desde Android)
    document.addEventListener('backbutton', function(e) {
      console.log('[CapacitorBridge] backbutton event received');
      if (handleBackAction()) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    
    // También escuchar el evento nativo de Capacitor si está disponible
    if (isNative) {
      // Registrar App plugin para escuchar backButton
      try {
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
          window.Capacitor.Plugins.App.addListener('backButton', function(data) {
            console.log('[CapacitorBridge] Capacitor backButton event:', data);
            if (!handleBackAction() && data && data.canGoBack === false) {
              // Si no hay nada que hacer y no se puede ir atrás, minimizar la app
              if (window.Capacitor.Plugins.App.minimizeApp) {
                window.Capacitor.Plugins.App.minimizeApp();
              }
            }
          });
          console.log('[CapacitorBridge] Capacitor App backButton listener registered');
        }
      } catch (err) {
        console.warn('[CapacitorBridge] Could not register Capacitor backButton listener:', err);
      }
    }
    
    // Exponer función globalmente para testing
    window.__handleBackAction = handleBackAction;
  }
  
  // Inicializar handler de back button (funciona en web y nativo)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBackButtonHandler);
  } else {
    initBackButtonHandler();
  }
  
  if (!isNative) {
    console.log('[CapacitorBridge] Not in native context, skipping native bridge setup');
    return;
  }
  
  // Initialize Capacitor global if not exists
  window.Capacitor = window.Capacitor || {};
  const cap = window.Capacitor;
  
  cap.Plugins = cap.Plugins || {};
  cap.PluginHeaders = cap.PluginHeaders || [];
  
  // Counter for callback IDs
  let callbackIdCounter = 0;
  const callbacks = {};
  
  // Platform detection
  cap.getPlatform = cap.getPlatform || function() {
    return isNativeAndroid ? 'android' : (isNativeIOS ? 'ios' : 'web');
  };
  
  cap.isNativePlatform = cap.isNativePlatform || function() {
    return isNative;
  };
  
  cap.isPluginAvailable = cap.isPluginAvailable || function(pluginName) {
    return cap.PluginHeaders.some(h => h.name === pluginName);
  };
  
  // Send message to native
  function postToNative(data) {
    const msg = JSON.stringify(data);
    console.log('[CapacitorBridge] Sending to native:', msg.substring(0, 200));
    
    if (isNativeAndroid) {
      window.androidBridge.postMessage(msg);
    } else if (isNativeIOS) {
      window.webkit.messageHandlers.bridge.postMessage(msg);
    }
  }
  
  // Receive message from native (for callbacks)
  window.Capacitor.fromNative = function(result) {
    console.log('[CapacitorBridge] Received from native:', JSON.stringify(result).substring(0, 200));
    
    const callbackId = result.callbackId;
    const callback = callbacks[callbackId];
    
    if (callback) {
      if (result.success) {
        callback.resolve(result.data);
      } else {
        callback.reject(new Error(result.error?.message || 'Native call failed'));
      }
      
      // Clean up unless it's a persistent listener
      if (!result.save) {
        delete callbacks[callbackId];
      }
    }
  };
  
  // Native promise call
  cap.nativePromise = function(pluginName, methodName, options) {
    return new Promise((resolve, reject) => {
      const callbackId = 'cap_' + (++callbackIdCounter);
      callbacks[callbackId] = { resolve, reject };
      
      postToNative({
        callbackId: callbackId,
        pluginId: pluginName,
        methodName: methodName,
        options: options || {}
      });
    });
  };
  
  // Native callback (for events/listeners)
  cap.nativeCallback = function(pluginName, methodName, options, callback) {
    const callbackId = 'cap_' + (++callbackIdCounter);
    callbacks[callbackId] = {
      resolve: callback,
      reject: (err) => console.error('[CapacitorBridge] Callback error:', err)
    };
    
    postToNative({
      callbackId: callbackId,
      pluginId: pluginName,
      methodName: methodName,
      options: options || {}
    });
    
    return callbackId;
  };
  
  // Add listener for events
  cap.addListener = function(pluginName, eventName, callback) {
    const callbackId = cap.nativeCallback(pluginName, 'addListener', {
      eventName: eventName
    }, callback);
    
    return {
      remove: function() {
        cap.nativePromise(pluginName, 'removeListener', {
          callbackId: callbackId,
          eventName: eventName
        });
        delete callbacks[callbackId];
      }
    };
  };
  
  // Plugin registration function
  cap.registerPlugin = function(pluginName, options) {
    console.log('[CapacitorBridge] Registering plugin:', pluginName);
    
    // Check if already registered
    if (cap.Plugins[pluginName]) {
      console.log('[CapacitorBridge] Plugin already registered:', pluginName);
      return cap.Plugins[pluginName];
    }
    
    // Create plugin proxy
    const plugin = new Proxy({}, {
      get: function(target, methodName) {
        // Handle Symbol.toPrimitive and valueOf to avoid "Cannot convert object to primitive value"
        if (methodName === Symbol.toPrimitive || methodName === 'valueOf') {
          return function() { return '[Plugin:' + pluginName + ']'; };
        }
        if (methodName === 'toString' || methodName === Symbol.toStringTag) {
          return function() { return '[Plugin:' + pluginName + ']'; };
        }
        // Handle then to avoid being treated as a Promise
        if (methodName === 'then') {
          return undefined;
        }
        if (methodName === 'addListener') {
          return function(eventName, callback) {
            return cap.addListener(pluginName, eventName, callback);
          };
        }
        if (methodName === 'removeListener' || methodName === 'removeAllListeners') {
          return function(handle) {
            if (handle && handle.remove) {
              handle.remove();
            }
          };
        }
        // Return function that calls native
        return function(options) {
          return cap.nativePromise(pluginName, methodName, options);
        };
      }
    });
    
    // Store plugin
    cap.Plugins[pluginName] = plugin;
    
    // Add to PluginHeaders if not present
    if (!cap.PluginHeaders.some(h => h.name === pluginName)) {
      cap.PluginHeaders.push({
        name: pluginName,
        methods: []
      });
    }
    
    console.log('[CapacitorBridge] Plugin registered successfully:', pluginName);
    return plugin;
  };
  
  console.log('[CapacitorBridge] Initialized. Plugins:', Object.keys(cap.Plugins));
  console.log('[CapacitorBridge] PluginHeaders:', JSON.stringify(cap.PluginHeaders));
  
  // ===== AUTO-REGISTER KNOWN PLUGINS =====
  // Registrar plugins conocidos para que estén disponibles
  console.log('[CapacitorBridge] Auto-registering known plugins...');
  cap.registerPlugin('MLKitScanner');
  cap.registerPlugin('MicrophonePlugin');
  cap.registerPlugin('App');
  
  // ===== MICROPHONE PERMISSION HELPER =====
  // Helper para solicitar permisos de micrófono antes de usar getUserMedia
  window.requestMicrophonePermission = async function() {
    console.log('[CapacitorBridge] requestMicrophonePermission called');
    
    // En Android nativo, usar el plugin
    if (isNativeAndroid && cap.Plugins.MicrophonePlugin) {
      try {
        const result = await cap.Plugins.MicrophonePlugin.requestPermission();
        console.log('[CapacitorBridge] MicrophonePlugin result:', result);
        return result.granted;
      } catch (err) {
        console.warn('[CapacitorBridge] MicrophonePlugin error:', err);
        // Fallback al método web
      }
    }
    
    // En web o si el plugin falla, intentar getUserMedia directamente
    // (esto mostrará el diálogo de permisos del navegador)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Detener el stream inmediatamente (solo queríamos el permiso)
      stream.getTracks().forEach(track => track.stop());
      return true;
    } catch (err) {
      console.warn('[CapacitorBridge] getUserMedia permission error:', err);
      return false;
    }
  };
  
  // Helper para verificar permiso sin solicitarlo
  window.checkMicrophonePermission = async function() {
    console.log('[CapacitorBridge] checkMicrophonePermission called');
    
    // En Android nativo, usar el plugin
    if (isNativeAndroid && cap.Plugins.MicrophonePlugin) {
      try {
        const result = await cap.Plugins.MicrophonePlugin.checkPermission();
        console.log('[CapacitorBridge] MicrophonePlugin check result:', result);
        return result.granted;
      } catch (err) {
        console.warn('[CapacitorBridge] MicrophonePlugin check error:', err);
      }
    }
    
    // En web, usar Permissions API si está disponible
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const result = await navigator.permissions.query({ name: 'microphone' });
        return result.state === 'granted';
      } catch (err) {
        console.warn('[CapacitorBridge] Permissions API error:', err);
      }
    }
    
    // No podemos verificar sin solicitar
    return null;
  };
  
  console.log('[CapacitorBridge] Microphone helpers registered');
  
})();
