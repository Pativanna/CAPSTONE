/**
 * Scanner ML Kit Continuo - Optimizado con CameraSource de Google
 * 
 * Features:
 * - Escaneo continuo sin salir (loop infinito)
 * - Layout: 80% cámara, 12% info última pieza, 8% safe area
 * - Cooldown de 2s por código individual
 * - Performance superior a CameraX
 */

const MLKitScanner = {
    // Estado del scanner
    isScanning: false,
    scannedCodes: new Map(), // Historial de códigos escaneados en sesión
    
    /**
     * Inicia el scanner continuo
     * @returns {Promise}
     */
    async start() {
        try {
            // Verificar permisos
            const perms = await window.MLKitScanner.checkPermissions();
            
            if (perms.camera !== 'granted') {
                const requested = await window.MLKitScanner.requestPermissions();
                if (requested.camera !== 'granted') {
                    throw new Error('Permiso de cámara denegado');
                }
            }
            
            // Agregar listener para códigos detectados
            await window.MLKitScanner.addListener('barcodeScanned', (data) => {
                this.handleBarcodeScanned(data);
            });
            
            // Iniciar scanner
            const result = await window.MLKitScanner.startScan();
            this.isScanning = true;
            
            console.log('✅ Scanner continuo iniciado:', result);
            return result;
            
        } catch (error) {
            console.error('❌ Error al iniciar scanner:', error);
            throw error;
        }
    },
    
    /**
     * Detiene el scanner
     * @returns {Promise}
     */
    async stop() {
        try {
            await window.MLKitScanner.stopScan();
            await window.MLKitScanner.removeAllListeners();
            this.isScanning = false;
            this.scannedCodes.clear();
            
            console.log('⏹️ Scanner detenido');
        } catch (error) {
            console.error('❌ Error al detener scanner:', error);
        }
    },
    
    /**
     * Handler para códigos escaneados (CONTINUO)
     * @param {Object} data - {value, format, timestamp}
     */
    handleBarcodeScanned(data) {
        const { value, format, timestamp } = data;
        
        console.log(`📱 Código detectado: ${value} (${format})`);
        
        // Guardar en historial
        this.scannedCodes.set(value, {
            format,
            timestamp,
            count: (this.scannedCodes.get(value)?.count || 0) + 1
        });
        
        // Disparar evento custom para que tu app lo maneje
        const event = new CustomEvent('mlkit:barcode', {
            detail: { value, format, timestamp }
        });
        document.dispatchEvent(event);
        
        // También puedes llamar directamente a tu función de verificación
        if (typeof window.handleDecodedValue === 'function') {
            window.handleDecodedValue(value);
        }
    },
    
    /**
     * Obtiene estadísticas de la sesión
     * @returns {Object}
     */
    getStats() {
        return {
            totalCodes: this.scannedCodes.size,
            scannedCodes: Array.from(this.scannedCodes.entries()).map(([code, data]) => ({
                code,
                ...data
            })),
            isScanning: this.isScanning
        };
    }
};

// Exportar globalmente
window.MLKitScanner = window.MLKitScanner || {};
window.MLKitScannerHelper = MLKitScanner;

console.log('✅ MLKitScanner Helper cargado');
