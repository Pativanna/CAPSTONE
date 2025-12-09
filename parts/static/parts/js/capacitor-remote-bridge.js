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
  
  if (!isNative) {
    console.log('[CapacitorBridge] Not in native context, skipping');
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
