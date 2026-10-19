"use strict";

/* ==========================================================================
   Поликлиника — регистратура. Логика интерфейса.
   ========================================================================== */

const SLOTS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"];
const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WEEKDAYS_FULL = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];
const PALETTE = ["#0f766e", "#2563eb", "#b45309", "#7c3aed", "#be123c", "#0891b2", "#4d7c0f", "#c2410c", "#4338ca", "#a21caf"];

const state = {
  weekStart: null,
  days: [],
  today: null,
  appointments: [],
  doctors: [],
  patients: [],
  date: null,
  time: null,
  pendingDelete: null,
  activeTab: "patients",
};

const $ = (id) => document.getElementById(id);

/* ── Утилиты ─────────────────────────────────────────────── */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function colorFor(id) { return PALETTE[(id - 1) % PALETTE.length]; }
function toISO(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function isoDate(iso) { return new Date(iso + "T12:00:00"); }
function ddmm(iso) {
  const d = isoDate(iso);
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
}
function weekdayOf(iso) { return (isoDate(iso).getDay() + 6) % 7; }
function initials(name) {
  return String(name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}
function nowMinutes() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
function slotMinutes(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

async function api(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* пустой ответ */ }
  if (!res.ok) throw new Error((body && body.error) || ("Ошибка " + res.status));
  return body;
}
function postJSON(url, data) {
  return api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

let toastTimer;
function toast(text, kind) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast show " + (kind || "ok");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 3600);
}

/* ── Расписание ──────────────────────────────────────────── */
async function loadSchedule() {
  const url = state.weekStart ? `/api/schedule?week_start=${state.weekStart}` : "/api/schedule";
  const data = await api(url);
  state.weekStart = data.week_start;
  state.days = data.days;
  state.today = data.today;
  state.appointments = data.appointments;
  renderSchedule();
  renderStats();
  const empty = $("weekEmpty");
  if (empty) empty.hidden = state.appointments.length > 0;
  renderDayChips();
  renderSlots();
}

function appointmentsAt(date, time) {
  return state.appointments.filter((a) => a.date === date && a.time === time);
}

function chipHTML(a) {
  return `<button type="button" class="chip" style="--c:${colorFor(a.doctor_id)}"
      data-appt="${a.id}" title="${esc(a.doctor)} — ${esc(a.patient)}, ${esc(a.time)}">
      <b>${esc(a.doctor.split(" ").slice(0, 2).join(" "))}</b>
      <i>${esc(a.patient.split(" ").slice(0, 2).join(" "))}</i>
    </button>`;
}

function renderSchedule() {
  $("weekLabel").textContent = ddmm(state.days[0]) + " — " + ddmm(state.days[6]);

  let html = "<thead><tr><th class='time-col' scope='col'>Время</th>";
  state.days.forEach((d) => {
    const dt = isoDate(d);
    const wd = WEEKDAYS_SHORT[weekdayOf(d)];
    const isToday = d === state.today;
    const isPast = d < state.today;
    html += `<th class="${isToday ? "today" : ""}${isPast ? " past" : ""}" scope="col">
        <span class="dow">${wd}</span><span class="dnum">${String(dt.getDate()).padStart(2, "0")}</span>
      </th>`;
  });
  html += "</tr></thead><tbody>";

  SLOTS.forEach((t) => {
    html += `<tr><th class="time-col" scope="row">${t}</th>`;
    state.days.forEach((d) => {
      const appts = appointmentsAt(d, t);
      const wd = weekdayOf(d);
      const isPast = d < state.today;
      const isSelected = state.date === d && state.time === t;
      const weekend = wd >= 5 ? " weekend" : "";
      html += `<td class="cell${isPast ? " past" : ""}${weekend}${isSelected ? " selected" : ""}"
          data-date="${d}" data-time="${t}">
          <div class="cell-inner">
            ${appts.map(chipHTML).join("")}
            ${appts.length ? "" : `<button type="button" class="cell-add" tabindex="-1" aria-hidden="true">+</button>`}
          </div>
        </td>`;
    });
    html += "</tr>";
  });
  html += "</tbody>";
  $("scheduleGrid").innerHTML = html;
}

function renderStats() {
  const week = state.appointments.length;
  const today = state.appointments.filter((a) => a.date === state.today).length;
  const items = [
    { v: week, l: "приёмов за неделю", cls: "" },
    { v: today, l: "сегодня", cls: "accent" },
    { v: state.doctors.length, l: "врачей", cls: "" },
    { v: state.patients.length, l: "пациентов", cls: "" },
  ];
  $("stats").innerHTML = items.map((i) =>
    `<div class="stat ${i.cls}"><span class="stat-value">${i.v}</span><span class="stat-label">${i.l}</span></div>`
  ).join("");
}

function renderLegend() {
  $("legend").innerHTML = state.doctors.map((d) =>
    `<span class="legend-item"><span class="dot" style="background:${colorFor(d.id)}"></span>${esc(d.full_name)} — ${esc(d.specialization)}</span>`
  ).join("");
}

function shiftWeek(delta) {
  const d = isoDate(state.weekStart);
  d.setDate(d.getDate() + delta * 7);
  state.weekStart = toISO(d);
  loadSchedule().catch((e) => toast(e.message, "error"));
}

function goToday() {
  state.weekStart = null;
  loadSchedule().then(() => {
    setDate(state.today, false);
  }).catch((e) => toast(e.message, "error"));
}

/* ── Выбор даты и времени ────────────────────────────────── */
function setDate(iso, openSlots = true) {
  state.date = iso || null;
  $("dateInput").value = state.date || "";
  renderDayChips();
  renderSlots();
  renderSchedule();
  if (openSlots) $("slotGrid").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setTime(t) {
  state.time = t || null;
  renderSlots();
  renderSchedule();
}

function setDoctor(id) {
  $("doctorId").value = id || "";
  const doc = state.doctors.find((d) => String(d.id) === String(id));
  $("doctorInput").value = doc ? `${doc.full_name} — ${doc.specialization}` : "";
  renderSlots();
}

function setPatient(id) {
  $("patientId").value = id || "";
  const p = state.patients.find((x) => String(x.id) === String(id));
  $("patientInput").value = p ? p.full_name : "";
}

function renderDayChips() {
  const wrap = $("dayChips");
  if (!state.days.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = state.days.map((d) => {
    const dt = isoDate(d);
    const active = state.date === d ? " active" : "";
    const today = d === state.today ? " today" : "";
    const past = d < state.today ? " disabled" : "";
    return `<button type="button" class="day-chip${active}${today}${past}" data-date="${d}"
        ${past ? "disabled" : ""} aria-pressed="${state.date === d}">
        <span class="wd">${WEEKDAYS_SHORT[weekdayOf(d)]}</span>
        <span class="dn">${String(dt.getDate()).padStart(2, "0")}</span>
      </button>`;
  }).join("");
}

function slotsTakenByDoctor(date) {
  const doctorId = $("doctorId").value;
  const taken = new Set();
  if (!doctorId || !date) return taken;
  state.appointments.forEach((a) => {
    if (String(a.doctor_id) === doctorId && a.date === date) taken.add(a.time);
  });
  return taken;
}

function renderSlots() {
  const date = state.date;
  const taken = slotsTakenByDoctor(date);
  const isPastDay = date ? date < state.today : false;
  const isToday = date === state.today;
  let shownTime = false;

  $("slotGrid").innerHTML = SLOTS.map((t) => {
    const occupied = taken.has(t);
    const passed = isPastDay || (isToday && slotMinutes(t) <= nowMinutes());
    const disabled = occupied || passed;
    const active = state.time === t && !disabled;
    if (active) shownTime = true;
    const note = occupied ? "занято" : passed ? "прошло" : "свободно";
    return `<button type="button" class="slot${active ? " active" : ""}" data-time="${t}"
        ${disabled ? "disabled" : ""} aria-pressed="${active}">
        <span>${t}</span><small>${note}</small>
      </button>`;
  }).join("");

  // Если выбранное время стало недоступным — снимаем выбор.
  if (state.time && !shownTime) state.time = null;

  let note;
  if (!date) note = "Сначала выберите дату.";
  else if (!$("doctorId").value) note = "Выберите врача — занятые часы станут недоступны.";
  else if (isPastDay) note = "Дата уже прошла — выберите другой день.";
  else note = "Серые часы заняты у выбранного врача или уже прошли.";
  $("slotNote").textContent = note;
}

/* ── Комбобокс ───────────────────────────────────────────── */
function setupCombo({ inputId, listId, comboId, hiddenId, getItems, labelOf, subOf, onPick }) {
  const input = $(inputId);
  const list = $(listId);
  const combo = $(comboId);
  let activeIndex = -1;
  let items = [];

  function renderList(query) {
    const q = (query || "").trim().toLowerCase();
    items = getItems().filter((it) => labelOf(it, true).toLowerCase().includes(q));
    activeIndex = items.length ? 0 : -1;
    list.innerHTML = items.length
      ? items.map((it, i) =>
          `<div class="combo-option${i === activeIndex ? " active" : ""}" role="option" data-idx="${i}" data-id="${it.id}">
            <b>${esc(labelOf(it, false))}</b>${subOf(it) ? ` — <span>${esc(subOf(it))}</span>` : ""}
          </div>`).join("")
      : '<div class="combo-empty">Ничего не найдено</div>';
  }
  function open(query) {
    renderList(query);
    combo.classList.add("open");
    input.setAttribute("aria-expanded", "true");
  }
  function close() {
    combo.classList.remove("open");
    input.setAttribute("aria-expanded", "false");
    activeIndex = -1;
  }
  function pick(it) {
    $(hiddenId).value = it.id;
    input.value = labelOf(it, false);
    close();
    onPick && onPick(it);
  }
  function highlight(idx) {
    const opts = list.querySelectorAll(".combo-option");
    if (!opts.length) return;
    activeIndex = (idx + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle("active", i === activeIndex));
    opts[activeIndex].scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("focus", () => open(input.value));
  input.addEventListener("blur", () => {
    // Если пользователь ввёл точное название и не выбрал вариант — выбираем сами.
    if ($(hiddenId).value) return;
    const q = input.value.trim().toLowerCase();
    if (!q) return;
    const matches = getItems().filter((it) => labelOf(it, true).toLowerCase().includes(q));
    if (matches.length === 1) pick(matches[0]);
  });
  input.addEventListener("click", () => { if (!combo.classList.contains("open")) open(input.value); });
  input.addEventListener("input", () => {
    $(hiddenId).value = "";
    onPick && onPick(null, true);
    open(input.value);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!combo.classList.contains("open")) open(input.value); else highlight(activeIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlight(activeIndex - 1); }
    else if (e.key === "Enter") {
      if (combo.classList.contains("open") && items[activeIndex]) { e.preventDefault(); pick(items[activeIndex]); }
    } else if (e.key === "Escape") { close(); }
    else if (e.key === "Tab") { close(); }
  });
  list.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".combo-option");
    if (!opt) return;
    e.preventDefault();
    pick(items[Number(opt.dataset.idx)]);
  });
  document.addEventListener("click", (e) => {
    if (!combo.contains(e.target)) close();
  });
  return { close, refresh: () => { if (combo.classList.contains("open")) renderList(input.value); } };
}

let doctorCombo, patientCombo;

function initCombos() {
  doctorCombo = setupCombo({
    inputId: "doctorInput", listId: "doctorComboList", comboId: "doctorCombo", hiddenId: "doctorId",
    getItems: () => state.doctors,
    labelOf: (d, full) => (full ? d.full_name + " " + d.specialization : d.full_name),
    subOf: (d) => d.specialization,
    onPick: (doc) => { if (doc) renderSlots(); else renderSlots(); },
  });
  patientCombo = setupCombo({
    inputId: "patientInput", listId: "patientComboList", comboId: "patientCombo", hiddenId: "patientId",
    getItems: () => state.patients,
    labelOf: (p, full) => (full ? p.full_name + " " + p.policy : p.full_name),
    subOf: (p) => "полис " + p.policy,
    onPick: () => {},
  });
}

/* ── Справочники ─────────────────────────────────────────── */
async function loadDoctors() {
  state.doctors = await api("/api/doctors");
  $("doctorsCount").textContent = state.doctors.length;
  renderLegend();
  renderDoctorList();
  renderStats();
  doctorCombo && doctorCombo.refresh();
}

async function loadPatients() {
  state.patients = await api("/api/patients");
  $("patientsCount").textContent = state.patients.length;
  renderPatients();
  renderStats();
  patientCombo && patientCombo.refresh();
}

function renderDoctorList() {
  const q = ($("doctorSearch").value || "").trim().toLowerCase();
  const items = state.doctors.filter((d) => (d.full_name + " " + d.specialization).toLowerCase().includes(q));
  $("doctorList").innerHTML = items.length ? items.map((d) =>
    `<li class="row" data-doctor="${d.id}" tabindex="0">
      <span class="avatar" style="background:${colorFor(d.id)}">${esc(initials(d.full_name))}</span>
      <span class="row-main"><b>${esc(d.full_name)}</b><small>${esc(d.specialization)}</small></span>
      <button class="btn text small" type="button" data-book-doctor="${d.id}">Записать</button>
    </li>`).join("") : '<li class="empty">Врачи не найдены</li>';
}

function renderPatients() {
  const q = ($("patientSearch").value || "").trim().toLowerCase();
  const items = state.patients.filter((p) => (p.full_name + " " + p.policy).toLowerCase().includes(q));
  $("patientList").innerHTML = items.length ? items.map((p) =>
    `<li class="row" data-patient="${p.id}" tabindex="0">
      <span class="avatar patient">${esc(initials(p.full_name))}</span>
      <span class="row-main"><b>${esc(p.full_name)}</b><small>Полис: ${esc(p.policy)}</small></span>
      <button class="btn text small" type="button" data-book-patient="${p.id}">Записать</button>
    </li>`).join("") : '<li class="empty">Пациенты не найдены</li>';
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  $("tab-patients").classList.toggle("hidden", tab !== "patients");
  $("tab-doctors").classList.toggle("hidden", tab !== "doctors");
}

/* ── Диалоги ─────────────────────────────────────────────── */
function openDialog(dlg) {
  if (!dlg) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}
function closeDialog(dlg) {
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

/* ── Карточка приёма ─────────────────────────────────────── */
function openDetails(apptId) {
  const a = state.appointments.find((x) => String(x.id) === String(apptId));
  if (!a) return;
  const wd = WEEKDAYS_FULL[weekdayOf(a.date)];
  $("detailsBody").innerHTML = `
    <dt>Дата</dt><dd>${wd}, ${ddmm(a.date)}</dd>
    <dt>Время</dt><dd>${esc(a.time)}</dd>
    <dt>Врач</dt><dd>${esc(a.doctor)}<br><span class="hint">${esc(a.specialization)}</span></dd>
    <dt>Пациент</dt><dd>${esc(a.patient)}<br><span class="hint">полис ${esc(a.policy)}</span></dd>`;
  state.pendingDelete = a.id;
  openDialog($("detailsDialog"));
}

/* ── Форма записи ────────────────────────────────────────── */
function validateForm() {
  const msg = $("formMsg");
  msg.className = "msg";
  msg.textContent = "";

  if (!$("doctorId").value) return "Выберите врача из списка.";
  if (!$("patientId").value) return "Выберите пациента из списка.";
  if (!state.date) return "Выберите дату приёма.";
  if (!state.time) return "Выберите свободное время.";
  if (state.date < state.today) return "Нельзя записаться на прошедшую дату.";
  return "";
}

function resetForm() {
  setDoctor("");
  setPatient("");
  state.time = null;
  $("formMsg").className = "msg";
  $("formMsg").textContent = "";
  setDate(state.today, false);
  $("doctorInput").focus();
}

document.addEventListener("DOMContentLoaded", () => {
  /* combobox */
  initCombos();

  /* навигация по неделе */
  $("prevWeek").addEventListener("click", () => shiftWeek(-1));
  $("nextWeek").addEventListener("click", () => shiftWeek(1));
  $("todayBtn").addEventListener("click", goToday);

  /* «Новая запись» — к форме */
  $("newApptBtn").addEventListener("click", () => {
    $("bookingPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    $("doctorInput").focus();
  });
  $("resetForm").addEventListener("click", resetForm);

  /* дата и время */
  $("dateInput").addEventListener("change", (e) => setDate(e.target.value, false));
  $("dayChips").addEventListener("click", (e) => {
    const chip = e.target.closest(".day-chip[data-date]");
    if (chip && !chip.disabled) setDate(chip.dataset.date, false);
  });
  $("slotGrid").addEventListener("click", (e) => {
    const slot = e.target.closest(".slot[data-time]");
    if (slot && !slot.disabled) { setTime(slot.dataset.time); renderSlots(); }
  });

  /* клик по клетке расписания */
  $("scheduleGrid").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-appt]");
    if (chip) { openDetails(chip.dataset.appt); return; }
    const cell = e.target.closest("td.cell[data-date]");
    if (!cell) return;
    setDate(cell.dataset.date, false);
    const t = cell.dataset.time;
    const occupied = slotsTakenByDoctor(cell.dataset.date).has(t);
    const passed = cell.dataset.date < state.today ||
      (cell.dataset.date === state.today && slotMinutes(t) <= nowMinutes());
    state.time = occupied || passed ? null : t;
    renderSlots();
    renderSchedule();
    $("bookingPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    if (occupied) toast("Это время занято у выбранного врача", "error");
    else if (passed) toast("Это время уже прошло", "error");
    else $("patientInput").focus();
  });

  /* отправка формы */
  $("apptForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const problem = validateForm();
    const msg = $("formMsg");
    if (problem) {
      msg.className = "msg error";
      msg.textContent = problem;
      return;
    }
    const payload = {
      doctor_id: $("doctorId").value,
      patient_id: $("patientId").value,
      date: state.date,
      time: state.time,
    };
    $("submitBtn").disabled = true;
    try {
      const created = await postJSON("/api/appointments", payload);
      const doc = state.doctors.find((d) => String(d.id) === String(created.doctor_id));
      msg.className = "msg ok";
      msg.textContent = `Записан: ${doc ? doc.full_name : "пациент"} — ${ddmm(created.date)}, ${created.time}.`;
      toast("Запись создана", "ok");
      state.time = null;
      setPatient("");
      renderSlots();
      await loadSchedule();
      $("patientInput").focus();
    } catch (err) {
      msg.className = "msg error";
      msg.textContent = err.message;
      toast(err.message, "error");
    } finally {
      $("submitBtn").disabled = false;
    }
  });

  /* справочники: вкладки и поиск */
  document.querySelectorAll(".tab").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
  $("patientSearch").addEventListener("input", renderPatients);
  $("doctorSearch").addEventListener("input", renderDoctorList);

  /* «Записать» из справочника */
  $("patientList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-book-patient]");
    const row = e.target.closest("[data-patient]");
    if (!btn && !row) return;
    const id = (btn || row).dataset.bookPatient || row.dataset.patient;
    setPatient(id);
    $("bookingPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Пациент выбран в форме");
  });
  $("doctorList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-book-doctor]");
    const row = e.target.closest("[data-doctor]");
    if (!btn && !row) return;
    const id = (btn || row).dataset.bookDoctor || row.dataset.doctor;
    setDoctor(id);
    $("bookingPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /* диалоги */
  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closeDialog(b.closest("dialog"))));
  document.querySelectorAll("dialog").forEach((dlg) =>
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeDialog(dlg); }));

  $("addPatientBtn").addEventListener("click", () => openDialog($("patientDialog")));
  $("addPatientInline").addEventListener("click", () => openDialog($("patientDialog")));
  $("addDoctorBtn").addEventListener("click", () => openDialog($("doctorDialog")));

  $("patientForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      const created = await postJSON("/api/patients", {
        full_name: form.full_name.value.trim(),
        policy: form.policy.value.trim(),
      });
      form.reset();
      closeDialog($("patientDialog"));
      await loadPatients();
      setPatient(created.id);
      toast("Пациент добавлен и выбран", "ok");
    } catch (err) { toast(err.message, "error"); }
  });

  $("doctorForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      const created = await postJSON("/api/doctors", {
        full_name: form.full_name.value.trim(),
        specialization: form.specialization.value.trim(),
      });
      form.reset();
      closeDialog($("doctorDialog"));
      await loadDoctors();
      setDoctor(created.id);
      toast("Врач добавлен и выбран", "ok");
    } catch (err) { toast(err.message, "error"); }
  });

  /* отмена записи: карточка → подтверждение */
  $("deleteApptBtn").addEventListener("click", () => {
    const a = state.appointments.find((x) => String(x.id) === String(state.pendingDelete));
    if (!a) return;
    closeDialog($("detailsDialog"));
    $("confirmText").textContent =
      `${a.patient} → ${a.doctor}, ${ddmm(a.date)} в ${a.time}. Запись будет удалена из журнала.`;
    openDialog($("confirmDialog"));
  });

  $("confirmYes").addEventListener("click", async () => {
    const id = state.pendingDelete;
    closeDialog($("confirmDialog"));
    if (!id) return;
    try {
      await api(`/api/appointments/${id}`, { method: "DELETE" });
      toast("Запись отменена", "ok");
      state.pendingDelete = null;
      await loadSchedule();
    } catch (err) { toast(err.message, "error"); }
  });

  /* инициализация данных */
  (async () => {
    $("todayLabel").textContent = new Date().toLocaleDateString("ru-RU", {
      weekday: "long", day: "numeric", month: "long",
    });
    try {
      await Promise.all([loadDoctors(), loadPatients()]);
      await loadSchedule();
      $("dateInput").min = state.today;
      setDate(state.today, false);
    } catch (err) {
      toast("Ошибка загрузки данных: " + err.message, "error");
    }
  })();
});
