import logging
from dataclasses import dataclass
from typing import List, Dict, Any, Optional, Tuple

import numpy as np

try:
    import cv2  # type: ignore
except Exception as exc:  # pragma: no cover
    cv2 = None
    _import_error = exc
else:
    _import_error = None


logger = logging.getLogger('parts.scanner')


@dataclass
class BarcodeResult:
    raw_value: str
    format: str
    confidence: Optional[float]
    points: Optional[List[Dict[str, float]]]


class LocalBarcodeDetectorError(RuntimeError):
    """Raised when the local detector cannot run."""


def _decode_with_barcode_detector(image: np.ndarray) -> List[BarcodeResult]:
    detector = cv2.barcode_BarcodeDetector()
    ok, decoded_info, decoded_type, points = detector.detectAndDecode(image)
    if not ok or not decoded_info:
        return []

    results: List[BarcodeResult] = []
    for idx, value in enumerate(decoded_info):
        if not value:
            continue
        fmt = ''
        if decoded_type is not None:
            fmt = decoded_type[idx] if idx < len(decoded_type) else ''
        point_set = None
        if points is not None and idx < len(points):
            pts = points[idx]
            point_set = [
                {'x': float(p[0]), 'y': float(p[1])}
                for p in pts
            ]
        results.append(
            BarcodeResult(
                raw_value=value.strip(),
                format=fmt.upper() if fmt else '',
                confidence=None,
                points=point_set,
            )
        )
    return results


def _enhance_image(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


def _adjust_gamma(image: np.ndarray, gamma: float) -> np.ndarray:
    if gamma <= 0:
        return image
    inv_gamma = 1.0 / gamma
    table = np.array([
        ((i / 255.0) ** inv_gamma) * 255
        for i in np.arange(256)
    ]).astype("uint8")
    return cv2.LUT(image, table)


def _morphological_enhancement(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    thresh = cv2.adaptiveThreshold(
        blurred,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        31,
        2,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=1)
    return cv2.cvtColor(closed, cv2.COLOR_GRAY2BGR)


def _adaptive_threshold_bgr(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        35,
        8,
    )
    return cv2.cvtColor(binary, cv2.COLOR_GRAY2BGR)


def _sharpen_image(image: np.ndarray) -> np.ndarray:
    kernel = np.array([
        [0, -1, 0],
        [-1, 5, -1],
        [0, -1, 0],
    ], dtype=np.float32)
    return cv2.filter2D(image, -1, kernel)


def _resize_image(image: np.ndarray, scale: float) -> np.ndarray:
    if scale == 1.0:
        return image
    return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def _rotation_variants(image: np.ndarray) -> List[Tuple[str, np.ndarray]]:
    variants: List[Tuple[str, np.ndarray]] = []
    try:
        variants.append(('rot-90', cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)))
        variants.append(('rot-270', cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)))
    except Exception:  # pragma: no cover
        return []
    return variants


def _order_quad_points(points: np.ndarray) -> np.ndarray:
    if points.shape[0] != 4:
        return points
    pts = points.reshape(4, 2)
    sums = pts.sum(axis=1)
    diffs = np.diff(pts, axis=1).reshape(4)
    ordered = np.zeros((4, 2), dtype=np.float32)
    ordered[0] = pts[np.argmin(sums)]
    ordered[2] = pts[np.argmax(sums)]
    ordered[1] = pts[np.argmin(diffs)]
    ordered[3] = pts[np.argmax(diffs)]
    return ordered


def _warp_perspective(image: np.ndarray, quad: np.ndarray) -> Optional[np.ndarray]:
    ordered = _order_quad_points(quad)
    (tl, tr, br, bl) = ordered
    width_top = np.linalg.norm(tr - tl)
    width_bottom = np.linalg.norm(br - bl)
    height_right = np.linalg.norm(br - tr)
    height_left = np.linalg.norm(bl - tl)
    width = int(max(width_top, width_bottom))
    height = int(max(height_right, height_left))
    width = max(240, min(width, 1280))
    height = max(120, min(height, 720))
    destination = np.array([
        [0, 0],
        [width - 1, 0],
        [width - 1, height - 1],
        [0, height - 1],
    ], dtype=np.float32)
    try:
        matrix = cv2.getPerspectiveTransform(ordered.astype(np.float32), destination)
        warped = cv2.warpPerspective(image, matrix, (width, height))
    except cv2.error:
        return None
    return warped


def _find_rois(image: np.ndarray, max_candidates: int = 5) -> List[np.ndarray]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    image_area = image.shape[0] * image.shape[1]
    quads: List[np.ndarray] = []
    for contour in contours:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if len(approx) != 4:
            continue
        area = cv2.contourArea(approx)
        if area < image_area * 0.02:
            continue
        quads.append(approx.reshape(-1, 2))
    quads.sort(key=lambda q: cv2.contourArea(q.reshape(-1, 1, 2)), reverse=True)
    return quads[:max_candidates]


def _detail_enhance(image: np.ndarray) -> np.ndarray:
    if hasattr(cv2, 'detailEnhance'):
        try:
            return cv2.detailEnhance(image, sigma_s=10, sigma_r=0.15)
        except cv2.error:
            return image
    return image


def _apply_filter_set(image: np.ndarray, base_label: str) -> List[Tuple[str, np.ndarray]]:
    candidates: List[Tuple[str, np.ndarray]] = []
    candidates.append((base_label, image))
    candidates.append((f'{base_label}-sharpen', _sharpen_image(image)))
    candidates.append((f'{base_label}-detail', _detail_enhance(image)))
    candidates.append((f'{base_label}-clahe', _enhance_image(image)))
    candidates.append((f'{base_label}-gamma08', _adjust_gamma(image, 0.8)))
    candidates.append((f'{base_label}-gamma13', _adjust_gamma(image, 1.3)))
    candidates.append((f'{base_label}-morph', _morphological_enhancement(image)))
    candidates.append((f'{base_label}-adaptive', _adaptive_threshold_bgr(image)))
    return candidates


def _build_variant_pool(image: np.ndarray) -> Tuple[List[Tuple[str, np.ndarray]], int]:
    if image is None:
        return [], 0
    pool: List[Tuple[str, np.ndarray]] = []
    scales = (1.0, 1.3, 1.6)
    for scale in scales:
        scaled = _resize_image(image, scale) if scale != 1.0 else image
        pool.extend(_apply_filter_set(scaled, f'scale-{scale:.2f}'))
    pool.extend(_rotation_variants(image))
    rois = _find_rois(image)
    for idx, quad in enumerate(rois):
        warped = _warp_perspective(image, quad)
        if warped is None:
            continue
        pool.extend(_apply_filter_set(warped, f'roi-{idx+1}'))
    unique: List[Tuple[str, np.ndarray]] = []
    seen = set()
    for label, candidate in pool:
        if candidate is None:
            continue
        # Use label as key; duplicates per label are unlikely but ensure deterministic behaviour
        key = (label,)
        if key in seen:
            continue
        seen.add(key)
        unique.append((label, candidate))
    return unique, len(rois)


def detect_barcodes(image_bytes: bytes) -> List[BarcodeResult]:
    """Detect barcodes using OpenCV's BarcodeDetector."""
    if cv2 is None:
        raise LocalBarcodeDetectorError(
            f"OpenCV no está disponible: {_import_error}"
        )

    np_data = np.frombuffer(image_bytes, np.uint8)
    image = cv2.imdecode(np_data, cv2.IMREAD_COLOR)
    if image is None:
        raise LocalBarcodeDetectorError("No se pudo decodificar la imagen enviada.")

    variants, roi_count = _build_variant_pool(image)
    logger.debug("barcode:local:variants total=%s rois=%s", len(variants), roi_count)
    for label, candidate in variants:
        try:
            results = _decode_with_barcode_detector(candidate)
        except Exception as exc:  # pragma: no cover
            logger.debug("barcode:local:variant-error variant=%s err=%s", label, exc)
            continue
        if results:
            logger.debug("barcode:local:decoded variant=%s count=%s", label, len(results))
            return results
        logger.debug("barcode:local:empty-variant variant=%s", label)

    logger.debug("barcode:local:empty")
    return []
