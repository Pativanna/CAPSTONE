# parts/forms.py
from django import forms
from .models import Part, Auto, Workshop, ReportSchedule, SynonymGroup, SynonymTerm   
from django.contrib.auth import get_user_model

User = get_user_model()

class PartForm(forms.ModelForm):
    class Meta:
        model = Part
        fields = [
            'name', 'catalog_name', 'position', 'details', 'auto', 'workshop',
            'sold', 'state', 'max_value', 'min_value', 'image'
        ]
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'catalog_name': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: Parachoque delantero'}),
            'position': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: Izquierda, RH, Delantera'}),
            'details': forms.Textarea(attrs={'class': 'form-control', 'rows': 3, 'placeholder': 'Ingresa todos los detalles, sin resumir'}),
            'auto': forms.Select(attrs={'class': 'form-control'}),
            'workshop': forms.Select(attrs={'class': 'form-control'}),
           'sold': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
            'state': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
            'max_value': forms.NumberInput(attrs={'class': 'form-control', 'value': 0}),
            'min_value': forms.NumberInput(attrs={'class': 'form-control', 'value': 0}),
            'image': forms.ClearableFileInput(attrs={'class': 'form-control', 'accept': 'image/*', 'capture': 'environment'}),
        }

    def clean(self):
        cleaned = super().clean()
        for field in ('name', 'catalog_name', 'position'):
            value = cleaned.get(field)
            if value:
                cleaned[field] = value.strip().upper()
        return cleaned

class AutoForm(forms.ModelForm):
    class Meta:
        model = Auto
        fields = ['brand_model', 'year', 'color', 'license_plate', 'notes']
        widgets = {
            'brand_model': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: Kia Morning'}),
            'year': forms.NumberInput(attrs={'class': 'form-control', 'placeholder': 'Ej: 2024'}),
            'color': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: Rojo'}),
            'license_plate': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: ABC-123'}),
            'notes': forms.Textarea(attrs={'class': 'form-control', 'rows': 3, 'placeholder': 'Notas internas, mantenimiento, contactabilidad...'}),
        }

class WorkshopForm(forms.ModelForm):
    class Meta:
        model = Workshop
        fields = ['name', 'direction']
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'direction': forms.TextInput(attrs={'class': 'form-control'}),
        }


class ReportScheduleForm(forms.ModelForm):
    recipients = forms.ModelMultipleChoiceField(
        queryset=User.objects.all(),
        widget=forms.SelectMultiple(attrs={'class': 'form-control'}),
        required=True
    )

    class Meta:
        model = ReportSchedule
        fields = ['name', 'frequency', 'recipients']
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'frequency': forms.Select(attrs={'class': 'form-control'}),
        }


class SynonymGroupForm(forms.ModelForm):
    class Meta:
        model = SynonymGroup
        fields = ['name', 'category', 'description']
        widgets = {
            'name': forms.TextInput(attrs={
                'class': 'form-control',
                'placeholder': 'Ej: Óptico',
                'autocomplete': 'off'
            }),
            'category': forms.Select(attrs={'class': 'form-select'}),
            'description': forms.Textarea(attrs={
                'class': 'form-control',
                'rows': 2,
                'placeholder': 'Notas opcionales sobre este grupo'
            }),
        }


class SynonymTermForm(forms.ModelForm):
    class Meta:
        model = SynonymTerm
        fields = ['group', 'term', 'priority', 'locale']
        widgets = {
            'group': forms.Select(attrs={'class': 'form-select'}),
            'term': forms.TextInput(attrs={
                'class': 'form-control',
                'placeholder': 'Nueva variante (ej: foco)'
            }),
            'priority': forms.NumberInput(attrs={
                'class': 'form-control',
                'min': 0,
                'step': 1
            }),
            'locale': forms.TextInput(attrs={
                'class': 'form-control',
                'placeholder': 'CL, MX, etc. (opcional)'
            }),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields['group'].queryset = SynonymGroup.objects.order_by('name')
        self.fields['priority'].initial = 0
