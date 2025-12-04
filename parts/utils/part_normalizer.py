import re
from difflib import get_close_matches
from functools import lru_cache

from django.db.models import Q

from parts.inventory_models import PiezaInventario
from parts.models import Part, SynonymGroup, SynonymTerm
from parts.vocabulario_automotriz import PIEZAS_AUTOMOTRICES, UBICACIONES


def _clean(text):
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text.strip())
    return text


@lru_cache(maxsize=1)
def get_piece_vocabulary():
    """
    Construye un conjunto de nombres de piezas combinando:
    - vocabulario manual
    - nombres normalizados/originales de PiezaInventario
    - catalog_name / name de Part
    """
    nombres = set()
    nombres.update(_clean(p).title() for p in PIEZAS_AUTOMOTRICES if p)

    inventario = PiezaInventario.objects.all().values_list(
        "nombre_normalizado", "nombre_original"
    )
    for normalizado, original in inventario:
        nombres.add(_clean(normalizado).title())
        nombres.add(_clean(original).title())

    parts = Part.objects.all().values_list("catalog_name", "name")
    for catalog, name in parts:
        nombres.add(_clean(catalog).title())
        nombres.add(_clean(name).title())

    synonym_categories = [SynonymGroup.Category.PART, SynonymGroup.Category.GENERIC]
    grupos = SynonymGroup.objects.filter(category__in=synonym_categories).values_list("name", flat=True)
    for nombre in grupos:
        nombres.add(_clean(nombre).title())
    terms = SynonymTerm.objects.filter(group__category__in=synonym_categories).values_list("term", flat=True)
    for term in terms:
        nombres.add(_clean(term).title())

    return sorted({n for n in nombres if n})


@lru_cache(maxsize=1)
def get_position_vocabulary():
    """
    Posiciones detectadas a partir de tablas + vocabulario manual.
    """
    posiciones = set(_clean(p).title() for p in UBICACIONES if p)
    posiciones.update(
        _clean(p).title()
        for p in PiezaInventario.objects.exclude(posicion="").values_list("posicion", flat=True)
    )
    posiciones.update(
        _clean(p).title()
        for p in Part.objects.exclude(position__isnull=True)
        .exclude(position__exact="")
        .values_list("position", flat=True)
    )
    return sorted({p for p in posiciones if p})


def _match_token(value, vocabulary, cutoff=0.75):
    """
    Retorna la mejor coincidencia para value dentro de vocabulary, o None.
    """
    if not value:
        return None
    cleaned = _clean(value).title()
    if not cleaned:
        return None
    matches = get_close_matches(cleaned, vocabulary, n=1, cutoff=cutoff)
    return matches[0] if matches else None


def normalize_piece_name(value):
    """
    Normaliza un nombre de pieza, devolviendo (normalizado, original, coincidencia).
    """
    vocab = get_piece_vocabulary()
    match = _match_token(value, vocab)
    return {
        "input": value or "",
        "normalized": match or _clean(value).title(),
        "matched": bool(match),
    }


def normalize_position(value):
    """
    Normaliza la posición utilizando tabla de ubicaciones.
    """
    vocab = get_position_vocabulary()
    raw = value or ""
    # Permite separar múltiples posiciones escritas con "/" "," "-" etc.
    parts = [
        token.strip()
        for token in re.split(r"[\\/|,&+-]+", raw)
        if token and token.strip()
    ]
    if not parts and raw:
        parts = [raw]

    normalized_parts = []
    matched_any = False
    for token in parts or [raw]:
        match = _match_token(token, vocab, cutoff=0.6)
        if match:
            normalized = match
            matched_any = True
        else:
            normalized = _clean(token).title()
        if normalized and normalized not in normalized_parts:
            normalized_parts.append(normalized)

    normalized_value = " / ".join(normalized_parts).strip()
    return {
        "input": raw,
        "normalized": normalized_value,
        "matched": matched_any,
    }


def refresh_caches():
    """
    Permite regenerar los caches (por ejemplo, después de una importación masiva).
    """
    get_piece_vocabulary.cache_clear()
    get_position_vocabulary.cache_clear()
