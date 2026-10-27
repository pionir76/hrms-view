// 실시간 현황 페이지 전용 스크립트 (2026-09-17 v4 개편)
//
// 쓰는 API:
//   GET /api/equipments/status  (70번) — 운영 장비 + 소속 압축기 상태. 5초마다
//   GET /api/system/status      (71번) — 시스템 정보·서버 상태 카드. 30초마다
//   GET /api/summary            (8번)  — 등록 전체·상태별 장비 수(미운영 표시). 30초마다
//   GET /api/events?since=&take= (9번) — 하단 이벤트 티커. 5초마다 since 폴링
//   (리스트 모드 "실시간 측정값" 보기는 79·80번 — dashboard-values.js)
//
// 화면 구성(사용자 결정):
//   좌 상단: 운영 장비(+미운영 수) / 운전 중인 장비 / 통신 불량 장비(모두 장비 기준) 카드
//   좌 하단: 장비 리스트 — A·B·C지구 3단, 시설동으로 묶음. 행마다 압축기 수량 배지(회색) + 통신·경보
//            on/off 배지 상시 표시(통신 = 주황, 경보 = 빨강으로 통일). 행을 누르면 장비 실시간 화면으로 이동
//   우 상단: 시스템 정보 — 저장소 사용량 도넛(사용량·전체·남은 용량), CPU·메모리 막대
//   우 하단: 서버 상태 — 서버 상태, DB 백업, 데이터 수집 주기, API 상태(응답 시간), 시스템 가동시간
//   하단: 이벤트 한 줄 티커(경보·통신장애·비상정지), 펼치면 목록 패널
//
// 운영 상태가 아닌 장비는 수집도 노출도 하지 않는다 — 70번 API가 운영 장비만 내려준다(백엔드 사양 2026-09-17).

const EQUIPMENT_POLL_MS = 5000;
const SYSTEM_POLL_MS = 30000;
const EVENT_POLL_MS = 5000;
const EVENT_KEEP = 100; // 펼친 목록에 보관하는 최근 이벤트 수
const TICKER_ITEMS = 10; // 티커에 흐르는 최근 이벤트 수

// 하단 이벤트는 장비의 경보·통신 정보만 — 로그인·시스템 이벤트는 제외
const DASHBOARD_EVENT_CATEGORIES = ["Alarm", "Communication", "EmergencyStop"];

const EQUIPMENT_FILTERS = [
  { key: "all", label: "전체", dot: null, test: () => true },
  { key: "run", label: "운전", dot: "d-run", test: (e) => e.isRunning },
  { key: "stop", label: "정지", dot: "d-stop", test: (e) => !e.isRunning },
  { key: "comm", label: "통신 불량", dot: "d-comm", test: (e) => isCommFail(e) },
  { key: "alarm", label: "경보", dot: "d-alarm", test: (e) => e.hasAlarm },
];

const dbState = {
  equipments: [],
  lastSignature: "",
  lastUpdatedAt: null,
  equipmentError: false,
  filter: "all",
  keyword: "",
  events: [], // 최신 먼저
  lastEventTimestamp: null,
  newEventCount: 0,
  summary: null, // 8번 요약 API 응답(등록 전체·상태별 장비 수) — null이면 아직 모름
  eventCategory: "",
  eventRegion: "", // 이벤트 목록 지구 필터("" = 전체, 예: "A 지구")
  panelOpen: false,
};

function isCommFail(item) {
  return item.communicationStatus !== "연결됨";
}

// ---------- 초기화 ----------

function initDashboard() {
  document.getElementById("dbSearch").addEventListener("input", (event) => {
    dbState.keyword = event.target.value.trim();
    renderEquipmentList(true);
    renderValuesTable(true);
  });
  document.getElementById("dbFilters").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter]");
    if (!chip) return;
    dbState.filter = chip.dataset.filter;
    renderFilters();
    renderEquipmentList(true);
    renderValuesTable(true);
  });
  document.getElementById("dbRegions").addEventListener("click", (event) => {
    const row = event.target.closest("[data-equipment-id]");
    if (row) window.location.href = `equipment-detail.html?id=${row.dataset.equipmentId}&from=list`;
  });
  document.getElementById("dbRegions").addEventListener("keydown", (event) => {
    const row = event.target.closest("[data-equipment-id]");
    if (row && event.key === "Enter") window.location.href = `equipment-detail.html?id=${row.dataset.equipmentId}&from=list`;
  });

  document.getElementById("dbTickerToggle").addEventListener("click", toggleEventsPanel);
  document.getElementById("dbEventFilters").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    dbState.eventCategory = chip.dataset.category;
    renderEventsPanel();
  });
  document.getElementById("dbEventRegions").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    dbState.eventRegion = chip.dataset.region;
    renderEventsPanel();
  });
  document.getElementById("dbEventsList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-event-id]");
    if (!row) return;
    const found = dbState.events.find((e) => String(e.id) === row.dataset.eventId);
    // 압축기 번호(COMP #n) 표시용으로 장비 상태에 딸린 압축기 목록을 넘긴다
    if (found) openEventModal(found, dbState.equipments.flatMap((e) => e.compressors || []));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dbState.panelOpen) toggleEventsPanel();
  });

  document.getElementById("dbSysToggle").addEventListener("click", toggleSystemPanel);
  initDashboardMap(); // 리스트 / 맵 전환과 맵 조작(dashboard-map.js)
  initDashboardValues(); // 리스트 모드의 운영 상태 / 실시간 측정값 보기 전환(dashboard-values.js)

  loadEquipments();
  setInterval(loadEquipments, EQUIPMENT_POLL_MS);
  loadSystemStatus();
  setInterval(loadSystemStatus, SYSTEM_POLL_MS);
  loadSummary();
  setInterval(loadSummary, SYSTEM_POLL_MS);
  loadEventsInitial();
  setInterval(pollEvents, EVENT_POLL_MS);
  setInterval(renderLiveBadge, 1000);
}

// ---------- 장비 상태 (5초) ----------

async function loadEquipments() {
  try {
    const equipments = await apiFetch("/api/equipments/status");
    dbState.equipments = equipments || [];
    dbState.lastUpdatedAt = Date.now();
    dbState.equipmentError = false;
  } catch (err) {
    dbState.equipmentError = true;
    renderLiveBadge();
    if (dbState.equipments.length === 0) {
      document.getElementById("dbRegions").innerHTML = `<div class="empty-state">장비 상태를 불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
    }
    return;
  }
  renderKpis();
  renderFilters();
  renderEquipmentList(false);
  renderDashboardMap(); // 맵 모드를 보고 있을 때만 다시 칠한다
  renderLiveBadge();
}

function renderLiveBadge() {
  const el = document.getElementById("dbLive");
  if (dbState.equipmentError) {
    el.className = "db-live error";
    el.textContent = "연결 확인 필요 · 마지막 값 표시 중";
    return;
  }
  if (!dbState.lastUpdatedAt) return;
  const sec = Math.max(0, Math.round((Date.now() - dbState.lastUpdatedAt) / 1000));
  el.className = "db-live";
  el.textContent = `실시간 · ${sec === 0 ? "방금" : `${sec}초 전`} 갱신`;
}

function renderKpis() {
  const list = dbState.equipments;
  const total = list.length;
  const running = list.filter((e) => e.isRunning).length;
  const commFail = list.filter(isCommFail).length;
  const compressorCount = list.reduce((sum, e) => sum + (e.compressors ? e.compressors.length : 0), 0);
  const buildingCount = new Set(list.map((e) => `${e.region}|${e.buildingName}`)).size;
  const pct = total ? Math.round((running / total) * 1000) / 10 : 0;

  renderInactiveCount(total);
  const sub = document.getElementById("kpiTotalSub");
  sub.innerHTML = `압축기 <b>${compressorCount}대</b> · 시설동 ${buildingCount}`;
  sub.title = "운영 장비에 속한 압축기·시설동 수 (미운영 장비 제외)";
  // 운전 중(강조) / 전체(약하게)
  document.getElementById("kpiRunning").innerHTML = `${running}<small class="db-kpi-of">/ ${total}대</small>`;
  document.getElementById("kpiRunningBar").style.width = `${pct}%`;
  document.getElementById("kpiRunningPct").textContent = `${pct}%`;
  document.getElementById("kpiComm").innerHTML = `${commFail}<small>대</small>`;
  // 통신 불량 장비가 있으면 카드를 주황으로 강조
  document.getElementById("kpiCommCard").classList.toggle("alert", commFail > 0);
}

// 미운영 장비 — 상태가 "미운영"인 장비 수(약하게 표시).
//
// 이 화면의 숫자는 전부 "운영 장비" 기준이다 — 70번·8번 API가 운영 장비만 집계한다(백엔드 2026-09-17).
// 그래서 카드 제목도 "전체 장비"가 아니라 "운영 장비"이고, 미운영 수를 옆에 같이 보여준다
// (운영 149 + 미운영 9 = 등록된 전체 158).
//
// 등록 전체 기준 값은 8번 요약 API에서 가져온다(약 0.3KB) — 예전엔 1번 장비 목록(약 190KB)을
// 통째로 받아 세었는데, 백엔드가 2026-09-18에 registeredEquipmentCount·equipmentCountByStatus를
// 추가해줘서 필요 없어졌다.
async function loadSummary() {
  try {
    dbState.summary = await apiFetch("/api/summary");
  } catch (err) {
    return; // 다음 주기에 재시도 — 모르면 "-"로 둔다
  }
  renderInactiveCount(dbState.equipments.length);
}

// 큰 숫자는 등록된 전체 장비 수, 그 옆에 운영·미운영을 약하게 붙인다(사용자 결정 2026-09-18).
// operating은 70번으로 받은 실제 목록 길이 — 요약 API를 아직 못 받았으면 이 값만 보여준다.
function renderInactiveCount(operating) {
  const summary = dbState.summary;
  // equipmentCountByStatus는 값이 0인 상태까지 8개가 항상 온다(백엔드 사양) — 0은 화면에서 거른다
  const byStatus = (summary && summary.equipmentCountByStatus) || {};
  const total = summary ? summary.registeredEquipmentCount : operating;
  const inactive = summary ? byStatus["미운영"] || 0 : null;
  const others = Object.entries(byStatus).filter(([status, count]) => count > 0 && status !== "운영" && status !== "미운영");
  const tip = summary
    ? `등록 ${total}대 = 운영 ${operating}대 + 미운영 ${inactive}대${others.length ? ` + ${others.map(([s, c]) => `${s} ${c}대`).join(" + ")}` : ""}`
    : "운영 중인 장비 수 (등록 전체는 조회 중)";

  const parts = [`<span class="db-kpi-extra">운영 ${operating}</span>`];
  if (inactive !== null) parts.push(`<span class="db-kpi-extra">미운영 ${inactive}</span>`);
  others.forEach(([status, count]) => parts.push(`<span class="db-kpi-extra">${escapeHtml(status)} ${count}</span>`));
  document.getElementById("kpiTotal").innerHTML = `<span title="${escapeHtml(tip)}">${total}<small>대</small></span>${parts.join("")}`;
}

function renderFilters() {
  const list = dbState.equipments;
  document.getElementById("dbFilters").innerHTML = EQUIPMENT_FILTERS.map((f) => {
    const count = list.filter(f.test).length;
    return `<button type="button" class="db-fchip ${f.dot || ""}${f.key === dbState.filter ? " active" : ""}" data-filter="${f.key}">${
      f.dot ? "<i></i>" : ""
    }${f.label}<em>${count}</em></button>`;
  }).join("");
}

// 5초마다 다시 그리면 마우스 오버·스크롤이 흔들린다 — 데이터·필터가 실제로 바뀐 경우에만 다시 그리고,
// 지구별 스크롤 위치는 유지한다. force는 필터·검색을 바꿨을 때.
function renderEquipmentList(force) {
  const filter = EQUIPMENT_FILTERS.find((f) => f.key === dbState.filter) || EQUIPMENT_FILTERS[0];
  const keyword = dbState.keyword;
  const visible = dbState.equipments.filter(
    (e) => filter.test(e) && (!keyword || e.name.includes(keyword) || e.buildingName.includes(keyword))
  );
  const signature = JSON.stringify([dbState.filter, keyword, visible]);
  if (!force && signature === dbState.lastSignature) return;
  dbState.lastSignature = signature;

  const container = document.getElementById("dbRegions");
  const scrollTops = {};
  container.querySelectorAll(".db-region-body").forEach((el) => (scrollTops[el.dataset.region] = el.scrollTop));

  const regions = collectRegions(dbState.equipments);
  container.innerHTML = regions
    .map((region) => {
      const all = dbState.equipments.filter((e) => e.region === region);
      const items = visible.filter((e) => e.region === region);
      const buildings = [...new Set(items.map((e) => e.buildingName))].sort((a, b) => a.localeCompare(b, "ko"));
      const running = all.filter((e) => e.isRunning).length;
      const comm = all.filter(isCommFail).length;
      const alarm = all.filter((e) => e.hasAlarm).length;
      const allBuildings = new Set(all.map((e) => e.buildingName)).size;

      const body =
        items.length === 0
          ? `<div class="db-region-empty">${all.length === 0 ? "운영 중인 장비가 없습니다." : "조건에 맞는 장비가 없습니다."}</div>`
          : buildings
              .map((b) => {
                const rows = items.filter((e) => e.buildingName === b).sort((x, y) => x.name.localeCompare(y.name, "ko"));
                return `<div class="db-bld"><div class="db-bld-head">${escapeHtml(b)}<em>${rows.length}</em></div>${rows.map(equipmentRowHtml).join("")}</div>`;
              })
              .join("");

      return `
        <div class="db-region">
          <div class="db-region-head">
            <b>${escapeHtml(region)}</b><span class="db-region-cnt">${all.length}대 · 시설동 ${allBuildings}</span>
            <span class="db-region-mini" title="운전 / 통신 불량 / 경보">
              <span class="d-run"><i></i>운전<b>${running}</b></span><span class="d-comm"><i></i>통신<b>${comm}</b></span><span class="d-alarm"><i></i>경보<b>${alarm}</b></span>
            </span>
          </div>
          <div class="db-region-body" data-region="${escapeHtml(region)}">${body}</div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".db-region-body").forEach((el) => {
    if (scrollTops[el.dataset.region]) el.scrollTop = scrollTops[el.dataset.region];
  });
}

// 압축기 램프 — 압축기마다 순번 칸 하나, 통신·경보 상태로 색을 입힌다(사용자 결정 2026-10-12,
// 시안 mokup/dashboard_lamps_v1). 예전엔 압축기 수량만 회색 사각에 표시했다.
//   경보 → 빨강 / 통신 끊김·재접속중 → 주황(이때 서버가 hasAlarm을 항상 false로 줘서 경보 여부를 모른다) / 정상 → 회청색
// 압축기별 운전 정보는 없으므로(운전은 장비 단위 isRunning) 정상을 초록으로 칠하지 않는다.
// 좁은 화면에서는 숫자 없는 점으로 줄어든다(dashboard.css). 맵 팝업(dashboard-map.js)도 같은 램프를 쓴다.
function compressorLampState(c) {
  if (c.communicationStatus !== "연결됨") return "comm";
  if (c.hasAlarm) return "alarm";
  return "ok";
}

const COMPRESSOR_LAMP_TEXT = { comm: "통신 끊김 — 경보 여부 알 수 없음", alarm: "경보", ok: "정상" };

function compressorLampsHtml(e) {
  const list = (e.compressors || []).slice().sort((a, b) => a.sequenceNo - b.sequenceNo);
  if (list.length === 0) return `<span class="db-lamps" title="압축기 없음"></span>`;
  return `<span class="db-lamps">${list
    .map((c) => {
      const st = compressorLampState(c);
      return `<span class="db-lamp${st === "ok" ? "" : ` ${st}`}" title="#${c.sequenceNo} ${COMPRESSOR_LAMP_TEXT[st]}">${c.sequenceNo}</span>`;
    })
    .join("")}</span>`;
}

function equipmentRowHtml(e) {
  const comm = isCommFail(e);
  const dotClass = comm ? "d-comm" : e.isRunning ? "d-run run" : "d-stop";
  // 통신이 끊기면 백엔드가 hasAlarm을 항상 false로 내린다(백엔드 변경 2026-09-28) — "경보 없음"이
  // 아니라 "알 수 없음"이므로, 경보 배지를 꺼진 모양 그대로 두지 않고 흐리게 구분한다.
  const alarmUnknown = comm;
  const emergency = !!e.isEmergencyStopped; // 70번(2026-09-29) — 현장 패널에서 직접 누른 경우도 반영된다
  const stateText = [
    emergency ? "비상정지" : null,
    e.isRunning ? "운전" : "정지",
    comm ? "통신 불량" : null,
    alarmUnknown ? "경보 여부 알 수 없음" : e.hasAlarm ? "경보" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return `
    <div class="db-eq${emergency ? " is-emg" : ""}" data-equipment-id="${e.id}" role="link" tabindex="0" title="${escapeHtml(e.name)} — ${stateText}">
      <span class="db-dot ${dotClass}"></span>
      <span class="db-eq-name">${escapeHtml(e.name)}</span>
      ${emergency ? `<span class="db-emg">비상정지</span>` : ""}
      ${compressorLampsHtml(e)}
      <span class="db-onoff comm${comm ? " on" : ""}">통신</span>
      <span class="db-onoff alarm${e.hasAlarm ? " on" : ""}${alarmUnknown ? " unknown" : ""}"${
        alarmUnknown ? ' title="통신이 끊겨 경보 여부를 알 수 없습니다"' : ""
      }>경보</span>
    </div>
  `;
}

// ---------- 시스템 정보 · 서버 상태 (30초) ----------

const DONUT_CIRCUMFERENCE = 2 * Math.PI * 74;

function formatBytesGB(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 100 ? `${Math.round(gb).toLocaleString("ko-KR")} GB` : `${gb.toFixed(1)} GB`;
}

function percentOf(used, total) {
  return total > 0 ? (used / total) * 100 : 0;
}

function healthBadge(status) {
  const cls = status === "정상" ? "ok" : status === "주의" ? "warn" : status === "오류" ? "err" : "none";
  return `<span class="db-health ${cls}">${escapeHtml(status || "-")}</span>`;
}

// 시작 시각부터 지금까지 — "12일 4시간" / "3시간 12분" / "8분"
function formatUptime(startedAtIso) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(startedAtIso).getTime()) / 60000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

// 우측 시스템 정보·서버 상태 패널 — 평소엔 접어 두고(열린 상태를 기억하지 않음) 버튼으로 연다.
// 접혀 있어도 30초 갱신은 계속해서 버튼의 상태 점을 맞춘다.
function toggleSystemPanel() {
  const body = document.querySelector(".db-body");
  const open = body.classList.toggle("sys-open");
  document.getElementById("dbSysToggle").setAttribute("aria-expanded", String(open));
  document.getElementById("dbColRight").setAttribute("aria-hidden", String(!open));
}

// 서버·API 중 나쁜 쪽을 버튼 점 색으로
function renderSystemDot(statuses) {
  const rank = { 정상: 1, 주의: 2, 오류: 3 };
  const worst = statuses.reduce((a, b) => ((rank[b] || 0) > (rank[a] || 0) ? b : a), null);
  const cls = worst === "정상" ? "ok" : worst === "주의" ? "warn" : worst === "오류" ? "err" : "none";
  const dot = document.getElementById("dbSysDot");
  dot.className = `db-sys-dot ${cls}`;
  document.getElementById("dbSysToggle").title = `서버 상태: ${worst || "알 수 없음"}`;
}

async function loadSystemStatus() {
  const errorEl = document.getElementById("sysError");
  const started = performance.now();
  let s;
  try {
    s = await apiFetch("/api/system/status");
  } catch (err) {
    errorEl.textContent = `시스템 정보를 불러오지 못했습니다. (${err.message})`;
    errorEl.hidden = false;
    document.getElementById("srvApi").innerHTML = `${healthBadge("오류")}<small>응답 없음</small>`;
    renderSystemDot(["오류"]);
    return;
  }
  renderSystemDot([s.server && s.server.status, s.api && s.api.status]);
  const responseMs = Math.round(performance.now() - started);
  errorEl.hidden = true;

  const checked = new Date(s.checkedAt);
  document.getElementById("sysCheckedAt").textContent = `${String(checked.getHours()).padStart(2, "0")}:${String(checked.getMinutes()).padStart(2, "0")}:${String(checked.getSeconds()).padStart(2, "0")} 기준 · 30초 갱신`;

  // 저장소
  if (s.storage) {
    const pct = percentOf(s.storage.usedBytes, s.storage.totalBytes);
    document.getElementById("sysDonutArc").setAttribute("stroke-dasharray", `${(DONUT_CIRCUMFERENCE * pct) / 100} ${DONUT_CIRCUMFERENCE}`);
    document.getElementById("sysStoragePct").innerHTML = `${Math.round(pct)}<small>%</small>`;
    document.getElementById("sysStorageUsed").textContent = formatBytesGB(s.storage.usedBytes);
    document.getElementById("sysStorageTotal").textContent = formatBytesGB(s.storage.totalBytes);
    document.getElementById("sysStorageFree").textContent = formatBytesGB(s.storage.totalBytes - s.storage.usedBytes);
    document.querySelector(".db-storage").title = `대상 드라이브: ${s.storage.target}`;
  } else {
    document.getElementById("sysDonutArc").setAttribute("stroke-dasharray", `0 ${DONUT_CIRCUMFERENCE}`);
    ["sysStoragePct", "sysStorageUsed", "sysStorageTotal", "sysStorageFree"].forEach((id) => (document.getElementById(id).textContent = "-"));
  }

  // CPU · 메모리
  if (s.cpu) {
    document.getElementById("sysCpu").innerHTML = `${s.cpu.usagePercent.toFixed(1)}%<small>${s.cpu.coreCount}코어</small>`;
    document.getElementById("sysCpuBar").style.width = `${Math.min(100, s.cpu.usagePercent)}%`;
  } else {
    document.getElementById("sysCpu").textContent = "-";
    document.getElementById("sysCpuBar").style.width = "0%";
  }
  if (s.memory) {
    const pct = percentOf(s.memory.usedBytes, s.memory.totalBytes);
    document.getElementById("sysMem").innerHTML = `${Math.round(pct)}%<small>${(s.memory.usedBytes / 1024 ** 3).toFixed(1)} / ${(s.memory.totalBytes / 1024 ** 3).toFixed(1)} GB</small>`;
    document.getElementById("sysMemBar").style.width = `${Math.min(100, pct)}%`;
  } else {
    document.getElementById("sysMem").textContent = "-";
    document.getElementById("sysMemBar").style.width = "0%";
  }

  // 서버 상태
  document.getElementById("srvServer").innerHTML = healthBadge(s.server && s.server.status);

  // DB 백업 — 백업 기능이 아직 없어 현재 항상 null(백엔드 README "DB 백업")
  const backup = s.databaseBackup;
  document.getElementById("srvBackup").innerHTML = !backup
    ? `<span class="db-health none">미설정</span><small>백업 기능 준비 중</small>`
    : `${backup.lastBackupAt ? escapeHtml(formatDateTimeSeconds(backup.lastBackupAt).slice(0, 16)) : "기록 없음"}${
        backup.lastBackupSucceeded ? "" : ` ${healthBadge("오류")}`
      }<small>${escapeHtml(backup.scheduleText || "일정 없음")}</small>`;

  document.getElementById("srvCollection").innerHTML = s.collection
    ? `${s.collection.intervalSeconds}초<small>압축기 ${s.collection.compressorCount}대</small>`
    : "-";

  document.getElementById("srvApi").innerHTML = `${healthBadge(s.api && s.api.status)}<small>응답 ${responseMs}ms</small>`;

  // 가동시간은 백엔드 서비스 시작 시각 기준(OS 부팅 시각 아님)
  if (s.server && s.server.startedAt) {
    document.getElementById("srvUptime").innerHTML = `${formatUptime(s.server.startedAt)}<small>서비스 시작 ${escapeHtml(
      formatDateTimeSeconds(s.server.startedAt).slice(0, 16)
    )}</small>`;
  } else {
    document.getElementById("srvUptime").textContent = "-";
  }
}

// ---------- 하단 이벤트 티커 / 펼친 목록 (5초) ----------

async function loadEventsInitial() {
  try {
    const events = await apiFetch("/api/events?take=100");
    // 폴링 기준 시각은 카테고리와 무관하게 받은 전체 중 최신 시각
    if (events && events.length > 0) dbState.lastEventTimestamp = events[0].createdAt;
    dbState.events = (events || []).filter((e) => DASHBOARD_EVENT_CATEGORIES.includes(e.category)).slice(0, EVENT_KEEP);
  } catch (err) {
    document.getElementById("dbTickerItems").innerHTML = `<span class="db-ticker-item muted">이벤트를 불러오지 못했습니다. (${escapeHtml(err.message)})</span>`;
    return;
  }
  renderTicker();
  renderEventsPanel();
}

async function pollEvents() {
  if (!dbState.lastEventTimestamp) {
    if (dbState.events.length === 0) loadEventsInitial();
    return;
  }
  let newEvents;
  try {
    newEvents = await apiFetch(`/api/events?since=${encodeURIComponent(dbState.lastEventTimestamp)}`);
  } catch (err) {
    return; // 다음 주기에 재시도
  }
  if (!newEvents || newEvents.length === 0) return;

  // since로 받으면 오래된 순 — 최신 시각을 기준으로 옮기고, 최신 먼저로 뒤집어 앞에 붙인다
  dbState.lastEventTimestamp = newEvents[newEvents.length - 1].createdAt;
  const knownIds = new Set(dbState.events.map((e) => e.id));
  const relevant = newEvents.filter((e) => DASHBOARD_EVENT_CATEGORIES.includes(e.category) && !knownIds.has(e.id)).reverse();
  if (relevant.length === 0) return;

  relevant.forEach((e) => (e._isNew = true));
  dbState.events = [...relevant, ...dbState.events].slice(0, EVENT_KEEP);
  if (!dbState.panelOpen) dbState.newEventCount += relevant.length;
  renderTicker();
  renderEventsPanel();
}

function eventTimeHtml(iso) {
  return `<time>${formatTimeOnly(iso)}</time>`;
}

// 최근 이벤트를 한 줄로 흘린다 — 끊김 없이 돌도록 같은 내용을 두 번 이어 붙이고, 길이에 맞춰 속도를 정한다
function renderTicker() {
  const track = document.getElementById("dbTickerItems");
  const recent = dbState.events.slice(0, TICKER_ITEMS);
  if (recent.length === 0) {
    track.classList.remove("moving");
    track.innerHTML = `<span class="db-ticker-item muted">최근 경보·통신 이벤트가 없습니다.</span>`;
  } else {
    const items = recent
      .map((e) => `<span class="db-ticker-item${e._isNew ? " new" : ""}">${eventBadgeHtml(e)}<span>${escapeHtml(e.message)}</span>${eventTimeHtml(e.createdAt)}</span>`)
      .join("");
    track.innerHTML = `<span class="db-ticker-run">${items}</span><span class="db-ticker-run" aria-hidden="true">${items}</span>`;
    const width = track.firstElementChild.scrollWidth;
    track.style.setProperty("--ticker-duration", `${Math.max(20, Math.round(width / 70))}s`);
    track.classList.add("moving");
  }

  const newBadge = document.getElementById("dbTickerNew");
  newBadge.hidden = dbState.newEventCount === 0;
  document.getElementById("dbTickerNewCount").textContent = dbState.newEventCount;
}

function toggleEventsPanel() {
  dbState.panelOpen = !dbState.panelOpen;
  document.getElementById("dbEventsPanel").hidden = !dbState.panelOpen;
  document.getElementById("dbTicker").classList.toggle("open", dbState.panelOpen);
  document.getElementById("dbTickerToggle").setAttribute("aria-expanded", String(dbState.panelOpen));
  document.getElementById("dbTickerToggleText").textContent = dbState.panelOpen ? "접기" : "펼치기";
  if (dbState.panelOpen) {
    renderEventsPanel();
  } else {
    // 펼쳐서 본 뒤 접으면 새 이벤트 표시를 지운다
    dbState.newEventCount = 0;
    dbState.events.forEach((e) => (e._isNew = false));
    renderTicker();
  }
}

// 이벤트의 지구 — 장비 상태(70번)에서 찾고, 없으면(운영이 아니게 된 장비 등) 문구 앞의 지구 이름으로 찾는다
// (서버 문구가 "C 지구 자동내구2동의 …"처럼 지구로 시작한다)
function eventRegion(e, regions) {
  const equipment = e.equipmentId ? dbState.equipments.find((x) => x.id === e.equipmentId) : null;
  if (equipment) return equipment.region;
  return regions.find((r) => String(e.message || "").startsWith(r)) || "";
}

// 지구(A·B·C) × 구분(경보·통신장애) 필터 — 사용자 결정 2026-10-27. 구분 칩은 경보·통신장애를 늘 보이고,
// 비상정지는 목록에 있을 때만 붙인다. 각 칩의 건수는 다른 쪽 필터를 반영한 건수다.
const DASHBOARD_EVENT_FILTER_CATEGORIES = ["Alarm", "Communication"];

function renderEventsPanel() {
  if (!dbState.panelOpen) return;
  const regions = collectRegions(dbState.equipments);
  if (dbState.eventRegion && !regions.includes(dbState.eventRegion)) dbState.eventRegion = "";
  const tagged = dbState.events.map((e) => ({ e, region: eventRegion(e, regions) }));
  const inRegion = (t) => !dbState.eventRegion || t.region === dbState.eventRegion;
  const inCategory = (t) => !dbState.eventCategory || t.e.category === dbState.eventCategory;

  document.getElementById("dbEventRegions").innerHTML = ["", ...regions]
    .map((r) => {
      const count = tagged.filter((t) => inCategory(t) && (!r || t.region === r)).length;
      return `<button type="button" class="chip${r === dbState.eventRegion ? " active" : ""}" data-region="${escapeHtml(r)}">${escapeHtml(r || "전체 지구")}<em>${count}</em></button>`;
    })
    .join("");

  const present = new Set(dbState.events.map((e) => e.category));
  const categories = ["", ...DASHBOARD_EVENT_FILTER_CATEGORIES, ...[...present].filter((c) => !DASHBOARD_EVENT_FILTER_CATEGORIES.includes(c)).sort()];
  if (dbState.eventCategory && !categories.includes(dbState.eventCategory)) dbState.eventCategory = "";
  document.getElementById("dbEventFilters").innerHTML = categories
    .map((cat) => {
      const label = cat === "" ? "전체" : EVENT_CATEGORY_LABEL[cat] || cat;
      const count = tagged.filter((t) => inRegion(t) && (!cat || t.e.category === cat)).length;
      return `<button type="button" class="chip${cat === dbState.eventCategory ? " active" : ""}" data-category="${cat}">${escapeHtml(label)}<em>${count}</em></button>`;
    })
    .join("");

  const rows = tagged.filter((t) => inRegion(t) && inCategory(t)).map((t) => t.e);
  document.getElementById("dbEventsList").innerHTML =
    rows.length === 0
      ? `<div class="empty-state">${dbState.events.length === 0 ? "최근 경보·통신 이벤트가 없습니다." : "조건에 맞는 이벤트가 없습니다."}</div>`
      : rows
          .map(
            (e) => `
              <div class="db-ev-row${e._isNew ? " new" : ""}" data-event-id="${e.id}">
                <span class="db-ev-badge">${eventBadgeHtml(e)}</span>
                <span class="db-ev-new">${e._isNew ? "새 이벤트" : ""}</span>
                <span class="db-ev-msg">${escapeHtml(e.message)}</span>
                <span class="db-ev-time">${escapeHtml(formatDateTimeSeconds(e.createdAt))}</span>
              </div>
            `
          )
          .join("");
}

document.addEventListener("DOMContentLoaded", initDashboard);
