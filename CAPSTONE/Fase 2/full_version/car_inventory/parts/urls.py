from django.urls import path
from . import views

urlpatterns = [
    path('parts/', views.part_list, name='part_list'),
    path('parts/add/', views.part_create, name='part_create'),
    path('parts/edit/<int:pk>/', views.part_edit, name='part_edit'),
    path('parts/delete/<int:pk>/', views.part_delete, name='part_delete'),
    path('upload/', views.upload_audio, name='upload_audio'),

    path('autos/', views.auto_list, name='auto_list'),
    path('autos/add/', views.auto_create, name='auto_create'),
    path('autos/edit/<int:pk>/', views.auto_edit, name='auto_edit'),
    path('autos/delete/<int:pk>/', views.auto_delete, name='auto_delete'),

    path('workshops/', views.workshop_list, name='workshop_list'),
    path('workshops/add/', views.workshop_create, name='workshop_create'),
    path('workshops/edit/<int:pk>/', views.workshop_edit, name='workshop_edit'),
    path('workshops/delete/<int:pk>/', views.workshop_delete, name='workshop_delete'),
]
