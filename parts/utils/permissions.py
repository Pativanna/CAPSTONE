"""Permission helpers shared across views."""
from __future__ import annotations

from django.core.exceptions import PermissionDenied


def has_voice_ingest_permission(user) -> bool:
    """Return True when the given user can use the hands-free ingestion stack."""
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    if getattr(user, 'is_superuser', False):
        return True
    profile = getattr(user, 'profile', None)
    if profile and hasattr(profile, 'can_add_parts') and callable(profile.can_add_parts):
        try:
            return bool(profile.can_add_parts())
        except Exception:
            return False
    return getattr(user, 'is_staff', False)


def ensure_voice_ingest_permission(user):
    """Raise PermissionDenied if the authenticated user cannot ingest parts via voice."""
    if not has_voice_ingest_permission(user):
        raise PermissionDenied('No tienes permiso para usar el modo manos libres.')

