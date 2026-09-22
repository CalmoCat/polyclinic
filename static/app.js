"use strict";

const SLOTS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"];
const WEEKDAYS_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#65a30d", "#7c3aed", "#b45309"];

const state = {
  weekStart: null,
  days: [],
  today: null,
  appointments: [],
  doctors: [],
  patients: [],
};

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
function ddmm(iso) {
  const d = new Date(iso + "T12:00:00");
  return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) throw new Error((body && body.error) || ("Ошибка " + res.status));
  return body;
}

let toastTimer;
function toast(text, kind) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.className = "show " + (kind || "ok");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, 3200);
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
}

function chipHTML(a) {
  const c = colorFor(a.doctor_id);
  return `<span class="chip" style="--c:${c}" title="${esc(a.doctor)} — ${esc(a.specialization)} • ${esc(a.patient)} (полис ${esc(a.policy)})">
      <b>${esc(a.doctor)}</b><i>${esc(a.patient)}</i>
      <button class="del" data-id="${a.id}" title="Отменить запись">×</button>
    </span>`;
}

function renderSchedule() {
  document.getElementById("weekLabel").textContent =
    ddmm(state.days[0]) + " — " + ddmm(state.days[6]);

  let html = "<thead><tr><th class='time-col'>Время</th>";
  state.days.forEach((d) => {
    const dt = new Date(d + "T12:00:00");
    const wd = WEEKDAYS_SHORT[(dt.getDay() + 6) % 7];
    const isToday = d === state.today;
    html += `<th class="${isToday ? "today" : ""}">
        <span class="dow">${wd}</span>
        <span class="dnum">${dt.getDate()}.${String(dt.getMonth() + 1).padStart(2, "0")}</span>
      </th>`;
  });
  html += "</tr></thead><tbody>";

  SLOTS.forEach((t) => {
    html += `<tr><td class="time-col">${t}</td>`;
    state.days.forEach((d) => {
      const appts = state.appointments.filter((a) => a.date === d && a.time === t);
      html += `<td class="cell">${appts.map(chipHTML).join("")}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody>";

  const grid = document.getElementById("scheduleGrid");
  grid.innerHTML = html;
  grid.querySelectorAll(".chip .del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Отменить эту запись на приём?")) return;
      try {
        await api(`/api/appointments/${btn.getAttribute("data-id")}`, { method: "DELETE" });
        toast("Запись отменена");
        await loadSchedule();
        renderTimeSelect();
      } catch (err) { toast(err.message, "error"); }
    });
  });
}

function renderLegend() {
  document.getElementById("legend").innerHTML = state.doctors.map((d) =>
    `<span class="legend-item"><span class="dot" style="background:${colorFor(d.id)}"></span>${esc(d.full_name)} — ${esc(d.specialization)}</span>`
  ).join("");
}

function shiftWeek(delta) {
  const d = new Date(state.weekStart + "T12:00:00");
  d.setDate(d.getDate() + delta * 7);
  state.weekStart = toISO(d);
  loadSchedule().catch((e) => toast(e.message, "error"));
}

/* ── Справочники ─────────────────────────────────────────── */
async function loadDoctors() {
  state.doctors = await api("/api/doctors");
  document.getElementById("doctorSelect").innerHTML =
    '<option value="">— выберите врача —</option>' +
    state.doctors.map((d) => `<option value="${d.id}">${esc(d.full_name)} — ${esc(d.specialization)}</option>`).join("");
  document.getElementById("doctorList").innerHTML = state.doctors.map((d) =>
    `<li><span class="dot" style="background:${colorFor(d.id)}"></span><span><b>${esc(d.full_name)}</b><small>${esc(d.specialization)}</small></span></li>`
  ).join("");
  renderLegend();
}

async function loadPatients() {
  state.patients = await api("/api/patients");
  document.getElementById("patientSelect").innerHTML =
    '<option value="">— выберите пациента —</option>' +
    state.patients.map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("");
  renderPatients();
}

function renderPatients() {
  const q = (document.getElementById("patientSearch").value || "").toLowerCase();
  const items = state.patients.filter((p) => (p.full_name + " " + p.policy).toLowerCase().includes(q));
  document.getElementById("patientList").innerHTML =
    items.map((p) =>
      `<li data-id="${p.id}"><span><b>${esc(p.full_name)}</b><small>Полис: ${esc(p.policy)}</small></span></li>`
    ).join("") || '<li class="empty">Пациенты не найдены</li>';

  document.querySelectorAll("#patientList li[data-id]").forEach((li) => {
    li.addEventListener("click", () => {
      document.getElementById("patientSelect").value = li.getAttribute("data-id");
      toast("Пациент выбран в форме записи");
    });
  });
}

/* ── Форма записи ────────────────────────────────────────── */
function renderTimeSelect() {
  const sel = document.getElementById("timeSelect");
  const doctorId = document.getElementById("doctorSelect").value;
  const date = document.getElementById("dateInput").value;

  // Показываем занятые слоты как недоступные (если дата в загруженной неделе).
  const taken = new Set();
  if (doctorId && date) {
    state.appointments.forEach((a) => {
      if (String(a.doctor_id) === doctorId && a.date === date) taken.add(a.time);
    });
  }
  sel.innerHTML = '<option value="">— выберите время —</option>' +
    SLOTS.map((t) => `<option value="${t}" ${taken.has(t) ? "disabled" : ""}>${t}${taken.has(t) ? " — занято" : ""}</option>`).join("");
}

document.getElementById("apptForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("formMsg");
  msg.textContent = "";
  msg.className = "msg";

  const payload = {
    doctor_id: document.getElementById("doctorSelect").value,
    patient_id: document.getElementById("patientSelect").value,
    date: document.getElementById("dateInput").value,
    time: document.getElementById("timeSelect").value,
  };

  try {
    const created = await api("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("Запись создана: " + created.date + " " + created.time);
    document.getElementById("doctorSelect").value = "";
    document.getElementById("patientSelect").value = "";
    document.getElementById("timeSelect").value = "";
    document.getElementById("dateInput").value = state.today;
    await loadSchedule();
    renderTimeSelect();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = "msg error";
  }
});

/* ── Диалоги: добавление пациента / врача ────────────────── */
function bindDialog(dialogId, formId, openBtnId, onAdded) {
  const dialog = document.getElementById(dialogId);
  document.getElementById(openBtnId).addEventListener("click", () => dialog.showModal());
  dialog.querySelector(".cancel").addEventListener("click", () => dialog.close());
  document.getElementById(formId).addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {};
    new FormData(form).forEach((v, k) => (payload[k] = v));
    try {
      await onAdded(payload);
      dialog.close();
      form.reset();
      toast("Добавлено");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

/* ── Инициализация ───────────────────────────────────────── */
async function init() {
  document.getElementById("prevWeek").addEventListener("click", () => shiftWeek(-1));
  document.getElementById("nextWeek").addEventListener("click", () => shiftWeek(1));
  document.getElementById("patientSearch").addEventListener("input", renderPatients);
  document.getElementById("doctorSelect").addEventListener("change", renderTimeSelect);
  document.getElementById("dateInput").addEventListener("change", renderTimeSelect);

  bindDialog("patientDialog", "patientForm", "addPatientBtn", async (p) => {
    await api("/api/patients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: p.full_name, policy: p.policy }),
    });
    await loadPatients();
  });

  bindDialog("doctorDialog", "doctorForm", "addDoctorBtn", async (d) => {
    await api("/api/doctors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: d.full_name, specialization: d.specialization }),
    });
    await loadDoctors();
  });

  try {
    await Promise.all([loadDoctors(), loadPatients()]);
    await loadSchedule();
    document.getElementById("dateInput").min = state.today;
    document.getElementById("dateInput").value = state.today;
    renderTimeSelect();
  } catch (err) {
    toast("Ошибка загрузки данных: " + err.message, "error");
  }
}

init();
