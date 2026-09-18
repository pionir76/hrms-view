// 이벤트 목록 — 자료 조회 · 장비 실시간 화면 공통 컴포넌트 + 전 화면 공통 이벤트 구분 정의
//
// 필요한 스크립트: channels.js(CHANNEL_COLORS), ui.js(escapeHtml, formatTimeOnly, formatDateTimeSeconds,
//                 minuteOfDayKst, todayDateString, formatRawValue는 channels.js)
// 필요한 스타일:   common/css/event-log.css
//
// 사용법:
//   const log = createEventLog({ root: 표가 들어갈 요소, filtersRoot: 구분 필터 칩 자리(선택) });
//   log.setEvents(events, { compressors });   // 다시 불러도 고른 필터·스크롤 위치는 유지
//
// 이벤트 응답 형식은 api-manual 9번 / 58번(최신 먼저). 내용을 클릭하면 상세 팝업이 뜬다 —
// 경보는 그 시점 측정값·정상 범위 스냅샷이 응답에 들어있어 추가 호출이 없다.

// 구분 이름·배지 색은 모든 화면이 이 정의를 쓴다(대시보드 이벤트 피드 포함)
const EVENT_CATEGORY_LABEL = {
  Alarm: "경보",
  Communication: "통신장애",
  UserAccess: "사용자",
  EmergencyStop: "비상정지",
  System: "시스템",
  Approval: "결재",
};

const EVENT_CATEGORY_BADGE = {
  Alarm: "badge-alarm",
  Communication: "badge-muted",
  EmergencyStop: "badge-stop",
  UserAccess: "badge-violet",
  System: "badge-violet",
  Approval: "badge-info",
};

// 경보 메시지는 서버가 한글 문장으로 조립해 내려준다 — "정상 범위로 복귀"가 해제 이벤트다
function isAlarmClearMessage(event) {
  return event.category === "Alarm" && String(event.message || "").includes("복귀");
}

// 경보 해제는 같은 "경보" 구분이지만 이름·색을 따로 보여준다
function eventCategoryLabel(event) {
  if (isAlarmClearMessage(event)) return "경보 해제";
  return EVENT_CATEGORY_LABEL[event.category] || event.category;
}

function eventBadgeClass(event) {
  if (isAlarmClearMessage(event)) return "badge-normal";
  return EVENT_CATEGORY_BADGE[event.category] || "badge-muted";
}

function eventBadgeHtml(event) {
  return `<span class="badge ${eventBadgeClass(event)}">${escapeHtml(eventCategoryLabel(event))}</span>`;
}

// ---------- 경보 구간 (발생 ↔ 해제 짝짓기) ----------
//
// 이벤트는 최신 먼저 오므로 시간 오름차순으로 훑는다. 압축기·채널별로 열린 구간을 하나씩 들고
// 있다가 해제를 만나면 닫는다. 해제가 먼저 오면 전날부터 이어진 경보라 자정부터 그린다.
// 끝까지 안 닫히면 "지금도 지속 중" — openEndMinute(지난 날짜 23:59, 오늘은 현재 시각)까지 그린다.

function buildAlarmRanges(events, openEndMinute = MINUTES_PER_DAY - 1) {
  const ascending = events
    .filter((e) => e.category === "Alarm" && e.compressorId && e.channelNo)
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const ranges = [];
  const open = new Map(); // key: compressorId|channelNo

  ascending.forEach((e) => {
    const key = `${e.compressorId}|${e.channelNo}`;
    const minute = minuteOfDayKst(e.createdAt);
    if (isAlarmClearMessage(e)) {
      const started = open.get(key);
      if (started === undefined) {
        ranges.push({ compressorId: e.compressorId, channelNo: e.channelNo, startMinute: 0, endMinute: minute, openStart: true });
      } else {
        ranges.push({ compressorId: e.compressorId, channelNo: e.channelNo, startMinute: started, endMinute: minute });
        open.delete(key);
      }
    } else if (!open.has(key)) {
      open.set(key, minute);
    }
  });

  open.forEach((startMinute, key) => {
    const [compressorId, channelNo] = key.split("|");
    ranges.push({
      compressorId: Number(compressorId),
      channelNo,
      startMinute,
      endMinute: Math.max(startMinute, openEndMinute),
      openEnd: true,
    });
  });

  return ranges;
}

// 해제되지 않은 경보를 어디까지 그릴지 — 오늘이면 현재 시각(분), 지난 날짜면 23:59
function alarmOpenEndMinute(date) {
  return date === todayDateString() ? minuteOfDayKst(new Date().toISOString()) : MINUTES_PER_DAY - 1;
}

function eventTargetLabel(event, compressors = []) {
  if (!event.compressorId) return "-";
  const compressor = compressors.find((c) => String(c.id) === String(event.compressorId));
  const compressorLabel = compressor ? `COMP #${compressor.sequenceNo}` : `압축기 ${event.compressorId}`;
  return event.channelNo ? `${compressorLabel} · ${event.channelNo}` : compressorLabel;
}

// ---------- 상세 팝업 (페이지마다 마크업을 두지 않고 처음 열 때 body에 한 번 붙인다) ----------

let eventModalEl = null;

function ensureEventModal() {
  if (eventModalEl) return eventModalEl;
  eventModalEl = document.createElement("div");
  eventModalEl.className = "modal-overlay";
  eventModalEl.hidden = true;
  eventModalEl.innerHTML = `
    <div class="modal-box ev-modal-box" role="dialog" aria-modal="true">
      <div class="modal-header ev-modal-header">
        <div>
          <span class="ev-modal-eyebrow">Event</span>
          <h2 class="ev-modal-title">이벤트 상세</h2>
        </div>
        <button type="button" class="modal-close-btn" data-close aria-label="닫기">×</button>
      </div>
      <div class="modal-body">
        <p class="ev-modal-message"></p>
        <table class="ev-detail-table">
          <colgroup><col style="width: 30%" /><col /></colgroup>
          <tbody>
            <tr><th>발생 시각</th><td data-field="time">-</td></tr>
            <tr><th>구분</th><td data-field="category">-</td></tr>
            <tr><th>대상</th><td data-field="target">-</td></tr>
            <tr data-alarm-row><th>측정값</th><td data-field="value">-</td></tr>
            <tr data-alarm-row><th>정상 범위</th><td data-field="range">-</td></tr>
          </tbody>
        </table>
        <p class="ev-modal-note" hidden>이 경보는 상세 값이 기록되기 전(2026-09-16 이전)에 발생해 측정값 정보가 없습니다.</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close>닫기</button>
      </div>
    </div>
  `;
  document.body.appendChild(eventModalEl);
  eventModalEl.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", closeEventModal));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !eventModalEl.hidden) closeEventModal();
  });
  return eventModalEl;
}

function openEventModal(event, compressors = []) {
  const modal = ensureEventModal();
  const field = (name) => modal.querySelector(`[data-field="${name}"]`);

  modal.querySelector(".ev-modal-message").textContent = event.message;
  field("time").textContent = formatDateTimeSeconds(event.createdAt);
  field("category").innerHTML = eventBadgeHtml(event);
  field("target").textContent = eventTargetLabel(event, compressors);

  const isAlarm = event.category === "Alarm";
  const hasSnapshot = event.value !== null && event.value !== undefined;
  modal.querySelectorAll("[data-alarm-row]").forEach((row) => {
    row.hidden = !isAlarm;
  });
  modal.querySelector(".ev-modal-note").hidden = !(isAlarm && !hasSnapshot);

  if (isAlarm) {
    const dp = event.decimalPlaces ?? 0;
    const unit = event.unit ? ` ${event.unit}` : "";
    field("value").textContent = hasSnapshot ? `${formatRawValue(event.value, dp)}${unit}` : "기록 없음";
    field("range").textContent =
      hasSnapshot && event.lowerLimit !== null && event.upperLimit !== null
        ? `${formatRawValue(event.lowerLimit, dp)} ~ ${formatRawValue(event.upperLimit, dp)}${unit}`
        : "기록 없음";
  }
  modal.hidden = false;
}

function closeEventModal() {
  if (eventModalEl) eventModalEl.hidden = true;
}

// ---------- 목록 컴포넌트 ----------

function createEventLog({ root, filtersRoot = null, emptyMessage = "이 날짜에 기록된 이벤트가 없습니다." }) {
  const st = { events: [], compressors: [], category: "" };

  root.classList.add("ev-log");
  root.innerHTML = `
    <div class="table-scroll ev-scroll">
      <table class="data-table table-hover ev-table">
        <colgroup>
          <col style="width: 80px" />
          <col />
          <col style="width: 130px" />
          <col style="width: 120px" />
        </colgroup>
        <thead>
          <tr><th>순번</th><th>내용</th><th>구분</th><th>시각</th></tr>
        </thead>
        <tbody><tr class="ev-empty-row"><td colspan="4"><div class="empty-state">불러오는 중...</div></td></tr></tbody>
      </table>
    </div>
  `;
  const tbody = root.querySelector("tbody");

  tbody.addEventListener("click", (event) => {
    const link = event.target.closest(".row-link");
    if (!link) return;
    const found = st.events.find((e) => String(e.id) === link.dataset.id);
    if (found) openEventModal(found, st.compressors);
  });

  if (filtersRoot) {
    filtersRoot.classList.add("chip-group");
    filtersRoot.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      st.category = chip.dataset.category;
      renderFilters();
      renderRows();
    });
  }

  function filtered() {
    return st.category ? st.events.filter((e) => e.category === st.category) : st.events;
  }

  function renderFilters() {
    if (!filtersRoot) return;
    const counts = {};
    st.events.forEach((e) => {
      counts[e.category] = (counts[e.category] || 0) + 1;
    });
    // 새로 받은 목록에 고른 구분이 없어졌으면 전체로 돌린다
    if (st.category && !counts[st.category]) st.category = "";
    const categories = ["", ...Object.keys(counts).sort()];
    filtersRoot.innerHTML = categories
      .map((cat) => {
        const label = cat === "" ? "전체" : escapeHtml(EVENT_CATEGORY_LABEL[cat] || cat);
        const count = cat === "" ? st.events.length : counts[cat];
        return `<button type="button" class="chip${cat === st.category ? " active" : ""}" data-category="${cat}">${label}<em>${count}</em></button>`;
      })
      .join("");
  }

  function renderRows() {
    const rows = filtered();
    if (rows.length === 0) {
      tbody.innerHTML = `<tr class="ev-empty-row"><td colspan="4"><div class="empty-state">${escapeHtml(emptyMessage)}</div></td></tr>`;
      return;
    }
    // 목록이 최신 먼저라 게시판처럼 최신 이벤트가 가장 큰 번호를 갖는다
    tbody.innerHTML = rows
      .map((e, i) => {
        const channelTag =
          e.channelNo && CHANNEL_COLORS[e.channelNo]
            ? `<span class="ev-ch" style="--channel-color: ${CHANNEL_COLORS[e.channelNo]}">${e.channelNo}</span>`
            : "";
        return `
          <tr>
            <td>${rows.length - i}</td>
            <td>${channelTag}<span class="row-link" data-id="${e.id}">${escapeHtml(e.message)}</span></td>
            <td>${eventBadgeHtml(e)}</td>
            <td>${formatTimeOnly(e.createdAt)}</td>
          </tr>
        `;
      })
      .join("");
  }

  function setEvents(events, { compressors } = {}) {
    st.events = events || [];
    if (compressors) st.compressors = compressors;
    renderFilters();
    renderRows();
  }

  function showMessage(message) {
    st.events = [];
    renderFilters();
    tbody.innerHTML = `<tr class="ev-empty-row"><td colspan="4"><div class="empty-state">${escapeHtml(message)}</div></td></tr>`;
  }

  return { setEvents, showMessage, getEvents: () => st.events };
}
