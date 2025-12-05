package com.carinventory.app.scanner;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.util.Log;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.ResultPoint;
import com.google.zxing.common.HybridBinarizer;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;

/**
 * ZXing Barcode Processor
 * Processes camera frames to detect barcodes using Google ZXing library
 * 
 * Supports: EAN13, EAN8, UPC-A, UPC-E, Code128, Code39, QR Code, Data Matrix
 * 
 * @see ANALISIS_MLKIT_ZXING.md
 */
public class ZXingBarcodeProcessor implements BarcodeProcessor {
    
    private static final String TAG = "ZXingBarcodeProcessor";
    
    private final ScannerCallback callback;
    private final MultiFormatReader reader;
    private String lastDetectedValue = "";
    private long lastDetectionTime = 0;
    private static final long DUPLICATE_THROTTLE_MS = 1000; // 1 second
    
    /**
     * Callback interface for barcode detection
     */
    public interface ScannerCallback {
        void onBarcodeDetected(String value, String format, float[] cornerPoints);
    }
    
    public ZXingBarcodeProcessor(ScannerCallback callback) {
        this.callback = callback;
        this.reader = new MultiFormatReader();
        
        // Configure supported formats (same as MLKit)
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(
            BarcodeFormat.EAN_13,      // Most common for products
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.CODE_128,    // Common for inventory
            BarcodeFormat.CODE_39,
            BarcodeFormat.QR_CODE,     // For versatility
            BarcodeFormat.DATA_MATRIX
        ));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        
        reader.setHints(hints);
        
        Log.i(TAG, "✅ ZXingBarcodeProcessor initialized with common formats");
    }
    
    @Override
    public void processByteBuffer(java.nio.ByteBuffer data, FrameMetadata frameMetadata) {
        if (data == null || !data.hasRemaining()) {
            return;
        }
        
        byte[] bytes = new byte[data.remaining()];
        data.get(bytes);
        
        process(bytes, frameMetadata.getWidth(), frameMetadata.getHeight(), frameMetadata.getRotation());
    }
    
    public void process(byte[] data, int width, int height, int rotation) {
        if (data == null || data.length == 0) {
            return;
        }
        
        try {
            // Create luminance source from YUV data
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                data,
                width,
                height,
                0, 0,           // left, top
                width, height,  // width, height
                false           // reverseHorizontal
            );
            
            // Create binary bitmap for ZXing
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            
            // Attempt to decode
            Result result = reader.decode(bitmap);
            
            if (result != null) {
                handleDetectedBarcode(result);
            }
            
        } catch (NotFoundException e) {
            // No barcode found - this is normal, happens most frames
            // Don't log to avoid spam
            
        } catch (Exception e) {
            Log.e(TAG, "Error processing frame", e);
            
        } finally {
            // Reset reader for next frame
            reader.reset();
        }
    }
    
    private void handleDetectedBarcode(Result result) {
        String value = result.getText();
        String format = result.getBarcodeFormat().toString();
        
        // Throttle duplicate detections
        long now = System.currentTimeMillis();
        if (value.equals(lastDetectedValue) && 
            (now - lastDetectionTime) < DUPLICATE_THROTTLE_MS) {
            return;
        }
        
        lastDetectedValue = value;
        lastDetectionTime = now;
        
        Log.i(TAG, "📷 Barcode detected: " + value + " (format: " + format + ")");
        
        // Extract corner points
        float[] cornerPoints = extractCornerPoints(result);
        
        // Notify callback
        if (callback != null) {
            callback.onBarcodeDetected(value, format, cornerPoints);
        }
    }
    
    private float[] extractCornerPoints(Result result) {
        ResultPoint[] points = result.getResultPoints();
        
        if (points == null || points.length < 2) {
            return null;
        }
        
        // ZXing typically returns 2-4 points depending on barcode type
        // For 1D barcodes: 2 points (left and right ends)
        // For 2D barcodes (QR): 4 points (corners)
        
        if (points.length == 2) {
            // 1D barcode - estimate corners
            ResultPoint p1 = points[0];
            ResultPoint p2 = points[1];
            
            float x1 = p1.getX();
            float y1 = p1.getY();
            float x2 = p2.getX();
            float y2 = p2.getY();
            
            // Estimate height (typical 1D barcode is about 50px tall)
            float estimatedHeight = 50;
            
            return new float[]{
                x1, y1 - estimatedHeight/2,  // topLeft
                x2, y2 - estimatedHeight/2,  // topRight
                x2, y2 + estimatedHeight/2,  // bottomRight
                x1, y1 + estimatedHeight/2   // bottomLeft
            };
            
        } else if (points.length >= 4) {
            // 2D barcode with actual corners
            return new float[]{
                points[0].getX(), points[0].getY(),  // topLeft
                points[1].getX(), points[1].getY(),  // topRight
                points[2].getX(), points[2].getY(),  // bottomRight
                points[3].getX(), points[3].getY()   // bottomLeft
            };
            
        } else {
            // 3 points (some QR codes)
            return new float[]{
                points[0].getX(), points[0].getY(),
                points[1].getX(), points[1].getY(),
                points[2].getX(), points[2].getY(),
                points[0].getX(), points[0].getY()  // Repeat first point
            };
        }
    }
    
    @Override
    public void stop() {
        reader.reset();
        lastDetectedValue = "";
        lastDetectionTime = 0;
        Log.i(TAG, "ZXing processor stopped");
    }
}
