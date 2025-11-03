import os
import sys
# ensure project path is importable
sys.path.insert(0, r"C:\Users\seban\Documents\GitHub\CAPSTONE\CAPSTONE\Fase 2\full_version\car_inventory")
os.environ.setdefault('DJANGO_SETTINGS_MODULE','car_inventory.settings')
import django
django.setup()
from django.test import Client
c = Client()
r = c.get('/parts/')
print('STATUS', r.status_code)
print('LENGTH', len(r.content))
text = r.content.decode(errors='replace')
print(text[:4000])
