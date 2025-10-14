from django.urls import path
from .views import RepuestoCreateView, RepuestoDeleteView, RepuestoDetailView, RepuestoListView, RepuestoUpdateView

urlpatterns = [
    path("repuestos/", RepuestoListView.as_view(), name="repuesto-list"),
    path("repuestos/nuevo/", RepuestoCreateView.as_view(), name="repuesto-create"),
    path("repuestos/<int:pk>/", RepuestoDetailView.as_view(), name="repuesto-detail"),
    path("repuestos/<int:pk>/editar/", RepuestoUpdateView.as_view(), name="repuesto-update"),
    path("repuestos/<int:pk>/eliminar/", RepuestoDeleteView.as_view(), name="repuesto-delete"),
]