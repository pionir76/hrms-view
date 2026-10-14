// 점검일지 페이지 전용 스크립트

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

const state = {
  equipments: [], // GET /api/equipments 원본 전체
  equipmentId: null,
  equipmentName: "",
  year: null,
  month: null,
};

const modalState = {
  equipmentId: null,
  equipmentName: "",
  region: "",
  buildingName: "",
  weekStart: null, // 'yyyy-MM-dd' (일요일)
  id: null,
  opinion: "",
  level1: null,
  level2: null,
  level3: null,
  results: [], // [{ itemNo, category, content, sun..sat, memo }]
  operatingStatus: "", // 장비 운영 상태 — 문서를 연 시점 값(우측 상단·PDF에 글자로 표시)
};

// ---------- 초기화 ----------

async function initInspectionPage() {
  populateYearMonthSelects();

  try {
    // 담당 장비만 — 저장 권한이 담당 기준이라 목록도 같은 기준으로 맞춘다(백엔드 2026-09-28).
    // 시스템관리자는 mine=true여도 서버가 전체를 준다.
    state.equipments = await apiFetch("/api/equipments?mine=true");
  } catch (err) {
    document.getElementById("calendarArea").innerHTML =
      `<div class="empty-state">장비 목록을 불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
    return;
  }

  // 담당 장비가 하나도 없으면 선택 자체가 불가능하다 — 화면이 고장 난 것으로 오해하지 않게 알려준다
  if (state.equipments.length === 0) {
    renderCalendarPlaceholder("담당 장비가 없습니다. 시스템관리자에게 담당 장비 등록을 요청하세요.");
  }

  populateRegionSelect();

  document.getElementById("regionSelect").addEventListener("change", onRegionChange);
  document.getElementById("buildingSelect").addEventListener("change", onBuildingChange);
  document.getElementById("equipmentSelect").addEventListener("change", onEquipmentChange);
  document.getElementById("yearSelect").addEventListener("change", onYearMonthChange);
  document.getElementById("monthSelect").addEventListener("change", onYearMonthChange);

  // 창은 닫기·× 버튼과 Esc로만 닫는다 — 바깥 클릭으로는 닫지 않는다(ui.js "창 닫기 공통 규칙")
  document.getElementById("modalCloseX").addEventListener("click", closeInspectionModal);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || isApprovalInboxOpen()) return;
    if (!document.getElementById("inspectionModal").hidden) closeInspectionModal();
  });

  document.getElementById("prevMonthBtn").addEventListener("click", () => changeMonth(-1));
  document.getElementById("nextMonthBtn").addEventListener("click", () => changeMonth(1));

  renderCalendarTitleOnly();
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
  renderEquipmentStatus(null);
  renderSelectionSummary();

  if (!region) {
    resetSelect(buildingSelect, "선택");
    renderCalendarPlaceholder("좌측에서 지역 · 시설동 · 설비를 선택하세요.");
    return;
  }

  // GET /api/equipments 응답 순서가 매번 안정적이지 않아서, 화면에 보이는 순서를 고정하려면 직접 정렬해야 한다.
  const buildings = [...new Set(state.equipments.filter((e) => e.region === region).map((e) => e.buildingName))].sort(
    (a, b) => a.localeCompare(b, "ko")
  );
  buildingSelect.innerHTML = `<option value="">선택</option>` + buildings.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
  buildingSelect.disabled = false;
  renderCalendarPlaceholder("좌측에서 시설동 · 설비를 선택하세요.");
}

function onBuildingChange() {
  const region = document.getElementById("regionSelect").value;
  const buildingName = document.getElementById("buildingSelect").value;
  const equipmentSelect = document.getElementById("equipmentSelect");

  state.equipmentId = null;
  renderEquipmentStatus(null);
  renderSelectionSummary();

  if (!buildingName) {
    resetSelect(equipmentSelect, "선택");
    renderCalendarPlaceholder("좌측에서 시설동 · 설비를 선택하세요.");
    return;
  }

  const equipments = state.equipments
    .filter((e) => e.region === region && e.buildingName === buildingName)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  equipmentSelect.innerHTML =
    `<option value="">선택</option>` + equipments.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("");
  equipmentSelect.disabled = false;
  renderCalendarPlaceholder("좌측에서 설비를 선택하세요.");
}

function onEquipmentChange() {
  const equipmentSelect = document.getElementById("equipmentSelect");
  const equipmentId = equipmentSelect.value;

  if (!equipmentId) {
    state.equipmentId = null;
    renderSelectionSummary();
    renderEquipmentStatus(null);
    renderCalendarPlaceholder("좌측에서 설비를 선택하세요.");
    return;
  }

  const equipment = state.equipments.find((e) => String(e.id) === String(equipmentId));
  state.equipmentId = equipmentId;
  state.equipmentName = equipment ? equipment.name : "";
  renderSelectionSummary();
  refreshEquipmentStatus(equipmentId, equipment ? equipment.status : null);

  document.getElementById("prevMonthBtn").disabled = false;
  document.getElementById("nextMonthBtn").disabled = false;

  loadCalendar();
}

function onYearMonthChange() {
  state.year = Number(document.getElementById("yearSelect").value);
  state.month = Number(document.getElementById("monthSelect").value);
  if (state.equipmentId) loadCalendar();
}

// 지역 › 시설동 › 설비 요약 배지
function renderSelectionSummary() {
  const region = document.getElementById("regionSelect").value;
  const buildingName = document.getElementById("buildingSelect").value;
  const el = document.getElementById("selectionSummary");

  if (!region) {
    el.innerHTML = `<span class="selection-placeholder">지역 · 시설동 · 설비를 선택하세요.</span>`;
    return;
  }

  const parts = [region];
  if (buildingName) parts.push(buildingName);
  if (state.equipmentId && state.equipmentName) parts.push(state.equipmentName);

  el.innerHTML = parts.map((p) => `<span class="selection-part">${escapeHtml(p)}</span>`).join(`<span class="selection-sep">›</span>`);
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

  renderCalendarTitleOnly();
  if (state.equipmentId) loadCalendar();
}

function renderCalendarPlaceholder(message) {
  renderCalendarTitleOnly();
  document.getElementById("prevMonthBtn").disabled = true;
  document.getElementById("nextMonthBtn").disabled = true;
  document.getElementById("calendarArea").innerHTML = `<div class="empty-state">${message}</div>`;
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

function isDocLocked(log) {
  return isApprovalStarted(log);
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
  renderCalendarTitleOnly();

  const calendarArea = document.getElementById("calendarArea");
  calendarArea.innerHTML = `<div class="empty-state">불러오는 중...</div>`;

  const weeks = getMonthWeeks(year, month);
  const weekStarts = weeks.map((w) => toDateStr(w[0]));

  let logs;
  try {
    logs = await Promise.all(
      weekStarts.map((ws) => apiFetch(`/api/inspection-logs?equipmentId=${equipmentId}&weekStart=${ws}`))
    );
  } catch (err) {
    calendarArea.innerHTML = `<div class="empty-state">불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
    return;
  }

  renderCalendarTable(weeks, logs, month);
}

function renderCalendarTable(weeks, logs, month) {
  const rows = weeks
    .map((week, i) => {
      const status = deriveWeekStatus(logs[i]);
      const weekStart = toDateStr(week[0]);
      const dayCells = week
        .map((d, dow) => {
          if (d.getMonth() + 1 !== month) {
            return `<td class="cal-empty"></td>`;
          }
          const cls = dow === 0 ? "cal-sun" : dow === 6 ? "cal-sat" : "";
          return `
            <td class="${cls}">
              <div class="cal-date">${d.getDate()}</div>
              <button type="button" class="cal-write-btn" data-week-start="${weekStart}">작성</button>
            </td>
          `;
        })
        .join("");

      return `
        <tr>
          ${dayCells}
          <td><span class="badge ${status.badgeClass}">${status.label}</span></td>
        </tr>
      `;
    })
    .join("");

  document.getElementById("calendarArea").innerHTML = `
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

// ---------- PDF 저장 (common/js/pdf-export.js) ----------
//
// 엑셀 저장을 대체한다(사용자 결정 2026-09-29, 교육훈련에서 먼저 시험). 결재가 끝난 문서만
// 저장할 수 있고(교육훈련과 같은 규칙), 그 문서는 잠겨 있으므로 저장된 값(modalState)으로 만든다.
// 요일 7칸 때문에 A4 가로로 찍는다(.pdf-doc.is-landscape).

function renderInspectionPdfButton() {
  const btn = document.getElementById("exportPdfBtn");
  if (!btn) return;
  const complete = isApprovalComplete(modalState);
  btn.disabled = !complete;
  btn.title = complete ? "" : "결재가 완료된 문서만 PDF로 저장할 수 있습니다";
}

function exportInspectionLogToPdf() {
  if (modalState.id === null || !isApprovalComplete(modalState)) return;

  // 결재란은 화면과 같은 공통 모듈로 그리고 조작 버튼(취소)만 걷어낸다
  const approvalEl = document.createElement("div");
  approvalEl.className = "approval-bar";
  renderApprovalBar(approvalEl, modalState, { allowApprove: false });
  approvalEl.querySelectorAll("button").forEach((btn) => btn.remove());

  const period = `${formatDateKo(modalState.weekStart)} (일) ~ ${formatDateKo(weekEndDateStr(modalState.weekStart))} (토)`;

  // 화면 표와 같은 묶음(rowspan)·순서로, 입력칸과 토글 버튼 대신 글자와 O/X 모양으로 채운다
  const rowsHtml = [];
  groupResultsByItem(modalState.results).forEach((group) => {
    group.rows.forEach((r, i) => {
      const leading =
        i === 0
          ? `<td class="pdf-center" rowspan="${group.rows.length}">${escapeHtml(group.key)}</td>
             <td class="pdf-middle" rowspan="${group.rows.length}">${escapeHtml(r.category)}</td>`
          : "";
      const days = DAY_KEYS.map(
        (day) => `<td class="pdf-center"><span class="ox-toggle-btn ${oxCellClass(r[day])}">${oxToggleSymbol(r[day])}</span></td>`
      ).join("");
      rowsHtml.push(`<tr>${leading}<td class="pdf-middle">${escapeHtml(r.content)}</td>${days}<td class="pdf-middle">${escapeHtml(r.memo || "")}</td></tr>`);
    });
  });

  printPdfDocument({
    fileName: pdfSafeFileName(["점검일지", modalState.region, modalState.equipmentName, modalState.weekStart]),
    html: `
      <div class="pdf-doc is-landscape">
        <div class="pdf-head">
          <div>
            <h1 class="pdf-title"><small>INSPECTION</small>점검일지</h1>
            <p class="pdf-meta">
              ${escapeHtml(modalState.region)} · ${escapeHtml(modalState.buildingName)} · <b>${escapeHtml(modalState.equipmentName)}</b><br />
              점검기간 ${escapeHtml(period)}
            </p>
          </div>
          <div class="pdf-head-right">
            <div class="pdf-status">운영 상태 : ${escapeHtml(modalState.operatingStatus || "-")}</div>
            ${approvalEl.outerHTML}
          </div>
        </div>
        <table class="pdf-table">
          <colgroup>
            <col style="width: 44px" />
            <col style="width: 150px" />
            <col />
            ${DAY_KEYS.map(() => `<col style="width: 40px" />`).join("")}
            <col style="width: 150px" />
          </colgroup>
          <thead>
            <tr>
              <th>번호</th>
              <th>점검항목</th>
              <th>점검내용</th>
              ${DAY_LABELS.map((l) => `<th>${l}</th>`).join("")}
              <th>비고</th>
            </tr>
          </thead>
          <tbody>${rowsHtml.join("")}</tbody>
        </table>
        <div class="pdf-box">
          <div class="pdf-box-title">점검자 의견</div>
          <div class="pdf-box-body">${escapeHtml(modalState.opinion || "")}</div>
          <div class="pdf-note-row">
            <p class="pdf-note">${document.querySelector(".opinion-note")?.innerHTML.trim() ?? ""}</p>
            <span class="pdf-printed">${escapeHtml(pdfPrintedByText())}</span>
          </div>
        </div>
      </div>
    `,
  });
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
        <h3 class="inspection-modal-title">${escapeHtml(modalState.equipmentName)}</h3>
        <p class="inspection-modal-subtitle">${formatDateKo(modalState.weekStart)} (일) ~ ${formatDateKo(weekEndDateStr(modalState.weekStart))} (토)</p>
      </div>
      <span class="doc-operating-status">운영 상태 : ${escapeHtml(modalState.operatingStatus || "-")}</span>
    </div>

    <div class="inspection-error" id="inspectionError" hidden></div>
    ${locked ? `<div class="inspection-locked-note">결재가 진행되어 이 점검표는 읽기 전용입니다. 다시 수정하려면 시스템관리자의 결재 리셋이 필요합니다.</div>` : ""}

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
      <p class="opinion-note">
        불필요 항목에는 [해당없음(N)] 으로 표시<br />
        점검내용에 대한 세부점검 내용은 사업자가 현소환경에 적정하게 작성·성안하여 함.<br />
        안전점검확인서의 결과가 동일적으로 근관한 경우 사업소의 자체 위임 점검규정에 따를수 있다. 이하 기타 일치도 동일하게 적용한다.
      </p>
    </div>

    <div class="inspection-modal-footer">
      <div class="footer-left">
        ${session && session.role === "시스템관리자" && modalState.id !== null && isApprovalStarted(modalState) ? `<button type="button" class="btn btn-secondary" id="resetApprovalBtn">결재 전체 리셋</button>` : ""}
      </div>
      <div class="footer-right">
        ${modalState.id !== null ? `<button type="button" class="btn btn-secondary" id="exportPdfBtn">PDF 저장</button>` : ""}
        <button type="button" class="btn btn-secondary" id="modalCancelBtn">닫기</button>
        ${locked ? "" : `<button type="button" class="btn btn-primary" id="saveInspectionBtn">저장</button>`}
      </div>
    </div>
  `;

  document.getElementById("modalBody").innerHTML = html;

  renderInspectionApprovalBar();
  renderInspectionTable();

  // 저장 전 문서(id 없음)는 PDF 대상이 아니라 버튼이 없다
  const pdfBtn = document.getElementById("exportPdfBtn");
  if (pdfBtn) pdfBtn.addEventListener("click", exportInspectionLogToPdf);
  renderInspectionPdfButton();
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

function renderInspectionApprovalBar() {
  renderApprovalBar(document.getElementById("approvalBar"), modalState, {
    allowApprove: modalState.id !== null, // 저장 전 문서는 결재할 수 없다
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
          <td class="item-content">${escapeHtml(r.content)}</td>
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
