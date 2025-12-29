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
  
  // Check if we're in a native app context
  const isNativeAndroid = typeof window.androidBridge !== 'undefined';
  const isNativeIOS = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge;
  const isNative = isNativeAndroid || isNativeIOS;
  
  console.log('[CapacitorBridge] isNativeAndroid:', isNativeAndroid);
  console.log('[CapacitorBridge] isNativeIOS:', isNativeIOS);

  // ===== SAFE AREA DETECTION =====
  // Detecta y aplica safe areas para Android cuando env() no funciona
  function initSafeAreas() {
    console.log('[CapacitorBridge] Initializing safe areas...');
    
    // Verificar si env() ya funciona (tiene valores > 0)
    const testEl = document.createElement('div');
    testEl.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);visibility:hidden;';
    document.body.appendChild(testEl);
    const envWorks = getComputedStyle(testEl).top !== '0px';
    document.body.removeChild(testEl);
    
    if (envWorks) {
      console.log('[CapacitorBridge] CSS env() safe-area working natively');
      return;
    }
    
    // Si estamos en Android nativo, calcular safe areas manualmente
    if (isNativeAndroid) {
      console.log('[CapacitorBridge] Calculating Android safe areas manually...');
      
      // Detectar si hay navigation bar en la parte inferior
      // En Android, la altura de la navigation bar suele ser ~48dp
      // Pero varía según el dispositivo y configuración
      
      // Usar visualViewport para detectar diferencias
      const viewport = window.visualViewport || {
        height: window.innerHeight,
        width: window.innerWidth
      };
      
      // La diferencia entre screen y viewport puede indicar la nav bar
      const screenHeight = window.screen.height;
      const viewportHeight = viewport.height;
      const screenWidth = window.screen.width;
      
      // Estimar altura de navigation bar (típicamente 48-56px en density 2-3)
      // Usar ratio de pantalla para estimar
      const density = window.devicePixelRatio || 1;
      const estimatedNavBar = Math.round(48 * density / density); // ~48px
      
      // Estimar status bar height (típicamente 24-28dp)
      const estimatedStatusBar = Math.round(24 * density / density); // ~24px
      
      // Para dispositivos con gesture navigation, la barra es más pequeña (~20px)
      // Detectar si es gesture navigation basado en el ratio de pantalla
      const aspectRatio = screenHeight / screenWidth;
      const isGestureNav = aspectRatio > 2.0; // Pantallas altas suelen tener gesture nav
      
      const navBarHeight = isGestureNav ? 20 : estimatedNavBar;
      const statusBarHeight = estimatedStatusBar;
      
      console.log('[CapacitorBridge] Estimated safe areas:', {
        navBarHeight,
        statusBarHeight,
        density,
        aspectRatio,
        isGestureNav
      });
      
      // Aplicar variables CSS
      document.documentElement.style.setProperty('--android-nav-height', navBarHeight + 'px');
      document.documentElement.style.setProperty('--android-status-height', statusBarHeight + 'px');
      
      // También sobrescribir safe-area si no funciona env()
      document.documentElement.style.setProperty('--safe-area-bottom', navBarHeight + 'px');
      document.documentElement.style.setProperty('--safe-area-top', statusBarHeight + 'px');
    }
    
    // Para iOS, env() debería funcionar, pero como fallback
    if (isNativeIOS && !envWorks) {
      console.log('[CapacitorBridge] iOS safe areas fallback');
      // iPhone X+ tienen notch de ~44px arriba y ~34px abajo
      document.documentElement.style.setProperty('--safe-area-top', '44px');
      document.documentElement.style.setProperty('--safe-area-bottom', '34px');
    }
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
  
})();
