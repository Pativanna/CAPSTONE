# parts/forms.py
from django import forms
from .models import Part, Auto, Workshop, ReportSchedule   
from django.contrib.auth import get_user_model

User = get_user_model()

class PartForm(forms.ModelForm):
    class Meta:
        model = Part
        fields = [
            'name', 'details', 'auto', 'workshop',
            'sold', 'state', 'max_value', 'min_value', 'image'
        ]
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'details': forms.Textarea(attrs={'class': 'form-control', 'rows': 3, 'placeholder': 'Ingresa todos los detalles, sin resumir'}),
            'auto': forms.Select(attrs={'class': 'form-control'}),
            'workshop': forms.Select(attrs={'class': 'form-control'}),
           'sold': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
            'state': forms.CheckboxInput(attrs={'class': 'form-check-input'}),
            'max_value': forms.NumberInput(attrs={'class': 'form-control', 'value': 0}),
            'min_value': forms.NumberInput(attrs={'class': 'form-control', 'value': 0}),
            'image': forms.ClearableFileInput(attrs={'class': 'form-control', 'accept': 'image/*', 'capture': 'environment'}),
        }

class AutoForm(forms.ModelForm):
    class Meta:
        model = Auto
        fields = ['brand_model', 'year', 'color', 'license_plate']
        widgets = {
            'brand_model': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: Kia Morning'}),
            'year': forms.NumberInput(attrs={'class': 'form-control', 'placeholder': 'Ej: 2024'}),
            'color': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: Rojo'}),
            'license_plate': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: ABC-123'}),
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