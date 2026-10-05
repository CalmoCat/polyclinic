"use strict";

const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const PALETTE = ["#0f766e", "#2563eb", "#a855f7", "#d97706", "#db2777", "#0891b2", "#4f46e5", "#65a30d", "#e11d48", "#475569"];

const state = {
  weekStart: null,
  days: [],
  today: null,
  slots: [],
  appointments: [],
  doctors: [],
  patients: [],
  adminDoctors: [],
  adminPatients: [],
  adminAppointments: [],
  adminAuthenticated: false,
  adminConfigured: false,
  csrfToken: null,
  adminSection: "doctors",
  appointmentScope: "upcoming",
  editingDoctorId: null,
  editingPatientId: null,
  availabilityRequest: 0,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function colorFor(id) {
  const index = Math.abs(Number(id) || 0) % PALETTE.length;
  return PALETTE[index];
}

function toISO(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function parseLocalDate(iso) {
  return new Date(iso + "T12:00:00");
}

function weekStartFor(iso) {
  const date = parseLocalDate(iso);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return toISO(date);
}

function formatDate(iso, options = { day: "2-digit", month: "2-digit", year: "numeric" }) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("ru-RU", options).format(parseLocalDate(iso));
}

function dayLabel(iso) {
  const date = parseLocalDate(iso);
  return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function setMessage(element, message, kind = "error") {
  element.textContent = message || "";
  element.classList.toggle("error", Boolean(message) && kind === "error");
  element.classList.toggle("success", Boolean(message) && kind === "success");
}

async function api(url, options = {}) {
  const opts = { ...options };
  const headers = new Headers(opts.headers || {});
  delete opts.adminRequest;
  if (options.adminRequest && state.csrfToken) {
    headers.set("X-CSRF-Token", state.csrfToken);
  }
  opts.headers = headers;
  let response;
  try {
    response = await fetch(url, opts);
  } catch (_error) {
    throw new Error("Не удалось связаться с сервером. Проверьте подключение и повторите попытку.");
  }
  let body = null;
  try { body = await response.json(); } catch (_error) { /* ответ может быть пустым */ }
  if (!response.ok) {
    const error = new Error((body && body.error) || `Ошибка ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function adminApi(url, options = {}) {
  return api(url, { ...options, adminRequest: true });
}

let toastTimer;
function toast(message, kind = "ok") {
  const element = $("#toast");
  element.textContent = message;
  element.className = `show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { element.className = ""; }, 3500);
}

function handleAdminError(error) {
  if (error.status === 401 || error.status === 403) {
    state.adminAuthenticated = false;
    state.csrfToken = null;
    updateAuthUI();
    showView("work");
  }
  toast(error.message, "error");
}

/* ── Расписание ───────────────────────────────────────────── */
async function loadSchedule() {
  const query = state.weekStart ? `?week_start=${encodeURIComponent(state.weekStart)}` : "";
  const data = await api(`/api/schedule${query}`);
  state.weekStart = data.week_start;
  state.days = data.days;
  state.today = data.today;
  state.slots = data.slots;
  state.appointments = data.appointments;
  $("#todayLabel").textContent = formatDate(state.today, { weekday: "long", day: "numeric", month: "long" });
  $("#dateInput").min = state.today;
  if (!$("#dateInput").value) $("#dateInput").value = state.today;
  renderSchedule();
}

function appointmentChip(appointment) {
  const cancelButton = state.adminAuthenticated
    ? `<button class="appointment-cancel" type="button" data-id="${appointment.id}" aria-label="Отменить запись ${esc(appointment.patient)}" title="Отменить запись">×</button>`
    : "";
  return `<div class="appointment-chip" style="--doctor-color:${colorFor(appointment.doctor_id)}">
    <b>${esc(appointment.doctor)}</b><span>${esc(appointment.patient)}</span>${cancelButton}
  </div>`;
}

function renderSchedule() {
  if (!state.days.length) return;
  $("#weekLabel").textContent = `${dayLabel(state.days[0])} — ${dayLabel(state.days[6])}`;
  let html = "<thead><tr><th class='time-col' scope='col'>Время</th>";
  state.days.forEach((date) => {
    const day = parseLocalDate(date);
    const weekday = WEEKDAYS_SHORT[(day.getDay() + 6) % 7];
    const isToday = date === state.today;
    html += `<th scope="col" class="${isToday ? "today" : ""}"><span class="dow">${weekday}</span><span class="dnum">${dayLabel(date)}</span></th>`;
  });
  html += "</tr></thead><tbody>";
  state.slots.forEach((time) => {
    html += `<tr><th scope="row" class="time-col">${esc(time)}</th>`;
    state.days.forEach((date) => {
      const appointments = state.appointments.filter((item) => item.date === date && item.time === time);
      html += `<td class="schedule-cell">${appointments.map(appointmentChip).join("")}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody>";
  $("#scheduleGrid").innerHTML = html;
  $("#scheduleHint").hidden = state.adminAuthenticated;
}

function renderLegend() {
  $("#legend").innerHTML = state.doctors.map((doctor) =>
    `<span class="legend-item"><span class="legend-dot" style="background:${colorFor(doctor.id)}"></span><span>${esc(doctor.full_name)} <small>${esc(doctor.specialization)}</small></span></span>`
  ).join("") || '<span class="quiet-note">Активных врачей пока нет.</span>';
}

function shiftWeek(delta) {
  if (!state.weekStart) return;
  const date = parseLocalDate(state.weekStart);
  date.setDate(date.getDate() + delta * 7);
  state.weekStart = toISO(date);
  loadSchedule().catch((error) => toast(error.message, "error"));
}

async function cancelAppointment(id) {
  if (!state.adminAuthenticated) return;
  if (!window.confirm("Отменить запись? Освободившееся время снова станет доступно для записи.")) return;
  try {
    await adminApi(`/api/appointments/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("Запись отменена, время освобождено");
    await Promise.all([loadSchedule(), refreshAvailability()]);
    if (state.adminAuthenticated) await loadAdminData();
  } catch (error) {
    handleAdminError(error);
  }
}

/* ── Справочники для регистратуры ─────────────────────────── */
async function loadDoctors() {
  state.doctors = await api("/api/doctors");
  const select = $("#doctorSelect");
  const selected = select.value;
  select.innerHTML = '<option value="">— Выберите врача —</option>' + state.doctors.map((doctor) =>
    `<option value="${doctor.id}">${esc(doctor.full_name)} — ${esc(doctor.specialization)}</option>`
  ).join("");
  select.value = state.doctors.some((doctor) => String(doctor.id) === selected) ? selected : "";
  select.disabled = state.doctors.length === 0;
  renderDoctors();
  renderLegend();
}

async function loadPatients() {
  state.patients = await api("/api/patients");
  const select = $("#patientSelect");
  const selected = select.value;
  select.innerHTML = '<option value="">— Выберите пациента —</option>' + state.patients.map((patient) =>
    `<option value="${patient.id}">${esc(patient.full_name)}</option>`
  ).join("");
  select.value = state.patients.some((patient) => String(patient.id) === selected) ? selected : "";
  select.disabled = state.patients.length === 0;
  renderPatients();
}

function renderDoctors() {
  const query = $("#doctorSearch").value.trim().toLocaleLowerCase("ru");
  const doctors = state.doctors.filter((doctor) => `${doctor.full_name} ${doctor.specialization}`.toLocaleLowerCase("ru").includes(query));
  $("#doctorList").innerHTML = doctors.map((doctor) =>
    `<li><span class="directory-avatar" style="--doctor-color:${colorFor(doctor.id)}">${esc(doctor.full_name.trim().charAt(0))}</span><span class="directory-copy"><b>${esc(doctor.full_name)}</b><small>${esc(doctor.specialization)}</small></span><span class="directory-chevron" aria-hidden="true">›</span></li>`
  ).join("") || '<li class="empty-state">Врачи не найдены</li>';
}

function renderPatients() {
  const query = $("#patientSearch").value.trim().toLocaleLowerCase("ru");
  const patients = state.patients.filter((patient) => `${patient.full_name} ${patient.policy}`.toLocaleLowerCase("ru").includes(query));
  $("#patientList").innerHTML = patients.map((patient) =>
    `<li><button class="patient-pick" type="button" data-id="${patient.id}" aria-label="Выбрать пациента ${esc(patient.full_name)}"><span class="patient-avatar">${esc(patient.full_name.trim().charAt(0))}</span><span class="directory-copy"><b>${esc(patient.full_name)}</b><small>Полис: ${esc(patient.policy)}</small></span><span class="directory-chevron" aria-hidden="true">›</span></button></li>`
  ).join("") || '<li class="empty-state">Пациенты не найдены</li>';
}

/* ── Проверка доступности слотов ───────────────────────────── */
async function refreshAvailability() {
  const select = $("#timeSelect");
  const doctorId = $("#doctorSelect").value;
  const date = $("#dateInput").value;
  const requestId = ++state.availabilityRequest;
  if (!doctorId || !date) {
    select.innerHTML = '<option value="">Выберите врача и дату</option>';
    select.disabled = true;
    return;
  }
  select.innerHTML = '<option value="">Проверяем свободное время…</option>';
  select.disabled = true;
  try {
    const result = await api(`/api/availability?doctor_id=${encodeURIComponent(doctorId)}&date=${encodeURIComponent(date)}`);
    if (requestId !== state.availabilityRequest) return;
    const booked = new Set(result.booked);
    select.innerHTML = '<option value="">— Выберите время —</option>' + result.slots.map((slot) =>
      `<option value="${esc(slot)}" ${booked.has(slot) ? "disabled" : ""}>${esc(slot)}${booked.has(slot) ? " — занято" : ""}</option>`
    ).join("");
    select.disabled = result.slots.length === 0 || result.available.length === 0;
    if (result.available.length === 0) {
      select.innerHTML = '<option value="">Свободного времени нет</option>';
    }
  } catch (error) {
    if (requestId !== state.availabilityRequest) return;
    select.innerHTML = '<option value="">Не удалось загрузить время</option>';
    select.disabled = true;
    setMessage($("#formMsg"), error.message);
  }
}

async function submitAppointment(event) {
  event.preventDefault();
  const message = $("#formMsg");
  setMessage(message, "");
  const payload = {
    doctor_id: $("#doctorSelect").value,
    patient_id: $("#patientSelect").value,
    date: $("#dateInput").value,
    time: $("#timeSelect").value,
  };
  const submit = $("#submitAppointment");
  submit.disabled = true;
  try {
    const created = await api("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.weekStart = weekStartFor(created.date);
    $("#patientSelect").value = "";
    $("#timeSelect").value = "";
    setMessage(message, `Запись создана на ${formatDate(created.date)} в ${created.time}.`, "success");
    toast("Запись успешно создана");
    await loadSchedule();
    await refreshAvailability();
    if (state.adminAuthenticated) await loadAdminData();
  } catch (error) {
    setMessage(message, error.message);
    if (error.status === 409) await refreshAvailability();
  } finally {
    submit.disabled = false;
  }
}

/* ── Авторизация и экран администратора ───────────────────── */
function updateAuthUI() {
  $("#adminTab").hidden = !state.adminAuthenticated;
  $("#adminLoginBtn").hidden = state.adminAuthenticated;
  $("#adminLogoutBtn").hidden = !state.adminAuthenticated;
  $("#adminBadge").hidden = !state.adminAuthenticated;
  $("#adminSetupHint").hidden = state.adminConfigured;
  $("#loginSubmit").disabled = !state.adminConfigured;
  $("#manageDoctorsBtn").textContent = state.adminAuthenticated ? "Управлять →" : "Для администратора ↗";
  renderSchedule();
}

async function checkAdminSession() {
  const status = await api("/api/admin/session");
  state.adminConfigured = status.configured;
  state.adminAuthenticated = status.authenticated;
  state.csrfToken = status.csrf_token;
  updateAuthUI();
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function showView(view, refreshAdmin = true) {
  const isAdmin = view === "admin" && state.adminAuthenticated;
  $("#workView").hidden = isAdmin;
  $("#adminView").hidden = !isAdmin;
  $("#workTab").classList.toggle("active", !isAdmin);
  $("#workTab").toggleAttribute("aria-current", !isAdmin);
  if (!isAdmin) $("#workTab").setAttribute("aria-current", "page");
  else $("#workTab").removeAttribute("aria-current");
  $("#adminTab").classList.toggle("active", isAdmin);
  if (isAdmin) {
    $("#adminTab").setAttribute("aria-current", "page");
    if (refreshAdmin) loadAdminData().catch(handleAdminError);
  } else {
    $("#adminTab").removeAttribute("aria-current");
  }
}

async function login(event) {
  event.preventDefault();
  const message = $("#loginMsg");
  setMessage(message, "");
  const button = $("#loginSubmit");
  button.disabled = true;
  try {
    const result = await api("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("#adminPassword").value }),
    });
    state.adminAuthenticated = true;
    state.csrfToken = result.csrf_token;
    $("#adminPassword").value = "";
    $("#loginDialog").close();
    updateAuthUI();
    showView("admin", false);
    await Promise.all([loadSchedule(), loadDoctors(), loadPatients()]);
    await loadAdminData();
    toast("Вы вошли в панель администратора");
  } catch (error) {
    setMessage(message, error.message);
  } finally {
    button.disabled = !state.adminConfigured;
  }
}

async function logout() {
  try {
    await adminApi("/api/admin/logout", { method: "POST" });
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) toast(error.message, "error");
  }
  state.adminAuthenticated = false;
  state.csrfToken = null;
  updateAuthUI();
  showView("work");
  toast("Вы вышли из панели администратора");
}

function switchAdminSection(section) {
  state.adminSection = section;
  $$(".admin-tab").forEach((button) => {
    const selected = button.dataset.adminSection === section;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  $("#adminDoctorsPanel").hidden = section !== "doctors";
  $("#adminPatientsPanel").hidden = section !== "patients";
  $("#adminAppointmentsPanel").hidden = section !== "appointments";
}

async function loadAdminData() {
  if (!state.adminAuthenticated) return;
  const scope = $("#appointmentScope").value || "upcoming";
  const [summary, doctors, patients, appointments] = await Promise.all([
    adminApi("/api/admin/summary"),
    adminApi("/api/admin/doctors"),
    adminApi("/api/admin/patients"),
    adminApi(`/api/admin/appointments?scope=${encodeURIComponent(scope)}&limit=100`),
  ]);
  state.adminDoctors = doctors;
  state.adminPatients = patients;
  state.adminAppointments = appointments.appointments;
  $("#statDoctors").textContent = summary.active_doctors;
  $("#statPatients").textContent = summary.active_patients;
  $("#statToday").textContent = summary.today_appointments;
  $("#statUpcoming").textContent = summary.upcoming_appointments;
  $("#doctorCountBadge").textContent = summary.active_doctors;
  renderAdminDoctors();
  renderAdminPatients();
  renderAdminAppointments(appointments);
}

function renderAdminDoctors() {
  const query = $("#doctorAdminSearch").value.trim().toLocaleLowerCase("ru");
  const doctors = state.adminDoctors.filter((doctor) => `${doctor.full_name} ${doctor.specialization}`.toLocaleLowerCase("ru").includes(query));
  $("#adminDoctorsTable").innerHTML = doctors.map((doctor) => {
    const active = Boolean(doctor.is_active);
    const actions = active
      ? `<button class="table-action" type="button" data-action="edit" data-id="${doctor.id}">Изменить</button><button class="table-action danger" type="button" data-action="archive" data-id="${doctor.id}">Удалить</button>`
      : `<button class="table-action" type="button" data-action="restore" data-id="${doctor.id}">Восстановить</button>`;
    return `<tr>
      <td><div class="table-person"><span class="directory-avatar small" style="--doctor-color:${colorFor(doctor.id)}">${esc(doctor.full_name.trim().charAt(0))}</span><b>${esc(doctor.full_name)}</b></div></td>
      <td>${esc(doctor.specialization)}</td><td>${doctor.upcoming_appointments}</td>
      <td><span class="status-pill ${active ? "status-active" : "status-archived"}">${active ? "Активен" : "В архиве"}</span></td>
      <td class="actions-cell">${actions}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="5" class="table-empty">По запросу ничего не найдено.</td></tr>';
}

function renderAdminPatients() {
  const query = $("#patientAdminSearch").value.trim().toLocaleLowerCase("ru");
  const patients = state.adminPatients.filter((patient) => `${patient.full_name} ${patient.policy}`.toLocaleLowerCase("ru").includes(query));
  $("#adminPatientsTable").innerHTML = patients.map((patient) => {
    const active = Boolean(patient.is_active);
    const actions = active
      ? `<button class="table-action" type="button" data-action="edit" data-id="${patient.id}">Изменить</button><button class="table-action danger" type="button" data-action="archive" data-id="${patient.id}">В архив</button>`
      : `<button class="table-action" type="button" data-action="restore" data-id="${patient.id}">Восстановить</button>`;
    return `<tr>
      <td><div class="table-person"><span class="patient-avatar small">${esc(patient.full_name.trim().charAt(0))}</span><b>${esc(patient.full_name)}</b></div></td>
      <td>${esc(patient.policy)}</td><td>${patient.upcoming_appointments}</td>
      <td><span class="status-pill ${active ? "status-active" : "status-archived"}">${active ? "Активен" : "В архиве"}</span></td>
      <td class="actions-cell">${actions}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="5" class="table-empty">По запросу ничего не найдено.</td></tr>';
}

function renderAdminAppointments(result) {
  const appointments = result.appointments || [];
  $("#adminAppointmentsTable").innerHTML = appointments.map((appointment) =>
    `<tr>
      <td><b>${formatDate(appointment.date)}</b><small class="table-subline">${esc(appointment.time)}</small></td>
      <td>${esc(appointment.patient)}</td>
      <td><div class="table-person"><span class="legend-dot" style="background:${colorFor(appointment.doctor_id)}"></span><span>${esc(appointment.doctor)}<small class="table-subline">${esc(appointment.specialization)}</small></span></div></td>
      <td class="actions-cell"><button class="table-action danger" type="button" data-action="cancel" data-id="${appointment.id}">Отменить</button></td>
    </tr>`
  ).join("") || '<tr><td colspan="4" class="table-empty">Записей в выбранном периоде нет.</td></tr>';
  const qualifier = result.scope === "upcoming" ? "ближайшие" : "последние";
  const footnote = result.total > result.limit
    ? `Показаны ${qualifier} ${result.limit} записей из ${result.total}.`
    : `Всего записей: ${result.total}.`;
  $("#appointmentListFootnote").textContent = footnote;
}

/* ── Добавление и редактирование врачей и пациентов ───────── */
function openDoctorDialog(doctor = null) {
  if (!state.adminAuthenticated) return openLoginDialog();
  state.editingDoctorId = doctor ? doctor.id : null;
  $("#doctorDialogTitle").textContent = doctor ? "Изменить данные врача" : "Новый врач";
  $("#doctorSubmit").textContent = doctor ? "Сохранить изменения" : "Добавить врача";
  $("#doctorForm").reset();
  $("#doctorName").value = doctor ? doctor.full_name : "";
  $("#doctorSpecialty").value = doctor ? doctor.specialization : "";
  setMessage($("#doctorFormMsg"), "");
  openDialog("doctorDialog");
  window.setTimeout(() => $("#doctorName").focus(), 0);
}

function openPatientDialog(patient = null) {
  state.editingPatientId = patient ? patient.id : null;
  $("#patientDialogTitle").textContent = patient ? "Изменить данные пациента" : "Новый пациент";
  $("#patientSubmit").textContent = patient ? "Сохранить изменения" : "Добавить пациента";
  $("#patientForm").reset();
  $("#patientName").value = patient ? patient.full_name : "";
  $("#patientPolicy").value = patient ? patient.policy : "";
  setMessage($("#patientFormMsg"), "");
  openDialog("patientDialog");
  window.setTimeout(() => $("#patientName").focus(), 0);
}

async function submitDoctor(event) {
  event.preventDefault();
  const isEdit = state.editingDoctorId !== null;
  const button = $("#doctorSubmit");
  button.disabled = true;
  setMessage($("#doctorFormMsg"), "");
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await adminApi(isEdit ? `/api/doctors/${state.editingDoctorId}` : "/api/doctors", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    $("#doctorDialog").close();
    state.editingDoctorId = null;
    toast(isEdit ? "Данные врача обновлены" : "Врач добавлен в справочник");
    await Promise.all([loadDoctors(), loadAdminData()]);
  } catch (error) {
    if (error.status === 401 || error.status === 403) handleAdminError(error);
    else setMessage($("#doctorFormMsg"), error.message);
  } finally {
    button.disabled = false;
  }
}

async function submitPatient(event) {
  event.preventDefault();
  const isEdit = state.editingPatientId !== null;
  const button = $("#patientSubmit");
  button.disabled = true;
  setMessage($("#patientFormMsg"), "");
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const created = await (isEdit
      ? adminApi(`/api/patients/${state.editingPatientId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        })
      : api("/api/patients", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        }));
    $("#patientDialog").close();
    state.editingPatientId = null;
    await loadPatients();
    if (!isEdit && created.id) $("#patientSelect").value = String(created.id);
    toast(isEdit ? "Данные пациента обновлены" : "Пациент добавлен в картотеку");
    if (state.adminAuthenticated) await loadAdminData();
  } catch (error) {
    if (error.status === 401 || error.status === 403) handleAdminError(error);
    else setMessage($("#patientFormMsg"), error.message);
  } finally {
    button.disabled = false;
  }
}

async function doctorAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const doctor = state.adminDoctors.find((item) => String(item.id) === button.dataset.id);
  if (!doctor) return;
  if (button.dataset.action === "edit") return openDoctorDialog(doctor);
  try {
    if (button.dataset.action === "archive") {
      if (!window.confirm(`Переместить врача «${doctor.full_name}» в архив? Старые приёмы сохранятся, новые записать будет нельзя.`)) return;
      await adminApi(`/api/doctors/${doctor.id}`, { method: "DELETE" });
      toast("Врач перенесён в архив");
    } else if (button.dataset.action === "restore") {
      await adminApi(`/api/doctors/${doctor.id}/restore`, { method: "POST" });
      toast("Врач восстановлен");
    }
    await Promise.all([loadDoctors(), loadAdminData()]);
  } catch (error) {
    handleAdminError(error);
  }
}

async function patientAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const patient = state.adminPatients.find((item) => String(item.id) === button.dataset.id);
  if (!patient) return;
  if (button.dataset.action === "edit") return openPatientDialog(patient);
  try {
    if (button.dataset.action === "archive") {
      if (!window.confirm(`Переместить карточку «${patient.full_name}» в архив? История приёмов сохранится.`)) return;
      await adminApi(`/api/patients/${patient.id}`, { method: "DELETE" });
      toast("Карточка пациента перенесена в архив");
    } else if (button.dataset.action === "restore") {
      await adminApi(`/api/patients/${patient.id}/restore`, { method: "POST" });
      toast("Карточка пациента восстановлена");
    }
    await Promise.all([loadPatients(), loadAdminData()]);
  } catch (error) {
    handleAdminError(error);
  }
}

/* ── Инициализация ────────────────────────────────────────── */
function openLoginDialog() {
  setMessage($("#loginMsg"), "");
  $("#adminSetupHint").hidden = state.adminConfigured;
  $("#loginSubmit").disabled = !state.adminConfigured;
  openDialog("loginDialog");
  window.setTimeout(() => $("#adminPassword").focus(), 0);
}

async function refreshEverything() {
  try {
    await Promise.all([loadDoctors(), loadPatients(), loadSchedule()]);
    await refreshAvailability();
    if (state.adminAuthenticated) await loadAdminData();
    toast("Данные обновлены");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function init() {
  $("#prevWeek").addEventListener("click", () => shiftWeek(-1));
  $("#nextWeek").addEventListener("click", () => shiftWeek(1));
  $("#currentWeek").addEventListener("click", () => {
    state.weekStart = null;
    loadSchedule().catch((error) => toast(error.message, "error"));
  });
  $("#refreshBtn").addEventListener("click", refreshEverything);
  $("#adminLoginBtn").addEventListener("click", openLoginDialog);
  $("#adminRefreshBtn").addEventListener("click", () => loadAdminData().catch(handleAdminError));
  $("#doctorSearch").addEventListener("input", renderDoctors);
  $("#patientSearch").addEventListener("input", renderPatients);
  $("#doctorSelect").addEventListener("change", () => {
    setMessage($("#formMsg"), "");
    refreshAvailability();
  });
  $("#dateInput").addEventListener("change", () => {
    setMessage($("#formMsg"), "");
    refreshAvailability();
  });
  $("#apptForm").addEventListener("submit", submitAppointment);
  $("#scheduleGrid").addEventListener("click", (event) => {
    const button = event.target.closest("button.appointment-cancel");
    if (button) cancelAppointment(button.dataset.id);
  });
  $("#patientList").addEventListener("click", (event) => {
    const button = event.target.closest("button.patient-pick");
    if (!button) return;
    $("#patientSelect").value = button.dataset.id;
    $("#patientSelect").focus();
    toast("Пациент выбран для записи");
  });
  $("#addPatientBtn").addEventListener("click", () => openPatientDialog());
  $("#addAdminPatientBtn").addEventListener("click", () => openPatientDialog());
  $("#addDoctorBtn").addEventListener("click", () => openDoctorDialog());
  $("#manageDoctorsBtn").addEventListener("click", () => {
    if (!state.adminAuthenticated) return openLoginDialog();
    showView("admin");
    switchAdminSection("doctors");
  });
  $("#doctorForm").addEventListener("submit", submitDoctor);
  $("#patientForm").addEventListener("submit", submitPatient);
  $("#loginForm").addEventListener("submit", login);
  $("#adminLogoutBtn").addEventListener("click", logout);
  $("#workTab").addEventListener("click", () => showView("work"));
  $("#adminTab").addEventListener("click", () => showView("admin"));
  $("#adminDoctorsTable").addEventListener("click", doctorAction);
  $("#adminPatientsTable").addEventListener("click", patientAction);
  $("#adminAppointmentsTable").addEventListener("click", (event) => {
    const button = event.target.closest('button[data-action="cancel"]');
    if (button) cancelAppointment(button.dataset.id);
  });
  $("#doctorAdminSearch").addEventListener("input", renderAdminDoctors);
  $("#patientAdminSearch").addEventListener("input", renderAdminPatients);
  $("#appointmentScope").addEventListener("change", () => {
    state.appointmentScope = $("#appointmentScope").value;
    loadAdminData().catch(handleAdminError);
  });
  $$(".admin-tab").forEach((button) => button.addEventListener("click", () => switchAdminSection(button.dataset.adminSection)));
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => {
    const dialog = document.getElementById(button.dataset.closeDialog);
    if (dialog) dialog.close();
  }));
  $("#loginDialog").addEventListener("close", () => {
    $("#adminPassword").value = "";
    setMessage($("#loginMsg"), "");
  });
  $("#doctorDialog").addEventListener("close", () => { state.editingDoctorId = null; });
  $("#patientDialog").addEventListener("close", () => { state.editingPatientId = null; });

  try {
    await checkAdminSession();
    await Promise.all([loadDoctors(), loadPatients(), loadSchedule()]);
    await refreshAvailability();
    if (state.adminAuthenticated) {
      showView("admin", false);
      await loadAdminData();
    }
  } catch (error) {
    toast(`Не удалось загрузить данные: ${error.message}`, "error");
  }
}

document.addEventListener("DOMContentLoaded", init, { once: true });
