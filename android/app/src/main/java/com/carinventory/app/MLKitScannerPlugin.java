package com.carinventory.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.Image;
import android.os.Bundle;
import android.util.Log;
import android.util.Size;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
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
            strings = { Manifest.permission.CAMERA },
            alias = "camera"
        )
    }
)
public class MLKitScannerPlugin extends Plugin {

    private static final String TAG = "MLKitScanner";
    
    // UI Components
    private FrameLayout scannerContainer;
    private PreviewView previewView;
    private TextView statusText;
    private Button closeButton;
    
    // Camera & Scanner
    private ProcessCameraProvider cameraProvider;
    private BarcodeScanner scanner;
    private ExecutorService cameraExecutor;
    
    // State
    private boolean isScanning = false;
    private boolean found = false;
    private boolean isProcessing = false;
    private PluginCall savedCall;

    @Override
    public void load() {
        super.load();
        Log.i(TAG, "✅ MLKitScannerPlugin loaded");
        cameraExecutor = Executors.newSingleThreadExecutor();
        setupMLKitScanner();
    }

    private void setupMLKitScanner() {
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
        Log.i(TAG, "✅ ML Kit barcode scanner initialized");
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        Log.i(TAG, "📷 startScan called");
        savedCall = call;
        
        if (isScanning) {
            Log.w(TAG, "⚠️ Scanner already active");
            call.reject("Scanner is already active");
            return;
        }

        // Check camera permission
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            Log.i(TAG, "🔐 Requesting camera permission...");
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }

        getActivity().runOnUiThread(this::createScannerUI);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            Log.i(TAG, "✅ Camera permission granted");
            getActivity().runOnUiThread(this::createScannerUI);
        } else {
            Log.e(TAG, "❌ Camera permission denied");
            call.reject("Camera permission is required");
        }
    }

    private void createScannerUI() {
        Log.i(TAG, "🎨 Creating scanner UI...");
        
        // Create container
        scannerContainer = new FrameLayout(getActivity());
        scannerContainer.setLayoutParams(new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        scannerContainer.setBackgroundColor(0xFF000000);
        
        // Create preview view
        previewView = new PreviewView(getActivity());
        previewView.setLayoutParams(new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        scannerContainer.addView(previewView);
        
        // Create status text
        statusText = new TextView(getActivity());
        FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        );
        statusParams.gravity = android.view.Gravity.TOP | android.view.Gravity.CENTER_HORIZONTAL;
        statusParams.topMargin = 100;
        statusText.setLayoutParams(statusParams);
        statusText.setTextColor(0xFFFFFFFF);
        statusText.setTextSize(18);
        statusText.setText("Apunta la cámara a un código de barras");
        statusText.setBackgroundColor(0x88000000);
        statusText.setPadding(32, 16, 32, 16);
        scannerContainer.addView(statusText);
        
        // Create close button
        closeButton = new Button(getActivity());
        FrameLayout.LayoutParams buttonParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        );
        buttonParams.gravity = android.view.Gravity.BOTTOM | android.view.Gravity.CENTER_HORIZONTAL;
        buttonParams.bottomMargin = 100;
        closeButton.setLayoutParams(buttonParams);
        closeButton.setText("Cancelar");
        closeButton.setTextSize(16);
        closeButton.setPadding(64, 32, 64, 32);
        closeButton.setOnClickListener(v -> stopScanInternal(true));
        scannerContainer.addView(closeButton);
        
        // Add to activity's root view
        FrameLayout rootView = getActivity().findViewById(android.R.id.content);
        rootView.addView(scannerContainer);
        
        Log.i(TAG, "✅ Scanner UI created");
        
        // Start camera
        found = false;
        isProcessing = false;
        startCamera();
    }

    private void startCamera() {
        Log.i(TAG, "📷 Starting camera...");
        isScanning = true;
        
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
                    (androidx.lifecycle.LifecycleOwner) getActivity(), 
                    cameraSelector, 
                    preview, 
                    imageAnalysis
                );

                Log.i(TAG, "✅ Camera started successfully");
                getActivity().runOnUiThread(() -> {
                    if (statusText != null) {
                        statusText.setText("Cámara activa - Escanea un código");
                    }
                });

            } catch (Exception e) {
                Log.e(TAG, "❌ Camera start failed", e);
                getActivity().runOnUiThread(() -> {
                    if (statusText != null) {
                        statusText.setText("Error: " + e.getMessage());
                    }
                    if (savedCall != null) {
                        savedCall.reject("Failed to start camera: " + e.getMessage());
                        savedCall = null;
                    }
                });
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }

    @androidx.camera.core.ExperimentalGetImage
    private void analyzeImage(@NonNull ImageProxy imageProxy) {
        if (found || isProcessing || !isScanning) {
            imageProxy.close();
            return;
        }

        Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) {
            imageProxy.close();
            return;
        }

        isProcessing = true;
        InputImage inputImage = InputImage.fromMediaImage(
            mediaImage, 
            imageProxy.getImageInfo().getRotationDegrees()
        );

        scanner.process(inputImage)
            .addOnSuccessListener(barcodes -> {
                if (!found && !barcodes.isEmpty()) {
                    Barcode barcode = barcodes.get(0);
                    String value = barcode.getRawValue();
                    if (value != null && !value.isEmpty()) {
                        found = true;
                        String format = formatToString(barcode.getFormat());
                        Log.i(TAG, "✅ Barcode found: " + value + " (" + format + ")");

                        getActivity().runOnUiThread(() -> {
                            if (statusText != null) {
                                statusText.setText("✅ Código encontrado: " + value);
                            }
                        });

                        // Return result after brief delay to show the user what was scanned
                        previewView.postDelayed(() -> {
                            JSObject result = new JSObject();
                            result.put("barcode", value);
                            result.put("format", format);
                            
                            // Notify listeners
                            notifyListeners("barcodeScanned", result);
                            
                            // Stop scanner and resolve call
                            stopScanInternal(false);
                            
                            if (savedCall != null) {
                                savedCall.resolve(result);
                                savedCall = null;
                            }
                        }, 500);
                    }
                }
                isProcessing = false;
            })
            .addOnFailureListener(e -> {
                Log.e(TAG, "ML Kit scan failed", e);
                isProcessing = false;
            })
            .addOnCompleteListener(task -> imageProxy.close());
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

    @PluginMethod
    public void stopScan(PluginCall call) {
        Log.i(TAG, "🛑 stopScan called from JS");
        stopScanInternal(true);
        call.resolve();
    }

    private void stopScanInternal(boolean cancelled) {
        Log.i(TAG, "🛑 Stopping scanner (cancelled=" + cancelled + ")");
        isScanning = false;
        
        getActivity().runOnUiThread(() -> {
            // Stop camera
            if (cameraProvider != null) {
                cameraProvider.unbindAll();
            }
            
            // Remove UI
            if (scannerContainer != null) {
                FrameLayout rootView = getActivity().findViewById(android.R.id.content);
                rootView.removeView(scannerContainer);
                scannerContainer = null;
                previewView = null;
                statusText = null;
                closeButton = null;
            }
            
            if (cancelled && savedCall != null) {
                JSObject result = new JSObject();
                result.put("cancelled", true);
                savedCall.resolve(result);
                savedCall = null;
            }
        });
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        result.put("method", "mlkit");
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
        if (scanner != null) {
            scanner.close();
        }
    }
}
