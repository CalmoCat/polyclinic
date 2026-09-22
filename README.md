# Поликлиника — Автоматизация Регистратора

Веб-приложение для регистратора поликлиники: сетка расписания врачей на неделю,
текстовая картотека пациентов и форма записи на приём с проверкой занятости времени
на бэкенде.

## Стек
- Бэкенд: Python + Flask
- БД: SQLite (встроенная, файл `clinic.db` создаётся автоматически)
- Фронтенд: HTML + CSS + ванильный JS (без сборки)

## Структура
```
polyclinic/
├── app.py            # бэкенд: маршруты, БД, бизнес-логика
├── clinic.db         # создаётся при первом запуске
├── requirements.txt
└── static/
    ├── index.html    # интерфейс
    ├── style.css
    └── app.js
```

## Запуск
```bash
cd polyclinic
pip install -r requirements.txt
python app.py
```
Открыть http://localhost:5000

## Структура БД
| Таблица | Поля |
|---|---|
| Врачи (`doctors`) | ID, ФИО (`full_name`), Специализация (`specialization`) |
| Пациенты (`patients`) | ID, ФИО (`full_name`), Полис (`policy`) |
| Журнал Записей (`appointments`) | ID, Врач_ID (`doctor_id`), Пациент_ID (`patient_id`), Дата Приема (`date`), Время Приема (`time`) |

## Бизнес-логика (проверка в коде)
Перед сохранением записи бэкенд выполняет запрос к «Журналу Записей»:

```sql
SELECT COUNT(*)
FROM appointments
WHERE doctor_id = X AND date = Y AND time = Z;
```

Если результат `> 0` — запись **блокируется** (HTTP 409) с сообщением
«Запись заблокирована: у врача уже есть приём на …».

## API
| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/doctors` | список врачей |
| POST | `/api/doctors` | добавить врача `{full_name, specialization}` |
| GET | `/api/patients` | список пациентов |
| POST | `/api/patients` | добавить пациента `{full_name, policy}` |
| GET | `/api/schedule?week_start=YYYY-MM-DD` | расписание на неделю |
| POST | `/api/appointments` | новая запись `{doctor_id, patient_id, date, time}` |
| DELETE | `/api/appointments/<id>` | отменить запись |

Как запустить на локальном ПК
Шаг 1. Скачайте и распакуйте архив

Скачайте 
polyclinic.zip
 и распакуйте, например, в C:\Users\Вы\Desktop\polyclinic.
Шаг 2. Установите Python (если ещё нет)

Скачайте с python.org (версия 3.8 или новее).
⚠️ При установке на Windows обязательно поставьте галочку «Add Python to PATH».
Шаг 3. Откройте терминал в папке проекта

Windows: откройте папку polyclinic в проводнике, нажмите на адресную строку, наберите cmd и Enter.
macOS / Linux: откройте Terminal и перейдите в папку: cd ~/Desktop/polyclinic
Шаг 4. Установите зависимости

Bash

pip install -r requirements.txt
(нужен только Flask)

Шаг 5. Запустите сервер

Bash

python app.py
Если на Windows команда python не находится, попробуйте py app.py.

Шаг 6. Откройте в браузере

Перейдите по адресу http://localhost:5000 — откроется приложение.
Готово! 🎉

Как открыть и запустить в Visual Studio Code
1. Установите VS Code

Скачайте с code.visualstudio.com (бесплатно) и установите.
2. Установите расширение Python

В VS Code слева откройте иконку «Расширения» (Extensions, Ctrl+Shift+X) → найдите Python (от Microsoft) → Install.
3. Откройте папку проекта

File → Open Folder… → выберите распакованную папку polyclinic.
4. Выберите интерпретатор Python

Ctrl+Shift+P → наберите Python: Select Interpreter → выберите ваш Python (где установлен Flask).
5. Установите зависимость

Откройте терминал в VS Code: Terminal → New Terminal (или Ctrl+`` ). Он сразу откроется в папке проекта. Выполните:
Bash

pip install -r requirements.txt
6. Запустите приложение (любой из способов)

Кнопкой: откройте файл app.py и нажмите зелёную стрелку ▷ в правом верхнем углу, либо
F5 (настроенный мной launch.json запустит Flask в режиме отладки), либо
в терминале: python app.py
7. Откройте в браузере

Перейдите на http://localhost:5000. VS Code может сам предложить открыть ссылку — нажмите «Open in Browser».
Остановить: кнопка «Стоп» (красный квадрат) на панели отладки или Ctrl+C в терминале.