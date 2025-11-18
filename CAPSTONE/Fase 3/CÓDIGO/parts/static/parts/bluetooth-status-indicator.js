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
      
      // Agregar estilos
      this.addStyles();
      
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
     * Agregar estilos CSS
     */
    addStyles() {
      if (document.getElementById('bluetooth-status-styles')) {
        return;
      }
      
      const style = document.createElement('style');
      style.id = 'bluetooth-status-styles';
      style.textContent = `
        .bluetooth-status-badge {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-radius: 20px;
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          margin-left: 8px;
          transition: all 0.3s ease;
          cursor: default;
          font-size: 13px;
          border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .bluetooth-status-badge .status-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.2);
          transition: all 0.3s ease;
        }
        
        .bluetooth-status-badge .status-icon i {
          font-size: 14px;
          transition: all 0.3s ease;
        }
        
        .bluetooth-status-badge .status-text {
          display: flex;
          flex-direction: column;
          line-height: 1.2;
        }
        
        .bluetooth-status-badge .status-title {
          font-weight: 600;
          color: rgba(255, 255, 255, 0.9);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        
        .bluetooth-status-badge .status-message {
          color: rgba(255, 255, 255, 0.7);
          font-size: 12px;
        }
        
        /* Estado: Desconectado */
        .bluetooth-status-badge.status-disconnected .status-icon {
          background: rgba(108, 117, 125, 0.3);
        }
        
        .bluetooth-status-badge.status-disconnected .status-icon i {
          color: #6c757d;
        }
        
        /* Estado: Conectando */
        .bluetooth-status-badge.status-connecting .status-icon {
          background: rgba(255, 193, 7, 0.3);
          animation: pulse 1.5s ease-in-out infinite;
        }
        
        .bluetooth-status-badge.status-connecting .status-icon i {
          color: #ffc107;
        }
        
        /* Estado: Conectado */
        .bluetooth-status-badge.status-connected .status-icon {
          background: rgba(40, 167, 69, 0.3);
        }
        
        .bluetooth-status-badge.status-connected .status-icon i {
          color: #28a745;
        }
        
        /* Estado: Reconectando */
        .bluetooth-status-badge.status-reconnecting .status-icon {
          background: rgba(23, 162, 184, 0.3);
          animation: pulse 1s ease-in-out infinite;
        }
        
        .bluetooth-status-badge.status-reconnecting .status-icon i {
          color: #17a2b8;
          animation: spin 2s linear infinite;
        }
        
        /* Estado: Imprimiendo */
        .bluetooth-status-badge.status-printing .status-icon {
          background: rgba(0, 123, 255, 0.3);
          animation: pulse 0.8s ease-in-out infinite;
        }
        
        .bluetooth-status-badge.status-printing .status-icon i {
          color: #007bff;
        }
        
        /* Estado: Error */
        .bluetooth-status-badge.status-error .status-icon {
          background: rgba(220, 53, 69, 0.3);
          animation: shake 0.5s ease-in-out;
        }
        
        .bluetooth-status-badge.status-error .status-icon i {
          color: #dc3545;
        }
        
        /* Animaciones */
        @keyframes pulse {
          0%, 100% {
            transform: scale(1);
            opacity: 1;
          }
          50% {
            transform: scale(1.1);
            opacity: 0.8;
          }
        }
        
        @keyframes spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        
        @keyframes shake {
          0%, 100% {
            transform: translateX(0);
          }
          25% {
            transform: translateX(-5px);
          }
          75% {
            transform: translateX(5px);
          }
        }
        
        /* Responsive */
        @media (max-width: 768px) {
          .bluetooth-status-badge .status-text {
            display: none;
          }
          
          .bluetooth-status-badge {
            padding: 6px;
          }
        }
      `;
      
      document.head.appendChild(style);
    }
    
    /**
     * Actualizar estado visual
     */
    updateStatus(status) {
      if (!this.indicatorElement) {
        return;
      }
      
      // Limpiar clases de estado previas
      this.indicatorElement.className = 'bluetooth-status-badge';
      
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
