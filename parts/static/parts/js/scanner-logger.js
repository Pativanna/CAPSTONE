/**
 * Sistema de logging para scanner
 * Captura logs y los envía automáticamente al servidor
 */

(function() {
  'use strict';
  
  if (typeof window.ScannerLogger !== 'undefined') {
    return; // Ya inicializado
  }
  
  const LOG_BUFFER_SIZE = 50;
  const SEND_INTERVAL_MS = 3000; // Enviar cada 3 segundos
  
  class ScannerLogger {
    constructor() {
      this.logs = [];
      this.sessionId = this.generateSessionId();
      this.deviceInfo = this.getDeviceInfo();
      this.sendTimer = null;
      
      // Interceptar console.log, console.error, etc.
      this.interceptConsole();
      
      // Iniciar envío periódico
      this.startPeriodicSend();
      
      console.log('[ScannerLogger] Initialized - session:', this.sessionId);
    }
    
    generateSessionId() {
      return 'scan-' + Date.now() + '-' + Math.random().toString(36).substring(7);
    }
    
    getDeviceInfo() {
      const ua = navigator.userAgent;
      let device = 'unknown';
      
      if (/Android/i.test(ua)) {
        const match = ua.match(/Android\s+([\d.]+)/);
        device = 'Android ' + (match ? match[1] : 'unknown');
      } else if (/iPhone|iPad/i.test(ua)) {
        device = 'iOS';
      }
      
      return device;
    }
    
    interceptConsole() {
      const originalLog = console.log;
      const originalError = console.error;
      const originalWarn = console.warn;
      const originalInfo = console.info;
      
      const self = this;
      
      console.log = function(...args) {
        self.addLog('info', args.join(' '));
        originalLog.apply(console, args);
      };
      
      console.error = function(...args) {
        self.addLog('error', args.join(' '));
        originalError.apply(console, args);
      };
      
      console.warn = function(...args) {
        self.addLog('warning', args.join(' '));
        originalWarn.apply(console, args);
      };
      
      console.info = function(...args) {
        self.addLog('info', args.join(' '));
        originalInfo.apply(console, args);
      };
    }
    
    addLog(level, message) {
      // Filtrar solo logs relevantes del scanner
      if (!message.includes('[scanner]') && 
          !message.includes('[MLKit]') && 
          !message.includes('Barcode') &&
          !message.includes('Camera')) {
        return;
      }
      
      this.logs.push({
        timestamp: new Date().toISOString(),
        level: level,
        message: message
      });
      
      // Limitar tamaño del buffer
      if (this.logs.length > LOG_BUFFER_SIZE) {
        this.logs.shift();
      }
    }
    
    async sendLogs() {
      if (this.logs.length === 0) {
        return;
      }
      
      const logsToSend = [...this.logs];
      this.logs = []; // Limpiar buffer
      
      try {
        const response = await fetch('/api/scanner-logs/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            logs: logsToSend,
            device: this.deviceInfo,
            session: this.sessionId
          })
        });
        
        if (!response.ok) {
          console.warn('[ScannerLogger] Failed to send logs:', response.status);
        }
      } catch (error) {
        console.warn('[ScannerLogger] Error sending logs:', error);
        // Re-agregar logs al buffer si falló
        this.logs.unshift(...logsToSend);
      }
    }
    
    startPeriodicSend() {
      this.sendTimer = setInterval(() => {
        this.sendLogs();
      }, SEND_INTERVAL_MS);
    }
    
    stopPeriodicSend() {
      if (this.sendTimer) {
        clearInterval(this.sendTimer);
        this.sendTimer = null;
      }
      // Enviar logs restantes
      this.sendLogs();
    }
  }
  
  // Inicializar globalmente
  window.ScannerLogger = new ScannerLogger();
  
  // Enviar logs al cerrar/salir
  window.addEventListener('beforeunload', () => {
    window.ScannerLogger.stopPeriodicSend();
  });
  
})();
