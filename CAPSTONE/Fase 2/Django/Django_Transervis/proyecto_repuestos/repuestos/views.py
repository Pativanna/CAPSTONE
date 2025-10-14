from django.urls import reverse_lazy
from django.views.generic import ListView, DetailView, CreateView, UpdateView, DeleteView
from .models import REPUESTO

class RepuestoListView(ListView):
    model = REPUESTO
    context_object_name = "repuestos"

class RepuestoDetailView(DetailView):
    model = REPUESTO

class RepuestoCreateView(CreateView):
    model = REPUESTO
    fields = [
        "nombre_repuesto", "precio", "fec_ingreso", "fec_venta", "notas",
        "id_estado", "id_modelo", "id_taller", "ultimo_precio", "id_posicion",
    ]
    success_url = reverse_lazy("repuesto-list")

class RepuestoUpdateView(UpdateView):
    model = REPUESTO
    fields = [
        "nombre_repuesto", "precio", "fec_ingreso", "fec_venta", "notas",
        "id_estado", "id_modelo", "id_taller", "ultimo_precio", "id_posicion",
    ]
    success_url = reverse_lazy("repuesto-list")

class RepuestoDeleteView(DeleteView):
    model = REPUESTO
    success_url = reverse_lazy("repuesto-list")
