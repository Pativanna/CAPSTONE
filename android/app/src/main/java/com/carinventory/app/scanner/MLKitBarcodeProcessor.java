package com.carinventory.app.scanner;

import android.graphics.Point;
import android.media.Image;
import android.util.Log;

import androidx.camera.core.ImageProxy;

import com.google.mlkit.vision.barcode.Barcode;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.common.InputImage;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * ML Kit on-device barcode processor
 */
public class MLKitBarcodeProcessor implements BarcodeProcessor {
    private static final String TAG = "MLKitBarcodeProcessor";
    private static final long DUPLICATE_THROTTLE_MS = 1000L;

    private final ScannerCallback callback;
    private final BarcodeScanner scanner;
    private final AtomicBoolean isProcessingFrame = new AtomicBoolean(false);

    private String lastDetectedValue = "";
    private long lastDetectionTime = 0L;

    /**
     * Callback interface for barcode detection
     */
    public interface ScannerCallback {
        void onBarcodeDetected(String value, String format, float[] cornerPoints);
    }

    public MLKitBarcodeProcessor(ScannerCallback callback) {
        this.callback = callback;

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

        this.scanner = BarcodeScanning.getClient(options);
        Log.i(TAG, "✅ ML Kit barcode scanner initialized");
    }

    @Override
    public void processByteBuffer(java.nio.ByteBuffer data, FrameMetadata frameMetadata) {
        // Not used in ML Kit path; ImageProxy-based method is preferred
    }

    @Override
    public boolean processImageProxy(ImageProxy imageProxy) {
        if (imageProxy == null) {
            return false;
        }

        Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) {
            imageProxy.close();
            return true;
        }

        if (isProcessingFrame.getAndSet(true)) {
            // Drop frame to keep analyzer responsive
            imageProxy.close();
            return true;
        }

        InputImage inputImage = InputImage.fromMediaImage(
            mediaImage,
            imageProxy.getImageInfo().getRotationDegrees()
        );

        scanner.process(inputImage)
            .addOnSuccessListener(Runnable::run, this::handleBarcodes)
            .addOnFailureListener(Runnable::run, e -> Log.e(TAG, "Barcode processing failed", e))
            .addOnCompleteListener(Runnable::run, t -> {
                isProcessingFrame.set(false);
                imageProxy.close();
            });

        // We close the proxy in onComplete
        return true;
    }

    private void handleBarcodes(List<Barcode> barcodes) {
        if (barcodes == null || barcodes.isEmpty()) {
            return;
        }

        for (Barcode barcode : barcodes) {
            if (barcode == null || barcode.getRawValue() == null) {
                continue;
            }

            String value = barcode.getRawValue();
            long now = System.currentTimeMillis();
            if (value.equals(lastDetectedValue) && (now - lastDetectionTime) < DUPLICATE_THROTTLE_MS) {
                continue;
            }

            lastDetectedValue = value;
            lastDetectionTime = now;

            String format = formatToString(barcode.getFormat());
            float[] cornerPoints = extractCornerPoints(barcode.getCornerPoints());

            Log.i(TAG, "📷 Barcode detected: " + value + " (format: " + format + ")");

            if (callback != null) {
                callback.onBarcodeDetected(value, format, cornerPoints);
            }

            // Only dispatch first non-duplicate per frame
            break;
        }
    }

    private String formatToString(int format) {
        switch (format) {
            case Barcode.FORMAT_EAN_13: return "EAN_13";
            case Barcode.FORMAT_EAN_8: return "EAN_8";
            case Barcode.FORMAT_UPC_A: return "UPC_A";
            case Barcode.FORMAT_UPC_E: return "UPC_E";
            case Barcode.FORMAT_QR_CODE: return "QR_CODE";
            case Barcode.FORMAT_CODE_128: return "CODE_128";
            case Barcode.FORMAT_CODE_39: return "CODE_39";
            case Barcode.FORMAT_DATA_MATRIX: return "DATA_MATRIX";
            default: return "UNKNOWN";
        }
    }

    private float[] extractCornerPoints(Point[] points) {
        if (points == null || points.length == 0) {
            return null;
        }

        if (points.length >= 4) {
            return new float[]{
                points[0].x, points[0].y,
                points[1].x, points[1].y,
                points[2].x, points[2].y,
                points[3].x, points[3].y
            };
        }

        // For 1D barcodes ML Kit usually returns 4 points; if not, just map available points
        float[] flat = new float[points.length * 2];
        for (int i = 0; i < points.length; i++) {
            flat[i * 2] = points[i].x;
            flat[i * 2 + 1] = points[i].y;
        }
        return flat;
    }

    @Override
    public void stop() {
        scanner.close();
        lastDetectedValue = "";
        lastDetectionTime = 0L;
        isProcessingFrame.set(false);
        Log.i(TAG, "ML Kit scanner stopped");
    }
}
