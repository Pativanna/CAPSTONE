/**
 * Indicador Visual de Estado de Bluetooth
 * Componente UI profesional para mostrar estado de conexión de impresora
 */

(function() {
  'use strict';
  
  class BluetoothStatusIndicator {
    constructor() {
      this.indicatorElement = null;
      this.animationTimeoutId = null;
      this.inlineMode = false;
      this.init();
    }
    
    /**
     * Inicializar indicador visual
     */
    init() {
      // Esperar a que el DOM esté listo con page:ready
      document.addEventListener('page:ready', () => this.createIndicator());
      if (document.readyState !== 'loading') {
        this.createIndicator();
      }
      
      // Registrar listener de cambios de estado
      if (window.printerManager) {
        window.printerManager.onStatusChange((status) => this.updateStatus(status));
      }
    }
    
    /**
     * Crear elemento indicador en el DOM
     */
    createIndicator() {
      const inlineIndicator = document.getElementById('bluetooth-status-container');
      if (inlineIndicator && inlineIndicator.dataset.inlineIndicator === 'true') {
        this.indicatorElement = inlineIndicator;
        this.inlineMode = true;
        return;
      }
      
      // Verificar si ya existe
      if (document.getElementById('bluetooth-status-indicator')) {
        return;
      }
      
      // Crear contenedor como li del navbar
      const indicator = document.createElement('li');
      indicator.id = 'bluetooth-status-indicator';
      indicator.className = 'nav-item';
      indicator.innerHTML = `
        <div class="bluetooth-status-badge">
          <div class="status-icon">
            <i class="fas fa-bluetooth-b"></i>
          </div>
          <div class="status-text">
            <span class="status-title">Impresora</span>
            <span class="status-message">Desconectada</span>
          </div>
        </div>
      `;
      
      
      // Buscar el botón de conexión para insertar después de él
      const connectBtn = document.getElementById('printer-connect-btn');
      if (connectBtn && connectBtn.parentElement) {
        // Insertar después del botón de conexión
        connectBtn.parentElement.insertAdjacentElement('afterend', indicator);
      } else {
        // Fallback: buscar el ul.navbar-nav y agregar al final
        const navbarNav = document.querySelector('.navbar-nav');
        if (navbarNav) {
          navbarNav.appendChild(indicator);
        }
      }
      
      this.indicatorElement = indicator.querySelector('.bluetooth-status-badge');
      
      // Verificar estado inicial con protección
      if (window.printerManager && typeof window.printerManager.isConnected === 'function') {
        try {
          if (window.printerManager.isConnected()) {
            const deviceName = window.printerManager.getDeviceName 
              ? window.printerManager.getDeviceName() 
              : 'Impresora';
            this.updateStatus({ 
              type: 'connected', 
              deviceName: deviceName,
              message: 'Conectado' 
            });
          }
        } catch (error) {
          console.warn('Error verificando estado inicial de impresora:', error);
        }
      }
    }
    

    /**
     * Actualizar estado visual
     */
    updateStatus(status) {
      if (!this.indicatorElement) {
        return;
      }
      
      // Limpiar clases de estado previas
      var baseClass = this.inlineMode ? 'bluetooth-status-badge bluetooth-status-badge--inline' : 'bluetooth-status-badge';
      this.indicatorElement.className = baseClass;
      
      // Obtener elementos
      const titleEl = this.indicatorElement.querySelector('.status-title');
      const messageEl = this.indicatorElement.querySelector('.status-message');
      
      // Actualizar según tipo de estado
      switch (status.type) {
        case 'connected':
          this.indicatorElement.classList.add('status-connected');
          titleEl.textContent = status.deviceName || 'Impresora';
          messageEl.textContent = 'Conectado';
          break;
          
        case 'connecting':
          this.indicatorElement.classList.add('status-connecting');
          titleEl.textContent = 'Impresora';
          messageEl.textContent = 'Conectando...';
          break;
          
        case 'reconnecting':
          this.indicatorElement.classList.add('status-reconnecting');
          titleEl.textContent = 'Impresora';
          messageEl.textContent = status.message || 'Reconectando...';
          break;
          
        case 'disconnected':
          this.indicatorElement.classList.add('status-disconnected');
          titleEl.textContent = 'Impresora';
          messageEl.textContent = 'Desconectada';
          break;
          
        case 'printing':
          this.indicatorElement.classList.add('status-printing');
          titleEl.textContent = 'Impresora';
          messageEl.textContent = 'Imprimiendo...';
          
          // Auto-revertir a conectado después de 3 segundos
          this.scheduleStatusRevert('connected', 3000);
          break;
          
        case 'printed':
          this.indicatorElement.classList.add('status-connected');
          titleEl.textContent = 'Impresora';
          messageEl.textContent = 'Impreso ✓';
          
          // Auto-revertir a conectado después de 2 segundos
          this.scheduleStatusRevert('connected', 2000);
          break;
          
        case 'error':
          this.indicatorElement.classList.add('status-error');
          titleEl.textContent = 'Impresora';
          messageEl.textContent = 'Error';
          
          // Mostrar tooltip con mensaje de error
          if (status.message) {
            this.indicatorElement.title = status.message;
          }
          
          // Auto-revertir a desconectado después de 5 segundos
          this.scheduleStatusRevert('disconnected', 5000);
          break;
      }
    }
    
    /**
     * Programar reversión de estado visual
     */
    scheduleStatusRevert(revertType, delay) {
      // Limpiar timeout previo
      if (this.animationTimeoutId) {
        clearTimeout(this.animationTimeoutId);
      }
      
      // Programar reversión
      this.animationTimeoutId = setTimeout(() => {
        if (window.printerManager) {
          const isConnected = window.printerManager.isConnected();
          const deviceName = window.printerManager.getDeviceName();
          
          if (isConnected) {
            this.updateStatus({ 
              type: 'connected', 
              deviceName: deviceName,
              message: 'Conectado' 
            });
          } else {
            this.updateStatus({ 
              type: 'disconnected', 
              message: 'Desconectada' 
            });
          }
        }
      }, delay);
    }
  }
  
  // Inicializar indicador cuando el documento esté listo con page:ready
  document.addEventListener('page:ready', () => {
    window.bluetoothStatusIndicator = new BluetoothStatusIndicator();
  });
  if (document.readyState !== 'loading') {
    window.bluetoothStatusIndicator = new BluetoothStatusIndicator();
  }
  
  console.log('Indicador de estado Bluetooth inicializado');
})();
