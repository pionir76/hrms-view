// 운전일지 페이지 전용 스크립트

const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
const TIME_SLOTS = ["time0900", "time1300", "time1600", "time2100"];
const TIME_SLOT_LABELS = ["09:00", "13:00", "16:00", "21:00"];
const TIME_SLOT_HOURS = [9, 13, 16, 21];
// 서버 자동 기록은 정각에 시작해 몇 초 걸린다 — 그 사이에 칸이 열려 사용자가 적은 값이 곧바로 덮어써지지 않게 1분 여유를 둔다
const SLOT_OPEN_GRACE_MS = 60 * 1000;

// 운전일지 결재를 막는 사유 — 백엔드 OperationLogRules와 같은 문구(api-manual 19번 409 본문)
const IDLE_BLOCK_MESSAGE = "미가동일은 결재 대상이 아닙니다.";
const NOT_FINISHED_BLOCK_MESSAGE = "21시 기록이 끝난 뒤에 결재할 수 있습니다.";

// 사업소 공통 서식의 "비고" 문구 (원문 그대로 4개 항목 전부 포함).
const OPERATION_NOTE_TEXT = [
  "주: 1. 불필요 항목에는 \"해당없음(/)\"으로 표시",
  "2. 각 점검내용에 대한 세부점검 내용은 사업자가 업소실정에 적정하게 작성하여야 함.",
  "3. 전기설비의 방폭 가연성가스중 암모니아, 브롬화메탄, 공기중자기발화가스는 제외",
  "4. 안전관리총괄자의 결재가 통상적으로 곤란할 경우 사업소의 자체 위임 전결규정에 따를 수 있다. 이하 기타 일지도 동일하게 적용한다.",
].join("<br />");

// 레포트 형식(항목 목록·구분·순서)은 백엔드가 관리하지 않는 프론트 책임 영역이다
// (README 10장 "운전일지 양식" 참고). 다만 16개 항목의 itemKey는 서버 자동 기록이 알고 있으므로
// 백엔드와 정확히 일치해야 한다 — 채널 자동측정 5개(channelNo 있음, AutoMeasuredItemCatalog),
// 장비설정 기반 랜덤값 5개(channelNo 없음, EquipmentRangeItemCatalog), 체크 항목 6개(kind "ox",
// CheckItemCatalog — 2026-11-06부터 서버가 직전 값 복사·정지 시 "/"/"O"로 자동 기록). 랜덤값은 2026-09-11
// 사양 변경으로 신규 추가됐다 — 냉각수온도(입구/출구)는 더 이상 CH01을 읽지 않고, 브라인온도
// (입구/출구)·운전전압과 함께 채널 없이 장비 설정(Has*/Min/Max) 기반 랜덤값으로 바뀌었다.
// 백엔드가 이미 소수점 1자리 문자열("12.3" 등)로 내려주므로 raw→실값 변환이 필요 없다
// (channelNo를 비워두면 dpFor()가 null을 반환해 자동으로 원문 그대로 표시된다).
const OPERATION_CATALOG = [
  {
    division: "냉매계통",
    equipmentLabel: "육안/온도계/누설감지기<br>모니터링시스템", // 줄은 <br>에서만 나눈다(사용자 결정 2026-10-27)
    items: [
      { key: "토출압력", label: "토출압력", kind: "auto", perCompressor: true, channelNo: "CH05", refKey: "토출압력", defaultRef: "1.8MPa 이하" },
      { key: "토출가스온도", label: "토출가스온도", kind: "auto", perCompressor: true, channelNo: "CH02", refKey: "토출가스온도", defaultRef: "80℃ 이하" },
      { key: "흡입압력", label: "흡입압력", kind: "auto", perCompressor: true, channelNo: "CH04", refKey: "흡입압력", defaultRef: "-0.05MPa 이상" },
      { key: "냉매량", label: "냉매량", kind: "ox", refKey: "냉매량", defaultRef: "액면계에서 액면이 보일 것 (100% 부하 운전중 중심선 위치)" },
      { key: "오일량", label: "오일량", kind: "ox", refKey: "오일량", defaultRef: "운전중: 유면계에서 하단 중심선 이상 (가동전: 상한선에 위치)" },
      { key: "오일압력", label: "오일압력", kind: "auto", perCompressor: true, channelNo: "CH06", refKey: "오일압력", defaultRef: "-" },
    ],
  },
  {
    division: "냉수<br>냉각수계통", // 표시 전용 문구 — 줄은 <br>에서만 나눈다(사용자 결정 2026-10-27)
    equipmentLabel: "온도계/모니터링시스템",
    items: [
      {
        // 장비설정 기반 랜덤값(HasCoolingWater+Min/Max) — 더 이상 CH01을 읽지 않는다(2026-09-11 사양 변경).
        key: "냉각수온도",
        label: "냉각수온도",
        kind: "auto-pair",
        pairKeys: ["냉각수온도(입구)", "냉각수온도(출구)"],
        pairLabels: ["입구", "출구"],
        refKey: "냉각수온도",
        defaultRef: "-",
      },
      {
        // 장비설정 기반 랜덤값(HasBrine+Min/Max) — 이전엔 사용자 직접입력이었다(2026-09-11 사양 변경).
        key: "브라인온도",
        label: "브라인온도",
        kind: "auto-pair",
        pairKeys: ["브라인온도(입구)", "브라인온도(출구)"],
        pairLabels: ["입구", "출구"],
        refKey: "브라인온도",
        defaultRef: "50℃ 이하",
      },
    ],
  },
  {
    division: "전기계통",
    equipmentLabel: "클램프메타<br>모니터링시스템",
    items: [
      // 장비설정 기반 랜덤값(HasVoltage+Min/Max) — 이전엔 사용자 직접입력이었다(2026-09-11 사양 변경).
      { key: "운전전압", label: "운전전압(V)", kind: "auto", refKey: "운전전압", defaultRef: "정격전압 ±10% (RS,ST,TR상)" },
      { key: "운전전류", label: "운전전류(A)", kind: "auto", channelNo: "CH07", refKey: "운전전류", defaultRef: "기계 전류 ±10% (R,S,T상)" },
      { key: "단자대&판넬상태", label: "단자대&판넬상태<br>(비가동시점검)", kind: "ox", refKey: "단자대&판넬상태", defaultRef: "느슨, 과열흔적, 먼지 등 청소상태" },
    ],
  },
  {
    division: "기타",
    equipmentLabel: "육안",
    items: [
      { key: "드레인상태", label: "드레인상태<br>(비가동시기 점검)", kind: "ox", refKey: "드레인상태", defaultRef: "동파 우려될 경우 냉수·냉각수 계통 물 배수 확인" },
      { key: "저압부단열재상태", label: "저압부 단열재상태<br>(비가동시기 점검)", kind: "ox", refKey: "저압부단열재상태", defaultRef: "열손실이 없도록 보냉, 방습이 충분할 것" },
      { key: "이상진동및소음상태", label: "이상진동 및 소음상태", kind: "ox", refKey: "이상진동및소음상태", defaultRef: "이상 진동, 소음이 없을 것" },
    ],
  },
];

const state = {
  equipments: [], // GET /api/equipments 원본 전체
  equipmentId: null,
  equipmentName: "",
  managementNumber: "", // 장비명 옆에 붙이는 관리번호
  year: null,
  month: null,
  compressors: [], // 선택한 설비의 압축기 목록 (GET /api/equipments/{id}/compressors, sequenceNo 오름차순)
};

const modalState = {
  equipmentId: null,
  equipmentName: "",
  managementNumber: "",
  region: "",
  buildingName: "",
  date: null, // 'yyyy-MM-dd'
  id: null,
  isIdle: false, // 미가동 일지 — 결재 대상이 아니다(api-manual 16번, 2026-11-06)
  pendingSlots: [], // 문서를 그린 시점에 아직 오지 않은 기록 시각(입력을 막은 칸) — 저장 때 그 사이 지난 칸은 서버 값으로 맞춘다
  level1: null,
  level2: null,
  level3: null,
  items: [], // [{ itemKey, compressorId, time0900..time2100 }]
  references: [], // [{ itemKey, referenceText }]
  operatingStatus: "", // 장비 운영 상태 — 문서를 연 시점 값(우측 상단에 글자로 표시)
};

// 압축기별 채널 설정(decimalPlaces) 캐시. raw ↔ 실값 변환에 사용.
const channelSettingsByCompressor = new Map();

// ---------- 초기화 ----------

async function initOperationPage() {
  populateYearMonthSelects();

  let myEquipments;
  try {
    // 담당 장비만 — 저장 권한이 담당 기준이라 목록도 같은 기준으로 맞춘다(백엔드 2026-09-28).
    // 시스템관리자는 mine=true여도 서버가 전체를 준다.
    myEquipments = await apiFetch("/api/equipments?mine=true");
  } catch (err) {
    document.getElementById("calendarArea").innerHTML =
      `<div class="empty-state">장비 목록을 불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
    return;
  }
  // 운전일지는 장비 상태가 '운영'인 장비에만 생긴다(api-manual 16번, 2026-11-06) — 나머지 장비는
  // 매일 빈 폼만 나와서 선택 목록에서 뺀다(사용자 결정 2026-11-06).
  state.equipments = myEquipments.filter((e) => e.status === "운영");

  // 고를 장비가 하나도 없으면 선택 자체가 불가능하다 — 화면이 고장 난 것으로 오해하지 않게 알려준다
  if (state.equipments.length === 0) {
    renderCalendarPlaceholder(
      myEquipments.length === 0
        ? "담당 장비가 없습니다. 시스템관리자에게 담당 장비 등록을 요청하세요."
        : "운영 중인 담당 장비가 없습니다. 운전일지는 장비 상태가 '운영'인 장비만 작성합니다."
    );
  }

  populateRegionSelect();

  document.getElementById("regionSelect").addEventListener("change", onRegionChange);
  document.getElementById("buildingSelect").addEventListener("change", onBuildingChange);
  document.getElementById("equipmentSelect").addEventListener("change", onEquipmentChange);
  document.getElementById("yearSelect").addEventListener("change", onYearMonthChange);
  document.getElementById("monthSelect").addEventListener("change", onYearMonthChange);

  // 창은 닫기·× 버튼과 Esc로만 닫는다 — 바깥 클릭으로는 닫지 않는다(ui.js "창 닫기 공통 규칙")
  document.getElementById("modalCloseX").addEventListener("click", closeOperationModal);
  document.getElementById("refEditCancelBtn").addEventListener("click", closeRefEditModal);
  document.getElementById("refEditSaveBtn").addEventListener("click", saveRefEdit);
  // Esc는 맨 위 창 하나만 — 실측 기준 수정 창이 운전일지 창 위에 뜬다
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || isApprovalInboxOpen()) return;
    if (!document.getElementById("refEditModal").hidden) closeRefEditModal();
    else if (!document.getElementById("operationModal").hidden) closeOperationModal();
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

// ---------- 지역 → 시설동 → 설비 계층 선택 (점검일지와 동일 패턴) ----------

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
  renderSelectionSummary();
  disableMonthNav();

  if (!region) {
    resetSelect(buildingSelect, "선택");
    renderCalendarPlaceholder("좌측에서 지역 · 시설동 · 설비를 선택하세요.");
    return;
  }

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
  renderSelectionSummary();
  disableMonthNav();

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

async function onEquipmentChange() {
  const equipmentSelect = document.getElementById("equipmentSelect");
  const equipmentId = equipmentSelect.value;

  if (!equipmentId) {
    state.equipmentId = null;
    renderSelectionSummary();
    disableMonthNav();
    renderCalendarPlaceholder("좌측에서 설비를 선택하세요.");
    return;
  }

  const equipment = state.equipments.find((e) => String(e.id) === String(equipmentId));
  state.equipmentId = equipmentId;
  state.equipmentName = equipment ? equipment.name : "";
  state.managementNumber = equipment ? equipment.managementNumber || "" : "";
  renderSelectionSummary();

  document.getElementById("prevMonthBtn").disabled = false;
  document.getElementById("nextMonthBtn").disabled = false;

  renderCalendarPlaceholder("불러오는 중...");
  try {
    state.compressors = await apiFetch(`/api/equipments/${equipmentId}/compressors`);
    await loadChannelSettings(state.compressors);
  } catch (err) {
    renderCalendarPlaceholder(`압축기 정보를 불러오지 못했습니다. (${escapeHtml(err.message)})`);
    return;
  }

  loadCalendar();
}

function onYearMonthChange() {
  state.year = Number(document.getElementById("yearSelect").value);
  state.month = Number(document.getElementById("monthSelect").value);
  if (state.equipmentId) loadCalendar();
}

function disableMonthNav() {
  document.getElementById("prevMonthBtn").disabled = true;
  document.getElementById("nextMonthBtn").disabled = true;
}

async function loadChannelSettings(compressors) {
  await Promise.all(
    compressors.map(async (c) => {
      const settings = await getChannelSettings(c.id);
      channelSettingsByCompressor.set(c.id, settings);
    })
  );
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
  if (state.equipmentId && state.equipmentName) parts.push(equipmentNameWithManagementNo(state.equipmentName, state.managementNumber));

  el.innerHTML = parts.map((p) => `<span class="selection-part">${escapeHtml(p)}</span>`).join(`<span class="selection-sep">›</span>`);
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
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
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

// ---------- 결재 상태 판정 (공용 판정 함수는 common/js/approval.js) ----------

function isAnyApproved() {
  return isApprovalStarted(modalState);
}

// 결재가 하나라도 진행되면 읽기 전용 — 점검일지와 같은 규칙(사용자 결정 2026-09-28).
// 2026-11-06부터 백엔드도 이 경우 저장을 409로 막는다(api-manual 18번). 미가동 전환(20-1번)만 예외.
function isDocLocked() {
  return isApprovalStarted(modalState);
}

// ---------- 기록 시각 판정 (브라우저 = 한국 시간 기준) ----------

// 그 날짜의 기록 시각 칸이 아직 오지 않았는지. 오지 않은 칸은 그 시각에 서버가 전 항목을 덮어쓰므로
// 입력을 막는다(사용자 결정 2026-11-06). 놓친 시각(서버가 꺼져 있던 칸)은 지난 칸이라 직접 적을 수 있다.
function isSlotPending(dateStr, slot) {
  const hour = TIME_SLOT_HOURS[TIME_SLOTS.indexOf(slot)];
  const slotTime = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00`);
  return Date.now() < slotTime.getTime() + SLOT_OPEN_GRACE_MS;
}

// 결재 차례인 사람에게 버튼을 비활성으로 보여줄 사유(툴팁). 막지 않으면 null. 서버도 같은 기준으로 409를 낸다.
function operationApproveBlockReason() {
  if (modalState.isIdle) return IDLE_BLOCK_MESSAGE;
  if (isSlotPending(modalState.date, "time2100")) return NOT_FINISHED_BLOCK_MESSAGE;
  return null;
}

// 저장 안 한 채 닫거나 결재하면 입력이 사라지므로, 연 시점 값을 기준으로 잡아 비교한다
const operationDirty = createDirtyTracker(() => ({
  items: modalState.items,
  references: modalState.references,
}));

function isFullyApproved() {
  return isApprovalComplete(modalState);
}

// 미가동 / 미상신 / 책임자 대기 / 총괄자 대기 / 완료 — level1이 아직이면 저장 여부와 무관하게 "미상신"으로 합친다.
// 미가동은 결재 단계와 상관없이 가장 먼저 본다 — 결재가 끝난 뒤 미가동으로 바꾼 날도 미가동으로 보인다.
function deriveDayStatus(log) {
  if (log && log.isIdle) {
    return { label: "미가동", badgeClass: "badge-idle" };
  }
  if (!log || log.id === null || !isApprovalLevelDone(log.level1)) {
    return { label: "미상신", badgeClass: "badge-muted" };
  }
  if (!isApprovalLevelDone(log.level2)) {
    return { label: "책임자 대기", badgeClass: "badge-warning" };
  }
  if (!isApprovalLevelDone(log.level3)) {
    return { label: "총괄자 대기", badgeClass: "badge-warning" };
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
  const monthDates = weeks.flat().filter((d) => d.getMonth() + 1 === month);
  const dateStrs = monthDates.map((d) => toDateStr(d));

  let logs;
  try {
    logs = await Promise.all(dateStrs.map((ds) => apiFetch(`/api/operation-logs?equipmentId=${equipmentId}&date=${ds}`)));
  } catch (err) {
    calendarArea.innerHTML = `<div class="empty-state">불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
    return;
  }

  const logsByDate = new Map(dateStrs.map((ds, i) => [ds, logs[i]]));
  renderCalendarTable(weeks, logsByDate, month);
}

function renderCalendarTable(weeks, logsByDate, month) {
  const rows = weeks
    .map((week) => {
      const dayCells = week
        .map((d, dow) => {
          if (d.getMonth() + 1 !== month) {
            return `<td class="cal-empty"></td>`;
          }
          const dateStr = toDateStr(d);
          const status = deriveDayStatus(logsByDate.get(dateStr));
          const isToday = dateStr === todayDateString();
          const cls = [dow === 0 ? "cal-sun" : dow === 6 ? "cal-sat" : "", isToday ? "cal-today" : ""].filter(Boolean).join(" ");
          return `
            <td class="${cls}">
              <div class="cal-date">${isToday ? `<span class="cal-today-num">${d.getDate()}</span><span class="cal-today-tag">오늘</span>` : d.getDate()}</div>
              <button type="button" class="cal-status-btn badge ${status.badgeClass}" data-date="${dateStr}">${status.label}</button>
            </td>
          `;
        })
        .join("");

      return `<tr>${dayCells}</tr>`;
    })
    .join("");

  document.getElementById("calendarArea").innerHTML = `
    <table class="data-table operation-calendar">
      <thead>
        <tr>${DAY_LABELS.map((label) => `<th>${label}</th>`).join("")}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  document.querySelectorAll(".cal-status-btn").forEach((btn) => {
    btn.addEventListener("click", () => openOperationModal(btn.dataset.date));
  });
}

// ---------- 운전일지 레포트 모달 ----------

async function openOperationModal(dateStr) {
  const modal = document.getElementById("operationModal");
  const modalBody = document.getElementById("modalBody");
  modal.hidden = false;
  modalBody.innerHTML = `<div class="empty-state">불러오는 중...</div>`;

  try {
    const equipment = state.equipments.find((e) => String(e.id) === String(state.equipmentId));
    const [log, operatingStatus] = await Promise.all([
      apiFetch(`/api/operation-logs?equipmentId=${state.equipmentId}&date=${dateStr}`),
      fetchEquipmentOperatingStatus(state.equipmentId, equipment ? equipment.status : ""),
    ]);
    modalState.operatingStatus = operatingStatus;
    modalState.equipmentId = state.equipmentId;
    modalState.equipmentName = state.equipmentName;
    modalState.managementNumber = state.managementNumber;
    modalState.region = equipment ? equipment.region : "";
    modalState.buildingName = equipment ? equipment.buildingName : "";
    modalState.date = dateStr;
    applyLogResponse(log);

    renderModalBody();
    operationDirty.capture();
  } catch (err) {
    operationDirty.reset();
    modalBody.innerHTML = `<div class="empty-state">불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
  }
}

// 결재가 끝난 문서만 엑셀로 저장할 수 있다(예전 PDF 저장과 같은 규칙)
function renderOperationExcelButton() {
  const btn = document.getElementById("exportExcelBtn");
  if (!btn) return;
  const complete = isFullyApproved();
  btn.disabled = !complete;
  btn.title = complete ? "" : "결재가 완료된 문서만 엑셀로 저장할 수 있습니다";
}

// ---------- 엑셀 저장 (common/js/excel-export.js) ----------
//
// PDF는 편집이 안 돼 쓰기 어렵다는 고객사 요청(2026-10-22)으로 되살리고 PDF 저장은 뺐다. 결재 완료 문서만 저장한다.
// 표 모양은 압축기 수에 따라 달라지지만, 변환기가 화면에 그려진 표를 훑기 때문에 여기서 따로 신경 쓸 게 없다.
async function exportOperationLogToExcel() {
  if (modalState.id === null || !isFullyApproved()) return;
  const dateObj = new Date(modalState.date);
  try {
    await withGlobalBusy(
      () =>
        exportLogToExcel({
          fileName: excelFileName(["운전일지", modalState.region, modalState.equipmentName, modalState.date]),
          sheets: [
            {
              name: modalState.date,
              title: "운전일지",
              info: [
                ["지역", modalState.region],
                ["시설동", modalState.buildingName],
                ["장비명", equipmentNameWithManagementNo(modalState.equipmentName, modalState.managementNumber)],
                ["날짜", `${formatDateKo(modalState.date)} (${DAY_LABELS[dateObj.getDay()]})`],
              ],
              approvals: approvalsForExcel(modalState),
              table: document.querySelector(".op-table"),
            },
          ],
        }),
      { label: "엑셀 파일 만드는 중..." }
    );
  } catch (err) {
    window.alert(`엑셀 파일을 만들지 못했습니다. (${err.message})`);
  }
}

// 화면 renderReportTable과 같은 칸 합치기 규칙으로, 입력칸 대신 글자·O/X 모양을 넣는다.
// 구분·사용장비·항목 이름은 코드에 적힌 고정 문구(<br> 포함)라 그대로 넣는다.
function closeOperationModal() {
  if (!confirmDiscardIfDirty(operationDirty)) return;
  operationDirty.reset();
  document.getElementById("operationModal").hidden = true;
}

function applyLogResponse(log) {
  modalState.id = log.id;
  modalState.isIdle = !!log.isIdle;
  modalState.level1 = log.level1;
  modalState.level2 = log.level2;
  modalState.level3 = log.level3;
  modalState.items = log.items.map((it) => ({ ...it }));
  modalState.references = log.references.map((r) => ({ ...r }));
}

function renderModalBody() {
  const session = getSession();
  const fullyApproved = isFullyApproved();
  const locked = isDocLocked();
  const dateObj = new Date(modalState.date);
  modalState.pendingSlots = TIME_SLOTS.filter((slot) => isSlotPending(modalState.date, slot));

  const html = `
    <div class="op-report-header">
      <div class="op-report-meta">
        <span class="op-meta-chip">${escapeHtml(modalState.region)}</span>
        <span class="op-meta-chip">${escapeHtml(modalState.buildingName)}</span>
        <span class="op-meta-chip op-meta-chip-primary">${escapeHtml(modalState.equipmentName)}${managementNoHtml(modalState.managementNumber)}</span>
      </div>
      <div class="op-report-right">
        ${renderIdleSwitchHtml()}
        <span class="doc-operating-status">운영 상태 : ${escapeHtml(modalState.operatingStatus || "-")}</span>
        <span class="op-report-date-badge">${formatDateKo(modalState.date)} (${DAY_LABELS[dateObj.getDay()]})</span>
      </div>
    </div>

    ${modalState.isIdle ? `<div class="op-idle-note">미가동일로 지정된 일지입니다. 미가동일은 결재 대상이 아닙니다.</div>` : ""}
    ${locked ? `<div class="op-approved-note">${fullyApproved ? "결재가 완료된" : "결재가 진행된"} 문서라 읽기 전용입니다. 다시 수정하려면 시스템관리자의 결재 리셋이 필요합니다.</div>` : ""}
    <div class="op-error" id="opError" hidden></div>

    <div class="approval-bar" id="approvalBar"></div>

    <div class="table-scroll">
      <table class="data-table op-table">
        <colgroup>
          <col style="width: 88px" />
          <col style="width: 175px" />
          <col style="width: 150px" />
          <col style="width: 76px" />
          <col style="width: 165px" />
          ${TIME_SLOT_LABELS.map(() => `<col style="width: 92px" />`).join("")}
        </colgroup>
        <thead>
          <tr>
            <th>구분</th>
            <th>사용장비</th>
            <th colspan="2">점검항목</th>
            <th>실측 기준</th>
            ${TIME_SLOTS.map((slot, i) =>
              modalState.pendingSlots.includes(slot)
                ? `<th class="op-th-pending" title="${TIME_SLOT_LABELS[i]}이 되면 서버가 자동으로 기록합니다">${TIME_SLOT_LABELS[i]}<span class="op-th-pending-tag">기록 전</span></th>`
                : `<th>${TIME_SLOT_LABELS[i]}</th>`
            ).join("")}
          </tr>
        </thead>
        <tbody id="reportTableBody"></tbody>
      </table>
    </div>

    <div class="operation-modal-footer">
      <div class="footer-left">
        ${session && session.role === "시스템관리자" && modalState.id !== null && isAnyApproved()
          ? `<button type="button" class="btn btn-secondary" id="resetApprovalBtn">결재 전체 리셋</button>`
          : ""}
      </div>
      <div class="footer-right">
        ${modalState.id !== null ? `<button type="button" class="btn btn-secondary" id="exportExcelBtn">엑셀 저장</button>` : ""}
        <button type="button" class="btn btn-secondary" id="modalCancelBtn">닫기</button>
        ${locked ? "" : `<button type="button" class="btn btn-primary" id="saveOperationBtn">저장</button>`}
      </div>
    </div>
  `;

  document.getElementById("modalBody").innerHTML = html;

  renderOperationApprovalBar();
  renderReportTable(buildReportRows(state.compressors));

  // 저장 전 문서(id 없음)는 엑셀 대상이 아니라 버튼이 없다
  const excelBtn = document.getElementById("exportExcelBtn");
  if (excelBtn) excelBtn.addEventListener("click", exportOperationLogToExcel);
  renderOperationExcelButton();
  document.getElementById("modalCancelBtn").addEventListener("click", closeOperationModal);
  const saveBtn = document.getElementById("saveOperationBtn");
  if (saveBtn) saveBtn.addEventListener("click", () => saveOperationLog());
  const resetBtn = document.getElementById("resetApprovalBtn");
  if (resetBtn) resetBtn.addEventListener("click", resetApprovals);
  document.querySelectorAll(".op-idle-opt").forEach((btn) => {
    btn.addEventListener("click", () => setOperationIdle(btn.dataset.idle === "true"));
  });
}

function showOpError(err) {
  const el = document.getElementById("opError");
  if (!el) return;
  let message = err.message;
  if (err.status === 403) message = "권한이 없습니다. (역할 또는 담당 장비 등록 여부를 확인하세요.)";
  // 409는 서버 문구(미가동·21시 전·결재 진행 중 저장 등)를 그대로 보여준다 — 본문이 비었을 때만 일반 안내
  if (err.status === 409 && !parseErrorBody(err.bodyText)) message = "처리할 수 없습니다. 결재 순서를 다시 확인하세요.";
  el.textContent = message;
  el.hidden = false;
}

// ---------- 가동 / 미가동 전환 (api-manual 20-1번) ----------

// 문서 머리 우측의 [가동 | 미가동] 전환 버튼. 결재가 진행·완료된 문서나 지난 날짜에도 바꿀 수 있다(사양).
// 로그가 없는 날짜(id 없음 — 서버가 하루 종일 꺼져 있던 날)는 서버가 받지 않으므로 비활성.
function renderIdleSwitchHtml() {
  const noLog = modalState.id === null;
  const idle = modalState.isIdle;
  const title = noLog ? "기록이 없는 날짜는 바꿀 수 없습니다" : "누르면 바로 저장됩니다";
  return `
    <div class="op-idle-switch${idle ? " is-idle" : ""}" role="group" aria-label="가동 상태" title="${title}">
      <button type="button" class="op-idle-opt${idle ? "" : " active"}" data-idle="false" aria-pressed="${!idle}"${noLog ? " disabled" : ""}>가동</button>
      <button type="button" class="op-idle-opt${idle ? " active" : ""}" data-idle="true" aria-pressed="${idle}"${noLog ? " disabled" : ""}>미가동</button>
    </div>
  `;
}

// 미가동 전환은 저장 버튼과 별개로 바로 저장된다. 응답으로 표 값까지 덮어쓰면 저장 안 한 입력이
// 사라지므로, 미가동 여부와 결재 상태만 받아와 다시 그린다(입력 중인 값과 변경 여부는 그대로 유지).
async function setOperationIdle(isIdle) {
  if (modalState.id === null || modalState.isIdle === isIdle) return;
  if (isIdle && !window.confirm("미가동 전환 하시겠습니까?\n미가동 상태에서는 결재가 불가능합니다.")) return;
  document.querySelectorAll(".op-idle-opt").forEach((btn) => (btn.disabled = true));
  try {
    const updated = await apiFetch(`/api/operation-logs/${modalState.id}/idle`, {
      method: "PUT",
      body: JSON.stringify({ isIdle }),
    });
    modalState.isIdle = !!updated.isIdle;
    modalState.level1 = updated.level1;
    modalState.level2 = updated.level2;
    modalState.level3 = updated.level3;
    renderModalBody();
    loadCalendar();
  } catch (err) {
    document.querySelectorAll(".op-idle-opt").forEach((btn) => (btn.disabled = false));
    showOpError(err);
  }
}

// ---------- 결재 바 (그리기는 common/js/approval.js, API 호출만 여기서) ----------

function renderOperationApprovalBar() {
  renderApprovalBar(document.getElementById("approvalBar"), modalState, {
    allowApprove: modalState.id !== null, // 저장 전 문서는 결재할 수 없다
    approveBlockedReason: operationApproveBlockReason(), // 미가동·21시 전이면 버튼 비활성 + 사유 툴팁
    onApprove: approveLevel,
    onCancel: cancelApproval,
  });
}

async function approveLevel() {
  if (!(await confirmBeforeApprove(operationDirty, () => saveOperationLog({ askConfirm: false, closeAfter: false })))) return;
  try {
    const updated = await apiFetch(`/api/operation-logs/${modalState.id}/approve`, { method: "POST" });
    applyLogResponse(updated);
    renderModalBody();
    operationDirty.capture();
    loadCalendar();
  } catch (err) {
    showOpError(err);
  }
}

async function cancelApproval() {
  if (!window.confirm("결재를 취소하시겠습니까?")) return;
  try {
    const updated = await apiFetch(`/api/operation-logs/${modalState.id}/approve/cancel`, { method: "POST" });
    applyLogResponse(updated);
    renderModalBody();
    operationDirty.capture();
    loadCalendar();
  } catch (err) {
    showOpError(err);
  }
}

async function resetApprovals() {
  try {
    const updated = await apiFetch(`/api/operation-logs/${modalState.id}/approvals/reset`, { method: "POST" });
    applyLogResponse(updated);
    renderModalBody();
    operationDirty.capture();
    loadCalendar();
  } catch (err) {
    showOpError(err);
  }
}

// ---------- 표 행 구성 (구분/사용장비/점검항목/실측기준 rowspan 병합) ----------

// 계통(division) 그룹 안에서 항목별로 몇 행을 차지하는지 계산해 펼친 뒤,
// division 전체 행 수를 다시 계산해서 각 행에 rowspan 메타데이터를 붙인다.
function buildReportRows(compressors) {
  const allRows = [];

  OPERATION_CATALOG.forEach((division) => {
    const divisionRows = [];

    division.items.forEach((item) => {
      if (item.kind === "auto" && item.perCompressor) {
        compressors.forEach((c, idx) => {
          divisionRows.push({
            itemLabel: item.label,
            subLabel: `압축기#${c.sequenceNo}`,
            itemKey: item.key,
            compressorId: c.id,
            refKey: item.refKey,
            defaultRef: item.defaultRef,
            kind: "text",
            auto: true,
            channelNo: item.channelNo,
            dpCompressorId: c.id,
            itemRowIndex: idx,
            itemRowCount: compressors.length,
          });
        });
      } else if (item.kind === "auto-pair") {
        // channelNo가 있으면 채널 자동측정(raw→실값 변환 필요), 없으면 장비설정 기반
        // 랜덤값(이미 실값 문자열이라 변환 불필요) — dpFor()가 channelNo 없으면 null을
        // 반환해서 자동으로 원문 그대로 표시된다.
        item.pairKeys.forEach((pairKey, idx) => {
          divisionRows.push({
            itemLabel: item.label,
            subLabel: item.pairLabels[idx],
            itemKey: pairKey,
            compressorId: null,
            refKey: item.refKey,
            defaultRef: item.defaultRef,
            kind: "text",
            auto: true,
            channelNo: item.channelNo || null,
            dpCompressorId: compressors[0] ? compressors[0].id : null,
            itemRowIndex: idx,
            itemRowCount: item.pairKeys.length,
          });
        });
      } else if (item.kind === "auto") {
        divisionRows.push({
          itemLabel: item.label,
          subLabel: "",
          itemKey: item.key,
          compressorId: null,
          refKey: item.refKey,
          defaultRef: item.defaultRef,
          kind: "text",
          auto: true,
          channelNo: item.channelNo || null,
          dpCompressorId: compressors[0] ? compressors[0].id : null,
          itemRowIndex: 0,
          itemRowCount: 1,
        });
      } else if (item.kind === "ox") {
        divisionRows.push({
          itemLabel: item.label,
          subLabel: "",
          itemKey: item.key,
          compressorId: null,
          refKey: item.refKey,
          defaultRef: item.defaultRef,
          kind: "toggle",
          auto: false,
          channelNo: null,
          dpCompressorId: null,
          itemRowIndex: 0,
          itemRowCount: 1,
        });
      }
    });

    divisionRows.forEach((row, idx) => {
      row.divisionName = division.division;
      row.equipmentLabel = division.equipmentLabel;
      row.isFirstOfDivision = idx === 0;
      row.divisionRowSpan = divisionRows.length;
    });

    allRows.push(...divisionRows);
  });

  return allRows;
}

function renderReportTable(rows) {
  const tbody = document.getElementById("reportTableBody");

  const dataRowsHtml = rows
    .map((r) => {
      const leading = [];
      if (r.isFirstOfDivision) {
        leading.push(`<td class="op-division" rowspan="${r.divisionRowSpan}">${r.divisionName}</td>`);
        leading.push(`<td class="op-equipment" rowspan="${r.divisionRowSpan}">${r.equipmentLabel}</td>`);
      }
      if (r.itemRowIndex === 0) {
        leading.push(`<td class="op-item" rowspan="${r.itemRowCount}">${r.itemLabel}</td>`);
      }

      // 압축기 반복/입출구 구분이 없는 단일 행 항목(냉매량·오일량·운전전압·운전전류·
      // 단자대&판넬상태·드레인상태·저압부단열재상태·이상진동및소음상태)은 서브(압축기번호) 칸이
      // 어차피 비어 있으므로, 그 칸과 실측기준 칸을 합쳐서 하나로 보여준다.
      const mergeSubWithRef = r.itemRowIndex === 0 && r.itemRowCount === 1 && !r.subLabel;

      let subCell = "";
      let refCell = "";
      if (r.itemRowIndex === 0) {
        const refValue = getReferenceText(r.refKey) ?? r.defaultRef ?? "";
        const plainItemLabel = r.itemLabel.replace(/<br\s*\/?>/gi, " ");
        const refText = refValue
          ? escapeAttr(refValue).replace(/\n/g, "<br />")
          : `<span class="op-ref-empty">-</span>`;
        const refDisplay = `<div class="op-ref-display" data-ref-key="${escapeAttr(r.refKey)}" data-item-label="${escapeAttr(plainItemLabel)}" data-current-value="${escapeAttr(refValue)}">${refText}</div>`;

        if (mergeSubWithRef) {
          refCell = `<td class="op-ref" colspan="2">${refDisplay}</td>`;
        } else {
          subCell = `<td class="op-sub">${r.subLabel || "-"}</td>`;
          refCell = `<td class="op-ref" rowspan="${r.itemRowCount}">${refDisplay}</td>`;
        }
      } else {
        subCell = `<td class="op-sub">${r.subLabel || "-"}</td>`;
      }

      const valueCells = TIME_SLOTS.map((slot) => renderValueCell(r, slot)).join("");

      return `<tr>${leading.join("")}${subCell}${refCell}${valueCells}</tr>`;
    })
    .join("");

  const noteRow = `
    <tr class="op-note-row">
      <td class="op-note-label">비고</td>
      <td class="op-note-text" colspan="8">${OPERATION_NOTE_TEXT}</td>
    </tr>
  `;

  tbody.innerHTML = dataRowsHtml + noteRow;

  wireTableEvents(tbody);
}

function renderValueCell(row, slot) {
  // 아직 오지 않은 기록 시각은 서버가 그 시각에 덮어쓰므로 입력을 막는다(사용자 결정 2026-11-06)
  const pending = modalState.pendingSlots.includes(slot);
  const disabled = isDocLocked() || pending;
  const cellClass = pending ? ` class="op-cell-pending"` : "";

  if (row.kind === "toggle") {
    const value = getItemSlotRaw(row.itemKey, row.compressorId, slot);
    return `
      <td${cellClass}>
        <button type="button" class="ox-toggle-btn ${oxCellClass(value)}" data-item-key="${escapeAttr(row.itemKey)}" data-slot="${slot}"${disabled ? " disabled" : ""}>${oxToggleSymbol(value)}</button>
      </td>
    `;
  }

  const raw = getItemSlotRaw(row.itemKey, row.compressorId, slot);
  const dp = row.auto ? dpFor(row.dpCompressorId, row.channelNo) : null;
  const display = toDisplayValue(raw, dp);
  const autoClass = row.auto ? "op-cell-auto" : "";

  return `
    <td${cellClass}>
      <input
        type="text"
        class="op-value-input ${autoClass}"
        data-item-key="${escapeAttr(row.itemKey)}"
        data-compressor-id="${row.compressorId ?? ""}"
        data-slot="${slot}"
        data-dp="${dp === null || dp === undefined ? "" : dp}"
        value="${escapeAttr(display)}"
        ${disabled ? "disabled" : ""}
      />
    </td>
  `;
}

function wireTableEvents(tbody) {
  tbody.querySelectorAll(".ox-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const itemKey = btn.dataset.itemKey;
      const slot = btn.dataset.slot;
      const current = getItemSlotRaw(itemKey, null, slot);
      const next = cycleOxValue(current);
      setItemSlotRaw(itemKey, null, slot, next);
      btn.innerHTML = oxToggleSymbol(next);
      btn.className = `ox-toggle-btn ${oxCellClass(next)}`;
    });
  });

  tbody.querySelectorAll(".op-value-input").forEach((input) => {
    input.addEventListener("change", () => {
      const itemKey = input.dataset.itemKey;
      const compressorId = input.dataset.compressorId ? Number(input.dataset.compressorId) : null;
      const slot = input.dataset.slot;
      const dp = input.dataset.dp !== "" ? Number(input.dataset.dp) : null;
      const raw = toRawValue(input.value, dp);
      setItemSlotRaw(itemKey, compressorId, slot, raw);
    });
  });

  if (isDocLocked()) return; // 잠긴 문서는 실측 기준도 못 고친다
  tbody.querySelectorAll(".op-ref-display").forEach((el) => {
    el.addEventListener("click", () => {
      openRefEditModal(el.dataset.refKey, el.dataset.itemLabel, el.dataset.currentValue);
    });
  });
}

// ---------- 실측 기준 수정 팝업 ----------

const refEditState = { refKey: null, currentValue: "" };

function openRefEditModal(refKey, itemLabel, currentValue) {
  refEditState.refKey = refKey;
  refEditState.currentValue = currentValue || "";
  document.getElementById("refEditItemLabel").textContent = itemLabel;
  const textarea = document.getElementById("refEditTextarea");
  // 기존 값(표에 실제로 표시 중인 값 — 저장된 값이 없으면 기본 기준값)을 입력칸에
  // 그대로 채워서 보여준다. 커서만 옮겨 필요한 부분만 고치고 저장할 수 있다.
  textarea.value = refEditState.currentValue;
  document.getElementById("refEditModal").hidden = false;
  textarea.focus();
}

function closeRefEditModal() {
  document.getElementById("refEditModal").hidden = true;
  refEditState.refKey = null;
  refEditState.currentValue = "";
}

function saveRefEdit() {
  const value = document.getElementById("refEditTextarea").value;
  setReferenceText(refEditState.refKey, value);
  closeRefEditModal();
  renderReportTable(buildReportRows(state.compressors));
}

// O/X// 토글은 common/js/ui.js의 cycleOxValue / oxCellClass / oxToggleSymbol을 쓴다.

// ---------- raw ↔ 실값 변환 (채널 자동측정 항목 전용) ----------

function dpFor(compressorId, channelNo) {
  if (!compressorId || !channelNo) return null;
  const settings = channelSettingsByCompressor.get(compressorId);
  const setting = findChannelSetting(settings, channelNo);
  return setting ? setting.decimalPlaces : null;
}

function toDisplayValue(raw, dp) {
  if (raw === null || raw === undefined || raw === "") return "";
  if (raw === "/") return "/";
  if (dp === null || dp === undefined) return String(raw);
  const num = Number(raw);
  if (Number.isNaN(num)) return String(raw);
  return formatRawValue(num, dp);
}

// 화면에 보이는 실값 문자열을 다시 raw int16 문자열로 되돌린다. 사용자가 손대지 않은
// 칸은 이 함수를 거치지 않고 원래 raw 값이 그대로 유지된다(modalState.items는 raw만 저장).
function toRawValue(display, dp) {
  const trimmed = (display || "").trim();
  if (trimmed === "") return null;
  if (trimmed === "/") return "/";
  if (dp === null || dp === undefined) return trimmed;
  const num = Number(trimmed);
  if (Number.isNaN(num)) return trimmed;
  return String(Math.round(num * Math.pow(10, dp)));
}

// ---------- modalState 조회/수정 헬퍼 ----------

function findItemEntry(itemKey, compressorId) {
  const normalized = compressorId ?? null;
  return modalState.items.find((it) => it.itemKey === itemKey && (it.compressorId ?? null) === normalized);
}

function getItemSlotRaw(itemKey, compressorId, slot) {
  const entry = findItemEntry(itemKey, compressorId);
  return entry ? entry[slot] : null;
}

function setItemSlotRaw(itemKey, compressorId, slot, value) {
  let entry = findItemEntry(itemKey, compressorId);
  if (!entry) {
    entry = { itemKey, compressorId: compressorId ?? null, time0900: null, time1300: null, time1600: null, time2100: null };
    modalState.items.push(entry);
  }
  entry[slot] = value;
}

function getReferenceText(refKey) {
  const entry = modalState.references.find((r) => r.itemKey === refKey);
  return entry ? entry.referenceText : undefined;
}

function setReferenceText(refKey, text) {
  let entry = modalState.references.find((r) => r.itemKey === refKey);
  if (!entry) {
    entry = { itemKey: refKey, referenceText: text };
    modalState.references.push(entry);
  } else {
    entry.referenceText = text;
  }
}

function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- 저장 ----------

// 저장은 문서 전체 교체다(18번). 창을 열어 둔 사이 기록 시각이 지나 서버가 그 칸을 적었다면, 화면에 남은
// 옛 값(대개 빈 칸)으로 보내면 서버 기록이 지워진다. 그래서 그린 시점엔 막혀 있었는데 지금은 지난 칸만
// 최신 서버 값으로 바꿔 보낸다 — 막혀 있던 칸이라 사용자가 고친 값은 없다.
async function mergeSlotsRecordedMeanwhile(items) {
  const passed = modalState.pendingSlots.filter((slot) => !isSlotPending(modalState.date, slot));
  if (passed.length === 0) return;

  const latest = await apiFetch(`/api/operation-logs?equipmentId=${modalState.equipmentId}&date=${modalState.date}`);
  latest.items.forEach((server) => {
    const compressorId = server.compressorId ?? null;
    let local = items.find((it) => it.itemKey === server.itemKey && it.compressorId === compressorId);
    if (!local) {
      local = { itemKey: server.itemKey, compressorId, time0900: null, time1300: null, time1600: null, time2100: null };
      items.push(local);
    }
    passed.forEach((slot) => {
      local[slot] = server[slot] ?? null;
    });
  });
}

// 결재 전 자동 저장에서도 부르므로 성공하면 true를 돌려준다(approval.js confirmBeforeApprove).
async function saveOperationLog({ askConfirm = true, closeAfter = true } = {}) {
  if (askConfirm && !window.confirm("저장하시겠습니까?")) return false;

  const items = modalState.items.map((it) => ({
    itemKey: it.itemKey,
    compressorId: it.compressorId ?? null,
    time0900: it.time0900 ?? null,
    time1300: it.time1300 ?? null,
    time1600: it.time1600 ?? null,
    time2100: it.time2100 ?? null,
  }));
  const payload = {
    equipmentId: Number(modalState.equipmentId),
    date: modalState.date,
    items,
    references: modalState.references.map((r) => ({
      itemKey: r.itemKey,
      referenceText: r.referenceText ?? null,
    })),
  };

  try {
    await mergeSlotsRecordedMeanwhile(items);
    await apiFetch("/api/operation-logs", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    loadCalendar();
    operationDirty.capture();
    if (closeAfter) closeOperationModal();
    return true;
  } catch (err) {
    showOpError(err);
    return false;
  }
}

document.addEventListener("DOMContentLoaded", initOperationPage);
