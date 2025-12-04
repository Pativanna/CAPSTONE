# parts/barcode_generator.py
"""
Sistema de generación de códigos de barras para piezas
Compatible con impresora térmica GOOJPRT PT210
"""

import barcode
from barcode.writer import ImageWriter, SVGWriter
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont
import os
from django.conf import settings
from datetime import datetime


class GeneradorEtiquetaPieza:
    """Genera códigos, etiquetas y comandos ESC/POS para una pieza."""
    
    # Configuración para impresora térmica de 58mm (ancho típico PT210)
    THERMAL_WIDTH_MM = 58
    THERMAL_WIDTH_PX = 384  # 58mm a 168 DPI (estándar térmicas)
    THERMAL_DPI = 203  # DPI de la GOOJPRT PT210
    DOT_MM = 25.4 / THERMAL_DPI
    DEFAULT_BARCODE_WIDTH_RATIO = 0.94  # 94 % del ancho útil mantiene márgenes pero llena mejor la etiqueta
    MIN_BARCODE_WIDTH_RATIO = 0.75
    MAX_BARCODE_WIDTH_RATIO = 0.98
    DEFAULT_MODULE_DOTS = 8  # cada módulo (barra mínima) ocupa 8 dots ~1.0 mm (aumentado para mayor grosor)
    MIN_MODULE_MM = 0.33  # salvaguarda para impresoras de mayor DPI (actualizado para 8 dots)
    DEFAULT_QUIET_ZONE_DOTS = 16  # ~2.0 mm a 203 DPI
    DEFAULT_MODULE_HEIGHT_MM = 25  # Aumentado de 18 a 25mm para barras más altas
    DEFAULT_TEXT_DISTANCE_MM = 4.5  # Aumentado de 3.2 a 4.5mm para más separación
    
    def __init__(self, part):
        """
        Inicializa el generador con una pieza
        
        Args:
            part: Instancia del modelo Part
        """
        self.part = part
        self.codigo_barras = self._generar_codigo()
    
    def _generar_codigo(self):
        """
        Genera un código único para la pieza usando EAN13 o CODE128
        
        Formato: PPPPPPPPPPPP (12 dígitos)
        - PPPP: ID de la pieza (4 dígitos, padding con ceros)
        - AAAA: Año del auto (4 dígitos)
        - TTTT: Timestamp corto (4 dígitos, últimos 4 de timestamp)
        
        Returns:
            str: Código de barras generado
        """
        # Opción 1: Código simple basado en ID (para CODE128)
        # Formato: INV-{ID}-{YEAR}
        codigo_simple = f"INV{self.part.id:06d}{self.part.auto.year}"
        
        return codigo_simple
    
    @classmethod
    def _resolve_module_width_mm(cls):
        custom_mm = getattr(settings, 'BARCODE_MODULE_WIDTH_MM', None)
        if custom_mm:
            return max(float(custom_mm), cls.MIN_MODULE_MM)
        custom_dots = getattr(settings, 'BARCODE_MIN_MODULE_DOTS', None)
        dots = float(custom_dots) if custom_dots else cls.DEFAULT_MODULE_DOTS
        return max(cls.MIN_MODULE_MM, round(dots * cls.DOT_MM, 4))

    @classmethod
    def _resolve_quiet_zone_mm(cls):
        custom_mm = getattr(settings, 'BARCODE_QUIET_ZONE_MM', None)
        if custom_mm:
            return max(float(custom_mm), cls._resolve_module_width_mm() * 8)
        custom_dots = getattr(settings, 'BARCODE_QUIET_ZONE_DOTS', None)
        dots = float(custom_dots) if custom_dots else cls.DEFAULT_QUIET_ZONE_DOTS
        return max(round(dots * cls.DOT_MM, 4), cls._resolve_module_width_mm() * 8)

    @classmethod
    def _resolve_module_height_mm(cls):
        custom_mm = getattr(settings, 'BARCODE_MODULE_HEIGHT_MM', None)
        if custom_mm:
            return max(float(custom_mm), 12.0)
        return cls.DEFAULT_MODULE_HEIGHT_MM

    @classmethod
    def _resolve_text_distance_mm(cls):
        custom = getattr(settings, 'BARCODE_TEXT_DISTANCE_MM', None)
        if custom:
            return max(float(custom), 2.0)
        return cls.DEFAULT_TEXT_DISTANCE_MM

    @classmethod
    def _resolve_barcode_width_ratio(cls):
        custom = getattr(settings, 'BARCODE_WIDTH_RATIO', None)
        if custom:
            try:
                value = float(custom)
            except (TypeError, ValueError):
                value = cls.DEFAULT_BARCODE_WIDTH_RATIO
        else:
            value = cls.DEFAULT_BARCODE_WIDTH_RATIO
        return max(cls.MIN_BARCODE_WIDTH_RATIO, min(cls.MAX_BARCODE_WIDTH_RATIO, value))

    def _barcode_writer_options(self, include_text=True):
        return {
            'module_width': self._resolve_module_width_mm(),
            'module_height': self._resolve_module_height_mm(),
            'quiet_zone': self._resolve_quiet_zone_mm(),
            'font_size': 9,
            'text_distance': self._resolve_text_distance_mm(),
            'background': 'white',
            'foreground': 'black',
            'write_text': include_text,
        }

    def _build_barcode_buffer(self, formato='CODE128', include_text=True, writer_cls=ImageWriter):
        barcode_class = barcode.get_barcode_class(formato)
        writer = writer_cls()
        if isinstance(writer, ImageWriter):
            writer.dpi = self.THERMAL_DPI
        options = self._barcode_writer_options(include_text=include_text)
        buffer = BytesIO()
        codigo = barcode_class(self.codigo_barras, writer=writer)
        codigo.write(buffer, options=options)
        buffer.seek(0)
        return buffer

    def generar_imagen_barcode(self, formato='CODE128', include_text=True):
        """Genera imagen raster optimizada para 203 DPI."""
        return self._build_barcode_buffer(formato=formato, include_text=include_text, writer_cls=ImageWriter)

    def generar_svg_barcode(self, formato='CODE128', include_text=True):
        """Genera código vectorial (SVG) para impresoras de mayor resolución."""
        return self._build_barcode_buffer(formato=formato, include_text=include_text, writer_cls=SVGWriter)
    
    def _render_etiqueta_image(self):
        """
        Crea la imagen PIL de la etiqueta completa (sin convertir a bytes).
        """
        # Generar código de barras base
        barcode_buffer = self.generar_imagen_barcode(formato='CODE128', include_text=True)
        barcode_img = Image.open(barcode_buffer).convert('L')

        # Ajustar con interpolación nearest para no distorsionar las barras
        target_width = int(self.THERMAL_WIDTH_PX * self._resolve_barcode_width_ratio())
        if abs(barcode_img.width - target_width) > 2:
            aspect_ratio = barcode_img.height / max(barcode_img.width, 1)
            target_height = max(130, int(target_width * aspect_ratio))
            barcode_img = barcode_img.resize(
                (target_width, target_height),
                Image.Resampling.NEAREST
            )
        barcode_width = barcode_img.width
        barcode_height = barcode_img.height
        
        # Calcular altura total de la etiqueta
        padding = 20  # Aumentado de 15 a 20 para más espacio entre secciones
        text_height = 160  # Aumentado de 140 a 160 para más espacio entre líneas
        total_height = barcode_height + text_height + (padding * 3)
        
        # Crear imagen base para la etiqueta
        etiqueta = Image.new('RGB', (self.THERMAL_WIDTH_PX, total_height), 'white')
        draw = ImageDraw.Draw(etiqueta)
        
        # Cargar fuente (usar fuente por defecto si no hay personalizada)
        try:
            font_titulo = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 18)  # Aumentado de 16 a 18
            font_normal = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)     # Aumentado de 13 a 14
            font_pequeña = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 11)    # Aumentado de 10 a 11
        except:
            # Fallback a fuente por defecto
            font_titulo = ImageFont.load_default()
            font_normal = ImageFont.load_default()
            font_pequeña = ImageFont.load_default()
        
        # Posición Y actual
        y_pos = padding
        
        # 1. Título: Nombre de la pieza (centrado, truncado si es muy largo)
        nombre_pieza = self.part.name[:30]  # Limitar a 30 caracteres
        # Usar textbbox para obtener dimensiones del texto
        bbox = draw.textbbox((0, 0), nombre_pieza, font=font_titulo)
        text_width = bbox[2] - bbox[0]
        x_centered = (self.THERMAL_WIDTH_PX - text_width) // 2
        draw.text((x_centered, y_pos), nombre_pieza, fill='black', font=font_titulo)
        y_pos += 28  # Aumentado de 24 a 28 para más espaciado
        
        # 2. Auto: Marca y modelo
        auto_info = f"{self.part.auto.brand_model} {self.part.auto.year}"[:35]
        bbox = draw.textbbox((0, 0), auto_info, font=font_normal)
        text_width = bbox[2] - bbox[0]
        x_centered = (self.THERMAL_WIDTH_PX - text_width) // 2
        draw.text((x_centered, y_pos), auto_info, fill='black', font=font_normal)
        y_pos += 24  # Aumentado de 20 a 24 para más espaciado
        
        # 3. Precio (si existe)
        if self.part.max_value > 0:
            precio_texto = f"${self.part.max_value:,}".replace(",", ".")
            if self.part.min_value > 0 and self.part.min_value != self.part.max_value:
                precio_texto = f"${self.part.min_value:,}-${self.part.max_value:,}".replace(",", ".")
            
            bbox = draw.textbbox((0, 0), precio_texto, font=font_titulo)
            text_width = bbox[2] - bbox[0]
            x_centered = (self.THERMAL_WIDTH_PX - text_width) // 2
            draw.text((x_centered, y_pos), precio_texto, fill='black', font=font_titulo)
            y_pos += 28  # Aumentado de 24 a 28 para más espaciado
        
        # 4. Línea separadora
        y_pos += 8  # Aumentado de 5 a 8
        draw.line([(padding, y_pos), (self.THERMAL_WIDTH_PX - padding, y_pos)], fill='black', width=1)
        y_pos += 12  # Aumentado de 10 a 12 para más espacio antes del código
        
        # 5. Pegar código de barras centrado
        x_barcode = (self.THERMAL_WIDTH_PX - barcode_width) // 2
        etiqueta.paste(barcode_img, (x_barcode, y_pos))
        y_pos += barcode_height + (padding * 2)  # Más espacio después del código de barras
        
        # 6. Información adicional (fecha, taller)
        fecha_texto = f"Fecha: {self.part.date_added.strftime('%d/%m/%Y')}"
        draw.text((padding, y_pos), fecha_texto, fill='black', font=font_pequeña)
        y_pos += 18  # Aumentado de 16 a 18 para más espaciado entre fecha y taller
        
        if self.part.workshop:
            taller_texto = f"Taller: {self.part.workshop.name[:25]}"
            draw.text((padding, y_pos), taller_texto, fill='black', font=font_pequeña)
        
        return etiqueta

    def generar_etiqueta_completa(self):
        """
        Genera etiqueta completa con código de barras + información de la pieza
        Optimizada para impresora térmica GOOJPRT PT210 (58mm)
        ORIENTACIÓN: Vertical (portrait) - se rota 90 grados para aprovechar altura
        
        Returns:
            BytesIO: Buffer con imagen PNG de la etiqueta completa
        """
        etiqueta = self._render_etiqueta_image()
        
        # Asegurar que la imagen sea exactamente 384px de ancho
        if etiqueta.width != self.THERMAL_WIDTH_PX:
            scale = self.THERMAL_WIDTH_PX / etiqueta.width
            new_height = int(etiqueta.height * scale)
            etiqueta = etiqueta.resize((self.THERMAL_WIDTH_PX, new_height), Image.Resampling.LANCZOS)
        
        # ROTAR 90 grados para orientación vertical (portrait)
        # Esto convierte el ancho (384px) en altura, aprovechando todo el espacio vertical
        etiqueta = etiqueta.rotate(90, expand=True, fillcolor='white')
        
        output_buffer = BytesIO()
        # Guardar sin DPI metadata para evitar problemas de escalado en navegadores
        etiqueta.save(output_buffer, format='PNG')
        output_buffer.seek(0)
        
        return output_buffer

    def generar_etiqueta_escpos(self, threshold=160):
        """
        Genera los comandos ESC/POS para imprimir la etiqueta en una impresora térmica.
        
        Args:
            threshold (int): Umbral (0-255) para convertir a blanco/negro.
        
        Returns:
            bytes: Secuencia ESC/POS lista para enviar a la impresora.
        """
        # Obtener etiqueta base
        etiqueta = self._render_etiqueta_image().convert('L')
        
        # Ajustar ancho a 384px
        if etiqueta.width != self.THERMAL_WIDTH_PX:
            scale = self.THERMAL_WIDTH_PX / etiqueta.width
            new_height = max(1, int(etiqueta.height * scale))
            etiqueta = etiqueta.resize((self.THERMAL_WIDTH_PX, new_height), Image.Resampling.LANCZOS)
        
        # APLICAR MISMA ROTACIÓN que generar_etiqueta_completa()
        # Rotar 90 grados para orientación vertical (portrait)
        etiqueta = etiqueta.rotate(90, expand=True, fillcolor=255)
        
        # Binarizar
        etiqueta = etiqueta.point(lambda x: 0 if x < threshold else 255, '1')
        pixels = etiqueta.load()
        width = etiqueta.width
        height = etiqueta.height
        bytes_per_line = (width + 7) // 8
        escpos = bytearray()
        escpos += b'\x1b\x40'      # ESC @
        escpos += b'\x1b\x61\x01'  # centrar
        for y in range(height):
            escpos += b'\x1d\x76\x30\x00'
            escpos += bytes([bytes_per_line & 0xFF, (bytes_per_line >> 8) & 0xFF])
            escpos += b'\x01\x00'
            for x in range(bytes_per_line):
                byte = 0
                for bit in range(8):
                    px = x * 8 + bit
                    if px < width:
                        if pixels[px, y] == 0:
                            byte |= (1 << (7 - bit))
                escpos.append(byte)
        escpos += b'\x1b\x64\x03'  # feed
        return bytes(escpos)
    
    def guardar_etiqueta(self, directorio=None):
        """
        Guarda la etiqueta como archivo PNG
        
        Args:
            directorio: Directorio donde guardar (default: media/barcodes/)
            
        Returns:
            str: Ruta del archivo guardado
        """
        if directorio is None:
            directorio = os.path.join(settings.MEDIA_ROOT, 'barcodes')
        
        # Crear directorio si no existe
        os.makedirs(directorio, exist_ok=True)
        
        # Generar nombre de archivo único
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"etiqueta_parte_{self.part.id}_{timestamp}.png"
        filepath = os.path.join(directorio, filename)
        
        # Generar y guardar etiqueta
        etiqueta_buffer = self.generar_etiqueta_completa()
        with open(filepath, 'wb') as f:
            f.write(etiqueta_buffer.getvalue())
        
        return filepath
    
    @staticmethod
    def generar_codigo_desde_parte(part):
        """
        Método estático para generar código rápidamente
        
        Args:
            part: Instancia del modelo Part
            
        Returns:
            str: Código de barras generado
        """
        generator = GeneradorEtiquetaPieza(part)
        return generator.codigo_barras


class GestorImpresoraTermica:
    """
    Gestor de impresión para GOOJPRT PT210
    Soporta impresión vía USB, Bluetooth y ESC/POS
    
    IMPORTANTE - Conexión Bluetooth:
    La impresora debe estar pareada con el SERVIDOR (Linux), no con el navegador.
    
    Opciones de uso:
    1. Bluetooth Server-Side: Emparejar PT210 con servidor Linux vía rfcomm
    2. Bluetooth Web API: Usar Web Bluetooth API desde navegador (solo Chrome/Edge)
    3. Network Printing: Compartir impresora via CUPS o raw TCP/IP
    """
    
    def __init__(self, tipo_conexion='usb', ruta_dispositivo=None, bt_address=None):
        """
        Inicializa el gestor de impresora
        
        Args:
            connection_type: 'usb', 'bluetooth', 'serial', 'network'
            device_path: Ruta del dispositivo (ej: /dev/usb/lp0 o /dev/rfcomm0)
            bt_address: Dirección MAC Bluetooth (ej: '00:11:22:33:44:55')
        """
        self.connection_type = tipo_conexion
        self.device_path = ruta_dispositivo or self._detectar_impresora()
        self.bt_address = bt_address
        self.printer = None
    
    def _detectar_impresora(self):
        """
        Detecta automáticamente la impresora GOOJPRT PT210
        
        Returns:
            str: Ruta del dispositivo detectado o None
        """
        # Rutas comunes para impresoras USB en Linux
        rutas_usb = [
            '/dev/usb/lp0',
            '/dev/usb/lp1',
            '/dev/ttyUSB0',
            '/dev/ttyUSB1',
        ]
        
        # Rutas comunes para Bluetooth (rfcomm)
        rutas_bluetooth = [
            '/dev/rfcomm0',
            '/dev/rfcomm1',
        ]
        
        # Intentar USB primero
        for ruta in rutas_usb:
            if os.path.exists(ruta):
                return ruta
        
        # Intentar Bluetooth
        for ruta in rutas_bluetooth:
            if os.path.exists(ruta):
                return ruta
        
        return None
    
    def conectar(self):
        """
        Establece conexión con la impresora
        Soporta: USB, Serial, Bluetooth (rfcomm), Network
        
        Returns:
            bool: True si conectó exitosamente
        """
        if self.connection_type == 'bluetooth' and not self.device_path and self.bt_address:
            # Intentar crear conexión rfcomm si solo se proporcionó MAC
            self.device_path = self._setup_bluetooth_rfcomm()
        
        if not self.device_path:
            raise Exception("No se detectó ninguna impresora térmica")
        
        try:
            # Intentar importar python-escpos
            from escpos.printer import Usb, Serial, Network
            
            if self.connection_type == 'usb':
                # Para GOOJPRT PT210, usar IDs comunes de vendor/product
                # Estos IDs pueden variar, verificar con 'lsusb'
                self.printer = Usb(0x0416, 0x5011, profile="POS-5890")
            
            elif self.connection_type in ('serial', 'bluetooth'):
                # Serial y Bluetooth (vía rfcomm) usan la misma interfaz
                self.printer = Serial(
                    devfile=self.device_path,
                    baudrate=9600,
                    bytesize=8,
                    parity='N',
                    stopbits=1,
                    timeout=1.0,
                    profile="POS-5890"
                )
            
            elif self.connection_type == 'network':
                # Impresión via red (IP del servidor de impresión)
                host = self.device_path  # En este caso device_path es la IP
                self.printer = Network(host, profile="POS-5890")
            
            else:
                raise Exception(f"Tipo de conexión '{self.connection_type}' no soportado")
            
            return True
        
        except ImportError:
            raise Exception("python-escpos no instalado. Ejecutar: pip install python-escpos")
        except Exception as e:
            raise Exception(f"Error conectando impresora: {str(e)}")
    
    def _setup_bluetooth_rfcomm(self):
        """
        Configura conexión Bluetooth usando rfcomm (Linux)
        
        Returns:
            str: Ruta del dispositivo rfcomm creado o None
        """
        if not self.bt_address:
            return None
        
        try:
            import subprocess
            
            # Intentar bind rfcomm0 a la dirección MAC
            # Requiere: sudo apt-get install bluez rfcomm
            cmd = ['rfcomm', 'bind', '/dev/rfcomm0', self.bt_address, '1']
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode == 0:
                return '/dev/rfcomm0'
            else:
                # Ya podría estar bindeado
                if os.path.exists('/dev/rfcomm0'):
                    return '/dev/rfcomm0'
                return None
        
        except Exception as e:
            print(f"Warning: No se pudo configurar rfcomm: {str(e)}")
            return None
    
    def imprimir_etiqueta(self, etiqueta_buffer):
        """
        Imprime etiqueta desde buffer de imagen
        
        Args:
            etiqueta_buffer: BytesIO con imagen PNG de la etiqueta
            
        Returns:
            bool: True si imprimió exitosamente
        """
        if not self.printer:
            self.conectar()
        
        try:
            # Abrir imagen desde buffer
            etiqueta_buffer.seek(0)
            imagen = Image.open(etiqueta_buffer)
            
            # Imprimir imagen
            self.printer.image(imagen)
            
            # Avanzar papel y cortar (si tiene autocorte)
            self.printer.text("\n\n")
            self.printer.cut()
            
            return True
        except Exception as e:
            raise Exception(f"Error imprimiendo etiqueta: {str(e)}")
    
    def imprimir_parte(self, part):
        """
        Genera e imprime etiqueta completa para una pieza
        
        Args:
            part: Instancia del modelo Part
            
        Returns:
            bool: True si imprimió exitosamente
        """
        # Generar etiqueta
        generator = GeneradorEtiquetaPieza(part)
        etiqueta_buffer = generator.generar_etiqueta_completa()
        
        # Imprimir
        return self.imprimir_etiqueta(etiqueta_buffer)
    
    def test_impresion(self):
        """
        Imprime una etiqueta de prueba
        
        Returns:
            bool: True si imprimió exitosamente
        """
        if not self.printer:
            self.conectar()
        
        try:
            self.printer.text("=" * 32 + "\n")
            self.printer.set(align='center', bold=True, height=2)
            self.printer.text("PRUEBA DE IMPRESORA\n")
            self.printer.set(align='center', bold=False, height=1)
            self.printer.text("GOOJPRT PT210\n")
            self.printer.text(f"Fecha: {datetime.now().strftime('%d/%m/%Y %H:%M')}\n")
            self.printer.text("=" * 32 + "\n")
            self.printer.text("\n\n")
            self.printer.cut()
            return True
        except Exception as e:
            raise Exception(f"Error en prueba de impresión: {str(e)}")
    
    def desconectar(self):
        """Cierra conexión con la impresora"""
        if self.printer:
            try:
                self.printer.close()
            except:
                pass
            self.printer = None
