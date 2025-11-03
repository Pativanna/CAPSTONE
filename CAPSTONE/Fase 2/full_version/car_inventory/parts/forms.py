# parts/forms.py
from django import forms
from .models import Part, Auto, Workshop    

class PartForm(forms.ModelForm):
    class Meta:
        model = Part
        fields = [
            'name', 'details', 'auto', 'workshop',
            'sold', 'state', 'max_value', 'min_value'
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
        }

class AutoForm(forms.ModelForm):
    class Meta:
        model = Auto
        fields = ['brand_model', 'year', 'color']
        widgets = {
            'brand_model': forms.TextInput(attrs={'class': 'form-control', 'placeholder': 'Ej: Toyota Yaris'}),
            'year': forms.NumberInput(attrs={'class': 'form-control', 'placeholder': 'Ej: 2010'}),
            'color': forms.TextInput(attrs={'class': 'form-control'}),
        }

class WorkshopForm(forms.ModelForm):
    class Meta:
        model = Workshop
        fields = ['name', 'direction']
        widgets = {
            'name': forms.TextInput(attrs={'class': 'form-control'}),
            'direction': forms.TextInput(attrs={'class': 'form-control'}),
        }