"""Custom DRF permissions aligned with UserProfile capabilities."""
from rest_framework.permissions import BasePermission, SAFE_METHODS


def _get_profile(user):
    return getattr(user, 'profile', None)


class PartInventoryPermission(BasePermission):
    """Maps DRF actions to role-based capabilities."""

    message = 'No tienes privilegios suficientes para esta acción.'

    def has_permission(self, request, view):
        user = request.user
        if not user or not user.is_authenticated:
            return False

        action = getattr(view, 'action', None)
        perfil = _get_profile(user)

        if request.method in SAFE_METHODS or action in {'stats', 'low_stock', 'top_selling'}:
            return True  # cualquier usuario autenticado puede consultar

        if action == 'create':
            return bool(perfil and perfil.can_add_parts()) or user.is_superuser

        if action in {'update', 'partial_update'}:
            return bool(perfil and perfil.can_edit_parts()) or user.is_superuser

        if action == 'destroy':
            return bool(perfil and perfil.can_delete_parts()) or user.is_superuser

        if action in {'mark_sold', 'mark_available'}:
            return bool(perfil and perfil.can_sell_parts()) or user.is_superuser

        return True

    def has_object_permission(self, request, view, obj):
        # Reuse global permission logic for object-level checks
        return self.has_permission(request, view)
