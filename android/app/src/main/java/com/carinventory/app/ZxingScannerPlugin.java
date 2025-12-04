package com.carinventory.app;

import android.Manifest;
import android.graphics.Rect;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.ResultPoint;
import com.google.zxing.common.HybridBinarizer;

import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.google.common.util.concurrent.ListenableFuture;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "ZxingScanner",
    permissions = {
        @Permission(
            alias = "camera",
            strings = { Manifest.permission.CAMERA }
        )
    }
)
@SuppressWarnings({"unused", "RedundantSuppression"})
public class ZxingScannerPlugin extends Plugin {
    
    private PreviewView previewView;
    private ProcessCameraProvider cameraProvider;
    private Camera camera;
    private MultiFormatReader reader;
    private ExecutorService cameraExecutor;
    private boolean isScanning = false;
    private PluginCall scanCall;
    
    @Override
    public void load() {
        super.load();
        setupBarcodeReader();
        cameraExecutor = Executors.newSingleThreadExecutor();
    }
    
    private void setupBarcodeReader() {
        reader = new MultiFormatReader();
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        
        // Formatos soportados (incluyendo CODE_128 para impresoras térmicas)
        EnumSet<BarcodeFormat> formats = EnumSet.of(
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.CODE_93,
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.QR_CODE,
            BarcodeFormat.DATA_MATRIX,
            BarcodeFormat.ITF
        );
        
        hints.put(DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader.setHints(hints);
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
            call.reject("Scanner already active");
            return;
        }
        
        if (!hasRequiredPermissions()) {
            call.reject("Camera permission not granted");
            return;
        }
        
        scanCall = call;
        scanCall.setKeepAlive(true);
        
        getBridge().executeOnMainThread(() -> {
            startCamera();
        });
    }
    
    @PluginMethod
    public void stopScan(PluginCall call) {
        stopCamera();
        call.resolve();
    }
    
    private void startCamera() {
        isScanning = true;
        
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = 
            ProcessCameraProvider.getInstance(getContext());
        
        cameraProviderFuture.addListener(() -> {
            try {
                cameraProvider = cameraProviderFuture.get();
                bindCameraUseCases();
            } catch (ExecutionException | InterruptedException e) {
                if (scanCall != null) {
                    scanCall.reject("Failed to start camera: " + e.getMessage());
                    scanCall = null;
                }
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }
    
    private void bindCameraUseCases() {
        // Obtener WebView para overlay
        WebView webView = getBridge().getWebView();
        if (webView == null || webView.getParent() == null) {
            if (scanCall != null) {
                scanCall.reject("WebView not available");
                scanCall = null;
            }
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
        
        // Configurar cámara
        CameraSelector cameraSelector = new CameraSelector.Builder()
            .requireLensFacing(CameraSelector.LENS_FACING_BACK)
            .build();
        
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        
        // Análisis de imagen para detección de códigos
        ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build();
        
        imageAnalysis.setAnalyzer(cameraExecutor, this::analyzeImage);
        
        try {
            cameraProvider.unbindAll();
            // BridgeActivity extends AppCompatActivity que implementa LifecycleOwner
            LifecycleOwner lifecycleOwner = (LifecycleOwner) getActivity();
            camera = cameraProvider.bindToLifecycle(
                lifecycleOwner,
                cameraSelector,
                preview,
                imageAnalysis
            );
        } catch (Exception e) {
            if (scanCall != null) {
                scanCall.reject("Failed to bind camera: " + e.getMessage());
                scanCall = null;
            }
        }
    }
    
    private void analyzeImage(ImageProxy image) {
        if (!isScanning) {
            image.close();
            return;
        }
        
        try {
            ByteBuffer buffer = image.getPlanes()[0].getBuffer();
            byte[] data = new byte[buffer.remaining()];
            buffer.get(data);
            
            int width = image.getWidth();
            int height = image.getHeight();
            
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                data, width, height, 0, 0, width, height, false
            );
            
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            
            Result result = reader.decode(bitmap);
            
            if (result != null) {
                handleBarcodeDetected(result);
            }
        } catch (Exception e) {
            // No barcode found, continue scanning
        } finally {
            image.close();
        }
    }
    
    private void handleBarcodeDetected(Result result) {
        if (scanCall == null || !isScanning) {
            return;
        }
        
        getBridge().executeOnMainThread(() -> {
            JSObject ret = new JSObject();
            ret.put("value", result.getText());
            ret.put("format", result.getBarcodeFormat().toString());
            
            // Corner points para highlight
            ResultPoint[] points = result.getResultPoints();
            if (points != null && points.length > 0) {
                JSObject[] cornerPoints = new JSObject[points.length];
                for (int i = 0; i < points.length; i++) {
                    JSObject point = new JSObject();
                    point.put("x", points[i].getX());
                    point.put("y", points[i].getY());
                    cornerPoints[i] = point;
                }
                ret.put("cornerPoints", cornerPoints);
            }
            
            // Notificar a JavaScript (escaneo continuo)
            notifyListeners("barcodeDetected", ret);
        });
    }
    
    private void stopCamera() {
        isScanning = false;
        
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
            }
        });
        
        if (scanCall != null) {
            scanCall.setKeepAlive(false);
            scanCall = null;
        }
    }
    
    @Override
    protected void handleOnDestroy() {
        stopCamera();
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
        super.handleOnDestroy();
    }
}
