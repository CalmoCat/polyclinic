# -*- coding: utf-8 -*-
"""
Поликлиника — Автоматизация Регистратора
=========================================
Бэкенд: Flask + SQLite.

База данных (БД):
  Врачи            (ID, ФИО, Специализация)
  Пациенты         (ID, ФИО, Полис)
  Журнал Записей   (ID, Врач_ID, Пациент_ID, Дата Приема, Время Приема)

Бизнес-логика (проверка в коде) — см. POST /api/appointments.
"""
import os
import sqlite3
import datetime

from flask import Flask, request, jsonify, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "clinic.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")

# Приёмные часы (сетка расписания) — почасовая запись с 08:00 до 16:00.
SLOTS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]

app = Flask(__name__, static_folder="static", static_url_path="/static")


# ----------------------------------------------------------------------------
# БД
# ----------------------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def today():
    """«Сегодня» для расчёта текущей недели (системная дата сервера)."""
    return datetime.date.today()


def week_days(anchor: datetime.date):
    """Возвращает 7 дат (понедельник–воскресенье) недели, в которую входит anchor."""
    monday = anchor - datetime.timedelta(days=anchor.weekday())
    return [monday + datetime.timedelta(days=i) for i in range(7)]


def init_db():
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS doctors (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name      TEXT NOT NULL,   -- ФИО
            specialization TEXT NOT NULL    -- Специализация
        );

        CREATE TABLE IF NOT EXISTS patients (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,        -- ФИО
            policy    TEXT NOT NULL         -- Полис
        );

        CREATE TABLE IF NOT EXISTS appointments (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            doctor_id  INTEGER NOT NULL,    -- Врач_ID
            patient_id INTEGER NOT NULL,    -- Пациент_ID
            date       TEXT NOT NULL,       -- Дата Приема (YYYY-MM-DD)
            time       TEXT NOT NULL,       -- Время Приема (HH:MM)
            FOREIGN KEY (doctor_id)  REFERENCES doctors(id),
            FOREIGN KEY (patient_id) REFERENCES patients(id)
        );
        """
    )
    if conn.execute("SELECT COUNT(*) FROM doctors").fetchone()[0] == 0:
        seed(conn)
    conn.commit()
    conn.close()


def seed(conn):
    """Демо-данные: врачи, пациенты и записи на текущую неделю."""
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
    conn.executemany("INSERT INTO doctors(full_name, specialization) VALUES (?, ?)", doctors)
    conn.executemany("INSERT INTO patients(full_name, policy) VALUES (?, ?)", patients)

    days = week_days(today())
    # (врач_idx, пациент_idx, смещение дня недели 0=Пн .. 4=Пт, время)
    appts = [
        (0, 0, 0, "09:00"), (0, 1, 0, "11:00"), (1, 2, 0, "10:00"),
        (2, 3, 1, "09:00"), (3, 4, 1, "13:00"),
        (4, 5, 2, "10:00"), (5, 0, 2, "14:00"),
        (0, 2, 3, "08:00"), (2, 1, 3, "12:00"),
        (3, 3, 4, "09:00"), (1, 5, 4, "15:00"), (5, 4, 4, "11:00"),
    ]
    for di, pi, offset, t in appts:
        conn.execute(
            "INSERT INTO appointments(doctor_id, patient_id, date, time) VALUES (?, ?, ?, ?)",
            (di + 1, pi + 1, days[offset].isoformat(), t),
        )


# ----------------------------------------------------------------------------
# Страница
# ----------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


# ----------------------------------------------------------------------------
# Справочники: Врачи
# ----------------------------------------------------------------------------
@app.route("/api/doctors", methods=["GET"])
def doctors_list():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, full_name, specialization FROM doctors ORDER BY full_name"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/doctors", methods=["POST"])
def doctors_create():
    data = request.get_json(force=True, silent=True) or {}
    full_name = (data.get("full_name") or "").strip()
    specialization = (data.get("specialization") or "").strip()
    if not full_name or not specialization:
        return jsonify({"error": "Укажите ФИО и специализацию врача"}), 400
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO doctors(full_name, specialization) VALUES (?, ?)",
        (full_name, specialization),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return jsonify({"id": new_id, "full_name": full_name, "specialization": specialization}), 201


# ----------------------------------------------------------------------------
# Справочники: Пациенты
# ----------------------------------------------------------------------------
@app.route("/api/patients", methods=["GET"])
def patients_list():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, full_name, policy FROM patients ORDER BY full_name"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/patients", methods=["POST"])
def patients_create():
    data = request.get_json(force=True, silent=True) or {}
    full_name = (data.get("full_name") or "").strip()
    policy = (data.get("policy") or "").strip()
    if not full_name or not policy:
        return jsonify({"error": "Укажите ФИО и номер полиса пациента"}), 400
    conn = get_db()
    cur = conn.execute(
        "INSERT INTO patients(full_name, policy) VALUES (?, ?)", (full_name, policy)
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return jsonify({"id": new_id, "full_name": full_name, "policy": policy}), 201


# ----------------------------------------------------------------------------
# Расписание (сетка на неделю)
# ----------------------------------------------------------------------------
@app.route("/api/schedule")
def schedule():
    ws = request.args.get("week_start")
    if ws:
        try:
            anchor = datetime.date.fromisoformat(ws)
        except ValueError:
            return jsonify({"error": "Некорректная дата week_start (ожидается YYYY-MM-DD)"}), 400
    else:
        anchor = today()

    days = week_days(anchor)
    conn = get_db()
    rows = conn.execute(
        """
        SELECT a.id, a.date, a.time,
               d.id AS doctor_id, d.full_name AS doctor, d.specialization,
               p.id AS patient_id, p.full_name AS patient, p.policy
        FROM appointments a
        JOIN doctors  d ON d.id = a.doctor_id
        JOIN patients p ON p.id = a.patient_id
        WHERE a.date BETWEEN ? AND ?
        ORDER BY a.date, a.time, d.full_name
        """,
        (days[0].isoformat(), days[-1].isoformat()),
    ).fetchall()
    conn.close()
    return jsonify(
        {
            "week_start": days[0].isoformat(),
            "days": [d.isoformat() for d in days],
            "today": today().isoformat(),
            "slots": SLOTS,
            "appointments": [dict(r) for r in rows],
        }
    )


# ----------------------------------------------------------------------------
# Журнал Записей: новая запись на приём
# ----------------------------------------------------------------------------
@app.route("/api/appointments", methods=["POST"])
def appointments_create():
    data = request.get_json(force=True, silent=True) or {}
    doctor_id = data.get("doctor_id")
    patient_id = data.get("patient_id")
    date = (data.get("date") or "").strip()
    time = (data.get("time") or "").strip()

    errors = []
    if not doctor_id or not patient_id:
        errors.append("Выберите врача и пациента")
    try:
        d = datetime.date.fromisoformat(date)
    except (ValueError, TypeError):
        d = None
        errors.append("Некорректная дата (ожидается YYYY-MM-DD)")
    if time not in SLOTS:
        errors.append("Приём возможен только в часы: " + ", ".join(SLOTS))
    if errors:
        return jsonify({"error": ". ".join(errors)}), 400

    if d < today():
        return jsonify({"error": "Нельзя записаться на прошедшую дату"}), 400

    conn = get_db()
    if not conn.execute("SELECT 1 FROM doctors WHERE id = ?", (doctor_id,)).fetchone():
        conn.close()
        return jsonify({"error": "Врач не найден"}), 404
    if not conn.execute("SELECT 1 FROM patients WHERE id = ?", (patient_id,)).fetchone():
        conn.close()
        return jsonify({"error": "Пациент не найден"}), 404

    # ─── БИЗНЕС-ЛОГИКА (проверка в коде) ─────────────────────────────────
    # Перед сохранением записи проверяем таблицу «Журнал Записей» запросом:
    #     SELECT COUNT(*) FROM appointments
    #     WHERE doctor_id = X AND date = Y AND time = Z
    # Если результат > 0 — запись БЛОКИРУЕТСЯ (у врача уже есть приём
    # на эту дату и время).
    # ----------------------------------------------------------------------
    count = conn.execute(
        "SELECT COUNT(*) FROM appointments WHERE doctor_id = ? AND date = ? AND time = ?",
        (doctor_id, date, time),
    ).fetchone()[0]

    if count > 0:
        conn.close()
        return jsonify(
            {
                "error": (
                    f"Запись заблокирована: у врача уже есть приём на {date} в {time}. "
                    "Выберите другое время или другого врача."
                )
            }
        ), 409

    cur = conn.execute(
        "INSERT INTO appointments(doctor_id, patient_id, date, time) VALUES (?, ?, ?, ?)",
        (doctor_id, patient_id, date, time),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return jsonify(
        {
            "id": new_id,
            "doctor_id": doctor_id,
            "patient_id": patient_id,
            "date": date,
            "time": time,
        }
    ), 201


@app.route("/api/appointments/<int:appt_id>", methods=["DELETE"])
def appointments_delete(appt_id):
    conn = get_db()
    cur = conn.execute("DELETE FROM appointments WHERE id = ?", (appt_id,))
    conn.commit()
    deleted = cur.rowcount
    conn.close()
    if deleted == 0:
        return jsonify({"error": "Запись не найдена"}), 404
    return jsonify({"ok": True})


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=False)
