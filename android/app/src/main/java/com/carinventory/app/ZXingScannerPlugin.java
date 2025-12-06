package com.carinventory.app;

import android.Manifest;
import android.graphics.Color;
import android.media.Image;
import android.util.Log;
import android.util.Size;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.carinventory.app.scanner.ZXingBarcodeProcessor;
import com.carinventory.app.scanner.BarcodeProcessor;
import com.carinventory.app.scanner.FrameMetadata;

import com.google.common.util.concurrent.ListenableFuture;

import java.nio.ByteBuffer;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * ZXing Scanner Plugin for Capacitor
 * Barcode scanning using Google ZXing library
 * 
 * Replacement for MLKit scanner with smaller APK footprint
 * ZXing core: ~300-500 KB vs MLKit: ~8-10 MB
 * 
 * @see ANALISIS_MLKIT_ZXING.md
 * @see Documentacion/Procedimientos/PROC_20251205_1800_implementacion_zxing.md
 */
@CapacitorPlugin(
    name = "ZXingScanner",
    permissions = {
        @Permission(
            strings = { Manifest.permission.CAMERA },
            alias = "camera"
        )
    }
)
public class ZXingScannerPlugin extends Plugin {
    
    private static final String TAG = "ZXingScanner";
    private static final String EVENT_BARCODE_SCANNED = "barcodeScanned";
    
    private FrameLayout scannerContainer;
    private PreviewView previewView;
    private LinearLayout infoPanel;
    private TextView barcodeValueText;
    private TextView barcodeFormatText;
    private TextView scanCountText;
    private ProcessCameraProvider cameraProvider;
    private ImageAnalysis imageAnalysis;
    private BarcodeProcessor barcodeProcessor;
    private ExecutorService cameraExecutor;
    private boolean isScanning = false;
    private int scanCount = 0;
    private String lastBarcode = "";
    private long lastBarcodeTime = 0;
    private static final long DEBOUNCE_MS = 1500;
    
    @Override
    public void load() {
        try {
            Log.i(TAG, "ZXingScanner plugin loading...");
            cameraExecutor = Executors.newSingleThreadExecutor();
            
            // Initialize barcode processor with ZXing
            barcodeProcessor = new ZXingBarcodeProcessor(this::onBarcodeDetected);
            
            Log.i(TAG, "✅ ZXingScanner plugin loaded successfully");
        } catch (Exception e) {
            Log.e(TAG, "❌ Failed to initialize ZXingScanner plugin", e);
            throw new RuntimeException("Failed to initialize ZXingScanner plugin", e);
        }
    }
    
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        JSObject permissionsResult = new JSObject();
        
        PermissionState cameraState = getPermissionState("camera");
        String state = cameraState == PermissionState.GRANTED ? "granted" : "prompt";
        
        permissionsResult.put("camera", state);
        call.resolve(permissionsResult);
    }
    
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("camera", "granted");
            call.resolve(result);
        } else {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
        }
    }
    
    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        JSObject permissionsResult = new JSObject();
        
        PermissionState cameraState = getPermissionState("camera");
        String state = cameraState == PermissionState.GRANTED ? "granted" : "denied";
        
        permissionsResult.put("camera", state);
        call.resolve(permissionsResult);
    }
    
    @PluginMethod
    public void startScan(PluginCall call) {
        if (isScanning) {
            Log.w(TAG, "Scan already in progress");
            call.resolve();
            return;
        }
        
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Camera permission not granted");
            return;
        }
        
        getActivity().runOnUiThread(() -> {
            try {
                Log.i(TAG, "🎬 Starting ZXing barcode scan...");
                
                // Reset scan count
                scanCount = 0;
                lastBarcode = "";
                
                // Create scanner container (fullscreen overlay)
                scannerContainer = new FrameLayout(getContext());
                scannerContainer.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                ));
                scannerContainer.setBackgroundColor(Color.BLACK);
                
                // Create main layout (vertical: camera 80%, info 20%)
                LinearLayout mainLayout = new LinearLayout(getContext());
                mainLayout.setOrientation(LinearLayout.VERTICAL);
                mainLayout.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                ));
                
                // Camera preview (80% height)
                previewView = new PreviewView(getContext());
                previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
                LinearLayout.LayoutParams previewParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 0, 4f);  // weight 4
                previewView.setLayoutParams(previewParams);
                Log.i(TAG, "📸 PreviewView created with COMPATIBLE mode");
                
                // Info panel (20% height)
                infoPanel = createInfoPanel();
                LinearLayout.LayoutParams infoParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);  // weight 1
                infoPanel.setLayoutParams(infoParams);
                
                // Add views
                mainLayout.addView(previewView);
                mainLayout.addView(infoPanel);
                scannerContainer.addView(mainLayout);
                
                // Add close button
                ImageButton closeButton = createCloseButton();
                FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(
                    dpToPx(48), dpToPx(48));
                closeParams.gravity = Gravity.TOP | Gravity.END;
                closeParams.setMargins(0, dpToPx(16), dpToPx(16), 0);
                closeButton.setLayoutParams(closeParams);
                scannerContainer.addView(closeButton);
                
                // Add scanning indicator
                TextView scanningBadge = createScanningBadge();
                FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                badgeParams.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
                badgeParams.setMargins(0, dpToPx(16), 0, 0);
                scanningBadge.setLayoutParams(badgeParams);
                scannerContainer.addView(scanningBadge);
                
                // Add container ON TOP of webview
                FrameLayout rootContainer = (FrameLayout) getBridge().getWebView().getParent();
                rootContainer.addView(scannerContainer);
                Log.i(TAG, "📸 Scanner container added to root. Children count: " + rootContainer.getChildCount());
                
                // Start camera
                Log.i(TAG, "📸 Calling startCamera()...");
                startCamera();
                
                isScanning = true;
                
                JSObject result = new JSObject();
                result.put("started", true);
                call.resolve(result);
                
                Log.i(TAG, "✅ ZXing scan started successfully");
                
            } catch (Exception e) {
                Log.e(TAG, "❌ Error starting scan", e);
                call.reject("Failed to start scan: " + e.getMessage());
            }
        });
    }
    
    private LinearLayout createInfoPanel() {
        LinearLayout panel = new LinearLayout(getContext());
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.parseColor("#1a1a2e"));
        panel.setPadding(dpToPx(16), dpToPx(12), dpToPx(16), dpToPx(12));
        
        // Title
        TextView title = new TextView(getContext());
        title.setText("Último código detectado");
        title.setTextColor(Color.parseColor("#888888"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        panel.addView(title);
        
        // Barcode value display
        LinearLayout valueContainer = new LinearLayout(getContext());
        valueContainer.setOrientation(LinearLayout.VERTICAL);
        valueContainer.setBackgroundColor(Color.parseColor("#252540"));
        valueContainer.setPadding(dpToPx(12), dpToPx(10), dpToPx(12), dpToPx(10));
        LinearLayout.LayoutParams valueContainerParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        valueContainerParams.setMargins(0, dpToPx(8), 0, dpToPx(8));
        valueContainer.setLayoutParams(valueContainerParams);
        
        barcodeValueText = new TextView(getContext());
        barcodeValueText.setText("---");
        barcodeValueText.setTextColor(Color.parseColor("#00ff88"));
        barcodeValueText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        barcodeValueText.setTypeface(android.graphics.Typeface.MONOSPACE);
        valueContainer.addView(barcodeValueText);
        
        barcodeFormatText = new TextView(getContext());
        barcodeFormatText.setText("");
        barcodeFormatText.setTextColor(Color.parseColor("#666666"));
        barcodeFormatText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        valueContainer.addView(barcodeFormatText);
        
        panel.addView(valueContainer);
        
        // Scan count
        scanCountText = new TextView(getContext());
        scanCountText.setText("Códigos escaneados: 0");
        scanCountText.setTextColor(Color.parseColor("#888888"));
        scanCountText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        panel.addView(scanCountText);
        
        return panel;
    }
    
    private ImageButton createCloseButton() {
        ImageButton button = new ImageButton(getContext());
        button.setBackgroundColor(Color.parseColor("#33ffffff"));
        button.setColorFilter(Color.WHITE);
        // Use system close icon
        button.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
        button.setScaleType(ImageButton.ScaleType.CENTER_INSIDE);
        button.setPadding(dpToPx(12), dpToPx(12), dpToPx(12), dpToPx(12));
        
        button.setOnClickListener(v -> {
            stopScanInternal();
        });
        
        return button;
    }
    
    private TextView createScanningBadge() {
        TextView badge = new TextView(getContext());
        badge.setText("Escaneando...");
        badge.setTextColor(Color.WHITE);
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        badge.setBackgroundColor(Color.parseColor("#cc007bff"));
        badge.setPadding(dpToPx(16), dpToPx(8), dpToPx(16), dpToPx(8));
        return badge;
    }
    
    private int dpToPx(int dp) {
        float density = getContext().getResources().getDisplayMetrics().density;
        return Math.round(dp * density);
    }
    
    @PluginMethod
    public void stopScan(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                stopScanInternal();
                
                JSObject result = new JSObject();
                result.put("stopped", true);
                call.resolve(result);
                
            } catch (Exception e) {
                Log.e(TAG, "❌ Error stopping scan", e);
                call.reject("Failed to stop scan: " + e.getMessage());
            }
        });
    }
    
    private void stopScanInternal() {
        Log.i(TAG, "⏹️ Stopping ZXing scan...");
        
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
            cameraProvider = null;
        }
        
        if (scannerContainer != null) {
            FrameLayout rootContainer = (FrameLayout) getBridge().getWebView().getParent();
            rootContainer.removeView(scannerContainer);
            scannerContainer = null;
            previewView = null;
            infoPanel = null;
        }
        
        isScanning = false;
        Log.i(TAG, "✅ ZXing scan stopped");
    }
    
    private void startCamera() {
        Log.i(TAG, "📸 startCamera() called");
        
        try {
            ListenableFuture<ProcessCameraProvider> cameraProviderFuture = 
                ProcessCameraProvider.getInstance(getContext());
            
            Log.i(TAG, "📸 Got cameraProviderFuture, adding listener...");
            
            cameraProviderFuture.addListener(() -> {
                try {
                    Log.i(TAG, "📸 cameraProviderFuture listener executing...");
                    cameraProvider = cameraProviderFuture.get();
                    Log.i(TAG, "📸 Got cameraProvider: " + cameraProvider);
                    bindCameraUseCases();
                } catch (ExecutionException | InterruptedException e) {
                    Log.e(TAG, "❌ Error getting camera provider", e);
                }
            }, ContextCompat.getMainExecutor(getContext()));
            
        } catch (Exception e) {
            Log.e(TAG, "❌ Error in startCamera()", e);
        }
    }
    
    private void bindCameraUseCases() {
        Log.i(TAG, "📸 bindCameraUseCases() called");
        
        if (cameraProvider == null) {
            Log.e(TAG, "❌ cameraProvider is null!");
            return;
        }
        
        if (previewView == null) {
            Log.e(TAG, "❌ previewView is null!");
            return;
        }
        
        try {
            Log.i(TAG, "📸 Building Preview...");
            // Preview
            Preview preview = new Preview.Builder().build();
            
            Log.i(TAG, "📸 Setting surface provider...");
            preview.setSurfaceProvider(previewView.getSurfaceProvider());
            
            Log.i(TAG, "📸 Building ImageAnalysis...");
            // Image Analysis for ZXing
            imageAnalysis = new ImageAnalysis.Builder()
                .setTargetResolution(new Size(1280, 720))
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build();
            
            imageAnalysis.setAnalyzer(cameraExecutor, new ImageAnalysis.Analyzer() {
                @Override
                public void analyze(@NonNull ImageProxy imageProxy) {
                    processImageProxy(imageProxy);
                }
            });
            
            // Camera selector (back camera)
            CameraSelector cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA;
            
            Log.i(TAG, "📸 Unbinding all previous use cases...");
            // Unbind previous use cases
            cameraProvider.unbindAll();
            
            Log.i(TAG, "📸 Binding to lifecycle...");
            // Bind new use cases
            cameraProvider.bindToLifecycle(
                (LifecycleOwner) getActivity(),
                cameraSelector,
                preview,
                imageAnalysis
            );
            
            Log.i(TAG, "✅ Camera use cases bound successfully");
            
        } catch (Exception e) {
            Log.e(TAG, "❌ Use case binding failed", e);
            e.printStackTrace();
        }
    }
        }
    }
    
    private void processImageProxy(ImageProxy imageProxy) {
        if (!isScanning || barcodeProcessor == null) {
            imageProxy.close();
            return;
        }
        
        try {
            // Convert ImageProxy to byte array for ZXing
            Image image = imageProxy.getImage();
            if (image == null) {
                imageProxy.close();
                return;
            }
            
            // Get Y plane (luminance) for barcode detection
            Image.Plane[] planes = image.getPlanes();
            ByteBuffer buffer = planes[0].getBuffer();
            
            int rotation = imageProxy.getImageInfo().getRotationDegrees();
            
            // Create FrameMetadata
            FrameMetadata frameMetadata = new FrameMetadata.Builder()
                .setWidth(imageProxy.getWidth())
                .setHeight(imageProxy.getHeight())
                .setRotation(rotation)
                .build();
            
            // Process with ZXing
            barcodeProcessor.processByteBuffer(buffer, frameMetadata);
            
        } catch (Exception e) {
            Log.e(TAG, "Error processing image", e);
        } finally {
            imageProxy.close();
        }
    }
    
    private void onBarcodeDetected(String value, String format, float[] cornerPoints) {
        Log.i(TAG, "📷 Barcode detected: " + value + " (format: " + format + ")");
        
        // Debounce: Ignore same barcode within DEBOUNCE_MS
        long now = System.currentTimeMillis();
        if (value.equals(lastBarcode) && (now - lastBarcodeTime) < DEBOUNCE_MS) {
            return;
        }
        
        lastBarcode = value;
        lastBarcodeTime = now;
        scanCount++;
        
        // Update UI on main thread
        getActivity().runOnUiThread(() -> {
            if (barcodeValueText != null) {
                barcodeValueText.setText(value);
            }
            if (barcodeFormatText != null) {
                barcodeFormatText.setText("Formato: " + format);
            }
            if (scanCountText != null) {
                scanCountText.setText("Códigos escaneados: " + scanCount);
            }
        });
        
        JSObject result = new JSObject();
        result.put("value", value);
        result.put("format", format);
        
        if (cornerPoints != null && cornerPoints.length == 8) {
            JSObject corners = new JSObject();
            corners.put("topLeft", new float[]{cornerPoints[0], cornerPoints[1]});
            corners.put("topRight", new float[]{cornerPoints[2], cornerPoints[3]});
            corners.put("bottomRight", new float[]{cornerPoints[4], cornerPoints[5]});
            corners.put("bottomLeft", new float[]{cornerPoints[6], cornerPoints[7]});
            result.put("cornerPoints", corners);
        }
        
        notifyListeners(EVENT_BARCODE_SCANNED, result);
    }
    
    @Override
    protected void handleOnDestroy() {
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
        super.handleOnDestroy();
    }
}
