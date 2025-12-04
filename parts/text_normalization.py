"""
Domain-specific transcript normalization for Spanish automotive parts.
Reduces ASR artifacts before sending to LLM and improves consistency.
"""
from __future__ import annotations

import re
from typing import List


_REPLACEMENTS = [
    # Common fused words (ensure space)
    (re.compile(r"(precio)([a-záéíóúñ])", re.IGNORECASE), r"\1 \2"),
    (re.compile(r"\b(el|del)([a-záéíóúñ])", re.IGNORECASE), r"\1 \2"),

    # Frequent ASR artifacts
    (re.compile(r"\bsparachoque\b", re.IGNORECASE), "parachoque"),
    (re.compile(r"\bpara\s*choque(s)?\b", re.IGNORECASE), "parachoque"),
    (re.compile(r"\bparachoques\b", re.IGNORECASE), "parachoque"),
    
    # Correcciones comunes de reconocimiento
    (re.compile(r"\bhuevo\b", re.IGNORECASE), "nuevo"),
    (re.compile(r"\bhueva\b", re.IGNORECASE), "nueva"),
    (re.compile(r"\bhuevos\b", re.IGNORECASE), "nuevos"),
    (re.compile(r"\bhuevas\b", re.IGNORECASE), "nuevas"),
    (re.compile(r"\bcerezo\b", re.IGNORECASE), "pesos"),
    (re.compile(r"\bcerezos\b", re.IGNORECASE), "pesos"),
    (re.compile(r"\baragua\b", re.IGNORECASE), "gran"),

    # Positions and directions
    (re.compile(r"\bdel\s*antero\b", re.IGNORECASE), "delantero"),
    (re.compile(r"\bdel\s*antera\b", re.IGNORECASE), "delantera"),
    (re.compile(r"\bantero\b", re.IGNORECASE), "delantero"),
    (re.compile(r"\bantera\b", re.IGNORECASE), "delantera"),
    (re.compile(r"\bdantera?\b", re.IGNORECASE), "delantera"),
    (re.compile(r"\bdantero\b", re.IGNORECASE), "delantero"),
    (re.compile(r"\btracero\b", re.IGNORECASE), "trasero"),
    (re.compile(r"\btracera\b", re.IGNORECASE), "trasera"),
    (re.compile(r"\bdel\s+delantero\b", re.IGNORECASE), "delantero"),
    (re.compile(r"\bdel\s+delantera\b", re.IGNORECASE), "delantera"),

    # Parts canonicalization (light-touch)
    (re.compile(r"\bcapo\b", re.IGNORECASE), "capó"),
    (re.compile(r"\bparabri[a-z]*\b", re.IGNORECASE), "parabrisas"),
    (re.compile(r"\bfoco\s+del\s+antero\b", re.IGNORECASE), "foco delantero"),
    (re.compile(r"\bfaro\s+del\s+antero\b", re.IGNORECASE), "faro delantero"),
]


def _remove_immediate_repeated_segments(text: str, *, min_len: int = 2, max_len: int = 6) -> str:
    """Remove immediate repeated token segments to avoid A B C A B C patterns.

    Works on-token; conservative to avoid altering semantics.
    """
    tokens: List[str] = text.split()
    i = 0
    out: List[str] = []
    n = len(tokens)
    while i < n:
        # Try longest first
        removed = False
        for L in range(min(max_len, (n - i) // 2), min_len - 1, -1):
            if i + 2 * L <= n and tokens[i:i+L] == tokens[i+L:i+2*L]:
                # Keep only one occurrence
                out.extend(tokens[i:i+L])
                i += 2 * L
                removed = True
                break
        if not removed:
            out.append(tokens[i])
            i += 1
    return " ".join(out)


# Palabras de relleno comunes que suelen intercalarse cuando el hablante duda o corrige
_FILLER_WORDS = (
    "está|esta|del|de|la|el|vehículo|y|en|muy|buen|bueno|estado|que|tiene|tienen|"
    "una|parte|exceptuando|todo|lo|demás|todas|sus|piezas|con|al|un|por|del|del|"
    ",|\."
)

_REPEATED_WITH_FILLERS_RE = re.compile(
    rf"\b([a-záéíóúñ]{{3,}}(?:\s+[a-záéíóúñ]{{3,}}){{0,3}})\b(?:\s+(?:{_FILLER_WORDS})){{0,6}}\s+\1\b",
    re.IGNORECASE
)


def _remove_repeated_phrases_with_fillers(text: str, max_passes: int = 4) -> str:
    """Colapsa repeticiones de frases cortas separadas por palabras de relleno.

    Ej: "parachoque delantero está ... parachoque delantero" -> "parachoque delantero ..."
    Conservador: limita frase a 1-4 palabras (>=3 letras cada una) y tolera hasta 6 fillers.
    """
    if not text:
        return text
    out = text
    for _ in range(max_passes):
        new = _REPEATED_WITH_FILLERS_RE.sub(r"\1", out)
        if new == out:
            break
        out = new
    return out


def _remove_trailing_repeat_of_head(text: str) -> str:
    """Si la frase final repite el bigrama/trigrama inicial, eliminar la repetición final.
    Útil cuando el hablante reitera el sujeto al terminar la frase.
    """
    toks = text.split()
    if len(toks) < 6:
        return text
    head5 = " ".join(toks[:5]).lower()
    tail5 = " ".join(toks[-5:]).lower()
    head4 = " ".join(toks[:4]).lower()
    tail4 = " ".join(toks[-4:]).lower()
    head3 = " ".join(toks[:3]).lower()
    tail3 = " ".join(toks[-3:]).lower()
    head2 = " ".join(toks[:2]).lower()
    tail2 = " ".join(toks[-2:]).lower()
    if tail5 == head5:
        return " ".join(toks[:-5]).strip()
    if tail4 == head4:
        return " ".join(toks[:-4]).strip()
    if tail3 == head3:
        return " ".join(toks[:-3]).strip()
    if tail2 == head2:
        return " ".join(toks[:-2]).strip()
    return text


def normalize_transcript(text: str) -> str:
    if not text:
        return text
    # Collapse whitespace once at start
    text = " ".join(text.split()).strip()

    # Apply regex replacements
    for pat, repl in _REPLACEMENTS:
        text = pat.sub(repl, text)

    # Remove immediate repeated segments (handles repeated phrases)
    text = _remove_immediate_repeated_segments(text)

    # Remove repeated phrases even if there are filler words in between
    text = _remove_repeated_phrases_with_fillers(text)

    # Final whitespace collapse
    text = " ".join(text.split()).strip()
    # Remove trailing repeat of subject/head if present
    text = _remove_trailing_repeat_of_head(text)
    return text


def limpiar_transcripcion_vosk_robusta(text: str) -> str:
    """
    Limpieza ROBUSTA para transcripciones de Vosk que vienen con resultados parciales acumulativos.
    
    Problema: Vosk envía: "la el iniciar iniciar el una la pieza es una rueda la pieza es una rueda delantera..."
    Causa: Resultados parciales que se acumulan y repiten
    
    Solución en múltiples pasos:
    1. Eliminar comandos de voz explícitos
    2. Eliminar palabras de relleno/duda excesivas
    3. Eliminar repeticiones inmediatas de tokens
    4. Identificar la frase más larga y completa (última versión del habla)
    5. Eliminar prefijos repetidos que son versiones parciales
    6. Normalización final
    
    Ejemplo:
    Input: "la el iniciar iniciar el una la pieza es una rueda la pieza es una rueda delantera la pieza es una rueda delantera derecha"
    Output: "la pieza es una rueda delantera derecha"
    """
    if not text:
        return ""
    
    # Paso 1: Eliminar comandos de voz explícitos
    comandos = [
        'iniciar ingreso',
        'detener ingreso',
        'cancelar ingreso',
        'confirmar ingreso',
        'repetir ingreso'
    ]
    for cmd in comandos:
        text = re.sub(rf'\b{re.escape(cmd)}\b', ' ', text, flags=re.IGNORECASE)
    
    # Paso 2: Colapsar espacios múltiples
    text = ' '.join(text.split())
    
    # Paso 3: Identificar patrón de repetición incremental
    # Vosk típicamente produce: "A B C ... A B C D ... A B C D E"
    # Queremos extraer solo: "A B C D E" (la versión final más larga)
    
    tokens = text.split()
    if len(tokens) < 3:
        return text.strip()
    
    # Paso 4: Buscar el patrón de frase que se repite expandiéndose
    # Estrategia: dividir en segmentos potenciales y quedarnos con el más largo que no sea repetición
    
    # Detectar si hay un patrón donde la misma secuencia inicial aparece múltiples veces
    # Ejemplo: "la pieza es una rueda" aparece 3 veces al inicio de sub-frases
    
    # Buscar la frase más larga que aparece al final (es la versión completa)
    # Método: buscar desde el final hacia atrás la secuencia más larga sin repetición interna
    
    # Paso 4a: Eliminar repeticiones de subsecuencias desde el inicio
    # Si "A B C" aparece seguido de "A B C D", eliminar la primera ocurrencia
    cleaned_tokens = []
    i = 0
    n = len(tokens)
    
    while i < n:
        # Buscar si hay una versión más larga de esta subsecuencia adelante
        mejor_match_len = 0
        mejor_match_pos = i
        
        # Buscar hacia adelante secuencias que empiecen igual
        for j in range(i + 1, n):
            # Comparar cuántos tokens coinciden desde i y desde j
            match_len = 0
            max_compare = min(j - i, n - j)
            for k in range(max_compare):
                if tokens[i + k].lower() == tokens[j + k].lower():
                    match_len += 1
                else:
                    break
            
            # Si encontramos una coincidencia de al menos 3 tokens, y la versión de j es más larga
            if match_len >= 3:
                # Verificar si la secuencia en j continúa más allá
                if j + match_len < n:
                    # Hay más contenido después, esta es una versión más completa
                    mejor_match_len = match_len
                    mejor_match_pos = j
        
        # Si encontramos una versión más larga adelante, saltar la actual
        if mejor_match_len >= 3:
            i += mejor_match_len
        else:
            cleaned_tokens.append(tokens[i])
            i += 1
    
    text = ' '.join(cleaned_tokens)
    
    # Paso 5: Eliminar repeticiones de palabras individuales consecutivas
    # "la la el el" -> "la el"
    text = re.sub(r'\b(\w+)(\s+\1)+\b', r'\1', text, flags=re.IGNORECASE)
    
    # Paso 6: Eliminar palabras de relleno excesivas al inicio
    palabras_relleno_inicio = ['la', 'el', 'una', 'un', 'de', 'del']
    tokens = text.split()
    while len(tokens) > 0 and tokens[0].lower() in palabras_relleno_inicio:
        # Solo eliminar si hay más de 2 palabras de relleno seguidas al inicio
        if len(tokens) > 1 and tokens[1].lower() in palabras_relleno_inicio:
            tokens.pop(0)
        else:
            break
    
    text = ' '.join(tokens)
    
    # Paso 7: Aplicar normalización estándar
    text = normalize_transcript(text)
    
    # Paso 8: Limpieza final de artefactos comunes
    text = re.sub(r'\s+', ' ', text)  # Espacios múltiples
    text = re.sub(r'^\s*[,;.]\s*', '', text)  # Puntuación al inicio
    text = text.strip()
    
    return text
