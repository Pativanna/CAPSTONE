package com.carinventory.app.scanner;

import android.content.Context;
import android.util.AttributeSet;
import android.util.Log;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;

import java.io.IOException;

/**
 * Preview de la cámara adaptado de Google ML Kit
 */
public class CameraSourcePreview extends ViewGroup {
    private static final String TAG = "CameraSourcePreview";
    
    private final SurfaceView surfaceView;
    private boolean startRequested;
    private boolean surfaceAvailable;
    private CameraSource cameraSource;
    
    private int previewWidth;
    private int previewHeight;
    
    public CameraSourcePreview(Context context, AttributeSet attrs) {
        super(context, attrs);
        startRequested = false;
        surfaceAvailable = false;
        
        surfaceView = new SurfaceView(context);
        surfaceView.getHolder().addCallback(new SurfaceCallback());
        addView(surfaceView);
    }
    
    public void start(CameraSource cameraSource) throws IOException {
        this.cameraSource = cameraSource;
        
        if (this.cameraSource != null) {
            startRequested = true;
            startIfReady();
        }
    }
    
    public void stop() {
        if (cameraSource != null) {
            cameraSource.stop();
        }
    }
    
    public void release() {
        if (cameraSource != null) {
            cameraSource.release();
            cameraSource = null;
        }
    }
    
    private void startIfReady() throws IOException {
        if (startRequested && surfaceAvailable) {
            cameraSource.start(surfaceView.getHolder());
            requestLayout();
            
            android.util.Size size = cameraSource.getPreviewSize();
            if (size != null) {
                previewWidth = size.getWidth();
                previewHeight = size.getHeight();
            }
            
            startRequested = false;
        }
    }
    
    private class SurfaceCallback implements SurfaceHolder.Callback {
        @Override
        public void surfaceCreated(SurfaceHolder surface) {
            surfaceAvailable = true;
            try {
                startIfReady();
            } catch (IOException e) {
                Log.e(TAG, "Could not start camera source.", e);
            }
        }
        
        @Override
        public void surfaceDestroyed(SurfaceHolder surface) {
            surfaceAvailable = false;
        }
        
        @Override
        public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}
    }
    
    @Override
    protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        int width = right - left;
        int height = bottom - top;
        
        if (previewWidth != 0 && previewHeight != 0) {
            // IMPORTANTE: La cámara puede rotar las dimensiones
            // Calcular aspect ratio correctamente
            float previewAspect = (float) previewHeight / (float) previewWidth;
            float viewAspect = (float) height / (float) width;
            
            int childWidth, childHeight;
            
            if (viewAspect > previewAspect) {
                // View es más alto que el preview - ajustar por ancho
                childWidth = width;
                childHeight = (int) (width * previewAspect);
            } else {
                // View es más ancho que el preview - ajustar por alto
                childHeight = height;
                childWidth = (int) (height / previewAspect);
            }
            
            // Centrar el preview
            int xOffset = (width - childWidth) / 2;
            int yOffset = (height - childHeight) / 2;
            
            for (int i = 0; i < getChildCount(); i++) {
                getChildAt(i).layout(xOffset, yOffset, xOffset + childWidth, yOffset + childHeight);
            }
            
            Log.d(TAG, String.format("Preview layout: view=%dx%d, preview=%dx%d, child=%dx%d",
                width, height, previewWidth, previewHeight, childWidth, childHeight));
        } else {
            // Sin tamaño de preview, usar todo el espacio
            for (int i = 0; i < getChildCount(); i++) {
                getChildAt(i).layout(0, 0, width, height);
            }
        }
    }
}
