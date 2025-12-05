package com.carinventory.app.scanner;

import android.graphics.Rect;
import android.util.Log;

import androidx.annotation.NonNull;

import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Procesador de códigos de barras con ML Kit
 * Implementa escaneo continuo con cooldown por código
 */
public class MLKitBarcodeProcessor implements BarcodeProcessor {
    private static final String TAG = "BarcodeProcessor";
    
    private final BarcodeScanner barcodeScanner;
    private final ScannerCallback scannerCallback;
    
    // Cooldown por código individual (2 segundos)
    private final Map<String, Long> codeDetectionTimes = new HashMap<>();
    private static final long CODE_COOLDOWN_MS = 2000;
    
    // Frame skipping para optimizar CPU
    private long lastFrameTime = 0;
    private static final long FRAME_INTERVAL_MS = 100; // Procesar 1 frame cada 100ms (10 FPS de análisis)
    
    // Estado de procesamiento
    private boolean isProcessing = false;
    
    // Variables sincronizadas para latest frame
    private ByteBuffer latestFrame;
    private FrameMetadata latestFrameMetadata;
    private ByteBuffer processingFrame;
    private FrameMetadata processingFrameMetadata;
    
    // Callback interface para escaneo continuo
    public interface ScannerCallback {
        void onBarcodeDetected(String code, String format, long timestamp);
    }
    
    public MLKitBarcodeProcessor(ScannerCallback callback) {
        this.scannerCallback = callback;
        
        // Configurar ML Kit para formatos comunes
        BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
            .setBarcodeFormats(
                Barcode.FORMAT_CODE_128,
                Barcode.FORMAT_CODE_39,
                Barcode.FORMAT_CODE_93,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_QR_CODE,
                Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E
            )
            .build();
        
        this.barcodeScanner = BarcodeScanning.getClient(options);
        Log.i(TAG, "MLKitBarcodeProcessor initialized with common formats");
    }
    
    @Override
    public synchronized void processByteBuffer(ByteBuffer data, FrameMetadata frameMetadata) {
        // Guardar el frame más reciente
        latestFrame = data;
        latestFrameMetadata = frameMetadata;
        
        // Solo procesar si no hay otro frame en proceso
        if (!isProcessing) {
            processLatestFrame();
        }
    }
    
    private synchronized void processLatestFrame() {
        // Transferir latest frame a processing
        processingFrame = latestFrame;
        processingFrameMetadata = latestFrameMetadata;
        latestFrame = null;
        latestFrameMetadata = null;
        
        if (processingFrame == null || processingFrameMetadata == null) {
            return;
        }
        
        // Frame skipping - solo procesar cada 100ms
        long currentTime = System.currentTimeMillis();
        if (currentTime - lastFrameTime < FRAME_INTERVAL_MS) {
            isProcessing = false;
            return;
        }
        lastFrameTime = currentTime;
        
        isProcessing = true;
        
        // Log cada 30 frames (aproximadamente cada 3 segundos a 10 FPS)
        if (Math.random() < 0.033) {
            Log.d(TAG, String.format("Processing frame: %dx%d, rotation=%d", 
                processingFrameMetadata.getWidth(),
                processingFrameMetadata.getHeight(),
                processingFrameMetadata.getRotation()));
        }
        
        // Crear InputImage
        InputImage image = InputImage.fromByteBuffer(
            processingFrame,
            processingFrameMetadata.getWidth(),
            processingFrameMetadata.getHeight(),
            processingFrameMetadata.getRotation(),
            InputImage.IMAGE_FORMAT_NV21
        );
        
        // Procesar con ML Kit
        barcodeScanner.process(image)
            .addOnSuccessListener(this::onSuccess)
            .addOnFailureListener(this::onFailure)
            .addOnCompleteListener(task -> {
                isProcessing = false;
                // Procesar siguiente frame si hay uno esperando
                if (latestFrame != null) {
                    processLatestFrame();
                }
            });
    }
    
    private void onSuccess(@NonNull List<Barcode> barcodes) {
        Log.d(TAG, "ML Kit processing complete - found " + barcodes.size() + " barcodes");
        
        if (barcodes.isEmpty()) {
            return;
        }
        
        long currentTime = System.currentTimeMillis();
        
        // Encontrar el código más centrado
        Barcode mostCentered = findMostCenteredBarcode(barcodes);
        
        if (mostCentered != null && mostCentered.getRawValue() != null) {
            String code = mostCentered.getRawValue();
            Log.i(TAG, "Detected barcode: " + code + " (format: " + getBarcodeFormatName(mostCentered.getFormat()) + ")");
            
            // Verificar cooldown para este código específico
            Long lastDetectionTime = codeDetectionTimes.get(code);
            if (lastDetectionTime != null && 
                (currentTime - lastDetectionTime) < CODE_COOLDOWN_MS) {
                Log.d(TAG, "Code still in cooldown: " + code);
                return;
            }
            
            // Actualizar tiempo de detección
            codeDetectionTimes.put(code, currentTime);
            
            // Limpiar códigos antiguos (más de 10 segundos)
            cleanupOldCodes(currentTime);
            
            // Enviar código a JavaScript
            Log.i(TAG, "Sending code to JavaScript: " + code);
            sendCodeToFlutter(code, mostCentered.getFormat());
        }
    }
    
    private void onFailure(@NonNull Exception e) {
        Log.e(TAG, "Barcode detection failed: " + e.getMessage());
    }
    
    private Barcode findMostCenteredBarcode(List<Barcode> barcodes) {
        if (barcodes.size() == 1) {
            return barcodes.get(0);
        }
        
        Barcode mostCentered = null;
        double minDistance = Double.MAX_VALUE;
        
        int frameWidth = processingFrameMetadata.getWidth();
        int frameHeight = processingFrameMetadata.getHeight();
        double centerX = frameWidth / 2.0;
        double centerY = frameHeight / 2.0;
        
        for (Barcode barcode : barcodes) {
            Rect boundingBox = barcode.getBoundingBox();
            if (boundingBox == null) continue;
            
            double barcodeX = boundingBox.centerX();
            double barcodeY = boundingBox.centerY();
            
            double distance = Math.sqrt(
                Math.pow(barcodeX - centerX, 2) + 
                Math.pow(barcodeY - centerY, 2)
            );
            
            if (distance < minDistance) {
                minDistance = distance;
                mostCentered = barcode;
            }
        }
        
        return mostCentered;
    }
    
    private void cleanupOldCodes(long currentTime) {
        codeDetectionTimes.entrySet().removeIf(
            entry -> (currentTime - entry.getValue()) > 10000
        );
    }
    
    private void sendCodeToFlutter(String code, int format) {
        if (scannerCallback != null) {
            scannerCallback.onBarcodeDetected(code, getBarcodeFormatName(format), System.currentTimeMillis());
        }
    }
    
    private String getBarcodeFormatName(int format) {
        switch (format) {
            case Barcode.FORMAT_CODE_128: return "CODE_128";
            case Barcode.FORMAT_CODE_39: return "CODE_39";
            case Barcode.FORMAT_CODE_93: return "CODE_93";
            case Barcode.FORMAT_EAN_8: return "EAN_8";
            case Barcode.FORMAT_EAN_13: return "EAN_13";
            case Barcode.FORMAT_QR_CODE: return "QR_CODE";
            case Barcode.FORMAT_UPC_A: return "UPC_A";
            case Barcode.FORMAT_UPC_E: return "UPC_E";
            default: return "UNKNOWN";
        }
    }
    
    @Override
    public void stop() {
        barcodeScanner.close();
        codeDetectionTimes.clear();
    }
}
