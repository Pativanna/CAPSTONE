import io
import json
from unittest.mock import patch, Mock
from django.test import TestCase, Client, override_settings
import tempfile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.core import mail
from parts.models import Workshop, Auto, Part, ReportSchedule


class BaseAuthTest(TestCase):
	def setUp(self):
		User = get_user_model()
		# Admin user (has access to reports)
		self.admin = User.objects.create_user(
			username="admin", password="pass", is_superuser=True, is_staff=True, email="admin@example.com"
		)
		# Normal user
		self.user = User.objects.create_user(
			username="user", password="pass", email="user@example.com"
		)
		# Minimal data
		self.ws = Workshop.objects.create(name="Central", direction="Calle 123")
		self.auto = Auto.objects.create(brand_model="Kia Morning", year=2024, color="rojo")
		self.part = Part.objects.create(
			name="Parachoques delantero",
			details="impecable",
			auto=self.auto,
			workshop=self.ws,
			max_value=0,
			min_value=0,
		)


@override_settings(STORAGES={
	"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
	"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class NavigationPagesTest(BaseAuthTest):
	def test_nav_pages_authenticated(self):
		c = Client()
		self.assertTrue(c.login(username="admin", password="pass"))
		pages = [
			reverse("part_list"),
			reverse("auto_list"),
			reverse("workshop_list"),
			reverse("dashboard"),
			reverse("report_page"),
			reverse("report_preview"),
			reverse("part_label", args=[self.part.id]),
			reverse("websocket_test"),
		]
		for url in pages:
			r = c.get(url)
			self.assertEqual(r.status_code, 200, f"GET {url} should be 200")

	def test_base_template_switches_present(self):
		c = Client()
		self.assertTrue(c.login(username="admin", password="pass"))
		r = c.get(reverse("part_list"))
		html = r.content.decode("utf-8")
		self.assertIn('id="ai-model-switch"', html)
		self.assertIn('id="beep-switch"', html)


@override_settings(STORAGES={
	"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
	"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class ReportsAccessTest(BaseAuthTest):
	def test_reports_access_denied_for_non_admin(self):
		c = Client()
		self.assertTrue(c.login(username="user", password="pass"))
		r1 = c.get(reverse("report_page"))
		self.assertEqual(r1.status_code, 403)
		r2 = c.get(reverse("report_preview"))
		self.assertEqual(r2.status_code, 403)

	def test_report_preview_pdf_content(self):
		c = Client()
		self.assertTrue(c.login(username="admin", password="pass"))
		r = c.get(reverse("report_preview") + "?frequency=weekly")
		self.assertEqual(r.status_code, 200)
		self.assertEqual(r["Content-Type"], "application/pdf")

	@override_settings(
		EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend',
		DEFAULT_FROM_EMAIL='noreply@example.com',
		STORAGES={
			"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
			"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
		},
		MEDIA_ROOT=tempfile.gettempdir(),
	)
	def test_report_send_now_creates_schedule_log_and_sends_email(self):
		c = Client()
		self.assertTrue(c.login(username="admin", password="pass"))
		# include at least one recipient (normal user has email)
		data = {
			"name": "Semanal",
			"frequency": "weekly",
			"recipients": [str(self.user.id)],
			"send_now": "1",
		}
		r = c.post(reverse("report_page"), data)
		self.assertEqual(r.status_code, 200)
		# schedule created
		self.assertTrue(ReportSchedule.objects.filter(name="Semanal").exists())
		# email sent
		self.assertGreaterEqual(len(mail.outbox), 1)
		self.assertIn("InventoryEye", mail.outbox[0].subject)
		# attachment present
		self.assertGreaterEqual(len(mail.outbox[0].attachments), 1)


@override_settings(STORAGES={
	"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
	"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class AdminVisibilityTest(BaseAuthTest):
	def test_admin_can_view_logs_and_users(self):
		c = Client()
		self.assertTrue(c.login(username="admin", password="pass"))
		self.assertEqual(c.get(reverse("parts:logs_page")).status_code, 200)
		self.assertEqual(c.get(reverse("parts:user_list")).status_code, 200)
		self.assertEqual(c.get(reverse("parts:part_publish_root")).status_code, 302)
		self.assertEqual(c.get(reverse("parts:part_publish", args=[self.part.id])).status_code, 200)

	def test_regular_user_blocked_from_logs_and_users(self):
		c = Client()
		self.assertTrue(c.login(username="user", password="pass"))
		self.assertEqual(c.get(reverse("parts:logs_page")).status_code, 403)
		api_resp = c.get(reverse("parts:logs_api"))
		self.assertEqual(api_resp.status_code, 403)
		self.assertEqual(api_resp.json().get("error"), "Solo administrador")
		self.assertEqual(c.get(reverse("parts:user_list")).status_code, 403)
		self.assertEqual(c.get(reverse("parts:part_publish", args=[self.part.id])).status_code, 403)


@override_settings(STORAGES={
	"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
	"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class PartImageUploadTest(BaseAuthTest):
	@override_settings(MEDIA_ROOT=tempfile.gettempdir())
	def test_part_create_with_image(self):
		c = Client()
		self.assertTrue(c.login(username="admin", password="pass"))
		# create a tiny in-memory PNG
		from PIL import Image
		img_io = io.BytesIO()
		Image.new("RGB", (10, 10), color=(255, 0, 0)).save(img_io, format="PNG")
		img_io.seek(0)
		image_file = SimpleUploadedFile("test.png", img_io.getvalue(), content_type="image/png")

		data = {
			"name": "Puerta delantera izquierda",
			"details": "con rayones",
			"auto": str(self.auto.id),
			"workshop": str(self.ws.id),
			"sold": "",
			"state": "on",
			"max_value": "0",
			"min_value": "0",
		}
		r = c.post(reverse("part_create"), data | {"image": image_file})
		# Create view redirects to list on success
		self.assertIn(r.status_code, (302, 303))


@override_settings(STORAGES={
	"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
	"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class LabelAndWebsocketTest(BaseAuthTest):
	def test_part_label_page(self):
		c = Client()
		self.assertTrue(c.login(username="admin", password="pass"))
		r = c.get(reverse("part_label", args=[self.part.id]))
		self.assertEqual(r.status_code, 200)
		html = r.content.decode("utf-8")
		# Basic scripts present
		self.assertIn("JsBarcode", html)
		self.assertIn("QRCode", html)

	def test_websocket_test_page(self):
		c = Client()
		self.assertTrue(c.login(username="admin", password="pass"))
		r = c.get(reverse("websocket_test"))
		self.assertEqual(r.status_code, 200)


@override_settings(STORAGES={
	"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
	"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class ExtractFromTranscriptLocalTest(BaseAuthTest):
	@patch("parts.vosk_views.requests.post")
	def test_extract_local_with_mocked_ollama(self, mock_post):
		# Mock Ollama API response
		mock_resp = Mock()
		mock_resp.status_code = 200
		mock_resp.json.return_value = {
			"response": '{"parte":"parachoques delantero","valor":"20000","min_value":"","detalles":"en buen estado"}'
		}
		mock_post.return_value = mock_resp

		c = Client()
		# Not login required for this endpoint (it's CSRF-exempt and open) – keep as is
		payload = {
			"transcript": "parachoques delantero en buen estado precio veinte mil kia morning rojo",
			"use_cloud": False
		}
		r = c.post(reverse("extract_from_transcript"), data=json.dumps(payload), content_type="application/json")
		self.assertEqual(r.status_code, 200)
		data = r.json()
		self.assertTrue(data.get("success"))
		fields = data.get("fields", {})
		for key in ["parte", "valor", "min_value", "detalles"]:
			self.assertIn(key, fields)


@override_settings(STORAGES={
	"default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
	"staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
})
class EntrenamientoVoskTest(BaseAuthTest):
	def test_entrenamiento_requiere_autenticacion(self):
		c = Client()
		respuesta = c.post(reverse("registrar_muestra_entrenamiento"), data={"comando": "iniciar_proceso"})
		self.assertEqual(respuesta.status_code, 401)

	def test_estado_entrenamiento_requiere_autenticacion(self):
		c = Client()
		respuesta = c.get(reverse("estado_entrenamiento_usuario"))
		self.assertEqual(respuesta.status_code, 401)

