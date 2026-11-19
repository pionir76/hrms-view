// 점검일지 페이지 전용 스크립트

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

const state = {
  equipments: [], // 지금 조회 범위(내 장비 / 전체 장비)에서 고를 수 있는 장비 — common/js/equipment-scope.js
  equipmentId: null,
  equipmentName: "",
  managementNumber: "", // 장비명 옆에 붙이는 관리번호
  year: null,
  month: null,
};

const modalState = {
  equipmentId: null,
  equipmentName: "",
  managementNumber: "",
  region: "",
  buildingName: "",
  weekStart: null, // 'yyyy-MM-dd' (일요일)
  id: null,
  opinion: "",
  level1: null,
  level2: null,
  level3: null,
  results: [], // [{ itemNo, category, content, sun..sat, memo }]
  operatingStatus: "", // 장비 운영 상태 — 문서를 연 시점 값(우측 상단에 글자로 표시)
};

// ---------- 초기화 ----------

async function initInspectionPage() {
  populateYearMonthSelects();

  // 캘린더는 장비를 고르기 전에도 항상 보인다(2026-11-19 고객사 요청) — 날짜만 있는 빈 캘린더로 시작하고,
  // 달 이동·년월 선택도 장비와 상관없이 쓸 수 있다.
  document.getElementById("yearSelect").addEventListener("change", onYearMonthChange);
  document.getElementById("monthSelect").addEventListener("change", onYearMonthChange);
  document.getElementById("prevMonthBtn").addEventListener("click", () => changeMonth(-1));
  document.getElementById("nextMonthBtn").addEventListener("click", () => changeMonth(1));
  renderEmptyCalendar();

  try {
    // 전체 장비 + 담당 장비 id(2026-11-19 — 전체 장비의 일지를 조회할 수 있다. 작성·결재는 담당 장비만)
    await loadEquipmentScope();
  } catch (err) {
    setPageNotice(`장비 목록을 불러오지 못했습니다. (${err.message})`);
    return;
  }

  initScopeSwitch("hrms_inspection_scope", applyEquipmentScope);
  applyEquipmentScope();

  document.getElementById("regionSelect").addEventListener("change", onRegionChange);
  document.getElementById("buildingSelect").addEventListener("change", onBuildingChange);
  document.getElementById("equipmentSelect").addEventListener("change", onEquipmentChange);

  // 창은 닫기·× 버튼과 Esc로만 닫는다 — 바깥 클릭으로는 닫지 않는다(ui.js "창 닫기 공통 규칙")
  document.getElementById("modalCloseX").addEventListener("click", closeInspectionModal);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || isApprovalInboxOpen()) return;
    if (!document.getElementById("inspectionModal").hidden) closeInspectionModal();
  });

  await openLogFromUrl();
}

// 일괄 결재 목록의 문서 제목 링크(새 탭)로 들어온 경우 — ?equipment={장비id}&week={주 시작 일요일} (2026-11-19).
// 그 장비·그 달을 고르고 그 주 점검일지 창을 바로 연다. 새로 고침해도 다시 열리지 않게 주소는 비운다.
async function openLogFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const equipmentId = params.get("equipment");
  const week = params.get("week");
  if (!equipmentId || !week) return;
  window.history.replaceState(null, "", window.location.pathname);

  moveCalendarToDate(week);
  const equipment = await pickEquipmentFromLink(equipmentId, applyEquipmentScope);
  if (!equipment) {
    window.alert("이 장비의 점검일지를 찾을 수 없습니다.");
    return;
  }
  openInspectionModal(week);
}

function populateYearMonthSelects() {
  const now = new Date();
  const thisYear = now.getFullYear();
  const yearSelect = document.getElementById("yearSelect");
  yearSelect.innerHTML = [thisYear, thisYear - 1, thisYear - 2]
    .map((y) => `<option value="${y}">${y}년</option>`)
    .join("");

  const monthSelect = document.getElementById("monthSelect");
  monthSelect.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((m) => `<option value="${m}">${m}월</option>`)
    .join("");
  monthSelect.value = String(now.getMonth() + 1);

  state.year = thisYear;
  state.month = now.getMonth() + 1;
}

// ---------- 조회 범위(내 장비 / 전체 장비) ----------

// 범위가 바뀌면 고를 수 있는 장비가 달라지므로 선택을 처음부터 다시 한다(캘린더는 빈 상태로).
function applyEquipmentScope() {
  state.equipments = scopedEquipments();
  pageNotice = "";
  if (state.equipments.length === 0) {
    // 고를 장비가 하나도 없으면 화면이 고장 난 것으로 오해하지 않게 알려준다
    pageNotice =
      equipmentScope.scope === "mine" && !isSystemAdminSession()
        ? "담당 장비가 없습니다. 시스템관리자에게 담당 장비 등록을 요청하세요. (전체 장비에서 다른 장비의 일지를 볼 수 있습니다)"
        : "등록된 장비가 없습니다.";
  }
  populateRegionSelect();
  resetSelect(document.getElementById("buildingSelect"), "선택");
  resetSelect(document.getElementById("equipmentSelect"), "선택");
  state.equipmentId = null;
  calendarNotice = "";
  renderEquipmentStatus(null);
  renderEmptyCalendar();
  renderSelectionSummary();
}

// ---------- 지역 → 시설동 → 설비 계층 선택 ----------

function populateRegionSelect() {
  const select = document.getElementById("regionSelect");
  const availableRegions = collectRegions(state.equipments);
  select.innerHTML = `<option value="">선택</option>` + availableRegions.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");
}

function resetSelect(select, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>`;
  select.disabled = true;
}

function onRegionChange() {
  const region = document.getElementById("regionSelect").value;
  const buildingSelect = document.getElementById("buildingSelect");
  const equipmentSelect = document.getElementById("equipmentSelect");

  resetSelect(equipmentSelect, "선택");
  state.equipmentId = null;
  calendarNotice = "";
  renderEquipmentStatus(null);
  renderEmptyCalendar();

  if (!region) {
    resetSelect(buildingSelect, "선택");
    renderSelectionSummary();
    return;
  }

  // GET /api/equipments 응답 순서가 매번 안정적이지 않아서, 화면에 보이는 순서를 고정하려면 직접 정렬해야 한다.
  const buildings = [...new Set(state.equipments.filter((e) => e.region === region).map((e) => e.buildingName))].sort(
    (a, b) => a.localeCompare(b, "ko")
  );
  buildingSelect.innerHTML = `<option value="">선택</option>` + buildings.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
  buildingSelect.disabled = false;
  renderSelectionSummary();
}

function onBuildingChange() {
  const region = document.getElementById("regionSelect").value;
  const buildingName = document.getElementById("buildingSelect").value;
  const equipmentSelect = document.getElementById("equipmentSelect");

  state.equipmentId = null;
  calendarNotice = "";
  renderEquipmentStatus(null);
  renderEmptyCalendar();

  if (!buildingName) {
    resetSelect(equipmentSelect, "선택");
    renderSelectionSummary();
    return;
  }

  const equipments = state.equipments
    .filter((e) => e.region === region && e.buildingName === buildingName)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  equipmentSelect.innerHTML =
    `<option value="">선택</option>` + equipments.map((e) => `<option value="${e.id}">${escapeHtml(equipmentOptionLabel(e))}</option>`).join("");
  equipmentSelect.disabled = false;
  renderSelectionSummary();
}

function onEquipmentChange() {
  const equipmentSelect = document.getElementById("equipmentSelect");
  const equipmentId = equipmentSelect.value;
  calendarNotice = "";

  if (!equipmentId) {
    state.equipmentId = null;
    renderSelectionSummary();
    renderEquipmentStatus(null);
    renderEmptyCalendar();
    return;
  }

  const equipment = state.equipments.find((e) => String(e.id) === String(equipmentId));
  state.equipmentId = equipmentId;
  state.equipmentName = equipment ? equipment.name : "";
  state.managementNumber = equipment ? equipment.managementNumber || "" : "";
  renderSelectionSummary();
  refreshEquipmentStatus(equipmentId, equipment ? equipment.status : null);

  loadCalendar();
}

function onYearMonthChange() {
  state.year = Number(document.getElementById("yearSelect").value);
  state.month = Number(document.getElementById("monthSelect").value);
  refreshCalendar();
}

// 장비를 골랐으면 그 장비의 일지로 채우고, 아니면 날짜만 있는 빈 캘린더
function refreshCalendar() {
  if (state.equipmentId) loadCalendar();
  else renderEmptyCalendar();
}

// ---------- 선택 요약 줄 — 선택 경로 + 안내·오류 ----------
//
// 캘린더를 항상 보여주면서(2026-11-19) 예전에 캘린더 자리를 덮던 안내·오류 문구를 이 줄로 옮겼다.
// pageNotice: 화면 전체에 걸린 문제(장비 목록 실패, 담당 장비 없음) — 선택을 바꿔도 남는다.
// calendarNotice: 지금 고른 장비의 일지를 못 불러온 경우 — 선택을 바꾸면 지운다.
let pageNotice = "";
let calendarNotice = "";

function setPageNotice(message) {
  pageNotice = message;
  renderSelectionSummary();
}

function setCalendarNotice(message) {
  calendarNotice = message;
  renderSelectionSummary();
}

// 지역 › 시설동 › 설비 요약 배지
function renderSelectionSummary() {
  const region = document.getElementById("regionSelect").value;
  const buildingName = document.getElementById("buildingSelect").value;
  const el = document.getElementById("selectionSummary");
  const notice = pageNotice || calendarNotice;
  const noticeHtml = notice ? `<span class="selection-notice">${escapeHtml(notice)}</span>` : "";

  if (!region) {
    el.innerHTML = pageNotice ? noticeHtml : `<span class="selection-placeholder">지역 · 시설동 · 설비를 선택하세요.</span>`;
    return;
  }

  const parts = [region];
  if (buildingName) parts.push(buildingName);
  if (state.equipmentId && state.equipmentName) parts.push(equipmentNameWithManagementNo(state.equipmentName, state.managementNumber));

  // 아직 덜 고른 단계를 이어서 알려준다(예전엔 캘린더 자리에 띄우던 안내)
  let hint = "";
  if (!buildingName) hint = "시설동 · 설비를 선택하세요.";
  else if (!state.equipmentId) hint = "설비를 선택하세요.";

  el.innerHTML =
    parts.map((p) => `<span class="selection-part">${escapeHtml(p)}</span>`).join(`<span class="selection-sep">›</span>`) +
    (hint ? `<span class="selection-hint">${hint}</span>` : "") +
    noticeHtml;
}

// ---------- 우측 상단: 선택한 장비의 운영 상태 ----------
//
// 관리자가 정하는 운영 상태(status)만 보여준다(사용자 결정 2026-09-29 — 운전·통신·경보는 표시하지
// 않고, 눌러서 다른 화면으로 가는 동작도 없다). 색은 장비 관리 화면과 같다.

function equipmentStatusBadgeHtml(status) {
  const cls = status === "운영" ? "badge-normal" : ["수리중", "점검중", "철거예정"].includes(status) ? "badge-warning" : "badge-muted";
  return `<span class="badge ${cls}">${escapeHtml(status || "-")}</span>`;
}

function renderEquipmentStatus(status) {
  const box = document.getElementById("equipmentStatusBox");
  box.hidden = !state.equipmentId;
  if (state.equipmentId) document.getElementById("equipmentStatusBadge").innerHTML = equipmentStatusBadgeHtml(status);
}

// 목록 값(화면을 연 시점)을 바로 보여주고, 장비 1건을 다시 읽어 지금 값으로 맞춘다.
// 기다리는 사이 다른 장비를 골랐으면 늦게 온 응답은 버린다.
async function refreshEquipmentStatus(equipmentId, listStatus) {
  renderEquipmentStatus(listStatus);
  try {
    const equipment = await apiFetch(`/api/equipments/${equipmentId}`);
    if (String(state.equipmentId) === String(equipmentId)) renderEquipmentStatus(equipment.status);
  } catch (err) {
    // 목록 값을 그대로 둔다
  }
}

function renderCalendarTitleOnly() {
  document.getElementById("calendarTitle").textContent = `${state.year}.${String(state.month).padStart(2, "0")}`;
}

// yearSelect의 고정 3개 옵션(올해/작년/재작년) 범위를 벗어난 연도로 이동했을 때 옵션을 추가한다.
function ensureYearOption(year) {
  const yearSelect = document.getElementById("yearSelect");
  const exists = Array.from(yearSelect.options).some((o) => o.value === String(year));
  if (exists) return;

  const option = document.createElement("option");
  option.value = String(year);
  option.textContent = `${year}년`;
  yearSelect.appendChild(option);

  const sorted = Array.from(yearSelect.options).sort((a, b) => Number(b.value) - Number(a.value));
  yearSelect.innerHTML = "";
  sorted.forEach((o) => yearSelect.appendChild(o));
}

function changeMonth(delta) {
  let month = state.month + delta;
  let year = state.year;
  if (month < 1) {
    month = 12;
    year -= 1;
  } else if (month > 12) {
    month = 1;
    year += 1;
  }
  state.month = month;
  state.year = year;

  ensureYearOption(year);
  document.getElementById("yearSelect").value = String(year);
  document.getElementById("monthSelect").value = String(month);

  refreshCalendar();
}

// ---------- 날짜 유틸 ----------

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateKo(dateStrOrDate) {
  const d = typeof dateStrOrDate === "string" ? new Date(dateStrOrDate) : dateStrOrDate;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

// 해당 연/월의 달력에 필요한 주(일~토) 목록을 만든다. 월 경계에 걸친 주는 앞뒤 달 날짜도 포함한다.
function getMonthWeeks(year, month) {
  const firstOfMonth = new Date(year, month - 1, 1);
  const lastOfMonth = new Date(year, month, 0);

  const start = new Date(firstOfMonth);
  start.setDate(start.getDate() - start.getDay());

  const end = new Date(lastOfMonth);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const weeks = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

// ---------- 결재 상태 판정 ----------

// 저장 안 하고 닫거나 결재하면 입력이 사라지므로, 열었을 때 값을 기준으로 잡아두고 비교한다.
// 요일 토글·비고는 modalState.results에 바로 반영되고, 의견만 textarea에서 읽는다.
const inspectionDirty = createDirtyTracker(() => ({
  opinion: document.getElementById("opinionTextarea")?.value ?? modalState.opinion,
  results: modalState.results,
}));

// 입력을 막는 경우: 결재가 진행됐거나, 담당이 아닌 장비(조회만, 2026-11-19)
function isDocLocked(log) {
  return isApprovalStarted(log) || isViewOnlyDoc();
}

// 지금 연 문서가 담당이 아닌 장비 것인지 — 작성·저장·결재·취소를 모두 막는다(서버도 담당이 아니면 403)
function isViewOnlyDoc() {
  return modalState.equipmentId !== null && !isMyEquipment(modalState.equipmentId);
}

// 미상신 / 책임자 결재 대기 / 총괄자결재대기 / 완료 — level1이 아직이면 저장 여부와 무관하게 "미상신"으로 합친다.
function deriveWeekStatus(log) {
  if (!log || log.id === null || !isApprovalLevelDone(log.level1)) {
    return { label: "미상신", badgeClass: "badge-muted" };
  }
  if (!isApprovalLevelDone(log.level2)) {
    return { label: "책임자 결재 대기", badgeClass: "badge-warning" };
  }
  if (!isApprovalLevelDone(log.level3)) {
    return { label: "총괄자결재대기", badgeClass: "badge-warning" };
  }
  return { label: "완료", badgeClass: "badge-normal" };
}

// ---------- 월 캘린더 ----------

async function loadCalendar() {
  const { equipmentId, year, month } = state;
  const seq = ++calendarRequestSeq;
  renderCalendarTitleOnly();

  // 불러오는 동안 캘린더를 덮지 않고 옅게만 한다. 같은 장비·같은 달을 다시 불러올 때(저장·결재 뒤)는
  // 지금 내용을 그대로 두고, 장비나 달이 바뀌었으면 날짜만 있는 빈 캘린더부터 그린다
  // (앞 장비의 버튼·배지가 잠깐이라도 새 장비 것처럼 보이지 않게).
  const calendarArea = document.getElementById("calendarArea");
  const weeks = getMonthWeeks(year, month);
  if (calendarArea.dataset.key !== calendarKey()) renderCalendarTable(weeks, null, month);
  calendarArea.classList.add("is-loading");

  const weekStarts = weeks.map((w) => toDateStr(w[0]));
  const today = todayDateString();

  // 아직 시작하지 않은 주(일요일이 내일 이후)는 쓸 일지가 없어 조회하지 않는다(2026-11-19)
  let logs;
  try {
    logs = await Promise.all(
      weekStarts.map((ws) => (ws > today ? null : apiFetch(`/api/inspection-logs?equipmentId=${equipmentId}&weekStart=${ws}`)))
    );
  } catch (err) {
    if (seq !== calendarRequestSeq) return;
    calendarArea.classList.remove("is-loading");
    setCalendarNotice(`점검일지를 불러오지 못했습니다. (${err.message})`);
    return;
  }

  // 기다리는 사이 장비·달을 바꿨으면 늦게 온 응답은 버린다 — 나중에 고른 쪽 결과만 그린다
  if (seq !== calendarRequestSeq) return;
  calendarArea.classList.remove("is-loading");
  if (calendarNotice) setCalendarNotice(""); // 앞서 실패했던 안내는 이번에 성공했으니 지운다
  renderCalendarTable(weeks, logs, month);
}

// 장비·달을 빨리 바꿀 때 먼저 보낸 조회가 늦게 와서 나중 선택을 덮지 않게 하는 번호(마지막 요청만 반영)
let calendarRequestSeq = 0;

// 지금 캘린더에 그려진 내용이 어느 장비·어느 달 것인지 — 빈 캘린더는 ""
function calendarKey() {
  return `${state.equipmentId}|${state.year}-${state.month}`;
}

// 장비를 고르기 전(또는 선택을 풀었을 때)의 캘린더 — 날짜·오늘 표시만 있고 버튼·배지는 없다
function renderEmptyCalendar() {
  calendarRequestSeq += 1; // 진행 중이던 조회 결과는 버린다
  renderCalendarTitleOnly();
  document.getElementById("calendarArea").classList.remove("is-loading");
  renderCalendarTable(getMonthWeeks(state.year, state.month), null, state.month);
}

// logs가 null이면 빈 캘린더(장비 미선택·불러오는 중)다.
// 미래 날짜(내일 이후)에는 "작성" 버튼을 두지 않는다 — 이번 주는 오늘까지의 칸으로 그 주 일지를 연다.
// 아직 시작하지 않은 주는 결재 칸도 비운다(2026-11-19 고객사 요청).
function renderCalendarTable(weeks, logs, month) {
  const today = todayDateString();
  const hasData = logs !== null;
  const writeLabel = state.equipmentId && !isMyEquipment(state.equipmentId) ? "보기" : "작성";
  const rows = weeks
    .map((week, i) => {
      const weekStart = toDateStr(week[0]);
      const weekNotStarted = weekStart > today;
      const status = !hasData || weekNotStarted ? null : deriveWeekStatus(logs[i]);
      const dayCells = week
        .map((d, dow) => {
          if (d.getMonth() + 1 !== month) {
            return `<td class="cal-empty"></td>`;
          }
          // 오늘 칸은 운전일지 캘린더와 같은 모양으로 표시한다(2026-11-17 현장 요청)
          const dateStr = toDateStr(d);
          const isToday = dateStr === today;
          const cls = [dow === 0 ? "cal-sun" : dow === 6 ? "cal-sat" : "", isToday ? "cal-today" : ""].filter(Boolean).join(" ");
          // 담당이 아닌 장비는 조회만 되므로 "보기"(2026-11-19)
          const writeBtn = !hasData || dateStr > today ? "" : `<button type="button" class="cal-write-btn" data-week-start="${weekStart}">${writeLabel}</button>`;
          return `
            <td class="${cls}">
              <div class="cal-date"><span class="cal-date-num">${d.getDate()}</span></div>
              ${writeBtn}
            </td>
          `;
        })
        .join("");

      return `
        <tr>
          ${dayCells}
          <td>${status ? `<span class="badge ${status.badgeClass}">${status.label}</span>` : ""}</td>
        </tr>
      `;
    })
    .join("");

  const calendarArea = document.getElementById("calendarArea");
  calendarArea.dataset.key = hasData ? calendarKey() : "";
  calendarArea.innerHTML = `
    <table class="data-table inspection-calendar">
      <thead>
        <tr>
          ${DAY_LABELS.map((label) => `<th>${label}</th>`).join("")}
          <th>결재</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  document.querySelectorAll(".cal-write-btn").forEach((btn) => {
    btn.addEventListener("click", () => openInspectionModal(btn.dataset.weekStart));
  });
}

// ---------- 안전점검표 모달 ----------

async function openInspectionModal(weekStart) {
  const modal = document.getElementById("inspectionModal");
  const modalBody = document.getElementById("modalBody");
  modal.hidden = false;
  modalBody.innerHTML = `<div class="empty-state">불러오는 중...</div>`;

  try {
    const equipment = state.equipments.find((e) => String(e.id) === String(state.equipmentId));
    const [log, operatingStatus] = await Promise.all([
      apiFetch(`/api/inspection-logs?equipmentId=${state.equipmentId}&weekStart=${weekStart}`),
      fetchEquipmentOperatingStatus(state.equipmentId, equipment ? equipment.status : ""),
    ]);
    modalState.operatingStatus = operatingStatus;
    modalState.equipmentId = state.equipmentId;
    modalState.equipmentName = state.equipmentName;
    modalState.managementNumber = state.managementNumber;
    modalState.region = equipment ? equipment.region : "";
    modalState.buildingName = equipment ? equipment.buildingName : "";
    modalState.weekStart = weekStart;
    modalState.id = log.id;
    modalState.opinion = log.opinion || "";
    modalState.level1 = log.level1;
    modalState.level2 = log.level2;
    modalState.level3 = log.level3;
    modalState.results = log.results.map((r) => ({ ...r }));

    renderModalBody();
    inspectionDirty.capture();
  } catch (err) {
    inspectionDirty.reset();
    modalBody.innerHTML = `<div class="empty-state">불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
  }
}

// 결재가 끝난 문서만 엑셀로 저장할 수 있다(예전 PDF 저장과 같은 규칙)
function renderInspectionExcelButton() {
  const btn = document.getElementById("exportExcelBtn");
  if (!btn) return;
  const complete = isApprovalComplete(modalState);
  btn.disabled = !complete;
  btn.title = complete ? "" : "결재가 완료된 문서만 엑셀로 저장할 수 있습니다";
}

// ---------- 엑셀 저장 (common/js/excel-export.js) ----------
//
// PDF는 편집이 안 돼 쓰기 어렵다는 고객사 요청(2026-10-22)으로 되살리고 PDF 저장은 뺐다. 결재 완료 문서만 저장하고,
// 잠긴 화면 표를 그대로 훑어 옮긴다 — O / X 칸은 아이콘의 <title> 글자(O, /, X)가 그대로 들어간다.
async function exportInspectionLogToExcel() {
  if (modalState.id === null || !isApprovalComplete(modalState)) return;
  const period = `${formatDateKo(modalState.weekStart)} (일) ~ ${formatDateKo(weekEndDateStr(modalState.weekStart))} (토)`;
  const opinion = document.getElementById("opinionTextarea")?.value.trim() ?? "";
  try {
    await withGlobalBusy(
      () =>
        exportLogToExcel({
          fileName: excelFileName(["점검일지", modalState.region, modalState.equipmentName, modalState.weekStart]),
          sheets: [
            {
              name: modalState.weekStart,
              title: "점검일지",
              info: [
                ["지역", modalState.region],
                ["시설동", modalState.buildingName],
                ["장비명", equipmentNameWithManagementNo(modalState.equipmentName, modalState.managementNumber)],
                ["점검기간", period],
              ],
              approvals: approvalsForExcel(modalState),
              table: document.querySelector(".inspection-table"),
              notes: [`점검자 의견: ${opinion || "-"}`, document.querySelector(".opinion-note")?.textContent.replace(/\s+/g, " ").trim() ?? ""],
            },
          ],
        }),
      { label: "엑셀 파일 만드는 중..." }
    );
  } catch (err) {
    window.alert(`엑셀 파일을 만들지 못했습니다. (${err.message})`);
  }
}

function closeInspectionModal() {
  if (!confirmDiscardIfDirty(inspectionDirty)) return;
  inspectionDirty.reset();
  document.getElementById("inspectionModal").hidden = true;
}

function weekEndDateStr(weekStart) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 6);
  return toDateStr(d);
}

function renderModalBody() {
  const locked = isDocLocked(modalState);
  const session = getSession();

  const html = `
    <div class="inspection-modal-head">
      <div>
        <p class="inspection-modal-location">${escapeHtml(modalState.region)} · ${escapeHtml(modalState.buildingName)}</p>
        <h3 class="inspection-modal-title">${escapeHtml(modalState.equipmentName)}${managementNoHtml(modalState.managementNumber)}</h3>
        <p class="inspection-modal-subtitle">${formatDateKo(modalState.weekStart)} (일) ~ ${formatDateKo(weekEndDateStr(modalState.weekStart))} (토)</p>
      </div>
      <span class="doc-operating-status">운영 상태 : ${escapeHtml(modalState.operatingStatus || "-")}</span>
    </div>

    <div class="inspection-error" id="inspectionError" hidden></div>
    ${
      isViewOnlyDoc()
        ? `<div class="inspection-locked-note">${JOURNAL_VIEW_ONLY_MESSAGE}</div>`
        : locked
          ? `<div class="inspection-locked-note">결재가 진행되어 이 점검표는 읽기 전용입니다. 다시 수정하려면 시스템관리자의 결재 리셋이 필요합니다.</div>`
          : ""
    }

    <div class="approval-bar" id="approvalBar"></div>

    <div class="table-scroll">
      <table class="data-table inspection-table">
        <colgroup>
          <col style="width: 48px" />
          <col style="width: 150px" />
          <col />
          ${DAY_KEYS.map(() => `<col style="width: 42px" />`).join("")}
          <col style="width: 130px" />
        </colgroup>
        <thead>
          <tr>
            <th>번호</th>
            <th class="item-content">점검항목</th>
            <th class="item-content">점검내용</th>
            ${DAY_LABELS.map((l) => `<th>${l}</th>`).join("")}
            <th class="item-content">비고</th>
          </tr>
        </thead>
        <tbody id="inspectionTableBody"></tbody>
      </table>
    </div>

    <div class="opinion-block">
      <label for="opinionTextarea">점검자 의견</label>
      <textarea id="opinionTextarea" class="opinion-textarea" placeholder="특이사항을 기록하세요." ${locked ? "disabled" : ""}>${escapeHtml(modalState.opinion)}</textarea>
      <!-- 양식 하단 부연설명(2026-11-19 고객사 문구로 교체) — 엑셀 저장 때도 이 글자를 그대로 옮긴다 -->
      <p class="opinion-note">
        1. 불필요 항목에는 [해당없음(/)] 으로 표시<br />
        2. 각 점검내용에 대한 세부점검 내용은 사업자가 업소실정에 적정하게 작성하여야 함.<br />
        3. 안전관리총괄자의 결재가 통상적으로 곤란한 경우 사업소의 자체 위임 전결규정에 따를수 있다. 이하 기타 일지도 동일하게 적용한다.
      </p>
    </div>

    <div class="inspection-modal-footer">
      <div class="footer-left">
        ${session && session.role === "시스템관리자" && modalState.id !== null && isApprovalStarted(modalState) ? `<button type="button" class="btn btn-secondary" id="resetApprovalBtn">결재 전체 리셋</button>` : ""}
      </div>
      <div class="footer-right">
        ${modalState.id !== null ? `<button type="button" class="btn btn-secondary" id="exportExcelBtn">엑셀 저장</button>` : ""}
        <button type="button" class="btn btn-secondary" id="modalCancelBtn">닫기</button>
        ${locked ? "" : `<button type="button" class="btn btn-primary" id="saveInspectionBtn">저장</button>`}
      </div>
    </div>
  `;

  document.getElementById("modalBody").innerHTML = html;

  renderInspectionApprovalBar();
  renderInspectionTable();

  // 저장 전 문서(id 없음)는 엑셀 대상이 아니라 버튼이 없다
  const excelBtn = document.getElementById("exportExcelBtn");
  if (excelBtn) excelBtn.addEventListener("click", exportInspectionLogToExcel);
  renderInspectionExcelButton();
  document.getElementById("modalCancelBtn").addEventListener("click", closeInspectionModal);

  const saveBtn = document.getElementById("saveInspectionBtn");
  if (saveBtn) saveBtn.addEventListener("click", () => saveInspectionLog());

  const resetBtn = document.getElementById("resetApprovalBtn");
  if (resetBtn) resetBtn.addEventListener("click", resetApprovals);
}

function showModalError(err) {
  const el = document.getElementById("inspectionError");
  if (!el) return;
  let message = err.message;
  if (err.status === 403) message = "권한이 없습니다. (역할 또는 담당 장비 등록 여부를 확인하세요.)";
  if (err.status === 409) message = "처리할 수 없습니다. 결재 순서를 다시 확인하세요.";
  el.textContent = message;
  el.hidden = false;
}

// ---------- 결재 바 ----------

// 작성이 끝나지 않은 일지는 결재할 수 없다(2026-11-19, 서버 14번 409 본문과 같은 문구)
const NOT_WRITTEN_BLOCK_MESSAGE = "작성이 끝나지 않은 일지는 결재할 수 없습니다.";

// 작성 완료 = 10개 항목 × 일~토가 모두 O·X·/ 중 하나로 채워짐(서버 기준과 같다 — 서버는 12번 isWritingComplete로
// 저장된 값 기준을 내려주지만, 화면은 지금 입력 중인 값으로 바로 판정한다. 결재를 누르면 저장 안 한 입력은
// 먼저 저장하므로(confirmBeforeApprove) 두 판정이 어긋나지 않는다).
function isInspectionWritingComplete() {
  return (
    modalState.results.length > 0 &&
    modalState.results.every((r) => DAY_KEYS.every((day) => r[day] !== null && r[day] !== undefined && r[day] !== ""))
  );
}

function renderInspectionApprovalBar() {
  renderApprovalBar(document.getElementById("approvalBar"), modalState, {
    allowApprove: modalState.id !== null && !isViewOnlyDoc(), // 저장 전 문서·담당이 아닌 장비는 결재할 수 없다
    allowCancel: !isViewOnlyDoc(),
    // 작성 미완료는 첫 결재 단계 버튼만 막는다(서버 기준 2026-11-19 — 그 뒤 단계는 앞 단계 결재 여부만 본다)
    approveBlockedReason: (levelKey) =>
      levelKey === firstApprovalLevelKey(modalState) && !isInspectionWritingComplete() ? NOT_WRITTEN_BLOCK_MESSAGE : null,
    onApprove: approveLevel,
    onCancel: cancelApproval,
  });
}

// 결재·취소·리셋 응답은 결재 상태만 믿고, 점검 내용은 조회 API(12번)로 다시 받는다.
//
// 결재 응답(14번)의 results를 그대로 쓰면, 저장해 둔 체크 값이 화면에서 전부 빈칸으로 바뀌는
// 현상이 있었다(2026-09-29 사용자 제보 — 결재 응답에 값이 비어 오는 것으로 보임). 결재는 점검
// 내용을 바꾸지 않으므로 내용은 원래 기준인 조회 API에서 받는다. 조회가 실패하면 결재 상태만
// 바꾸고 지금 화면의 내용은 그대로 둔다.
async function applyApprovalResponse(updated) {
  modalState.level1 = updated.level1;
  modalState.level2 = updated.level2;
  modalState.level3 = updated.level3;
  try {
    const fresh = await apiFetch(`/api/inspection-logs?equipmentId=${modalState.equipmentId}&weekStart=${modalState.weekStart}`);
    applyLogResponse(fresh);
  } catch (err) {
    // 다음에 창을 다시 열면 맞춰진다
  }
  renderModalBody();
  inspectionDirty.capture();
  loadCalendar();
}

async function approveLevel() {
  if (!(await confirmBeforeApprove(inspectionDirty, () => saveInspectionLog({ askConfirm: false, closeAfter: false })))) return;
  try {
    const updated = await apiFetch(`/api/inspection-logs/${modalState.id}/approve`, { method: "POST" });
    await applyApprovalResponse(updated);
  } catch (err) {
    showModalError(err);
  }
}

async function cancelApproval() {
  if (!window.confirm("결재를 취소하시겠습니까?")) return;
  try {
    const updated = await apiFetch(`/api/inspection-logs/${modalState.id}/approve/cancel`, { method: "POST" });
    await applyApprovalResponse(updated);
  } catch (err) {
    showModalError(err);
  }
}

async function resetApprovals() {
  if (!window.confirm("이 문서의 결재를 전부 리셋하시겠습니까?")) return;
  try {
    const updated = await apiFetch(`/api/inspection-logs/${modalState.id}/approvals/reset`, { method: "POST" });
    await applyApprovalResponse(updated);
  } catch (err) {
    showModalError(err);
  }
}

function applyLogResponse(log) {
  modalState.id = log.id;
  modalState.opinion = log.opinion || "";
  modalState.level1 = log.level1;
  modalState.level2 = log.level2;
  modalState.level3 = log.level3;
  modalState.results = log.results.map((r) => ({ ...r }));
}

// ---------- 점검표 ----------

// "4-1"/"4-2"/"4-3"처럼 세부 항목이 여러 개인 경우, 번호·점검항목 칸을 rowspan으로 묶기 위해 그룹을 만든다.
function groupResultsByItem(results) {
  const groups = [];
  results.forEach((r) => {
    const groupKey = r.itemNo.split("-")[0];
    const last = groups[groups.length - 1];
    if (last && last.key === groupKey) {
      last.rows.push(r);
    } else {
      groups.push({ key: groupKey, rows: [r] });
    }
  });
  return groups;
}

// 점검내용 중 줄을 바꿀 자리를 정해 둔 항목(2026-11-19 고객사 요청) — 이 글자 바로 뒤 띄어쓰기에서 다음 줄로 넘긴다.
// 문구 자체는 서버(GET /api/inspection-items)가 주는 그대로이고, 화면·엑셀(셀 안 <br> → 줄바꿈)에서만 끊는다.
// 나머지 줄바꿈은 CSS(.inspection-item-text, word-break: keep-all)로 단어 사이에서만 일어난다.
const INSPECTION_CONTENT_LINE_BREAK_AFTER = {
  "3": "적정 상태,", // 탈/부착 용이한 구조 등 안전밸브 적정 상태, ⏎ 가용전 상태
  "4-2": "방지장치,", // 과부하 보호장치, 액체동결 방지장치, ⏎ 냉각수 단수 보호장치 작동여부
};

function inspectionContentHtml(r) {
  const content = r.content ?? "";
  const breakAfter = INSPECTION_CONTENT_LINE_BREAK_AFTER[r.itemNo];
  const at = breakAfter ? content.indexOf(`${breakAfter} `) : -1;
  if (at === -1) return escapeHtml(content); // 서버 문구가 바뀌어 자리를 못 찾으면 끊지 않는다
  const cut = at + breakAfter.length;
  return `${escapeHtml(content.slice(0, cut))}<br />${escapeHtml(content.slice(cut + 1))}`;
}

function renderInspectionTable() {
  const locked = isDocLocked(modalState);
  const tbody = document.getElementById("inspectionTableBody");
  const groups = groupResultsByItem(modalState.results);

  const rowsHtml = [];
  groups.forEach((group) => {
    group.rows.forEach((r, i) => {
      const idx = modalState.results.indexOf(r);
      const dayCells = DAY_KEYS.map(
        (day) => `
          <td class="day-cell">
            <button type="button" class="ox-toggle-btn ${oxCellClass(r[day])}" data-idx="${idx}" data-day="${day}" ${locked ? "disabled" : ""}>${oxToggleSymbol(r[day])}</button>
          </td>
        `
      ).join("");

      const leadingCells =
        i === 0
          ? `
            <td rowspan="${group.rows.length}">${group.key}</td>
            <td class="item-content" rowspan="${group.rows.length}">${escapeHtml(r.category)}</td>
          `
          : "";

      rowsHtml.push(`
        <tr>
          ${leadingCells}
          <td class="item-content inspection-item-text">${inspectionContentHtml(r)}</td>
          ${dayCells}
          <td class="item-content"><input type="text" class="memo-input" data-idx="${idx}" value="${escapeHtml(r.memo || "")}" ${locked ? "disabled" : ""} /></td>
        </tr>
      `);
    });
  });

  tbody.innerHTML = rowsHtml.join("");

  if (!locked) {
    tbody.querySelectorAll(".ox-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const day = btn.dataset.day;
        const next = cycleOxValue(modalState.results[idx][day]);
        modalState.results[idx][day] = next;
        btn.innerHTML = oxToggleSymbol(next);
        btn.className = `ox-toggle-btn ${oxCellClass(next)}`;
        renderInspectionApprovalBar(); // 마지막 칸을 채우면 결재 버튼이 바로 풀린다(작성 완료 판정)
      });
    });

    tbody.querySelectorAll(".memo-input").forEach((input) => {
      input.addEventListener("input", () => {
        modalState.results[Number(input.dataset.idx)].memo = input.value;
      });
    });
  }
}

// ---------- 저장 ----------

// 결재 전 자동 저장에서도 부르므로, 성공하면 true를 돌려준다(confirmBeforeApprove 참고).
// askConfirm=false면 이미 사용자에게 물어본 흐름이라 확인창을 건너뛴다.
async function saveInspectionLog({ askConfirm = true, closeAfter = true } = {}) {
  if (isViewOnlyDoc()) return false; // 담당이 아닌 장비는 조회만(저장 버튼도 없다)
  if (askConfirm && !window.confirm("저장하시겠습니까?")) return false;

  const opinion = document.getElementById("opinionTextarea").value;
  const payload = {
    equipmentId: Number(modalState.equipmentId),
    weekStartDate: modalState.weekStart,
    opinion,
    results: modalState.results.map((r) => ({
      itemNo: r.itemNo,
      sun: r.sun,
      mon: r.mon,
      tue: r.tue,
      wed: r.wed,
      thu: r.thu,
      fri: r.fri,
      sat: r.sat,
      memo: r.memo,
    })),
  };

  try {
    await apiFetch("/api/inspection-logs", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    loadCalendar();
    inspectionDirty.capture();
    if (closeAfter) closeInspectionModal();
    return true;
  } catch (err) {
    showModalError(err);
    return false;
  }
}

document.addEventListener("DOMContentLoaded", initInspectionPage);
