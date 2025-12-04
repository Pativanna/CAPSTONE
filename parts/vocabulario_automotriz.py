"""
Vocabulario especializado para reconocimiento de voz en el dominio automotriz.
Este vocabulario ayuda a Vosk a priorizar palabras técnicas del sector.
"""

# Términos de piezas automotrices - DICCIONARIO REAL DE LA BASE DE DATOS
PIEZAS_AUTOMOTRICES = [
    # A
    "aislapol", "airbag", "alerón", "alfombra", "alternador", "amortiguador",
    "amplificador", "antena", "apertura", "apoyabrazos", "asiento", "asientos",
    
    # B
    "bandeja", "barra", "base", "bcm", "bieleta", "bisagra", "bisel", "block",
    "bobina", "bocina", "bomba", "borne", "botón", "botonera", "brazo",
    
    # C
    "cajetín", "caja", "caliper", "canister", "cañería", "capó", "cardán",
    "cárter", "catalítico", "chapa", "cigüeñal", "cinta", "cinturón", "cofia",
    "columna", "comando", "compresor", "consola", "control", "cremallera",
    "cubre", "cuerpo", "culata", "cuna", "cortina",
    
    # D
    "depósito", "disco", "dtc", "dirección",
    
    # E
    "ecu", "eje", "electroventilador", "embrague", "encendedor", "encendido",
    "enganche", "equipaje", "escape", "espejo", "espiral", "estabilizadora",
    "estacionamiento", "espejos", "exterior",
    
    # F
    "filtro", "flujómetro", "foco", "freno", "frontal", "funda", "fusible",
    "fusilera", "frm",
    
    # G
    "gancho", "goma", "guardafango", "guantera",
    
    # H
    "hazard", "hidráulica", "horquilla",
    
    # I
    "inferior", "inyección", "intermitente", "interior",
    
    # J
    "juego",
    
    # K
    "kit",
    
    # L
    "letras", "levas", "llanta", "llave", "limpiaparabrisas", "líquido",
    "logo", "luz",
    
    # M
    "maleta", "manilla", "manguera", "mano", "maza", "mediana", "ménsula",
    "moldura", "módulo", "motor", "múltiple", "muñón",
    
    # N
    "neblinero", "neumático",
    
    # O
    "óptico", "oxígeno",
    
    # P
    "palanca", "palier", "pantalla", "parabrisas", "parachoque", "parasol",
    "parlante", "partida", "pastilla", "patente", "pedal", "pedalera",
    "pequeña", "piñón", "piola", "pistón", "polen", "porta", "portalón",
    "positivo", "protector", "puerta", "puerto",
    
    # R
    "radiador", "radio", "ramal", "refuerzo", "refrigerante", "rejilla",
    "repuesto", "resistencia", "retrovisor", "riel", "rodamiento", "rótula",
    "rueda",
    
    # S
    "seguridad", "sensor", "servofreno", "sinóptico", "sonda", "soporte",
    "superior", "sunroof", "suspensión",
    
    # T
    "tablero", "tapa", "tapabarro", "tapiz", "techo", "telecomando", "tensor",
    "tercera", "termostato", "torpedo", "trasero", "tren", "tubo", "turbo",
    
    # U
    "usb",
    
    # V
    "válvula", "varilla", "varillaje", "ventilación", "ventilador", "vidrio",
    "volante",
    
    # Z
    "zapata", "zócalo",
    
    # Términos compuestos comunes (palabras individuales)
    "aceite", "accesorios", "aceleración", "acondicionado", "admisión",
    "agua", "aire", "airbag", "alzavidrios", "arranque", "auxiliar",
    "batería", "bencina", "calefacción", "cambios", "cigarros", "cinturones",
    "combustible", "completo", "confort", "contacto", "correa", "grande",
]

# Posiciones y ubicaciones
UBICACIONES = [
    "delantero", "trasero", "delantera", "trasera",
    "izquierdo", "derecho", "izquierda", "derecha",
    "superior", "inferior", "central",
    "interno", "externo", "lateral",
]

# Estados y condiciones
ESTADOS = [
    "nuevo", "usado", "original", "alternativo",
    "bueno", "malo", "regular", "excelente",
    "rayado", "abollado", "roto", "dañado",
    "completo", "incompleto", "limpio", "sucio",
    "pintado", "cromado", "plástico", "metal",
]

# Marcas comunes
MARCAS = [
    "toyota", "ford", "chevrolet", "volkswagen", "nissan",
    "honda", "hyundai", "kia", "mazda", "peugeot",
    "renault", "fiat", "citroën", "suzuki", "mitsubishi",
]

# Modelos genéricos
MODELOS = [
    "corolla", "hilux", "etios", "yaris",
    "fiesta", "focus", "ranger", "ecosport",
    "onix", "cruze", "s10", "montana",
    "gol", "polo", "saveiro", "amarok",
]

# Colores
COLORES = [
    "blanco", "negro", "gris", "plata", "plateado",
    "rojo", "azul", "verde", "amarillo", "naranja",
    "beige", "marrón", "dorado", "bordó",
]

# Números y cantidades comunes
NUMEROS = [
    "uno", "dos", "tres", "cuatro", "cinco",
    "seis", "siete", "ocho", "nueve", "diez",
    "veinte", "treinta", "cuarenta", "cincuenta",
    "cien", "mil", "millón",
]

# Preposiciones y conectores comunes en descripciones
CONECTORES = [
    "del", "de", "la", "el", "los", "las",
    "con", "sin", "para", "por", "en",
    "tiene", "es", "está", "son", "están",
    "buen", "mal", "mejor", "peor",
]

# Comandos del sistema
COMANDOS = [
    "iniciar", "proceso", "finalizar", "terminar", "detener",
    "guardar", "pieza", "listo", "confirmar", "cancelar",
    # Palabras del comando "confirmar datos"
    "datos", "correcto", "aceptar", "acepto", "confirmado",
    "confirma", "guardado", "guarda", "todo", "sí", "si",
    "ok", "aceptado",
]

# Términos monetarios
MONETARIOS = [
    "pesos", "peso", "dólares", "dólar",
    "vale", "valor", "precio", "cuesta", "costa",
]


def obtener_vocabulario_completo():
    """
    Retorna el vocabulario completo combinando todas las categorías.
    """
    vocabulario = set()
    
    # Agregar todas las listas
    vocabulario.update(PIEZAS_AUTOMOTRICES)
    vocabulario.update(UBICACIONES)
    vocabulario.update(ESTADOS)
    vocabulario.update(MARCAS)
    vocabulario.update(MODELOS)
    vocabulario.update(COLORES)
    vocabulario.update(NUMEROS)
    vocabulario.update(CONECTORES)
    vocabulario.update(COMANDOS)
    vocabulario.update(MONETARIOS)
    
    return sorted(list(vocabulario))


def obtener_vocabulario_json():
    """
    Retorna el vocabulario en formato JSON para Vosk.
    """
    import json
    return json.dumps(obtener_vocabulario_completo(), ensure_ascii=False)


def obtener_vocabulario_extendido():
    """
    Retorna vocabulario extendido con variaciones comunes.
    Útil para reconocimiento más flexible.
    """
    base = obtener_vocabulario_completo()
    extendido = set(base)
    
    # Agregar plurales básicos
    for palabra in base:
        if not palabra.endswith('s'):
            extendido.add(palabra + 's')
    
    return sorted(list(extendido))


# Información del vocabulario
def info_vocabulario():
    """
    Retorna estadísticas del vocabulario cargado.
    """
    vocab = obtener_vocabulario_completo()
    return {
        'total_palabras': len(vocab),
        'piezas': len(PIEZAS_AUTOMOTRICES),
        'ubicaciones': len(UBICACIONES),
        'estados': len(ESTADOS),
        'marcas': len(MARCAS),
        'modelos': len(MODELOS),
        'colores': len(COLORES),
    }
