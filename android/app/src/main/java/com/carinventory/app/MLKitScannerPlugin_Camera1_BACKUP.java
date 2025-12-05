package com.carinventory.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.graphics.Color;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;

import com.carinventory.app.scanner.CameraSource;
import com.carinventory.app.scanner.CameraSourcePreview;
import com.carinventory.app.scanner.MLKitBarcodeProcessor;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;

/**
 * Scanner ML Kit optimizado con CameraSource de Google
 * Layout: 80% cámara, 12% info, 8% safe area
 * Escaneo continuo sin salir
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
class MLKitScannerPlugin_Camera1_BACKUP extends Plugin {
    
    private CameraSource cameraSource;
    private CameraSourcePreview cameraPreview;
    private LinearLayout scannerContainer;
    private TextView infoTextView;
    private boolean isScanning = false;
    private String lastScannedCode = "";
    
    @Override
    public void load() {
        super.load();
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
        
        // Iniciar escaneo continuo
        startContinuousScanning(call);
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
    
    private void startContinuousScanning(@NonNull PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            try {
                createScannerUI(call);
                isScanning = true;
                
                JSObject ret = new JSObject();
                ret.put("status", "started");
                ret.put("mode", "continuous");
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Failed to start scanner: " + e.getMessage());
            }
        });
    }
    
    @SuppressLint("ClickableViewAccessibility")
    private void createScannerUI(@NonNull PluginCall scanCall) throws IOException {
        WebView webView = getBridge().getWebView();
        if (webView == null || webView.getParent() == null) {
            throw new IOException("WebView not available");
        }
        
        ViewGroup parent = (ViewGroup) webView.getParent();
        
        // Ocultar WebView temporalmente (no transparente, sino invisible)
        webView.setVisibility(View.GONE);
        
        // Crear contenedor principal con layout vertical
        scannerContainer = new LinearLayout(getContext());
        scannerContainer.setOrientation(LinearLayout.VERTICAL);
        scannerContainer.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        scannerContainer.setBackgroundColor(Color.BLACK);
        
        // Agregar contenedor ENCIMA (último índice = más al frente)
        parent.addView(scannerContainer);
        
        // Crear vista de cámara (80% de altura)
        cameraPreview = new CameraSourcePreview(getContext(), null);
        LinearLayout.LayoutParams cameraParams = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            0.80f // 80% weight
        );
        cameraPreview.setLayoutParams(cameraParams);
        scannerContainer.addView(cameraPreview);
        
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
        
        // Crear y configurar CameraSource
        cameraSource = new CameraSource(getActivity());
        
        // Crear procesador con callback continuo
        MLKitBarcodeProcessor processor = new MLKitBarcodeProcessor((code, format, timestamp) -> {
            // Callback ejecutado cada vez que se detecta un código
            lastScannedCode = code;
            
            // Actualizar UI con info del código
            getBridge().executeOnMainThread(() -> {
                String displayText = String.format(
                    "✅ Código: %s\nFormato: %s\nEscanea otro código...",
                    code,
                    format
                );
                if (infoTextView != null) {
                    infoTextView.setText(displayText);
                }
            });
            
            // Notificar a JavaScript para procesamiento continuo
            JSObject eventData = new JSObject();
            eventData.put("value", code);
            eventData.put("format", format);
            eventData.put("timestamp", timestamp);
            notifyListeners("barcodeScanned", eventData);
        });
        
        cameraSource.setFrameProcessor(processor);
        
        // Iniciar cámara
        cameraPreview.start(cameraSource);
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
        lastScannedCode = "";
        
        getBridge().executeOnMainThread(() -> {
            if (cameraPreview != null) {
                cameraPreview.stop();
                cameraPreview.release();
                cameraPreview = null;
            }
            
            if (cameraSource != null) {
                cameraSource.release();
                cameraSource = null;
            }
            
            if (scannerContainer != null && scannerContainer.getParent() != null) {
                ((ViewGroup) scannerContainer.getParent()).removeView(scannerContainer);
                scannerContainer = null;
            }
            
            infoTextView = null;
            
            // Restaurar WebView
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.setVisibility(View.VISIBLE);
            }
        });
    }
    
    @Override
    protected void handleOnDestroy() {
        stopCamera();
        super.handleOnDestroy();
    }
}
