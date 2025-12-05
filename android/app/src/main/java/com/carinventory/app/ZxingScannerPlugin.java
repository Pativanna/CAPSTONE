package com.carinventory.app;

import android.Manifest;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

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
        ),
        @Permission(
            alias = "microphone",
            strings = { Manifest.permission.RECORD_AUDIO }
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
    private PluginCall pendingStartCall;
    
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
        result.put("camera", hasPermission("camera") ? "granted" : "prompt");
        result.put("microphone", hasPermission("microphone") ? "granted" : "prompt");
        call.resolve(result);
    }
    
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (hasPermission("camera") && hasPermission("microphone")) {
            JSObject result = new JSObject();
            result.put("camera", "granted");
            result.put("microphone", "granted");
            call.resolve(result);
            return;
        }
        requestAllPermissions(call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        JSObject result = new JSObject();
        boolean cameraGranted = hasPermission("camera");
        boolean microphoneGranted = hasPermission("microphone");
        result.put("camera", cameraGranted ? "granted" : "denied");
        result.put("microphone", microphoneGranted ? "granted" : "denied");

        if (cameraGranted && microphoneGranted) {
            call.resolve(result);
        } else {
            call.reject("Required permissions not granted", "PERMISSION_DENIED", result);
        }
    }
    
    @PluginMethod
    public void startScan(PluginCall call) {
        if (isScanning || pendingStartCall != null) {
            call.reject("Scanner already active");
            return;
        }
        
        if (!hasRequiredPermissions()) {
            call.reject("Required permissions not granted");
            return;
        }
        
        pendingStartCall = call;
        
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
            isScanning = true;
            resolvePendingStart();
        } catch (Exception e) {
            rejectPendingStart("Failed to bind camera: " + e.getMessage());
        }
    }
    
    private void analyzeImage(ImageProxy image) {
        if (!isScanning) {
            image.close();
            return;
        }
        
        try {
            byte[] luminance = extractLuminance(image);
            if (luminance == null) {
                return;
            }
            
            int width = image.getWidth();
            int height = image.getHeight();
            
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                luminance, width, height, 0, 0, width, height, false
            );
            
            int rotation = image.getImageInfo().getRotationDegrees();
            source = rotateSourceIfNeeded(source, rotation);
            
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Result result = reader.decodeWithState(bitmap);
            
            if (result != null) {
                handleBarcodeDetected(result);
            }
        } catch (Exception e) {
            // Ignorar y continuar con el siguiente frame
        } finally {
            image.close();
            reader.reset();
        }
    }
    
    private void handleBarcodeDetected(Result result) {
        if (!isScanning) {
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

    private byte[] extractLuminance(ImageProxy image) {
        try {
            ImageProxy.PlaneProxy plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int width = image.getWidth();
            int height = image.getHeight();
            int rowStride = plane.getRowStride();
            int pixelStride = plane.getPixelStride();
            
            buffer.rewind();
            byte[] yuvData = new byte[buffer.remaining()];
            buffer.get(yuvData);
            
            byte[] luminance = new byte[width * height];
            if (pixelStride == 1 && rowStride == width) {
                System.arraycopy(yuvData, 0, luminance, 0, luminance.length);
                return luminance;
            }
            
            for (int row = 0; row < height; row++) {
                int srcRowStart = row * rowStride;
                int dstRowStart = row * width;
                if (pixelStride == 1) {
                    System.arraycopy(yuvData, srcRowStart, luminance, dstRowStart, width);
                } else {
                    for (int col = 0; col < width; col++) {
                        luminance[dstRowStart + col] = yuvData[srcRowStart + col * pixelStride];
                    }
                }
            }
            return luminance;
        } catch (Exception ex) {
            return null;
        }
    }

    private PlanarYUVLuminanceSource rotateSourceIfNeeded(PlanarYUVLuminanceSource source, int rotation) {
        if (!source.isRotateSupported() || rotation == 0) {
            return source;
        }
        if (rotation == 90) {
            return source.rotateCounterClockwise();
        } else if (rotation == 180) {
            return source.rotateCounterClockwise().rotateCounterClockwise();
        } else if (rotation == 270) {
            return source.rotateCounterClockwise().rotateCounterClockwise().rotateCounterClockwise();
        }
        return source;
    }
}
