// 장비 실시간 화면 전용 스크립트
//
// 트렌드 그래프·운전 상태 타임라인은 common/js/trend-view.js, 이벤트 목록·상세 팝업은
// common/js/event-log.js 공통 컴포넌트를 쓴다(자료 조회 화면과 같은 모양·동작).
//
// 쓰는 API:
//   장비 상세      GET /api/equipments/{id}                  (1번)
//   압축기 목록    GET /api/equipments/{id}/compressors      (3번)
//   채널 현재값    GET /api/compressors/{id}/channels        (3초마다)
//   하루 트렌드    GET /api/compressors/{id}/trend?date=     (6번)
//   가동율         GET /api/equipments/{id}/utilization?from= (7번)
//   그날 이벤트    GET /api/equipments/{id}/events?date=     (58번) — 예전에는 전체 이벤트 200건(9번)을
//                  받아 이 장비 것만 걸렀는데, 다른 장비 이벤트가 많으면 이 장비 것이 잘려 나갔다.
//
// 오늘 날짜를 보고 있으면 이벤트는 10초, 트렌드·가동율은 60초마다 다시 불러온다(트렌드 기록이
// 분 단위라 더 자주 받아도 달라지는 게 없다). 다시 그려도 보던 시간 구간·선택 채널·필터는 유지된다.

const CHANNEL_POLL_INTERVAL_MS = 3000; // 백엔드 압축기 수집 주기(3초)에 맞춤
const STATUS_POLL_INTERVAL_MS = 10 * 1000; // 장비 경보·운전 상태, 압축기 통신 상태 — 보는 날짜와 무관하게 "지금" 상태
const LIVE_EVENT_INTERVAL_MS = 10 * 1000;
const LIVE_TREND_INTERVAL_MS = 60 * 1000;

const state = {
  equipmentId: null,
  equipment: null,
  compressors: [],
  selectedCompressorId: null,
  date: null,
  events: [],
  alarmRanges: [],
  trend: null, // { compressorId, points, channelSettings } — 이벤트만 새로 받았을 때 경보 구간을 다시 입히려고 보관
};

let trendView = null;
let eventLog = null;
let liveEventTimer = null;
let liveTrendTimer = null;

function getEquipmentIdFromQuery() {
  return new URLSearchParams(window.location.search).get("id");
}

function commBadge(status) {
  const cls = status === "연결됨" ? "badge-normal" : "badge-alarm";
  return `<span class="badge ${cls}">${escapeHtml(status || "-")}</span>`;
}

// 장비 기준 경보 상태 — 소속 압축기 중 하나라도 경보가 확정되면 장비 hasAlarm이 true(api-manual 1번).
// 압축기별 경보 상태는 표에서 빼고 장비명 아래에 이 배지 하나로만 보여준다(사용자 결정).
function equipmentAlarmBadge(hasAlarm) {
  return hasAlarm ? `<span class="badge badge-alarm">경보발생</span>` : `<span class="badge badge-normal">정상</span>`;
}

function isViewingToday() {
  return state.date === todayDateString();
}

async function initEquipmentDetail() {
  state.equipmentId = getEquipmentIdFromQuery();
  if (!state.equipmentId) {
    document.getElementById("equipmentTitle").textContent = "잘못된 요청입니다.";
    return;
  }

  state.date = todayDateString();
  document.getElementById("trendDate").value = state.date;

  trendView = createTrendView({
    root: document.getElementById("trendView"),
    timelineRoot: document.getElementById("trendTimeline"),
  });
  eventLog = createEventLog({
    root: document.getElementById("eventLog"),
    filtersRoot: document.getElementById("eventFilters"),
  });

  const [equipment, compressors] = await Promise.all([
    apiFetch(`/api/equipments/${state.equipmentId}`).catch(() => null),
    apiFetch(`/api/equipments/${state.equipmentId}/compressors`).catch(() => []),
  ]);

  if (!equipment) {
    document.getElementById("equipmentTitle").textContent = "장비 정보를 불러오지 못했습니다.";
    trendView.showMessage("장비 정보를 불러오지 못했습니다.");
    eventLog.showMessage("장비 정보를 불러오지 못했습니다.");
    return;
  }

  state.equipment = equipment;
  state.compressors = (compressors || []).slice().sort((a, b) => a.sequenceNo - b.sequenceNo);
  state.selectedCompressorId = state.compressors.length > 0 ? state.compressors[0].id : null;

  document.getElementById("equipmentTitle").textContent = equipment.name;
  renderEquipmentStatus(equipment);
  renderCompressorSummary();
  populateCompressorTableHead();
  renderCompressorTable();
  populateEmergencyCompressorSelect();
  setupEmergencyModal(equipment);

  if (state.compressors.length > 0) {
    refreshChannelValues();
    setInterval(refreshChannelValues, CHANNEL_POLL_INTERVAL_MS);
  }
  setInterval(refreshStatus, STATUS_POLL_INTERVAL_MS);

  document.getElementById("trendDate").addEventListener("change", onDateChange);

  await loadDay();
}

// 날짜의 데이터 전체(이벤트 → 트렌드 → 가동율)를 불러온다. 경보 구간이 이벤트에서 나오므로 이벤트가 먼저다.
async function loadDay() {
  await loadEvents();
  await Promise.all([loadTrend(), loadUtilization()]);
  updateLiveRefresh();
}

function onDateChange() {
  const value = document.getElementById("trendDate").value;
  if (!value) return;
  state.date = value;
  state.trend = null;
  trendView.resetView(); // 날짜가 바뀌면 하루 전체 보기로 시작
  loadDay();
}

// 오늘을 보고 있을 때만 주기적으로 다시 불러온다
function updateLiveRefresh() {
  clearInterval(liveEventTimer);
  clearInterval(liveTrendTimer);
  const live = isViewingToday();
  document.getElementById("trendLiveBadge").hidden = !live;
  if (!live) return;
  liveEventTimer = setInterval(() => loadEvents({ silent: true }), LIVE_EVENT_INTERVAL_MS);
  liveTrendTimer = setInterval(() => {
    loadTrend({ silent: true });
    loadUtilization();
  }, LIVE_TREND_INTERVAL_MS);
}

// ---------- 좌측 요약 ----------

async function loadUtilization() {
  const valueEl = document.getElementById("statUtilization");
  const subEl = document.getElementById("statUtilizationSub");
  const meterEl = document.getElementById("statUtilizationMeter");
  let utilization = null;
  try {
    utilization = await apiFetch(`/api/equipments/${state.equipmentId}/utilization?from=${state.date}`);
  } catch (err) {
    // 아래에서 "-"로 표시
  }
  if (!utilization || utilization.utilizationPercent === null || utilization.utilizationPercent === undefined) {
    valueEl.textContent = "-";
    subEl.textContent = `${state.date} 트렌드 기록이 없어 계산할 수 없습니다`;
    meterEl.style.width = "0%";
    return;
  }
  valueEl.innerHTML = `${utilization.utilizationPercent}<small>%</small>`;
  meterEl.style.width = `${Math.max(0, Math.min(100, utilization.utilizationPercent))}%`;
  // 분모는 실제 기록이 있는 분이라(api-manual 7번) 기록 시간을 함께 보여준다
  subEl.textContent = `${state.date} · 기록 ${formatMinutes(utilization.totalMinutes)} 중 운전 ${formatMinutes(utilization.runningMinutes)}`;
}

// 장비명 아래 설명 + 경보 배지, 운전상태 타일
function renderEquipmentStatus(equipment) {
  document.getElementById("equipmentSubtitle").textContent =
    `${equipment.region} · ${equipment.buildingName} · 운영 상태: ${equipment.status}`;
  document.getElementById("equipmentAlarmBadge").innerHTML = equipmentAlarmBadge(equipment.hasAlarm);
  document.getElementById("statRunningState").textContent = equipment.isRunning ? "운전중" : "정지";
  document.getElementById("statRunningTile").classList.toggle("is-stopped", !equipment.isRunning);
}

// 장비 경보·운전 상태와 압축기 통신 상태를 다시 받는다. 실패하면 지금 표시를 그대로 두고 다음 주기에 재시도.
async function refreshStatus() {
  try {
    const [equipment, compressors] = await Promise.all([
      apiFetch(`/api/equipments/${state.equipmentId}`),
      apiFetch(`/api/equipments/${state.equipmentId}/compressors`),
    ]);
    state.equipment = equipment;
    renderEquipmentStatus(equipment);
    compressors.forEach((c) => {
      const cell = document.getElementById(`comm-${c.id}`);
      if (cell) cell.innerHTML = commBadge(c.communicationStatus);
    });
  } catch (err) {
    // 다음 주기에 재시도
  }
}

// 좌측 "압축기 구성" — 압축기별 IP/MAC 주소만 보여준다 (통신/경보 상태는 우측 실시간 리스트에서만 표시).
function renderCompressorSummary() {
  const tbody = document.getElementById("compressorSummaryList");
  if (state.compressors.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">등록된 압축기가 없습니다.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = state.compressors
    .map(
      (c) => `
        <tr>
          <td>#${c.sequenceNo}</td>
          <td>${escapeHtml(c.ipAddress || "-")}</td>
          <td>${escapeHtml(c.macAddress || "-")}</td>
        </tr>
      `
    )
    .join("");
}

// ---------- 압축기 리스트 (채널 현재값 3초 갱신) ----------

// 컬럼 순서: 압축기 | 저온 ~ 운전전류(채널 7개) | 통신 상태.
// 채널 머리글은 채널명만 보여주고(채널번호·단위 없음), 단위는 각 값 뒤에 붙인다.
function populateCompressorTableHead() {
  const channelHeaders = CHANNELS.map((ch) => `<th>${ch.label}</th>`).join("");
  document.getElementById("compressorTableHeadRow").innerHTML = `<th>압축기</th>${channelHeaders}<th>통신 상태</th>`;
}

function renderCompressorTable() {
  const tbody = document.getElementById("compressorTableBody");
  const colCount = 2 + CHANNELS.length;

  if (state.compressors.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${colCount}"><div class="empty-state">등록된 압축기가 없습니다.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = state.compressors
    .map((c) => {
      const channelCells = CHANNELS.map((ch) => `<td id="chval-${c.id}-${ch.no}">-</td>`).join("");
      return `
        <tr class="clickable" data-id="${c.id}">
          <td>COMP #${c.sequenceNo}</td>
          ${channelCells}
          <td id="comm-${c.id}">${commBadge(c.communicationStatus)}</td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => selectCompressor(Number(row.dataset.id)));
  });
  applyCompressorSelection();
}

function applyCompressorSelection() {
  document.querySelectorAll("#compressorTableBody tr[data-id]").forEach((row) => {
    row.classList.toggle("selected", Number(row.dataset.id) === state.selectedCompressorId);
  });
  const compressor = state.compressors.find((c) => c.id === state.selectedCompressorId);
  document.getElementById("trendCompressorLabel").textContent = compressor ? `COMP #${compressor.sequenceNo}` : "";
}

// 압축기 리스트의 채널값 셀만 갱신한다 (행 재생성 없이 값만 바꿔서 선택 표시가 유지됨).
async function refreshChannelValues() {
  await Promise.all(
    state.compressors.map(async (c) => {
      let values;
      let settings;
      try {
        [values, settings] = await Promise.all([apiFetch(`/api/compressors/${c.id}/channels`), getChannelSettings(c.id)]);
      } catch (err) {
        return; // 이 압축기만 조회 실패 — 기존 값을 유지하고 다음 주기에 재시도
      }

      CHANNELS.forEach((ch) => {
        const cell = document.getElementById(`chval-${c.id}-${ch.no}`);
        if (!cell) return;
        const found = values.find((v) => v.channelNo === ch.no);
        if (!found) {
          cell.textContent = "-";
          return;
        }
        const setting = findChannelSetting(settings, ch.no);
        const unit = (setting && setting.unit) || ch.unit;
        cell.innerHTML =
          `${formatRawValue(found.value, setting ? setting.decimalPlaces : null)}` +
          `<span class="chval-unit">${escapeHtml(unit)}</span>`;
      });
    })
  );
}

function selectCompressor(compressorId) {
  if (compressorId === state.selectedCompressorId) return;
  state.selectedCompressorId = compressorId;
  state.trend = null;
  applyCompressorSelection();
  loadTrend(); // 보던 시간 구간·선택 채널은 컴포넌트가 유지한다
}

function populateEmergencyCompressorSelect() {
  const select = document.getElementById("emergencyCompressorSelect");
  if (state.compressors.length === 0) {
    select.innerHTML = `<option value="">선택 가능한 압축기가 없습니다</option>`;
    return;
  }
  select.innerHTML = state.compressors
    .map((c) => `<option value="${c.id}">COMP #${c.sequenceNo} (${escapeHtml(c.ipAddress || "IP 없음")})</option>`)
    .join("");
}

// ---------- 트렌드 ----------

function selectedCompressorLabel() {
  const compressor = state.compressors.find((c) => c.id === state.selectedCompressorId);
  return compressor ? `COMP #${compressor.sequenceNo}` : "";
}

function selectedAlarmRanges() {
  return state.alarmRanges.filter((r) => String(r.compressorId) === String(state.selectedCompressorId));
}

// silent: 주기 갱신 — 실패해도 지금 그래프를 그대로 두고 다음 주기에 다시 시도한다
async function loadTrend({ silent = false } = {}) {
  const compressorId = state.selectedCompressorId;
  if (!compressorId) {
    trendView.showMessage("이 장비에는 압축기가 없습니다.");
    return;
  }
  if (!silent && !state.trend) trendView.showMessage("불러오는 중...", { label: selectedCompressorLabel() });

  const date = state.date;
  let points;
  let channelSettings = [];
  try {
    points = await apiFetch(`/api/compressors/${compressorId}/trend?date=${date}`);
  } catch (err) {
    if (!silent) trendView.showMessage(`트렌드를 불러오지 못했습니다. (${err.message})`, { label: selectedCompressorLabel(), alarmRanges: selectedAlarmRanges() });
    return;
  }
  try {
    channelSettings = await getChannelSettings(compressorId);
  } catch (err) {
    // 채널 설정 조회 실패 시 raw 값·공통 정의(CHANNELS)로 대체해서 그린다
  }

  // 기다리는 사이 압축기나 날짜를 바꿨으면 늦게 온 응답은 버린다
  if (compressorId !== state.selectedCompressorId || date !== state.date) return;

  state.trend = { compressorId, points, channelSettings };
  renderTrend();
}

function renderTrend() {
  if (!state.trend) return;
  trendView.setData({
    points: state.trend.points,
    channelSettings: state.trend.channelSettings,
    alarmRanges: selectedAlarmRanges(),
    label: selectedCompressorLabel(),
    emptyMessage: `${state.date}에 기록된 트렌드가 없습니다.`,
  });
}

// ---------- 이벤트 ----------

async function loadEvents({ silent = false } = {}) {
  const date = state.date;
  let events;
  try {
    events = await apiFetch(`/api/equipments/${state.equipmentId}/events?date=${date}`);
  } catch (err) {
    if (!silent) eventLog.showMessage(`이벤트를 불러오지 못했습니다. (${err.message})`);
    return;
  }
  if (date !== state.date) return;

  const nextRanges = buildAlarmRanges(events, alarmOpenEndMinute(date));
  const rangesChanged = JSON.stringify(nextRanges) !== JSON.stringify(state.alarmRanges);
  const eventsChanged = events.length !== state.events.length || (events[0] && state.events[0] && events[0].id !== state.events[0].id);

  state.events = events;
  state.alarmRanges = nextRanges;
  if (!silent || eventsChanged) eventLog.setEvents(events, { compressors: state.compressors });
  // 새 경보가 생기거나 해제되면(또는 진행 중 경보가 현재 시각까지 늘어나면) 그래프 음영도 갱신
  if (silent && rangesChanged) renderTrend();
}

// ---------- 비상정지 (API 미구현 — 확인 절차 UI만) ----------

function setupEmergencyModal(equipment) {
  const modal = document.getElementById("emergencyModal");
  const openBtn = document.getElementById("emergencyStopBtn");
  const cancelBtn = document.getElementById("emergencyCancelBtn");
  const confirmBtn = document.getElementById("emergencyConfirmBtn");
  const confirmText = document.getElementById("emergencyConfirmText");
  const select = document.getElementById("emergencyCompressorSelect");

  function openModal() {
    confirmText.textContent = `${equipment.name}의 선택한 압축기에 비상정지 명령을 전송합니다. 계속하시겠습니까?`;
    confirmBtn.disabled = state.compressors.length === 0;
    select.hidden = false;
    confirmBtn.hidden = false;
    cancelBtn.textContent = "취소";
    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
  }

  openBtn.addEventListener("click", openModal);
  cancelBtn.addEventListener("click", closeModal);

  confirmBtn.addEventListener("click", () => {
    const compressorId = select.value;
    confirmText.textContent =
      `비상정지 API가 아직 준비되지 않아 압축기 ${compressorId}에 실제 명령은 전송되지 않았습니다. (TODO.md 1-1번 참고)`;
    select.hidden = true;
    confirmBtn.hidden = true;
    cancelBtn.textContent = "닫기";
  });
}

document.addEventListener("DOMContentLoaded", initEquipmentDetail);
