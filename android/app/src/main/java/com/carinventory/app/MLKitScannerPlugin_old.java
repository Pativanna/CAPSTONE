package com.carinventory.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.util.Size;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
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

import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
    private long lastDetectionTime = 0;
    private static final long DETECTION_COOLDOWN_MS = 100; // 100ms entre detecciones para escaneo continuo
    
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
            isScanning = true;
            resolvePendingStart();
        } catch (Exception e) {
            rejectPendingStart("Failed to bind camera: " + e.getMessage());
        }
    }
    
    @SuppressLint("UnsafeOptInUsageError")
    private void analyzeImage(@NonNull ImageProxy imageProxy) {
        if (!isScanning || isProcessing) {
            imageProxy.close();
            return;
        }
        
        // Cooldown para evitar spam de detecciones
        long currentTime = System.currentTimeMillis();
        if (currentTime - lastDetectionTime < DETECTION_COOLDOWN_MS) {
            imageProxy.close();
            return;
        }
        
        isProcessing = true;
        
        @SuppressLint("UnsafeOptInUsageError")
        InputImage image = InputImage.fromMediaImage(
            imageProxy.getImage(),
            imageProxy.getImageInfo().getRotationDegrees()
        );
        
        Task<List<Barcode>> result = barcodeScanner.process(image);
        
        result.addOnSuccessListener(barcodes -> {
            if (!barcodes.isEmpty() && isScanning) {
                for (Barcode barcode : barcodes) {
                    handleBarcodeDetected(barcode);
                    lastDetectionTime = System.currentTimeMillis();
                    break; // Procesar solo el primero para escaneo continuo
                }
            }
            isProcessing = false;
            imageProxy.close();
        }).addOnFailureListener(e -> {
            isProcessing = false;
            imageProxy.close();
        });
    }
    
    private void handleBarcodeDetected(Barcode barcode) {
        if (!isScanning) {
            return;
        }
        
        getBridge().executeOnMainThread(() -> {
            JSObject ret = new JSObject();
            ret.put("value", barcode.getRawValue());
            ret.put("format", getBarcodeFormatName(barcode.getFormat()));
            
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
        rejectPendingStart("Scan cancelled");
        
        getBridge().executeOnMainThread(() -> {
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
