package com.carinventory.app.scanner;

import android.graphics.ImageFormat;
import android.media.Image;
import android.util.Log;

import androidx.camera.core.ImageProxy;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.Result;
import com.google.zxing.ResultPoint;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.common.PlanarYUVLuminanceSource;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Procesador de códigos de barras usando ZXing sobre frames de CameraX.
 */
public class ZXingBarcodeProcessor implements BarcodeProcessor {
    private static final String TAG = "ZXingBarcodeProcessor";
    private static final long DUPLICATE_THROTTLE_MS = 1000L;

    private final ScannerCallback callback;
    private final MultiFormatReader reader;
    private final AtomicBoolean isProcessingFrame = new AtomicBoolean(false);

    private String lastDetectedValue = "";
    private long lastDetectionTime = 0L;

    /**
     * Callback para resultados de escaneo.
     */
    public interface ScannerCallback {
        void onBarcodeDetected(String value, String format, float[] cornerPoints);
    }

    public ZXingBarcodeProcessor(ScannerCallback callback) {
        this.callback = callback;
        this.reader = new MultiFormatReader();

        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Arrays.asList(
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.QR_CODE,
            BarcodeFormat.DATA_MATRIX
        ));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        reader.setHints(hints);

        Log.i(TAG, "✅ ZXing barcode scanner initialized");
    }

    @Override
    public void processByteBuffer(ByteBuffer data, FrameMetadata frameMetadata) {
        // No se usa; CameraX entrega ImageProxy
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

        if (mediaImage.getFormat() != ImageFormat.YUV_420_888) {
            Log.w(TAG, "Formato de imagen no soportado: " + mediaImage.getFormat());
            imageProxy.close();
            return true;
        }

        if (isProcessingFrame.getAndSet(true)) {
            imageProxy.close();
            return true;
        }

        try {
            ByteBuffer yBuffer = mediaImage.getPlanes()[0].getBuffer();
            byte[] yData = new byte[yBuffer.remaining()];
            yBuffer.get(yData);

            int width = imageProxy.getWidth();
            int height = imageProxy.getHeight();
            int rotation = imageProxy.getImageInfo().getRotationDegrees();

            byte[] luminance = rotateYIfNeeded(yData, width, height, rotation);
            int finalWidth = (rotation == 90 || rotation == 270) ? height : width;
            int finalHeight = (rotation == 90 || rotation == 270) ? width : height;

            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                luminance,
                finalWidth,
                finalHeight,
                0,
                0,
                finalWidth,
                finalHeight,
                false
            );
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));

            try {
                Result result = reader.decodeWithState(bitmap);
                handleResult(result);
            } catch (NotFoundException e) {
                // Sin código en este frame
            } finally {
                reader.reset();
            }
        } catch (Exception e) {
            Log.e(TAG, "Error procesando frame", e);
        } finally {
            isProcessingFrame.set(false);
            imageProxy.close();
        }

        return true;
    }

    private void handleResult(Result result) {
        if (result == null || result.getText() == null) {
            return;
        }

        String value = result.getText();
        long now = System.currentTimeMillis();
        if (value.equals(lastDetectedValue) && (now - lastDetectionTime) < DUPLICATE_THROTTLE_MS) {
            return;
        }

        lastDetectedValue = value;
        lastDetectionTime = now;

        String format = result.getBarcodeFormat() != null ? result.getBarcodeFormat().toString() : "UNKNOWN";
        float[] cornerPoints = extractCornerPoints(result.getResultPoints());

        Log.i(TAG, "📷 Barcode detected: " + value + " (format: " + format + ")");

        if (callback != null) {
            callback.onBarcodeDetected(value, format, cornerPoints);
        }
    }

    private float[] extractCornerPoints(ResultPoint[] points) {
        if (points == null || points.length == 0) {
            return null;
        }
        float[] flat = new float[points.length * 2];
        for (int i = 0; i < points.length; i++) {
            flat[i * 2] = points[i].getX();
            flat[i * 2 + 1] = points[i].getY();
        }
        return flat;
    }

    private byte[] rotateYIfNeeded(byte[] data, int width, int height, int rotation) {
        if (rotation == 0) {
            return data;
        }
        if (rotation == 90 || rotation == 270) {
            byte[] rotated = new byte[data.length];
            int newWidth = height;
            int newHeight = width;
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int destX = rotation == 90 ? y : (newWidth - y - 1);
                    int destY = rotation == 90 ? (newHeight - x - 1) : x;
                    rotated[destY * newWidth + destX] = data[y * width + x];
                }
            }
            return rotated;
        } else if (rotation == 180) {
            byte[] rotated = new byte[data.length];
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    rotated[(height - y - 1) * width + (width - x - 1)] = data[y * width + x];
                }
            }
            return rotated;
        }
        return data;
    }

    @Override
    public void stop() {
        lastDetectedValue = "";
        lastDetectionTime = 0L;
        isProcessingFrame.set(false);
        Log.i(TAG, "ZXing scanner stopped");
    }
}
