// 자료 조회 페이지 전용 스크립트
//
// "장비 한 대의 하루"를 보는 화면이다. 전용 API가 따로 있는 게 아니라 네 개를 조합한다:
//   압축기 목록  GET /api/equipments/{id}/compressors      (3번)
//   하루 트렌드  GET /api/compressors/{id}/trend?date=     (6번, 압축기 1대씩)
//   그날 가동율  GET /api/equipments/{id}/utilization?from= (7번)
//   그날 이벤트  GET /api/equipments/{id}/events?date=     (58번, 페이징 없음)
//
// 엑셀 저장(2026-10-27)은 조회 때 받아둔 값만 쓴다 — 추가 요청 없이 압축기마다 시트 하나.
//
// 트렌드 그래프·운전 상태 타임라인은 common/js/trend-view.js, 이벤트 표·상세 팝업은
// common/js/event-log.js 공통 컴포넌트가 그린다(장비 실시간 화면과 공유). 이 파일은 조회 조건,
// 요약 타일, 압축기 탭과 데이터 불러오기만 맡는다.


const state = {
  equipments: [], // GET /api/equipments 전체
  equipment: null, // 조회한 장비
  date: null, // 'yyyy-MM-dd' (KST)
  compressors: [],
  selectedCompressorId: null,
  // 조회 시점에 전 압축기의 하루치를 한꺼번에 받아둔다 — 압축기 6대가 동시 호출로 0.2초
  // 남짓이라(측정값) 탭 전환마다 요청하는 것보다 훨씬 매끄럽다.
  // Map<compressorId, { points, channelSettings } | { error }>
  trendByCompressor: new Map(),
  utilization: null, // 그날 가동율(7번 응답) — 엑셀 머리에도 쓴다
  events: [], // 그날 전체 이벤트(최신 먼저)
  alarmRanges: [], // buildAlarmRanges 결과(전 압축기)
};

let trendView = null;
let eventLog = null;

function initDataQueryPage() {
  document.getElementById("dqDate").value = todayDateString();

  document.getElementById("dqRegion").addEventListener("change", onRegionChange);
  document.getElementById("dqBuilding").addEventListener("change", onBuildingChange);
  document.getElementById("dqEquipment").addEventListener("change", updateSearchButtonState);
  document.getElementById("dqDate").addEventListener("change", updateSearchButtonState);
  document.getElementById("dqSearchBtn").addEventListener("click", runQuery);
  document.getElementById("dqExcelBtn").addEventListener("click", exportTrendExcel);
  document.getElementById("dqPrevDay").addEventListener("click", () => shiftDate(-1));
  document.getElementById("dqNextDay").addEventListener("click", () => shiftDate(1));

  trendView = createTrendView({
    root: document.getElementById("dqTrendView"),
    timelineRoot: document.getElementById("dqTimeline"),
  });
  eventLog = createEventLog({
    root: document.getElementById("dqEventLog"),
    filtersRoot: document.getElementById("dqEventFilters"),
  });

  loadEquipments();
}

async function loadEquipments() {
  try {
    await withGlobalBusy(async () => {
      state.equipments = await apiFetch("/api/equipments");
    });
  } catch (err) {
    showError(`장비 목록을 불러오지 못했습니다. (${err.message})`);
    return;
  }

  const select = document.getElementById("dqRegion");
  const available = collectRegions(state.equipments);
  select.innerHTML = `<option value="">선택</option>` + available.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");
}

// ---------- 지역 → 시설동 → 설비 ----------

function onRegionChange() {
  const region = document.getElementById("dqRegion").value;
  const buildingSelect = document.getElementById("dqBuilding");
  const equipmentSelect = document.getElementById("dqEquipment");

  equipmentSelect.innerHTML = `<option value="">선택</option>`;
  equipmentSelect.disabled = true;

  if (!region) {
    buildingSelect.innerHTML = `<option value="">선택</option>`;
    buildingSelect.disabled = true;
    updateSearchButtonState();
    return;
  }

  const buildings = [...new Set(state.equipments.filter((e) => e.region === region).map((e) => e.buildingName))].sort((a, b) =>
    a.localeCompare(b, "ko")
  );
  buildingSelect.innerHTML =
    `<option value="">선택</option>` + buildings.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
  buildingSelect.disabled = false;
  updateSearchButtonState();
}

function onBuildingChange() {
  const region = document.getElementById("dqRegion").value;
  const buildingName = document.getElementById("dqBuilding").value;
  const equipmentSelect = document.getElementById("dqEquipment");

  if (!buildingName) {
    equipmentSelect.innerHTML = `<option value="">선택</option>`;
    equipmentSelect.disabled = true;
    updateSearchButtonState();
    return;
  }

  const equipments = state.equipments
    .filter((e) => e.region === region && e.buildingName === buildingName)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  equipmentSelect.innerHTML =
    `<option value="">선택</option>` + equipments.map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("");
  equipmentSelect.disabled = false;
  updateSearchButtonState();
}

function updateSearchButtonState() {
  const hasEquipment = !!document.getElementById("dqEquipment").value;
  const hasDate = !!document.getElementById("dqDate").value;
  document.getElementById("dqSearchBtn").disabled = !(hasEquipment && hasDate);
}

// 날짜를 하루 앞뒤로 옮긴다 — 이미 조회한 상태면 그 날짜로 바로 다시 조회한다.
function shiftDate(days) {
  const input = document.getElementById("dqDate");
  if (!input.value) return;
  input.value = shiftDateString(input.value, days);
  updateSearchButtonState();
  if (state.equipment) runQuery();
}

function showError(message) {
  const el = document.getElementById("dqError");
  el.textContent = message;
  el.hidden = false;
}

// ---------- 조회 ----------

async function runQuery() {
  const equipmentId = document.getElementById("dqEquipment").value;
  const date = document.getElementById("dqDate").value;
  if (!equipmentId || !date) return;

  document.getElementById("dqError").hidden = true;
  document.getElementById("dqExcelBtn").disabled = true; // 새 조회가 끝나기 전엔 예전 결과를 저장하지 않게
  state.equipment = state.equipments.find((e) => String(e.id) === String(equipmentId));
  state.date = date;

  try {
    await withGlobalBusy(async () => {
      const [compressors, utilization, events] = await Promise.all([
        apiFetch(`/api/equipments/${equipmentId}/compressors`),
        apiFetch(`/api/equipments/${equipmentId}/utilization?from=${date}`),
        apiFetch(`/api/equipments/${equipmentId}/events?date=${date}`),
      ]);

      state.compressors = compressors.slice().sort((a, b) => a.sequenceNo - b.sequenceNo);
      state.utilization = utilization;
      state.events = events;
      state.alarmRanges = buildAlarmRanges(events, alarmOpenEndMinute(date));
      state.selectedCompressorId = state.compressors.length > 0 ? state.compressors[0].id : null;

      renderSummary(utilization);
      renderCompressorTabs();
      eventLog.setEvents(events, { compressors: state.compressors });

      await loadAllTrends();
    });
  } catch (err) {
    showError(`조회하지 못했습니다. (${err.message})`);
    return;
  }

  document.getElementById("dqEmpty").hidden = true;
  document.getElementById("dqResult").hidden = false;
  document.getElementById("dqExcelBtn").disabled = state.compressors.length === 0;

  trendView.resetView(); // 날짜·장비가 바뀌었으니 하루 전체 보기로 시작한다

  if (state.selectedCompressorId) showTrend(state.selectedCompressorId);
  else trendView.showMessage("이 장비에는 압축기가 없습니다.");
}

// ---------- 요약 타일 ----------

// 숫자는 크게, 단위는 작게(<small>) 그린다 — 값은 모두 서버 숫자라 이스케이프가 필요 없다
function renderSummary(utilization) {
  const percent = utilization.utilizationPercent;
  const utilEl = document.getElementById("dqUtilization");
  if (percent === null) utilEl.textContent = "기록 없음";
  else utilEl.innerHTML = `${percent}<small>%</small>`;
  setMeter("dqUtilizationMeter", percent === null ? 0 : percent);
  document.getElementById("dqUtilizationSub").textContent =
    percent === null ? "그날 트렌드 기록이 없습니다" : `운전 ${formatMinutes(utilization.runningMinutes)}`;

  // 가동율의 분모는 "요청 기간 전체"가 아니라 "실제 기록이 있는 분"이다(api-manual 7번).
  // 기록이 비어 있으면 가동율이 실제보다 높게 보일 수 있어 함께 보여준다.
  document.getElementById("dqRecorded").innerHTML = formatMinutesHtml(utilization.totalMinutes);
  setMeter("dqRecordedMeter", ((utilization.totalMinutes || 0) / MINUTES_PER_DAY) * 100);

  const alarms = state.events.filter((e) => e.category === "Alarm");
  const occurred = alarms.filter((e) => !isAlarmClearMessage(e)).length;
  const cleared = alarms.length - occurred;
  document.getElementById("dqAlarmCount").innerHTML = `${occurred}<small>건</small>`;
  document.getElementById("dqAlarmPills").innerHTML =
    `<span class="mini-pill">발생 ${occurred}</span><span class="mini-pill ok">해제 ${cleared}</span>`;
  document.getElementById("dqAlarmSub").textContent = `전체 이벤트 ${state.events.length}건`;

  document.getElementById("dqCompressorCount").innerHTML = `${state.compressors.length}<small>대</small>`;
}

function setMeter(id, percent) {
  document.getElementById(id).style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

// ---------- 압축기 탭 ----------

function renderCompressorTabs() {
  const el = document.getElementById("dqCompressorTabs");
  el.innerHTML = state.compressors
    .map(
      (c) => `
      <button type="button" class="segmented-btn${String(c.id) === String(state.selectedCompressorId) ? " active" : ""}" data-id="${c.id}">
        COMP #${c.sequenceNo}
      </button>
    `
    )
    .join("");

  el.querySelectorAll(".segmented-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (String(btn.dataset.id) === String(state.selectedCompressorId)) return;
      state.selectedCompressorId = Number(btn.dataset.id);
      renderCompressorTabs();
      showTrend(state.selectedCompressorId);
    });
  });
}

// ---------- 트렌드 ----------

// 조회 한 번에 전 압축기의 하루치를 동시에 받아둔다. 압축기 하나가 실패해도 나머지는
// 그대로 쓸 수 있게 각각 따로 담는다.
async function loadAllTrends() {
  state.trendByCompressor = new Map();
  if (state.compressors.length === 0) return;

  let done = 0;
  const showProgress = () => setGlobalBusyLabel(`트렌드 불러오는 중... (${done}/${state.compressors.length})`);
  showProgress();

  await Promise.all(
    state.compressors.map(async (c) => {
      try {
        const [points, channelSettings] = await Promise.all([
          apiFetch(`/api/compressors/${c.id}/trend?date=${state.date}`),
          getChannelSettings(c.id),
        ]);
        state.trendByCompressor.set(c.id, { points, channelSettings });
      } catch (err) {
        state.trendByCompressor.set(c.id, { error: err.message });
      } finally {
        done += 1;
        showProgress();
      }
    })
  );
}

// 탭 전환은 이미 받아둔 데이터를 그리기만 한다 — 보던 시간 구간·선택 채널은 컴포넌트가 유지한다
function showTrend(compressorId) {
  const entry = state.trendByCompressor.get(Number(compressorId));
  const compressor = state.compressors.find((c) => String(c.id) === String(compressorId));
  const label = compressor ? `COMP #${compressor.sequenceNo}` : "";
  const alarmRanges = state.alarmRanges.filter((r) => String(r.compressorId) === String(compressorId));

  if (!entry) {
    trendView.showMessage("트렌드 데이터가 없습니다.", { label, alarmRanges });
  } else if (entry.error) {
    trendView.showMessage(`트렌드를 불러오지 못했습니다. (${entry.error})`, { label, alarmRanges });
  } else {
    trendView.setData({ points: entry.points, channelSettings: entry.channelSettings, alarmRanges, label });
  }
}

// ---------- 엑셀 저장 (2026-10-27 고객사 요청) ----------
//
// 조회한 장비·날짜의 하루 트렌드를 압축기마다 시트 하나로 저장한다(시트 이름 "COMP #1" …).
//   - 위쪽: 장비·기록 정보 — 지역·시설동·장비명(관리번호)·위치 / 압축기·날짜 / 기록 분·통신장애 분 / 가동율·출력
//   - 아래: 시각 + 센서 측정값 7열(화면과 같은 DISPLAY_CHANNELS 순서, 이름·단위는 그 압축기의 채널 설정).
//     00:00~23:59 1,440행 고정이고, 기록이 없는 분(또는 값이 없는 채널)은 "-"(사용자 결정).
//     값은 원시값에 소수점 자리수를 적용한 숫자 셀이라 엑셀에서 바로 계산·그래프가 된다.
// 운전·경보·통신 상태 열은 넣지 않는다(사용자 결정 — 센서 측정값만). 통신장애는 머리의 분 수로만 알린다.
const TREND_EXCEL_COLUMNS = 1 + DISPLAY_CHANNELS.length; // 시각 + 센서 7개
const TREND_EXCEL_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const TREND_EXCEL_LABEL_FILL = "FFF8F9FC";
const TREND_EXCEL_HEADER_FILL = "FFF1F3F8";

async function exportTrendExcel() {
  if (!state.equipment || !state.date || state.compressors.length === 0) return;
  const e = state.equipment;
  try {
    await withGlobalBusy(
      async () => {
        const workbook = new ExcelJS.Workbook();
        state.compressors.forEach((c) => writeTrendSheet(workbook, c));
        await downloadExcelWorkbook(workbook, excelFileName(["트렌드", e.region, e.name, state.date]));
      },
      { label: "엑셀 파일 만드는 중..." }
    );
  } catch (err) {
    showError(`엑셀 파일을 만들지 못했습니다. (${err.message})`);
  }
}

function writeTrendSheet(workbook, compressor) {
  const sheet = workbook.addWorksheet(`COMP #${compressor.sequenceNo}`, {
    pageSetup: { orientation: "portrait", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.getColumn(1).width = 9;
  for (let col = 2; col <= TREND_EXCEL_COLUMNS; col += 1) sheet.getColumn(col).width = 14;

  const entry = state.trendByCompressor.get(compressor.id);
  const slots = entry && !entry.error ? buildDailySlots(entry.points) : new Array(MINUTES_PER_DAY).fill(null);
  writeTrendSheetHead(sheet, compressor, slots);

  if (!entry || entry.error) {
    const row = sheet.addRow([`트렌드를 불러오지 못했습니다.${entry && entry.error ? ` (${entry.error})` : ""}`]);
    sheet.mergeCells(row.number, 1, row.number, TREND_EXCEL_COLUMNS);
    applyExcelCell(row.getCell(1), { align: "left" });
    return;
  }

  // 머리글 — "토출압력 (MPa)"처럼 채널명 + 단위
  const columns = DISPLAY_CHANNELS.map((ch) => {
    const setting = findChannelSetting(entry.channelSettings, ch.no);
    return {
      key: ch.no.toLowerCase(),
      label: (setting && setting.channelName) || ch.label,
      unit: (setting && setting.unit) || ch.unit,
      dp: setting ? setting.decimalPlaces : null,
    };
  });
  const headerRow = sheet.addRow(["시각", ...columns.map((c) => `${c.label} (${c.unit})`)]);
  headerRow.eachCell((cell) => applyExcelCell(cell, { bold: true, fill: TREND_EXCEL_HEADER_FILL }));
  headerRow.height = 22;

  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
    const point = slots[minute];
    const values = columns.map((c) => {
      const v = point ? toActualValue(point[c.key], c.dp) : null;
      return v === null || v === undefined ? "-" : v;
    });
    const row = sheet.addRow([minuteLabel(minute), ...values]);
    row.eachCell((cell, col) => {
      applyExcelCell(cell, { align: col === 1 || cell.value === "-" ? "center" : "right" });
      const dp = col > 1 ? columns[col - 2].dp : null;
      if (typeof cell.value === "number" && dp !== null && dp !== undefined) cell.numFmt = dp > 0 ? `0.${"0".repeat(dp)}` : "0";
    });
  }

  sheet.views = [{ state: "frozen", ySplit: headerRow.number }]; // 머리글까지 고정
  sheet.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: headerRow.number, column: TREND_EXCEL_COLUMNS } };
}

// 제목 + 정보 5줄(왼쪽 라벨·값, 오른쪽 라벨·값) + 빈 줄
function writeTrendSheetHead(sheet, compressor, slots) {
  const e = state.equipment;
  const recorded = slots.filter(Boolean).length;
  const commLoss = slots.filter((p) => p && p.isConnected === false).length;
  const percent = state.utilization ? state.utilization.utilizationPercent : null;
  const day = TREND_EXCEL_WEEKDAYS[new Date(`${state.date}T00:00:00`).getDay()];
  const session = getSession();
  const printedBy = (session && session.profile && session.profile.fullName) || (session && session.username) || "";
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const printedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const titleRow = sheet.addRow(["트렌드 기록"]);
  sheet.mergeCells(titleRow.number, 1, titleRow.number, TREND_EXCEL_COLUMNS);
  applyExcelCell(titleRow.getCell(1), { bold: true, size: 14, align: "left" });
  titleRow.getCell(1).border = {};
  titleRow.height = 26;

  const info = [
    [["지역", e.region], ["시설동", e.buildingName]],
    [["장비명", equipmentNameWithManagementNo(e.name, e.managementNumber)], ["위치", e.location || "-"]],
    [["압축기", `COMP #${compressor.sequenceNo}`], ["날짜", `${state.date} (${day})`]],
    [["기록", `${recorded.toLocaleString()}분 / ${MINUTES_PER_DAY.toLocaleString()}분`], ["통신장애", `${commLoss.toLocaleString()}분`]],
    [["가동율", percent === null ? "기록 없음" : `${percent}% (장비 기준)`], ["출력", `${printedAt}${printedBy ? ` · ${printedBy}` : ""}`]],
  ];
  // 8열을 [라벨 1 | 값 3 | 라벨 1 | 값 3]으로 나눈다
  info.forEach(([left, right]) => {
    const row = sheet.addRow([]);
    [
      [left, 1],
      [right, 5],
    ].forEach(([[label, value], col]) => {
      const labelCell = row.getCell(col);
      labelCell.value = label;
      applyExcelCell(labelCell, { bold: true, fill: TREND_EXCEL_LABEL_FILL, size: 9 });
      sheet.mergeCells(row.number, col + 1, row.number, col + 3);
      const valueCell = row.getCell(col + 1);
      valueCell.value = value ?? "";
      applyExcelCell(valueCell, { align: "left" });
    });
    row.height = 20;
  });
  sheet.addRow([]);
}

document.addEventListener("DOMContentLoaded", initDataQueryPage);
