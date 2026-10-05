# -*- coding: utf-8 -*-
"""Поликлиника: регистратура и панель администратора (Flask + SQLite)."""
from __future__ import annotations

import datetime as dt
import hmac
import os
import re
import secrets
import sqlite3
import threading
from contextlib import closing
from functools import wraps
from typing import Any

from flask import Flask, current_app, jsonify, request, send_from_directory, session

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DEFAULT_DB_PATH = os.path.join(BASE_DIR, "clinic.db")

# Почасовая сетка записи. Проверяется на сервере, а не только в браузере.
SLOTS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY") or secrets.token_hex(32),
    DATABASE=os.environ.get("CLINIC_DB_PATH", DEFAULT_DB_PATH),
    ADMIN_PASSWORD=os.environ.get("ADMIN_PASSWORD", ""),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE", "0").lower() in {"1", "true", "yes"},
    PERMANENT_SESSION_LIFETIME=dt.timedelta(hours=8),
    MAX_CONTENT_LENGTH=64 * 1024,
)

_initialized_databases: set[str] = set()
_database_init_lock = threading.Lock()


def today() -> dt.date:
    """Текущая дата на сервере, используемая для проверки записей."""
    return dt.date.today()


def week_days(anchor: dt.date) -> list[dt.date]:
    """Семь дат с понедельника по воскресенье недели, содержащей anchor."""
    monday = anchor - dt.timedelta(days=anchor.weekday())
    return [monday + dt.timedelta(days=i) for i in range(7)]


def get_db() -> sqlite3.Connection:
    """Открывает SQLite-соединение с включёнными внешними ключами."""
    conn = sqlite3.connect(current_app.config["DATABASE"], timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, declaration: str) -> None:
    if column not in _table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")


def init_db(db_path: str | None = None) -> None:
    """Создаёт таблицы и безопасно расширяет схему существующей БД."""
    path = os.path.abspath(db_path or current_app.config["DATABASE"])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS doctors (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name      TEXT NOT NULL,
                specialization TEXT NOT NULL,
                is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
            );

            CREATE TABLE IF NOT EXISTS patients (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                policy    TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
            );

            CREATE TABLE IF NOT EXISTS appointments (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                doctor_id  INTEGER NOT NULL,
                patient_id INTEGER NOT NULL,
                date       TEXT NOT NULL,
                time       TEXT NOT NULL,
                FOREIGN KEY (doctor_id)  REFERENCES doctors(id),
                FOREIGN KEY (patient_id) REFERENCES patients(id)
            );
            """
        )
        # Миграция исходной версии: в ней записи не имели признака активности.
        _add_column_if_missing(conn, "doctors", "is_active", "INTEGER NOT NULL DEFAULT 1")
        _add_column_if_missing(conn, "patients", "is_active", "INTEGER NOT NULL DEFAULT 1")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date, time)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date ON appointments(doctor_id, date, time)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_appointments_patient_date ON appointments(patient_id, date, time)")

        # Уникальные индексы защищают от двойной записи даже при одновременных запросах.
        # Если в старой сторонней БД уже есть дубликаты, не удаляем медицинские данные:
        # проверка транзакцией BEGIN IMMEDIATE всё равно защищает новые запросы.
        try:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_doctor_slot "
                "ON appointments(doctor_id, date, time)"
            )
        except sqlite3.IntegrityError:
            current_app.logger.warning("В старой БД есть повторные записи врача; уникальный индекс пропущен")
        try:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_appointments_patient_slot "
                "ON appointments(patient_id, date, time)"
            )
        except sqlite3.IntegrityError:
            current_app.logger.warning("В старой БД есть повторные записи пациента; уникальный индекс пропущен")

        # Сериализуем первоначальное заполнение, если сервер запущен несколькими workers.
        conn.execute("BEGIN IMMEDIATE")
        doctors_count = conn.execute("SELECT COUNT(*) FROM doctors").fetchone()[0]
        patients_count = conn.execute("SELECT COUNT(*) FROM patients").fetchone()[0]
        appointments_count = conn.execute("SELECT COUNT(*) FROM appointments").fetchone()[0]
        # Демо-данные добавляются только в действительно пустую новую БД.
        if doctors_count == 0 and patients_count == 0 and appointments_count == 0:
            _seed(conn)
        conn.commit()
    finally:
        conn.close()
    _initialized_databases.add(path)


def _seed(conn: sqlite3.Connection) -> None:
    """Небольшие демонстрационные данные для первого запуска."""
    doctors = [
        ("Иванова Анна Петровна", "Терапевт"),
        ("Смирнов Дмитрий Игоревич", "Хирург"),
        ("Кузнецова Ольга Сергеевна", "Офтальмолог"),
        ("Попов Алексей Викторович", "Невролог"),
        ("Соколова Мария Андреевна", "Педиатр"),
        ("Лебедев Николай Степанович", "Кардиолог"),
    ]
    patients = [
        ("Петров Иван Сергеевич", "7723 4567 8901 2345"),
        ("Сидорова Елена Михайловна", "6611 2233 4455 6677"),
        ("Козлов Андрей Владимирович", "5522 3344 5566 7788"),
        ("Новикова Татьяна Игоревна", "8811 2233 4455 6699"),
        ("Морозов Сергей Дмитриевич", "4400 1122 3344 5566"),
        ("Волкова Анна Николаевна", "9900 8877 6655 4433"),
    ]
    doctor_ids = []
    for full_name, specialization in doctors:
        cursor = conn.execute(
            "INSERT INTO doctors(full_name, specialization) VALUES (?, ?)",
            (full_name, specialization),
        )
        doctor_ids.append(cursor.lastrowid)
    patient_ids = []
    for full_name, policy in patients:
        cursor = conn.execute(
            "INSERT INTO patients(full_name, policy) VALUES (?, ?)", (full_name, policy)
        )
        patient_ids.append(cursor.lastrowid)

    days = week_days(today())
    # (индекс врача, индекс пациента, смещение от понедельника, время)
    appointments = [
        (0, 0, 0, "09:00"), (0, 1, 0, "11:00"), (1, 2, 0, "10:00"),
        (2, 3, 1, "09:00"), (3, 4, 1, "13:00"),
        (4, 5, 2, "10:00"), (5, 0, 2, "14:00"),
        (0, 2, 3, "08:00"), (2, 1, 3, "12:00"),
        (3, 3, 4, "09:00"), (1, 5, 4, "15:00"), (5, 4, 4, "11:00"),
    ]
    for doctor_idx, patient_idx, day_offset, slot in appointments:
        conn.execute(
            "INSERT INTO appointments(doctor_id, patient_id, date, time) VALUES (?, ?, ?, ?)",
            (doctor_ids[doctor_idx], patient_ids[patient_idx], days[day_offset].isoformat(), slot),
        )


def _ensure_db_initialized() -> None:
    path = os.path.abspath(current_app.config["DATABASE"])
    if path in _initialized_databases:
        return
    with _database_init_lock:
        if path not in _initialized_databases:
            init_db(path)


@app.before_request
def ensure_database() -> None:
    # Работает и при запуске через `python app.py`, и через `flask --app app run`.
    _ensure_db_initialized()


def _json_object() -> dict[str, Any]:
    value = request.get_json(silent=True)
    return value if isinstance(value, dict) else {}


def _clean_text(data: dict[str, Any], key: str, label: str, max_length: int) -> tuple[str | None, str | None]:
    value = data.get(key)
    if not isinstance(value, str):
        return None, f"Укажите {label}"
    value = value.strip()
    if not value:
        return None, f"Укажите {label}"
    if len(value) > max_length:
        return None, f"Поле «{label}» должно быть не длиннее {max_length} символов"
    if any(ord(char) < 32 for char in value):
        return None, f"Поле «{label}» содержит недопустимые символы"
    return value, None


def _positive_id(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None


def _iso_date(value: Any) -> dt.date | None:
    if not isinstance(value, str) or not DATE_RE.fullmatch(value):
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def _normalized(value: str) -> str:
    return " ".join(value.casefold().split())


def _normalized_policy(value: str) -> str:
    return re.sub(r"[\s-]", "", value).casefold()


def _duplicate_doctor(conn: sqlite3.Connection, full_name: str, specialization: str, except_id: int | None = None) -> bool:
    query = "SELECT id, full_name, specialization FROM doctors WHERE is_active = 1"
    rows = conn.execute(query).fetchall()
    return any(
        row["id"] != except_id
        and _normalized(row["full_name"]) == _normalized(full_name)
        and _normalized(row["specialization"]) == _normalized(specialization)
        for row in rows
    )


def _duplicate_policy(conn: sqlite3.Connection, policy: str, except_id: int | None = None) -> bool:
    rows = conn.execute("SELECT id, policy FROM patients").fetchall()
    normalized = _normalized_policy(policy)
    return any(row["id"] != except_id and _normalized_policy(row["policy"]) == normalized for row in rows)


def _error(message: str, status: int):
    return jsonify({"error": message}), status


def _admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not current_app.config.get("ADMIN_PASSWORD"):
            return _error("Панель администратора не настроена. Задайте переменную ADMIN_PASSWORD на сервере.", 503)
        if not session.get("admin_authenticated"):
            return _error("Требуется вход администратора", 401)
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            expected = session.get("csrf_token", "")
            supplied = request.headers.get("X-CSRF-Token", "")
            if not expected or not hmac.compare_digest(expected, supplied):
                return _error("Сессия устарела. Обновите страницу и войдите снова.", 403)
        return view(*args, **kwargs)
    return wrapped


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


# ── Авторизация панели администратора ────────────────────────────────────────
@app.route("/api/admin/session", methods=["GET"])
def admin_session():
    authenticated = bool(current_app.config.get("ADMIN_PASSWORD") and session.get("admin_authenticated"))
    return jsonify({
        "configured": bool(current_app.config.get("ADMIN_PASSWORD")),
        "authenticated": authenticated,
        "csrf_token": session.get("csrf_token") if authenticated else None,
    })


@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    configured_password = current_app.config.get("ADMIN_PASSWORD", "")
    if not configured_password:
        return _error("Вход администратора отключён: задайте переменную ADMIN_PASSWORD на сервере.", 503)
    password = _json_object().get("password")
    if not isinstance(password, str) or not hmac.compare_digest(
        password.encode("utf-8"), configured_password.encode("utf-8")
    ):
        return _error("Неверный пароль администратора", 401)
    session.clear()
    session.permanent = True
    session["admin_authenticated"] = True
    session["csrf_token"] = secrets.token_urlsafe(32)
    return jsonify({"ok": True, "csrf_token": session["csrf_token"]})


@app.route("/api/admin/logout", methods=["POST"])
@_admin_required
def admin_logout():
    session.clear()
    return jsonify({"ok": True})


# ── Справочник врачей ────────────────────────────────────────────────────────
@app.route("/api/doctors", methods=["GET"])
def doctors_list():
    with closing(get_db()) as conn:
        rows = conn.execute(
            "SELECT id, full_name, specialization FROM doctors WHERE is_active = 1 ORDER BY full_name, id"
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/doctors", methods=["POST"])
@_admin_required
def doctors_create():
    data = _json_object()
    full_name, error_name = _clean_text(data, "full_name", "ФИО врача", 120)
    specialization, error_specialty = _clean_text(data, "specialization", "специализацию", 80)
    if error_name or error_specialty:
        return _error(". ".join(error for error in (error_name, error_specialty) if error), 400)

    with closing(get_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        if _duplicate_doctor(conn, full_name, specialization):
            return _error("Такой врач уже есть в справочнике", 409)
        cursor = conn.execute(
            "INSERT INTO doctors(full_name, specialization) VALUES (?, ?)",
            (full_name, specialization),
        )
        conn.commit()
        doctor_id = cursor.lastrowid
    return jsonify({"id": doctor_id, "full_name": full_name, "specialization": specialization, "is_active": 1}), 201


@app.route("/api/admin/doctors", methods=["GET"])
@_admin_required
def admin_doctors_list():
    with closing(get_db()) as conn:
        rows = conn.execute(
            """
            SELECT d.id, d.full_name, d.specialization, d.is_active,
                   COUNT(CASE WHEN a.date >= ? THEN 1 END) AS upcoming_appointments
            FROM doctors d
            LEFT JOIN appointments a ON a.doctor_id = d.id
            GROUP BY d.id
            ORDER BY d.is_active DESC, d.full_name, d.id
            """,
            (today().isoformat(),),
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/doctors/<int:doctor_id>", methods=["PATCH"])
@_admin_required
def doctors_update(doctor_id: int):
    data = _json_object()
    full_name, error_name = _clean_text(data, "full_name", "ФИО врача", 120)
    specialization, error_specialty = _clean_text(data, "specialization", "специализацию", 80)
    if error_name or error_specialty:
        return _error(". ".join(error for error in (error_name, error_specialty) if error), 400)

    with closing(get_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        doctor = conn.execute("SELECT id FROM doctors WHERE id = ?", (doctor_id,)).fetchone()
        if doctor is None:
            return _error("Врач не найден", 404)
        if _duplicate_doctor(conn, full_name, specialization, except_id=doctor_id):
            return _error("Такой врач уже есть в справочнике", 409)
        conn.execute(
            "UPDATE doctors SET full_name = ?, specialization = ? WHERE id = ?",
            (full_name, specialization, doctor_id),
        )
        conn.commit()
    return jsonify({"id": doctor_id, "full_name": full_name, "specialization": specialization})


@app.route("/api/doctors/<int:doctor_id>", methods=["DELETE"])
@_admin_required
def doctors_delete(doctor_id: int):
    # Архивирование вместо физического удаления сохраняет старые записи и историю.
    with closing(get_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        doctor = conn.execute("SELECT id, is_active FROM doctors WHERE id = ?", (doctor_id,)).fetchone()
        if doctor is None:
            return _error("Врач не найден", 404)
        if doctor["is_active"]:
            conn.execute("UPDATE doctors SET is_active = 0 WHERE id = ?", (doctor_id,))
            conn.commit()
    return jsonify({"ok": True, "archived": True})


@app.route("/api/doctors/<int:doctor_id>/restore", methods=["POST"])
@_admin_required
def doctors_restore(doctor_id: int):
    with closing(get_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        doctor = conn.execute(
            "SELECT id, full_name, specialization, is_active FROM doctors WHERE id = ?", (doctor_id,)
        ).fetchone()
        if doctor is None:
            return _error("Врач не найден", 404)
        if _duplicate_doctor(conn, doctor["full_name"], doctor["specialization"], except_id=doctor_id):
            return _error("Нельзя восстановить: активный врач с такими данными уже есть", 409)
        conn.execute("UPDATE doctors SET is_active = 1 WHERE id = ?", (doctor_id,))
        conn.commit()
    return jsonify({"ok": True, "is_active": 1})


# ── Картотека пациентов ──────────────────────────────────────────────────────
@app.route("/api/patients", methods=["GET"])
def patients_list():
    with closing(get_db()) as conn:
        rows = conn.execute(
            "SELECT id, full_name, policy FROM patients WHERE is_active = 1 ORDER BY full_name, id"
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/patients", methods=["POST"])
def patients_create():
    data = _json_object()
    full_name, error_name = _clean_text(data, "full_name", "ФИО пациента", 120)
    policy, error_policy = _clean_text(data, "policy", "номер полиса", 40)
    if error_name or error_policy:
        return _error(". ".join(error for error in (error_name, error_policy) if error), 400)
    if len(_normalized_policy(policy)) < 5:
        return _error("Номер полиса должен содержать не менее 5 символов", 400)

    with closing(get_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        if _duplicate_policy(conn, policy):
            return _error("Пациент с таким номером полиса уже есть в картотеке", 409)
        cursor = conn.execute(
            "INSERT INTO patients(full_name, policy) VALUES (?, ?)", (full_name, policy)
        )
        conn.commit()
        patient_id = cursor.lastrowid
    return jsonify({"id": patient_id, "full_name": full_name, "policy": policy, "is_active": 1}), 201


@app.route("/api/admin/patients", methods=["GET"])
@_admin_required
def admin_patients_list():
    with closing(get_db()) as conn:
        rows = conn.execute(
            """
            SELECT p.id, p.full_name, p.policy, p.is_active,
                   COUNT(CASE WHEN a.date >= ? THEN 1 END) AS upcoming_appointments
            FROM patients p
            LEFT JOIN appointments a ON a.patient_id = p.id
            GROUP BY p.id
            ORDER BY p.is_active DESC, p.full_name, p.id
            """,
            (today().isoformat(),),
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/patients/<int:patient_id>", methods=["PATCH"])
@_admin_required
def patients_update(patient_id: int):
    data = _json_object()
    full_name, error_name = _clean_text(data, "full_name", "ФИО пациента", 120)
    policy, error_policy = _clean_text(data, "policy", "номер полиса", 40)
    if error_name or error_policy:
        return _error(". ".join(error for error in (error_name, error_policy) if error), 400)
    if len(_normalized_policy(policy)) < 5:
        return _error("Номер полиса должен содержать не менее 5 символов", 400)

    with closing(get_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        patient = conn.execute("SELECT id FROM patients WHERE id = ?", (patient_id,)).fetchone()
        if patient is None:
            return _error("Пациент не найден", 404)
        if _duplicate_policy(conn, policy, except_id=patient_id):
            return _error("Пациент с таким номером полиса уже есть в картотеке", 409)
        conn.execute(
            "UPDATE patients SET full_name = ?, policy = ? WHERE id = ?",
            (full_name, policy, patient_id),
        )
        conn.commit()
    return jsonify({"id": patient_id, "full_name": full_name, "policy": policy})


@app.route("/api/patients/<int:patient_id>", methods=["DELETE"])
@_admin_required
def patients_delete(patient_id: int):
    # Архивная карточка остаётся связанной с историческими приёмами.
    with closing(get_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        patient = conn.execute("SELECT id, is_active FROM patients WHERE id = ?", (patient_id,)).fetchone()
        if patient is None:
            return _error("Пациент не найден", 404)
        if patient["is_active"]:
            conn.execute("UPDATE patients SET is_active = 0 WHERE id = ?", (patient_id,))
            conn.commit()
    return jsonify({"ok": True, "archived": True})


@app.route("/api/patients/<int:patient_id>/restore", methods=["POST"])
@_admin_required
def patients_restore(patient_id: int):
    with closing(get_db()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        patient = conn.execute("SELECT id FROM patients WHERE id = ?", (patient_id,)).fetchone()
        if patient is None:
            return _error("Пациент не найден", 404)
        conn.execute("UPDATE patients SET is_active = 1 WHERE id = ?", (patient_id,))
        conn.commit()
    return jsonify({"ok": True, "is_active": 1})


# ── Расписание и доступность ──────────────────────────────────────────────────
@app.route("/api/schedule", methods=["GET"])
def schedule():
    week_start = request.args.get("week_start")
    anchor = _iso_date(week_start) if week_start else today()
    if anchor is None:
        return _error("Некорректная дата week_start (ожидается YYYY-MM-DD)", 400)

    days = week_days(anchor)
    with closing(get_db()) as conn:
        rows = conn.execute(
            """
            SELECT a.id, a.date, a.time,
                   d.id AS doctor_id, d.full_name AS doctor, d.specialization,
                   p.id AS patient_id, p.full_name AS patient
            FROM appointments a
            JOIN doctors d ON d.id = a.doctor_id
            JOIN patients p ON p.id = a.patient_id
            WHERE a.date BETWEEN ? AND ?
            ORDER BY a.date, a.time, d.full_name
            """,
            (days[0].isoformat(), days[-1].isoformat()),
        ).fetchall()
    return jsonify({
        "week_start": days[0].isoformat(),
        "days": [day.isoformat() for day in days],
        "today": today().isoformat(),
        "slots": SLOTS,
        "appointments": [dict(row) for row in rows],
    })


@app.route("/api/availability", methods=["GET"])
def availability():
    doctor_id = _positive_id(request.args.get("doctor_id"))
    appointment_date = _iso_date(request.args.get("date"))
    if doctor_id is None:
        return _error("Выберите врача", 400)
    if appointment_date is None:
        return _error("Некорректная дата (ожидается YYYY-MM-DD)", 400)
    if appointment_date < today():
        return _error("Нельзя записаться на прошедшую дату", 400)

    with closing(get_db()) as conn:
        doctor = conn.execute(
            "SELECT id FROM doctors WHERE id = ? AND is_active = 1", (doctor_id,)
        ).fetchone()
        if doctor is None:
            return _error("Врач не найден или архивирован", 404)
        booked = {
            row["time"] for row in conn.execute(
                "SELECT time FROM appointments WHERE doctor_id = ? AND date = ?",
                (doctor_id, appointment_date.isoformat()),
            ).fetchall()
        }
    return jsonify({
        "date": appointment_date.isoformat(),
        "doctor_id": doctor_id,
        "slots": SLOTS,
        "booked": sorted(booked),
        "available": [slot for slot in SLOTS if slot not in booked],
    })


# ── Запись на приём ───────────────────────────────────────────────────────────
@app.route("/api/appointments", methods=["POST"])
def appointments_create():
    data = _json_object()
    doctor_id = _positive_id(data.get("doctor_id"))
    patient_id = _positive_id(data.get("patient_id"))
    appointment_date = _iso_date(data.get("date"))
    appointment_time = data.get("time")
    if not isinstance(appointment_time, str):
        appointment_time = ""
    appointment_time = appointment_time.strip()

    errors = []
    if doctor_id is None:
        errors.append("Выберите врача")
    if patient_id is None:
        errors.append("Выберите пациента")
    if appointment_date is None:
        errors.append("Некорректная дата (ожидается YYYY-MM-DD)")
    if appointment_time not in SLOTS:
        errors.append("Приём возможен только в часы: " + ", ".join(SLOTS))
    if errors:
        return _error(". ".join(errors), 400)
    if appointment_date < today():
        return _error("Нельзя записаться на прошедшую дату", 400)

    date_text = appointment_date.isoformat()
    with closing(get_db()) as conn:
        # BEGIN IMMEDIATE не даёт двум параллельным запросам занять один слот.
        conn.execute("BEGIN IMMEDIATE")
        doctor = conn.execute(
            "SELECT id FROM doctors WHERE id = ? AND is_active = 1", (doctor_id,)
        ).fetchone()
        if doctor is None:
            return _error("Врач не найден или архивирован", 404)
        patient = conn.execute(
            "SELECT id FROM patients WHERE id = ? AND is_active = 1", (patient_id,)
        ).fetchone()
        if patient is None:
            return _error("Пациент не найден или архивирован", 404)

        doctor_busy = conn.execute(
            "SELECT 1 FROM appointments WHERE doctor_id = ? AND date = ? AND time = ? LIMIT 1",
            (doctor_id, date_text, appointment_time),
        ).fetchone()
        if doctor_busy:
            return _error(
                f"Время занято: у врача уже есть приём {date_text} в {appointment_time}. Выберите другой слот.",
                409,
            )
        patient_busy = conn.execute(
            "SELECT 1 FROM appointments WHERE patient_id = ? AND date = ? AND time = ? LIMIT 1",
            (patient_id, date_text, appointment_time),
        ).fetchone()
        if patient_busy:
            return _error(
                f"У пациента уже есть запись {date_text} в {appointment_time}.", 409
            )

        try:
            cursor = conn.execute(
                "INSERT INTO appointments(doctor_id, patient_id, date, time) VALUES (?, ?, ?, ?)",
                (doctor_id, patient_id, date_text, appointment_time),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            return _error("Этот временной слот уже занят. Обновите расписание и выберите другой.", 409)
        appointment_id = cursor.lastrowid

    return jsonify({
        "id": appointment_id,
        "doctor_id": doctor_id,
        "patient_id": patient_id,
        "date": date_text,
        "time": appointment_time,
    }), 201


@app.route("/api/admin/summary", methods=["GET"])
@_admin_required
def admin_summary():
    now = today().isoformat()
    with closing(get_db()) as conn:
        active_doctors = conn.execute("SELECT COUNT(*) FROM doctors WHERE is_active = 1").fetchone()[0]
        active_patients = conn.execute("SELECT COUNT(*) FROM patients WHERE is_active = 1").fetchone()[0]
        today_appointments = conn.execute(
            "SELECT COUNT(*) FROM appointments WHERE date = ?", (now,)
        ).fetchone()[0]
        upcoming_appointments = conn.execute(
            "SELECT COUNT(*) FROM appointments WHERE date >= ?", (now,)
        ).fetchone()[0]
    return jsonify({
        "active_doctors": active_doctors,
        "active_patients": active_patients,
        "today_appointments": today_appointments,
        "upcoming_appointments": upcoming_appointments,
    })


@app.route("/api/admin/appointments", methods=["GET"])
@_admin_required
def admin_appointments_list():
    scope = request.args.get("scope", "upcoming")
    if scope not in {"upcoming", "all"}:
        return _error("Неизвестный фильтр записей", 400)
    try:
        limit = int(request.args.get("limit", "100"))
    except ValueError:
        return _error("Некорректный limit", 400)
    limit = max(1, min(limit, 250))

    conditions = []
    params: list[Any] = []
    if scope == "upcoming":
        conditions.append("a.date >= ?")
        params.append(today().isoformat())
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    with closing(get_db()) as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM appointments a{where}", params
        ).fetchone()[0]
        order = "a.date ASC, a.time ASC, a.id ASC" if scope == "upcoming" else "a.date DESC, a.time DESC, a.id DESC"
        rows = conn.execute(
            f"""
            SELECT a.id, a.date, a.time,
                   d.id AS doctor_id, d.full_name AS doctor, d.specialization,
                   p.id AS patient_id, p.full_name AS patient
            FROM appointments a
            JOIN doctors d ON d.id = a.doctor_id
            JOIN patients p ON p.id = a.patient_id
            {where}
            ORDER BY {order}
            LIMIT ?
            """,
            [*params, limit],
        ).fetchall()
    return jsonify({"appointments": [dict(row) for row in rows], "total": total, "limit": limit, "scope": scope})


@app.route("/api/appointments/<int:appointment_id>", methods=["DELETE"])
@_admin_required
def appointments_delete(appointment_id: int):
    with closing(get_db()) as conn:
        cursor = conn.execute("DELETE FROM appointments WHERE id = ?", (appointment_id,))
        conn.commit()
        deleted = cursor.rowcount
    if deleted == 0:
        return _error("Запись не найдена", 404)
    return jsonify({"ok": True})


if __name__ == "__main__":
    with app.app_context():
        init_db()
    app.run(
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "5000")),
        debug=False,
    )
