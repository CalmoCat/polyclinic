"""Smoke and regression tests for the clinic API (stdlib unittest)."""
import datetime as dt
import os
import sqlite3
import tempfile
import unittest

import app as clinic


class ClinicApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="polyclinic-test-")
        self.db_path = os.path.join(self.temp_dir.name, "clinic-test.db")
        self.previous_config = {
            "DATABASE": clinic.app.config["DATABASE"],
            "ADMIN_PASSWORD": clinic.app.config["ADMIN_PASSWORD"],
            "SECRET_KEY": clinic.app.config["SECRET_KEY"],
            "TESTING": clinic.app.config.get("TESTING", False),
        }
        clinic.app.config.update(
            DATABASE=self.db_path,
            ADMIN_PASSWORD="test-only-admin-password",
            SECRET_KEY="test-only-session-secret",
            TESTING=True,
        )
        clinic._initialized_databases.discard(os.path.abspath(self.db_path))
        self.client = clinic.app.test_client()
        self.csrf = None

    def tearDown(self):
        clinic._initialized_databases.discard(os.path.abspath(self.db_path))
        clinic.app.config.update(self.previous_config)
        self.temp_dir.cleanup()

    def login(self):
        response = self.client.post(
            "/api/admin/login", json={"password": "test-only-admin-password"}
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        self.csrf = response.get_json()["csrf_token"]

    def admin_request(self, method, path, **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        if self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        return self.client.open(path, method=method, headers=headers, **kwargs)

    def test_static_page_and_public_directory_endpoints(self):
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("Панель администратора".encode(), page.data)
        page.close()

        doctors = self.client.get("/api/doctors")
        patients = self.client.get("/api/patients")
        self.assertEqual(doctors.status_code, 200)
        self.assertEqual(patients.status_code, 200)
        self.assertEqual(len(doctors.get_json()), 6)
        self.assertEqual(len(patients.get_json()), 6)

        schedule = self.client.get("/api/schedule")
        self.assertEqual(schedule.status_code, 200)
        body = schedule.get_json()
        self.assertEqual(len(body["days"]), 7)
        self.assertEqual(len(body["slots"]), 9)
        self.assertIn("appointments", body)

        date = (dt.date.today() + dt.timedelta(days=14)).isoformat()
        availability = self.client.get(f"/api/availability?doctor_id=1&date={date}")
        self.assertEqual(availability.status_code, 200)
        self.assertEqual(len(availability.get_json()["available"]), 9)

    def test_admin_doctor_crud_is_protected_and_archives_history_safely(self):
        blocked = self.client.post(
            "/api/doctors", json={"full_name": "Тестовый Врач", "specialization": "Терапевт"}
        )
        self.assertEqual(blocked.status_code, 401)

        self.login()
        created = self.admin_request(
            "POST", "/api/doctors",
            json={"full_name": "  Тестовый Врач  ", "specialization": "Терапевт"},
        )
        self.assertEqual(created.status_code, 201, created.get_json())
        doctor_id = created.get_json()["id"]
        self.assertEqual(created.get_json()["full_name"], "Тестовый Врач")

        duplicate = self.admin_request(
            "POST", "/api/doctors",
            json={"full_name": "тестовый   врач", "specialization": "терапевт"},
        )
        self.assertEqual(duplicate.status_code, 409)

        updated = self.admin_request(
            "PATCH", f"/api/doctors/{doctor_id}",
            json={"full_name": "Доктор Тест", "specialization": "Кардиолог"},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.get_json()["full_name"], "Доктор Тест")

        missing_csrf = self.client.delete(f"/api/doctors/{doctor_id}")
        self.assertEqual(missing_csrf.status_code, 403)
        archived = self.admin_request("DELETE", f"/api/doctors/{doctor_id}")
        self.assertEqual(archived.status_code, 200)
        self.assertTrue(archived.get_json()["archived"])
        self.assertNotIn(doctor_id, [doctor["id"] for doctor in self.client.get("/api/doctors").get_json()])

        admin_list = self.admin_request("GET", "/api/admin/doctors").get_json()
        archived_doctor = next(doctor for doctor in admin_list if doctor["id"] == doctor_id)
        self.assertEqual(archived_doctor["is_active"], 0)
        restored = self.admin_request("POST", f"/api/doctors/{doctor_id}/restore")
        self.assertEqual(restored.status_code, 200)
        self.assertIn(doctor_id, [doctor["id"] for doctor in self.client.get("/api/doctors").get_json()])

    def test_appointment_conflicts_availability_and_admin_cancellation(self):
        date = (dt.date.today() + dt.timedelta(days=30)).isoformat()
        payload = {"doctor_id": 1, "patient_id": 1, "date": date, "time": "10:00"}
        created = self.client.post("/api/appointments", json=payload)
        self.assertEqual(created.status_code, 201, created.get_json())
        appointment_id = created.get_json()["id"]

        same_doctor = self.client.post(
            "/api/appointments", json={**payload, "patient_id": 2}
        )
        self.assertEqual(same_doctor.status_code, 409)
        self.assertIn("Время занято", same_doctor.get_json()["error"])

        same_patient = self.client.post(
            "/api/appointments", json={**payload, "doctor_id": 2, "time": "10:00"}
        )
        self.assertEqual(same_patient.status_code, 409)
        self.assertIn("пациента", same_patient.get_json()["error"])

        availability = self.client.get(f"/api/availability?doctor_id=1&date={date}").get_json()
        self.assertIn("10:00", availability["booked"])
        self.assertNotIn("10:00", availability["available"])

        forbidden_delete = self.client.delete(f"/api/appointments/{appointment_id}")
        self.assertEqual(forbidden_delete.status_code, 401)
        self.login()
        cancelled = self.admin_request("DELETE", f"/api/appointments/{appointment_id}")
        self.assertEqual(cancelled.status_code, 200)
        self.assertIn("10:00", self.client.get(f"/api/availability?doctor_id=1&date={date}").get_json()["available"])

    def test_admin_patient_lifecycle_and_inactive_patient_booking(self):
        self.login()
        initial_patients = self.client.get("/api/patients").get_json()
        patient_id = initial_patients[0]["id"]
        other_policy = initial_patients[1]["policy"]

        updated = self.admin_request(
            "PATCH", f"/api/patients/{patient_id}",
            json={"full_name": "Обновлённый Пациент", "policy": "AA-9988 7766"},
        )
        self.assertEqual(updated.status_code, 200, updated.get_json())
        self.assertEqual(updated.get_json()["full_name"], "Обновлённый Пациент")

        duplicate = self.admin_request(
            "PATCH", f"/api/patients/{patient_id}",
            json={"full_name": "Обновлённый Пациент", "policy": other_policy},
        )
        self.assertEqual(duplicate.status_code, 409)

        archived = self.admin_request("DELETE", f"/api/patients/{patient_id}")
        self.assertEqual(archived.status_code, 200)
        self.assertNotIn(patient_id, [patient["id"] for patient in self.client.get("/api/patients").get_json()])

        future = (dt.date.today() + dt.timedelta(days=30)).isoformat()
        rejected = self.client.post(
            "/api/appointments",
            json={"doctor_id": 1, "patient_id": patient_id, "date": future, "time": "11:00"},
        )
        self.assertEqual(rejected.status_code, 404)

        restored = self.admin_request("POST", f"/api/patients/{patient_id}/restore")
        self.assertEqual(restored.status_code, 200)
        self.assertIn(patient_id, [patient["id"] for patient in self.client.get("/api/patients").get_json()])

    def test_patient_policy_validation_and_past_dates(self):
        duplicate_policy = self.client.post(
            "/api/patients",
            json={"full_name": "Дубликат Полиса", "policy": "7723456789012345"},
        )
        self.assertEqual(duplicate_policy.status_code, 409)

        short_policy = self.client.post(
            "/api/patients", json={"full_name": "Короткий Полис", "policy": "123"}
        )
        self.assertEqual(short_policy.status_code, 400)

        past = (dt.date.today() - dt.timedelta(days=1)).isoformat()
        past_appointment = self.client.post(
            "/api/appointments",
            json={"doctor_id": 1, "patient_id": 1, "date": past, "time": "10:00"},
        )
        self.assertEqual(past_appointment.status_code, 400)

    def test_legacy_database_is_migrated_without_losing_rows(self):
        legacy_path = os.path.join(self.temp_dir.name, "legacy.db")
        conn = sqlite3.connect(legacy_path)
        conn.executescript(
            """
            CREATE TABLE doctors (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, specialization TEXT NOT NULL);
            CREATE TABLE patients (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, policy TEXT NOT NULL);
            CREATE TABLE appointments (id INTEGER PRIMARY KEY AUTOINCREMENT, doctor_id INTEGER NOT NULL, patient_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL);
            INSERT INTO doctors(full_name, specialization) VALUES ('Старый врач', 'Терапевт');
            INSERT INTO patients(full_name, policy) VALUES ('Старый пациент', '12345678');
            """
        )
        conn.commit()
        conn.close()

        with clinic.app.app_context():
            clinic.init_db(legacy_path)
        conn = sqlite3.connect(legacy_path)
        doctor_columns = {row[1] for row in conn.execute("PRAGMA table_info(doctors)")}
        patient_columns = {row[1] for row in conn.execute("PRAGMA table_info(patients)")}
        self.assertIn("is_active", doctor_columns)
        self.assertIn("is_active", patient_columns)
        self.assertEqual(conn.execute("SELECT full_name FROM doctors").fetchone()[0], "Старый врач")
        self.assertEqual(conn.execute("SELECT full_name FROM patients").fetchone()[0], "Старый пациент")
        conn.close()


if __name__ == "__main__":
    unittest.main()
