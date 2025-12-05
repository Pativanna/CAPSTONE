package com.carinventory.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.graphics.Color;
import android.graphics.Rect;
import android.util.Log;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

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

/**
 * Scanner ML Kit con CameraX moderno
 * Layout: 80% cámara, 12% info, 8% safe area
 * Características: autofocus continuo, tap-to-focus, flash automático
 */
@CapacitorPlugin(
    name = "MLKitScanner",
    permissions = {
        @Permission(
            alias = "camera",
            strings = { Manifest.permission.CAMERA }
        )
    }
)
@SuppressWarnings({"unused", "RedundantSuppression"})
public class MLKitScannerPlugin extends Plugin {
    
    private static final String TAG = "MLKitScanner";
    
    private LinearLayout scannerContainer;
    private PreviewView cameraPreview;
    private TextView infoTextView;
    private ProcessCameraProvider cameraProvider;
    private Camera camera;
    private BarcodeScanner barcodeScanner;
    private ExecutorService cameraExecutor;
    
    private boolean isScanning = false;
    private boolean isProcessing = false;
    private String lastScannedCode = "";
    
    // Cooldown management
    private final Map<String, Long> codeDetectionTimes = new HashMap<>();
    private static final long CODE_COOLDOWN_MS = 2000;
    private static final long FRAME_COOLDOWN_MS = 50;
    private long lastFrameTime = 0;
    
    // Auto torch
    private boolean torchEnabled = false;
    private static final double LOW_LIGHT_THRESHOLD = 0.15;
    
    @Override
    public void load() {
        try {
            super.load();
            Log.i(TAG, "MLKitScanner plugin loading...");
            setupBarcodeScanner();
            cameraExecutor = Executors.newSingleThreadExecutor();
            Log.i(TAG, "✅ Plugin loaded successfully with CameraX");
        } catch (Exception e) {
            Log.e(TAG, "❌ FATAL: Plugin load failed", e);
        }
    }
    
    private void setupBarcodeScanner() {
        try {
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
            
            barcodeScanner = BarcodeScanning.getClient(options);
            Log.i(TAG, "BarcodeScanner initialized with common formats");
        } catch (Exception e) {
            Log.e(TAG, "Failed to setup barcode scanner", e);
            throw e;
        }
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
        
        if (getActivity() == null) {
            call.reject("Activity not available");
            return;
        }
        
        codeDetectionTimes.clear();
        
        // startCamera uses MainExecutor, no need for extra runOnUiThread
        startCamera(call);
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
    
    private void startCamera(@NonNull PluginCall call) {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = 
            ProcessCameraProvider.getInstance(getContext());
        
        cameraProviderFuture.addListener(() -> {
            try {
                cameraProvider = cameraProviderFuture.get();
                
                // CRITICAL: createScannerUI MUST run on main thread
                if (getActivity() != null) {
                    getActivity().runOnUiThread(() -> createScannerUI(call));
                } else {
                    call.reject("Activity not available");
                }
            } catch (ExecutionException | InterruptedException e) {
                Log.e(TAG, "Failed to start camera", e);
                call.reject("Failed to start camera: " + e.getMessage());
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }
    
    @SuppressLint("ClickableViewAccessibility")
    private void createScannerUI(@NonNull PluginCall call) {
        WebView webView = getBridge().getWebView();
        if (webView == null) {
            Log.e(TAG, "WebView is null");
            call.reject("WebView not available");
            return;
        }
        
        if (webView.getParent() == null) {
            Log.e(TAG, "WebView parent is null");
            call.reject("WebView parent not available");
            return;
        }
        
        if (!(webView.getParent() instanceof ViewGroup)) {
            Log.e(TAG, "WebView parent is not a ViewGroup");
            call.reject("Invalid WebView parent");
            return;
        }
        
        ViewGroup parent = (ViewGroup) webView.getParent();
        
        // Ocultar WebView completamente (no transparente, INVISIBLE)
        webView.setVisibility(View.GONE);
        
        // Crear contenedor principal con layout vertical
        scannerContainer = new LinearLayout(getContext());
        scannerContainer.setOrientation(LinearLayout.VERTICAL);
        scannerContainer.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        scannerContainer.setBackgroundColor(Color.BLACK);
        
        // Agregar contenedor ENCIMA (no detrás)
        parent.addView(scannerContainer);
        
        // Crear vista de cámara (80% de altura)
        cameraPreview = new PreviewView(getContext());
        cameraPreview.setImplementationMode(PreviewView.ImplementationMode.PERFORMANCE);
        LinearLayout.LayoutParams cameraParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            0.80f // 80% weight
        );
        cameraPreview.setLayoutParams(cameraParams);
        scannerContainer.addView(cameraPreview);
        
        // Tap-to-focus
        cameraPreview.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN && camera != null) {
                focusOnPoint(event.getX(), event.getY());
                return true;
            }
            return false;
        });
        
        // Crear área de info (12% de altura)
        infoTextView = new TextView(getContext());
        infoTextView.setTextColor(Color.WHITE);
        infoTextView.setBackgroundColor(Color.parseColor("#1E1E1E"));
        infoTextView.setGravity(Gravity.CENTER);
        infoTextView.setPadding(dpToPx(16), dpToPx(12), dpToPx(16), dpToPx(12));
        infoTextView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        infoTextView.setText("🔍 Escanea códigos de barras\nAcerca el código a la cámara");
        
        LinearLayout.LayoutParams infoParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            0.12f // 12% weight
        );
        infoTextView.setLayoutParams(infoParams);
        scannerContainer.addView(infoTextView);
        
        // Crear área de safe zone (8% de altura) - invisible
        View safeZone = new View(getContext());
        safeZone.setBackgroundColor(Color.BLACK);
        LinearLayout.LayoutParams safeParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            0.08f // 8% weight
        );
        safeZone.setLayoutParams(safeParams);
        scannerContainer.addView(safeZone);
        
        // Bind camera
        bindCameraUseCases(call);
    }
    
    private void bindCameraUseCases(@NonNull PluginCall call) {
        if (cameraProvider == null) {
            call.reject("Camera provider not initialized");
            return;
        }
        
        if (!(getActivity() instanceof LifecycleOwner)) {
            call.reject("Activity does not implement LifecycleOwner");
            return;
        }
        
        CameraSelector cameraSelector = new CameraSelector.Builder()
            .requireLensFacing(CameraSelector.LENS_FACING_BACK)
            .build();
        
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(cameraPreview.getSurfaceProvider());
        
        // Image analysis optimizado para ML Kit
        ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
            .setTargetResolution(new Size(1280, 720))
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
            
            enableContinuousAutofocus();
            isScanning = true;
            
            JSObject ret = new JSObject();
            ret.put("status", "started");
            ret.put("mode", "continuous");
            call.resolve(ret);
            
            Log.i(TAG, "Camera bound successfully with CameraX");
        } catch (Exception e) {
            Log.e(TAG, "Failed to bind camera", e);
            call.reject("Failed to bind camera: " + e.getMessage());
        }
    }
    
    private void enableContinuousAutofocus() {
        if (camera == null || cameraPreview == null || getActivity() == null) return;
        
        // Already on main thread from bindCameraUseCases
        try {
            CameraControl cameraControl = camera.getCameraControl();
            MeteringPointFactory factory = cameraPreview.getMeteringPointFactory();
            
            // Use 0.5, 0.5 normalized coordinates (center) instead of pixel coordinates
            MeteringPoint centerPoint = factory.createPoint(0.5f, 0.5f);
            
            FocusMeteringAction action = new FocusMeteringAction.Builder(centerPoint)
                .setAutoCancelDuration(5, TimeUnit.SECONDS)
                .build();
            
            cameraControl.startFocusAndMetering(action);
            Log.d(TAG, "Continuous autofocus enabled");
        } catch (Exception e) {
            Log.w(TAG, "Autofocus not supported", e);
        }
    }
    
    private void focusOnPoint(float x, float y) {
        if (camera == null || cameraPreview == null || getActivity() == null) return;
        
        getActivity().runOnUiThread(() -> {
            try {
                CameraControl cameraControl = camera.getCameraControl();
                MeteringPointFactory factory = cameraPreview.getMeteringPointFactory();
                
                // factory.createPoint expects pixel coordinates from the view
                MeteringPoint point = factory.createPoint(x, y);
                
                FocusMeteringAction action = new FocusMeteringAction.Builder(point)
                    .setAutoCancelDuration(3, TimeUnit.SECONDS)
                    .build();
                
                cameraControl.startFocusAndMetering(action);
                Log.d(TAG, "Tap-to-focus at (" + x + ", " + y + ")");
            } catch (Exception e) {
                Log.w(TAG, "Tap-to-focus failed", e);
            }
        });
    }
    
    @SuppressLint("UnsafeOptInUsageError")
    private void analyzeImage(@NonNull ImageProxy imageProxy) {
        if (!isScanning || isProcessing) {
            imageProxy.close();
            return;
        }
        
        // Frame cooldown
        long currentTime = System.currentTimeMillis();
        if (currentTime - lastFrameTime < FRAME_COOLDOWN_MS) {
            imageProxy.close();
            return;
        }
        lastFrameTime = currentTime;
        
        isProcessing = true;
        
        // Calcular luminosidad para flash automático
        double luminance = calculateLuminance(imageProxy);
        boolean shouldEnableTorch = luminance < LOW_LIGHT_THRESHOLD;
        if (shouldEnableTorch != torchEnabled) {
            updateTorch(shouldEnableTorch);
        }
        
        // Validate image is available
        @SuppressLint("UnsafeOptInUsageError")
        android.media.Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) {
            Log.w(TAG, "ImageProxy.getImage() returned null");
            isProcessing = false;
            imageProxy.close();
            return;
        }
        
        @SuppressLint("UnsafeOptInUsageError")
        InputImage image = InputImage.fromMediaImage(
            mediaImage,
            imageProxy.getImageInfo().getRotationDegrees()
        );
        
        Task<List<Barcode>> result = barcodeScanner.process(image);
        
        result.addOnSuccessListener(barcodes -> {
            if (!barcodes.isEmpty() && isScanning) {
                Log.d(TAG, "ML Kit processing complete - found " + barcodes.size() + " barcodes");
                Barcode mostCentered = findMostCenteredBarcode(barcodes, imageProxy.getWidth(), imageProxy.getHeight());
                if (mostCentered != null) {
                    handleBarcodeDetected(mostCentered);
                }
            }
            isProcessing = false;
            imageProxy.close();
        }).addOnFailureListener(e -> {
            Log.e(TAG, "Barcode detection failed", e);
            isProcessing = false;
            imageProxy.close();
        });
    }
    
    private double calculateLuminance(ImageProxy imageProxy) {
        try {
            @SuppressLint("UnsafeOptInUsageError")
            android.media.Image image = imageProxy.getImage();
            if (image == null) return 0.5;
            
            android.media.Image.Plane[] planes = image.getPlanes();
            if (planes == null || planes.length == 0) {
                Log.w(TAG, "No image planes available");
                return 0.5;
            }
            
            android.media.Image.Plane yPlane = planes[0];
            if (yPlane == null) {
                Log.w(TAG, "Y plane is null");
                return 0.5;
            }
            
            java.nio.ByteBuffer yBuffer = yPlane.getBuffer();
            if (yBuffer == null || yBuffer.remaining() == 0) {
                Log.w(TAG, "Y buffer is null or empty");
                return 0.5;
            }
            
            // CRITICAL: Save position and restore it to avoid buffer exhaustion
            int originalPosition = yBuffer.position();
            yBuffer.rewind();
            
            int sampleSize = Math.min(1000, yBuffer.remaining());
            long sum = 0;
            
            // Sample evenly across the buffer
            int step = Math.max(1, yBuffer.remaining() / sampleSize);
            for (int i = 0; i < sampleSize; i++) {
                int position = i * step;
                if (position < yBuffer.remaining()) {
                    sum += (yBuffer.get(position) & 0xFF);
                }
            }
            
            // Restore original position
            yBuffer.position(originalPosition);
            
            return (sum / (double) sampleSize) / 255.0;
        } catch (Exception e) {
            Log.w(TAG, "Failed to calculate luminance", e);
            return 0.5;
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
    
    private void handleBarcodeDetected(Barcode barcode) {
        if (!isScanning || getActivity() == null) return;
        
        String code = barcode.getRawValue();
        if (code == null || code.isEmpty()) return;
        
        long currentTime = System.currentTimeMillis();
        Long lastDetection = codeDetectionTimes.get(code);
        if (lastDetection != null && (currentTime - lastDetection) < CODE_COOLDOWN_MS) {
            Log.d(TAG, "Code still in cooldown: " + code);
            return;
        }
        
        codeDetectionTimes.put(code, currentTime);
        codeDetectionTimes.entrySet().removeIf(entry -> 
            (currentTime - entry.getValue()) > 10000
        );
        
        lastScannedCode = code;
        
        getActivity().runOnUiThread(() -> {
            String displayText = String.format(
                "✅ Código: %s\nFormato: %s\nEscanea otro código...",
                code,
                getBarcodeFormatName(barcode.getFormat())
            );
            if (infoTextView != null) {
                infoTextView.setText(displayText);
            }
        });
        
        JSObject eventData = new JSObject();
        eventData.put("value", code);
        eventData.put("format", getBarcodeFormatName(barcode.getFormat()));
        eventData.put("timestamp", currentTime);
        notifyListeners("barcodeScanned", eventData);
        
        Log.i(TAG, "Detected barcode: " + code + " (format: " + getBarcodeFormatName(barcode.getFormat()) + ")");
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
            default: return "UNKNOWN";
        }
    }
    
    private void updateTorch(boolean enable) {
        if (camera == null || !camera.getCameraInfo().hasFlashUnit() || getActivity() == null) return;
        
        getActivity().runOnUiThread(() -> {
            try {
                camera.getCameraControl().enableTorch(enable);
                torchEnabled = enable;
                Log.d(TAG, "Torch " + (enable ? "enabled" : "disabled") + " (low light detection)");
            } catch (Exception e) {
                Log.w(TAG, "Failed to toggle torch", e);
            }
        });
    }
    
    private int dpToPx(int dp) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            dp,
            getContext().getResources().getDisplayMetrics()
        );
    }
    
    private void stopCamera() {
        isScanning = false;
        isProcessing = false;
        lastScannedCode = "";
        codeDetectionTimes.clear();
        
        if (getActivity() == null) return;
        
        getActivity().runOnUiThread(() -> {
            // Apagar torch directamente (ya estamos en main thread)
            if (torchEnabled && camera != null && camera.getCameraInfo().hasFlashUnit()) {
                try {
                    camera.getCameraControl().enableTorch(false);
                    torchEnabled = false;
                } catch (Exception e) {
                    Log.w(TAG, "Failed to disable torch on stop", e);
                }
            }
            
            if (cameraProvider != null) {
                cameraProvider.unbindAll();
            }
            
            if (scannerContainer != null && scannerContainer.getParent() != null) {
                ((ViewGroup) scannerContainer.getParent()).removeView(scannerContainer);
                scannerContainer = null;
            }
            
            cameraPreview = null;
            infoTextView = null;
            camera = null;
            
            // Restaurar WebView
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setVisibility(View.VISIBLE);
            }
            
            Log.i(TAG, "Camera stopped");
        });
    }
    
    @Override
    protected void handleOnDestroy() {
        // Stop scanning immediately to prevent new frames
        isScanning = false;
        isProcessing = false;
        
        // Shutdown executor gracefully
        if (cameraExecutor != null && !cameraExecutor.isShutdown()) {
            cameraExecutor.shutdown();
            try {
                // Wait for ongoing tasks to complete
                if (!cameraExecutor.awaitTermination(2, TimeUnit.SECONDS)) {
                    Log.w(TAG, "Executor did not terminate in time, forcing shutdown");
                    cameraExecutor.shutdownNow();
                }
            } catch (InterruptedException e) {
                Log.w(TAG, "Interrupted while waiting for executor shutdown", e);
                cameraExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
        
        // Close barcode scanner
        if (barcodeScanner != null) {
            try {
                barcodeScanner.close();
            } catch (Exception e) {
                Log.w(TAG, "Error closing barcode scanner", e);
            }
        }
        
        // Stop camera on main thread if activity is still available
        if (getActivity() != null) {
            stopCamera();
        } else {
            Log.w(TAG, "Activity null during destroy, skipping camera cleanup UI");
        }
        
        super.handleOnDestroy();
    }
}
