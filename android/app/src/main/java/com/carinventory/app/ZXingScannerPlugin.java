package com.carinventory.app;

import android.Manifest;
import android.graphics.ImageFormat;
import android.media.Image;
import android.util.Log;
import android.util.Size;
import android.view.Surface;
import android.view.ViewGroup;
import android.widget.FrameLayout;

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
    
    private PreviewView previewView;
    private ProcessCameraProvider cameraProvider;
    private ImageAnalysis imageAnalysis;
    private BarcodeProcessor barcodeProcessor;
    private ExecutorService cameraExecutor;
    private boolean isScanning = false;
    
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
                
                // Create preview view
                previewView = new PreviewView(getContext());
                previewView.setLayoutParams(new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                ));
                
                // Add to bridge webview
                FrameLayout container = (FrameLayout) getBridge().getWebView().getParent();
                container.addView(previewView, 0); // Behind webview
                
                // Start camera
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
    
    @PluginMethod
    public void stopScan(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                Log.i(TAG, "⏹️ Stopping ZXing scan...");
                
                if (cameraProvider != null) {
                    cameraProvider.unbindAll();
                    cameraProvider = null;
                }
                
                if (previewView != null) {
                    FrameLayout container = (FrameLayout) getBridge().getWebView().getParent();
                    container.removeView(previewView);
                    previewView = null;
                }
                
                isScanning = false;
                
                JSObject result = new JSObject();
                result.put("stopped", true);
                call.resolve(result);
                
                Log.i(TAG, "✅ ZXing scan stopped");
                
            } catch (Exception e) {
                Log.e(TAG, "❌ Error stopping scan", e);
                call.reject("Failed to stop scan: " + e.getMessage());
            }
        });
    }
    
    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = 
            ProcessCameraProvider.getInstance(getContext());
        
        cameraProviderFuture.addListener(() -> {
            try {
                cameraProvider = cameraProviderFuture.get();
                bindCameraUseCases();
            } catch (ExecutionException | InterruptedException e) {
                Log.e(TAG, "Error binding camera", e);
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }
    
    private void bindCameraUseCases() {
        if (cameraProvider == null) {
            return;
        }
        
        // Preview
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        
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
        
        try {
            // Unbind previous use cases
            cameraProvider.unbindAll();
            
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
