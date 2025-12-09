package com.carinventory.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.Image;
import android.util.Log;
import android.util.Size;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "MLKitScanner",
    permissions = {
        @Permission(
            alias = "camera",
            strings = { Manifest.permission.CAMERA }
        )
    }
)
public class MLKitScannerPlugin extends Plugin {

    private static final String TAG = "MLKitScanner";
    
    private PreviewView previewView;
    private ExecutorService cameraExecutor;
    private BarcodeScanner scanner;
    private ProcessCameraProvider cameraProvider;
    private boolean isScanning = false;
    private PluginCall scanCallbackHolder;

    @PluginMethod
    public void startScan(PluginCall call) {
        Log.i(TAG, "📷 startScan called");
        
        if (!hasRequiredPermissions()) {
            Log.i(TAG, "Requesting camera permission...");
            requestAllPermissions(call, "handleCameraPermission");
            return;
        }
        
        scanCallbackHolder = call;
        call.setKeepAlive(true);
        
        getActivity().runOnUiThread(() -> {
            try {
                setupPreviewView();
                setupMLKitScanner();
                startCamera();
            } catch (Exception e) {
                Log.e(TAG, "Error starting scan", e);
                JSObject error = new JSObject();
                error.put("error", e.getMessage());
                call.reject("Failed to start scanner: " + e.getMessage());
            }
        });
    }

    @PermissionCallback
    private void handleCameraPermission(PluginCall call) {
        if (getPermissionState("camera") == com.getcapacitor.PermissionState.GRANTED) {
            Log.i(TAG, "Camera permission granted");
            startScan(call);
        } else {
            Log.e(TAG, "Camera permission denied");
            call.reject("Camera permission denied");
        }
    }

    private void setupPreviewView() {
        Log.i(TAG, "Setting up preview view...");
        
        if (previewView != null) {
            Log.i(TAG, "Preview view already exists");
            return;
        }
        
        previewView = new PreviewView(getContext());
        previewView.setId(View.generateViewId());
        
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        );
        
        // Get the bridge's web view parent
        ViewGroup parent = (ViewGroup) bridge.getWebView().getParent();
        parent.addView(previewView, 0, params);
        
        // Make webview transparent so preview shows through
        bridge.getWebView().setBackgroundColor(android.graphics.Color.TRANSPARENT);
        
        Log.i(TAG, "Preview view added to layout");
    }

    private void setupMLKitScanner() {
        Log.i(TAG, "Setting up ML Kit scanner...");
        
        BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
            .setBarcodeFormats(
                Barcode.FORMAT_EAN_13,
                Barcode.FORMAT_EAN_8,
                Barcode.FORMAT_UPC_A,
                Barcode.FORMAT_UPC_E,
                Barcode.FORMAT_CODE_128,
                Barcode.FORMAT_CODE_39,
                Barcode.FORMAT_QR_CODE,
                Barcode.FORMAT_DATA_MATRIX
            )
            .build();
        
        scanner = BarcodeScanning.getClient(options);
        cameraExecutor = Executors.newSingleThreadExecutor();
        
        Log.i(TAG, "✅ ML Kit scanner initialized");
    }

    private void startCamera() {
        Log.i(TAG, "Starting camera...");
        
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = 
            ProcessCameraProvider.getInstance(getContext());

        cameraProviderFuture.addListener(() -> {
            try {
                cameraProvider = cameraProviderFuture.get();

                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());

                ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
                    .setTargetResolution(new Size(1280, 720))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build();

                imageAnalysis.setAnalyzer(cameraExecutor, this::analyzeImage);

                CameraSelector cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA;

                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(
                    (LifecycleOwner) getActivity(), 
                    cameraSelector, 
                    preview, 
                    imageAnalysis
                );

                isScanning = true;
                Log.i(TAG, "✅ Camera started successfully");
                
                // Notify JS that camera is ready
                JSObject result = new JSObject();
                result.put("status", "started");
                notifyListeners("scannerReady", result);

            } catch (Exception e) {
                Log.e(TAG, "❌ Camera start failed", e);
                if (scanCallbackHolder != null) {
                    scanCallbackHolder.reject("Camera start failed: " + e.getMessage());
                    scanCallbackHolder = null;
                }
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }

    @androidx.camera.core.ExperimentalGetImage
    private void analyzeImage(@NonNull ImageProxy imageProxy) {
        if (!isScanning) {
            imageProxy.close();
            return;
        }

        Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) {
            imageProxy.close();
            return;
        }

        InputImage inputImage = InputImage.fromMediaImage(
            mediaImage, 
            imageProxy.getImageInfo().getRotationDegrees()
        );

        scanner.process(inputImage)
            .addOnSuccessListener(barcodes -> {
                if (!barcodes.isEmpty()) {
                    Barcode barcode = barcodes.get(0);
                    String value = barcode.getRawValue();
                    if (value != null && !value.isEmpty()) {
                        String format = formatToString(barcode.getFormat());
                        Log.i(TAG, "✅ Barcode found: " + value + " (" + format + ")");
                        
                        // Send barcode to JS (don't stop scanning)
                        JSObject result = new JSObject();
                        result.put("barcode", value);
                        result.put("format", format);
                        notifyListeners("barcodeScanned", result);
                    }
                }
            })
            .addOnFailureListener(e -> {
                Log.e(TAG, "ML Kit scan error", e);
            })
            .addOnCompleteListener(task -> imageProxy.close());
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        Log.i(TAG, "stopScan called");
        
        getActivity().runOnUiThread(() -> {
            try {
                isScanning = false;
                
                if (cameraProvider != null) {
                    cameraProvider.unbindAll();
                    cameraProvider = null;
                }
                
                if (cameraExecutor != null) {
                    cameraExecutor.shutdown();
                    cameraExecutor = null;
                }
                
                if (scanner != null) {
                    scanner.close();
                    scanner = null;
                }
                
                if (previewView != null) {
                    ViewGroup parent = (ViewGroup) previewView.getParent();
                    if (parent != null) {
                        parent.removeView(previewView);
                    }
                    previewView = null;
                }
                
                // Restore webview background
                bridge.getWebView().setBackgroundColor(android.graphics.Color.WHITE);
                
                if (scanCallbackHolder != null) {
                    scanCallbackHolder.resolve();
                    scanCallbackHolder = null;
                }
                
                Log.i(TAG, "✅ Scanner stopped");
                call.resolve();
                
            } catch (Exception e) {
                Log.e(TAG, "Error stopping scanner", e);
                call.reject("Failed to stop scanner: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("hasPermission", hasRequiredPermissions());
        call.resolve(result);
    }

    private boolean hasRequiredPermissions() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA) 
            == PackageManager.PERMISSION_GRANTED;
    }

    private String formatToString(int format) {
        switch (format) {
            case Barcode.FORMAT_EAN_13: return "EAN_13";
            case Barcode.FORMAT_EAN_8: return "EAN_8";
            case Barcode.FORMAT_UPC_A: return "UPC_A";
            case Barcode.FORMAT_UPC_E: return "UPC_E";
            case Barcode.FORMAT_CODE_128: return "CODE_128";
            case Barcode.FORMAT_CODE_39: return "CODE_39";
            case Barcode.FORMAT_QR_CODE: return "QR_CODE";
            case Barcode.FORMAT_DATA_MATRIX: return "DATA_MATRIX";
            default: return "UNKNOWN";
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        isScanning = false;
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
        if (scanner != null) {
            scanner.close();
        }
    }
}
