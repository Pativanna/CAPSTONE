package com.carinventory.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.graphics.Rect;
import android.util.Size;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraControl;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.MeteringPointFactory;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.tasks.Task;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "MLKitScanner",
    permissions = {
        @Permission(
            alias = "camera",
            strings = { Manifest.permission.CAMERA }
        ),
        @Permission(
            alias = "microphone",
            strings = { Manifest.permission.RECORD_AUDIO }
        )
    }
)
@SuppressWarnings({"unused", "RedundantSuppression"})
public class MLKitScannerPlugin extends Plugin {
    
    private PreviewView previewView;
    private ProcessCameraProvider cameraProvider;
    private Camera camera;
    private BarcodeScanner barcodeScanner;
    private ExecutorService cameraExecutor;
    private boolean isScanning = false;
    private boolean isProcessing = false;
    private PluginCall pendingStartCall;
    
    // Cooldown por código (2 segundos)
    private Map<String, Long> codeDetectionTimes = new HashMap<>();
    private static final long CODE_COOLDOWN_MS = 2000; // 2 segundos entre detecciones del MISMO código
    private static final long FRAME_COOLDOWN_MS = 50; // 50ms entre frames para optimizar CPU
    
    // Torch automático
    private boolean torchEnabled = false;
    private static final double LOW_LIGHT_THRESHOLD = 0.15; // Umbral de luminosidad para flash automático
    private long lastFrameTime = 0;
    
    @Override
    public void load() {
        super.load();
        setupBarcodeScanner();
        cameraExecutor = Executors.newSingleThreadExecutor();
    }
    
    private void setupBarcodeScanner() {
        // Configurar ML Kit para todos los formatos comunes
        BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
            .setBarcodeFormats(
                Barcode.FORMAT_CODE_128,  // Códigos térmicos
                Barcode.FORMAT_CODE_39,
                Barcode.FORMAT_CODE_93,
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E,
                Barcode.FORMAT_QR_CODE,
                Barcode.FORMAT_DATA_MATRIX,
                Barcode.FORMAT_ITF
            )
            .build();
        
        barcodeScanner = BarcodeScanning.getClient(options);
    }
    
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject result = new JSObject();
        
        if (hasRequiredPermissions()) {
            result.put("camera", "granted");
        } else {
            result.put("camera", "prompt");
        }
        
        call.resolve(result);
    }
    
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (hasRequiredPermissions()) {
            JSObject result = new JSObject();
            result.put("camera", "granted");
            call.resolve(result);
        } else {
            requestAllPermissions(call, "permissionsCallback");
        }
    }
    
    @PluginMethod
    public void startScan(PluginCall call) {
        if (isScanning) {
            call.reject("Already scanning");
            return;
        }
        
        if (!hasRequiredPermissions()) {
            call.reject("Camera permission not granted");
            return;
        }
        
        // Limpiar historial de detecciones al iniciar nueva sesión
        codeDetectionTimes.clear();
        pendingStartCall = call;
        startCamera();
    }
    
    @PluginMethod
    public void stopScan(PluginCall call) {
        stopCamera();
        call.resolve();
    }
    
    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        JSObject result = new JSObject();
        
        if (hasRequiredPermissions()) {
            result.put("camera", "granted");
        } else {
            result.put("camera", "denied");
        }
        
        call.resolve(result);
    }
    
    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = 
            ProcessCameraProvider.getInstance(getContext());
        
        cameraProviderFuture.addListener(() -> {
            try {
                cameraProvider = cameraProviderFuture.get();
                bindCameraUseCases();
            } catch (ExecutionException | InterruptedException e) {
                rejectPendingStart("Failed to start camera: " + e.getMessage());
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }
    
    @SuppressLint("ClickableViewAccessibility")
    private void bindCameraUseCases() {
        // Obtener WebView para overlay
        WebView webView = getBridge().getWebView();
        if (webView == null || webView.getParent() == null) {
            rejectPendingStart("WebView not available");
            return;
        }
        
        // Crear PreviewView para cámara
        previewView = new PreviewView(getContext());
        previewView.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        
        // Agregar PreviewView DETRÁS del WebView
        ViewGroup parent = (ViewGroup) webView.getParent();
        parent.addView(previewView, 0); // Índice 0 = detrás
        
        // Hacer WebView transparente
        webView.setBackgroundColor(0x00000000);
        webView.setLayerType(WebView.LAYER_TYPE_SOFTWARE, null);
        
        // Configurar cámara trasera
        CameraSelector cameraSelector = new CameraSelector.Builder()
            .requireLensFacing(CameraSelector.LENS_FACING_BACK)
            .build();
        
        // Preview de cámara
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        
        // Análisis de imagen para ML Kit (optimizado para escaneo rápido)
        ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
            .setTargetResolution(new Size(1280, 720)) // Resolución óptima para ML Kit
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build();
        
        imageAnalysis.setAnalyzer(cameraExecutor, this::analyzeImage);
        
        try {
            cameraProvider.unbindAll();
            LifecycleOwner lifecycleOwner = (LifecycleOwner) getActivity();
            camera = cameraProvider.bindToLifecycle(
                lifecycleOwner,
                cameraSelector,
                preview,
                imageAnalysis
            );
            
            // Configurar autofocus continuo
            enableContinuousAutofocus();
            
            // Tap-to-focus en PreviewView
            previewView.setOnTouchListener((v, event) -> {
                if (event.getAction() == MotionEvent.ACTION_DOWN && camera != null) {
                    focusOnPoint(event.getX(), event.getY());
                    return true;
                }
                return false;
            });
            
            isScanning = true;
            resolvePendingStart();
        } catch (Exception e) {
            rejectPendingStart("Failed to bind camera: " + e.getMessage());
        }
    }
    
    private void enableContinuousAutofocus() {
        if (camera == null) return;
        
        getBridge().executeOnMainThread(() -> {
            try {
                CameraControl cameraControl = camera.getCameraControl();
                MeteringPointFactory factory = previewView.getMeteringPointFactory();
                MeteringPoint centerPoint = factory.createPoint(
                    previewView.getWidth() / 2.0f,
                    previewView.getHeight() / 2.0f
                );
                
                FocusMeteringAction action = new FocusMeteringAction.Builder(centerPoint)
                    .setAutoCancelDuration(5, TimeUnit.SECONDS)
                    .build();
                
                cameraControl.startFocusAndMetering(action);
            } catch (Exception e) {
                // Silently fail if autofocus not supported
            }
        });
    }
    
    private void focusOnPoint(float x, float y) {
        if (camera == null || previewView == null) return;
        
        getBridge().executeOnMainThread(() -> {
            try {
                CameraControl cameraControl = camera.getCameraControl();
                MeteringPointFactory factory = previewView.getMeteringPointFactory();
                MeteringPoint point = factory.createPoint(x, y);
                
                FocusMeteringAction action = new FocusMeteringAction.Builder(point)
                    .setAutoCancelDuration(3, TimeUnit.SECONDS)
                    .build();
                
                cameraControl.startFocusAndMetering(action);
            } catch (Exception e) {
                // Silently fail
            }
        });
    }
    
    private void updateTorch(boolean enable) {
        if (camera == null || !camera.getCameraInfo().hasFlashUnit()) return;
        
        getBridge().executeOnMainThread(() -> {
            try {
                camera.getCameraControl().enableTorch(enable);
                torchEnabled = enable;
            } catch (Exception e) {
                // Silently fail
            }
        });
    }
    
    @SuppressLint("UnsafeOptInUsageError")
    private void analyzeImage(@NonNull ImageProxy imageProxy) {
        if (!isScanning || isProcessing) {
            imageProxy.close();
            return;
        }
        
        // Cooldown entre frames para optimizar CPU
        long currentTime = System.currentTimeMillis();
        if (currentTime - lastFrameTime < FRAME_COOLDOWN_MS) {
            imageProxy.close();
            return;
        }
        lastFrameTime = currentTime;
        
        isProcessing = true;
        
        // Calcular luminosidad para torch automático
        double luminance = calculateLuminance(imageProxy);
        boolean shouldEnableTorch = luminance < LOW_LIGHT_THRESHOLD;
        if (shouldEnableTorch != torchEnabled) {
            updateTorch(shouldEnableTorch);
        }
        
        @SuppressLint("UnsafeOptInUsageError")
        InputImage image = InputImage.fromMediaImage(
            imageProxy.getImage(),
            imageProxy.getImageInfo().getRotationDegrees()
        );
        
        Task<List<Barcode>> result = barcodeScanner.process(image);
        
        result.addOnSuccessListener(barcodes -> {
            if (!barcodes.isEmpty() && isScanning) {
                // Escanear solo el código más centrado
                Barcode mostCentered = findMostCenteredBarcode(barcodes, imageProxy.getWidth(), imageProxy.getHeight());
                if (mostCentered != null) {
                    handleBarcodeDetected(mostCentered, luminance);
                }
            }
            isProcessing = false;
            imageProxy.close();
        }).addOnFailureListener(e -> {
            isProcessing = false;
            imageProxy.close();
        });
    }
    
    private double calculateLuminance(ImageProxy imageProxy) {
        // Estimación simple de luminosidad basada en el brillo promedio de la imagen
        // En producción, esto debería ser más sofisticado
        try {
            @SuppressLint("UnsafeOptInUsageError")
            android.media.Image image = imageProxy.getImage();
            if (image == null) return 0.5;
            
            // Obtener plano Y (luminancia) de YUV
            android.media.Image.Plane yPlane = image.getPlanes()[0];
            java.nio.ByteBuffer yBuffer = yPlane.getBuffer();
            
            // Muestrear algunos pixels para estimar luminosidad
            int sampleSize = Math.min(1000, yBuffer.remaining());
            long sum = 0;
            for (int i = 0; i < sampleSize; i++) {
                sum += (yBuffer.get(i) & 0xFF);
            }
            
            return (sum / (double) sampleSize) / 255.0;
        } catch (Exception e) {
            return 0.5; // Valor medio por defecto
        }
    }
    
    private Barcode findMostCenteredBarcode(List<Barcode> barcodes, int imageWidth, int imageHeight) {
        if (barcodes.isEmpty()) return null;
        if (barcodes.size() == 1) return barcodes.get(0);
        
        int centerX = imageWidth / 2;
        int centerY = imageHeight / 2;
        
        Barcode mostCentered = null;
        double minDistance = Double.MAX_VALUE;
        
        for (Barcode barcode : barcodes) {
            Rect boundingBox = barcode.getBoundingBox();
            if (boundingBox == null) continue;
            
            int barcodeX = boundingBox.centerX();
            int barcodeY = boundingBox.centerY();
            
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
    
    private void handleBarcodeDetected(Barcode barcode, double luminance) {
        if (!isScanning) return;
        
        String code = barcode.getRawValue();
        if (code == null || code.isEmpty()) return;
        
        // Verificar cooldown de 2 segundos para el MISMO código
        long currentTime = System.currentTimeMillis();
        Long lastDetection = codeDetectionTimes.get(code);
        if (lastDetection != null && (currentTime - lastDetection) < CODE_COOLDOWN_MS) {
            // Ignorar detección, aún en cooldown
            return;
        }
        
        // Actualizar tiempo de detección para este código
        codeDetectionTimes.put(code, currentTime);
        
        // Limpiar códigos antiguos del mapa (mayores a 10 segundos)
        codeDetectionTimes.entrySet().removeIf(entry -> 
            (currentTime - entry.getValue()) > 10000
        );
        
        getBridge().executeOnMainThread(() -> {
            JSObject ret = new JSObject();
            ret.put("value", code);
            ret.put("format", getBarcodeFormatName(barcode.getFormat()));
            ret.put("luminance", luminance);
            ret.put("timestamp", currentTime);
            
            // Corner points para highlight visual
            if (barcode.getCornerPoints() != null) {
                JSArray cornerPoints = new JSArray();
                for (android.graphics.Point point : barcode.getCornerPoints()) {
                    JSObject pointObj = new JSObject();
                    pointObj.put("x", point.x);
                    pointObj.put("y", point.y);
                    cornerPoints.put(pointObj);
                }
                ret.put("cornerPoints", cornerPoints);
            }
            
            // Notificar a JavaScript para escaneo continuo
            notifyListeners("barcodeDetected", ret);
        });
    }
    
    private String getBarcodeFormatName(int format) {
        switch (format) {
            case Barcode.FORMAT_CODE_128: return "CODE_128";
            case Barcode.FORMAT_CODE_39: return "CODE_39";
            case Barcode.FORMAT_CODE_93: return "CODE_93";
            case Barcode.FORMAT_EAN_13: return "EAN_13";
            case Barcode.FORMAT_EAN_8: return "EAN_8";
            case Barcode.FORMAT_UPC_A: return "UPC_A";
            case Barcode.FORMAT_UPC_E: return "UPC_E";
            case Barcode.FORMAT_QR_CODE: return "QR_CODE";
            case Barcode.FORMAT_DATA_MATRIX: return "DATA_MATRIX";
            case Barcode.FORMAT_ITF: return "ITF";
            default: return "UNKNOWN";
        }
    }
    
    private void stopCamera() {
        isScanning = false;
        isProcessing = false;
        codeDetectionTimes.clear();
        rejectPendingStart("Scan cancelled");
        
        getBridge().executeOnMainThread(() -> {
            // Apagar torch si está encendido
            if (torchEnabled) {
                updateTorch(false);
            }
            
            if (cameraProvider != null) {
                cameraProvider.unbindAll();
            }
            
            if (previewView != null && previewView.getParent() != null) {
                ((ViewGroup) previewView.getParent()).removeView(previewView);
                previewView = null;
            }
            
            // Restaurar WebView
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setBackgroundColor(0xFFFFFFFF);
                webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null);
            }
        });
    }
    
    @Override
    protected void handleOnDestroy() {
        stopCamera();
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
        if (barcodeScanner != null) {
            barcodeScanner.close();
        }
        super.handleOnDestroy();
    }

    private void resolvePendingStart() {
        if (pendingStartCall != null) {
            JSObject ret = new JSObject();
            ret.put("status", "started");
            ret.put("torchSupported", camera != null && camera.getCameraInfo().hasFlashUnit());
            pendingStartCall.resolve(ret);
            pendingStartCall = null;
        }
    }

    private void rejectPendingStart(String message) {
        if (pendingStartCall != null) {
            pendingStartCall.reject(message);
            pendingStartCall = null;
        }
    }
}
