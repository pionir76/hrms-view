// 시스템 전체에서 재사용하는 공통 UI 유틸 — 화면 전체를 덮는 BUSY(처리 중) 오버레이.
// 특정 버튼만 잠그지 않고 화면 전체의 상호작용을 막아, 처리 중에 다른 곳을 눌러
// 생기는 중복 요청/엉뚱한 상태 전환을 함께 막는다.

// 아무리 빨리 끝나는 처리라도 최소 이 시간만큼은 BUSY 표시를 유지한다 — 너무 짧으면
// 스피너가 반짝하고 사라지는 것처럼 보여 오히려 "화면이 깜빡였나?" 하는 느낌만 준다.
const BUSY_MIN_MS = 400;
const BUSY_DEFAULT_LABEL = "처리 중...";

let busyOverlayEl = null;
let busyDepth = 0; // withGlobalBusy가 중첩 호출돼도 제일 바깥쪽이 끝날 때만 감추기 위한 카운터

function ensureBusyOverlay() {
  if (busyOverlayEl) return busyOverlayEl;
  busyOverlayEl = document.createElement("div");
  busyOverlayEl.className = "global-busy-overlay";
  busyOverlayEl.hidden = true;
  busyOverlayEl.innerHTML = `
    <div class="global-busy-card">
      <div class="global-busy-spinner"></div>
      <span class="global-busy-label">처리 중...</span>
    </div>
  `;
  document.body.appendChild(busyOverlayEl);
  return busyOverlayEl;
}

// 오버레이는 마우스만 막는다 — BUSY 중에 Esc(아래 모달 닫기)·Enter/Space(포커스된 저장 버튼 다시 누르기)·
// Tab(가려진 입력칸으로 이동)이 먹히지 않게 키보드도 막는다. 다른 핸들러보다 먼저 받도록 window 캡처 단계에서 끊는다.
const BUSY_BLOCKED_KEYS = new Set(["Escape", "Enter", " ", "Tab"]);
["keydown", "keyup", "keypress"].forEach((type) => {
  window.addEventListener(
    type,
    (event) => {
      if (busyDepth === 0 || !BUSY_BLOCKED_KEYS.has(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
});

function showGlobalBusy(label) {
  busyDepth += 1;
  setGlobalBusyLabel(label);
  ensureBusyOverlay().hidden = false;
}

function hideGlobalBusy() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (busyDepth === 0) {
    ensureBusyOverlay().hidden = true;
    setGlobalBusyLabel(BUSY_DEFAULT_LABEL);
  }
}

// 오래 걸리는 작업(대용량 파일 업로드 등)이 진행 상황을 문구로 갱신할 수 있게 열어둔다 —
// 스피너만 계속 돌면 "멈춘 것 아닌가" 싶어지기 때문.
function setGlobalBusyLabel(label) {
  ensureBusyOverlay().querySelector(".global-busy-label").textContent = label || BUSY_DEFAULT_LABEL;
}

// 실행할 비동기 작업(task, 보통 API 호출)을 전체 화면 BUSY 오버레이로 감싼다.
// 성공/실패와 무관하게 시작 시점 기준 BUSY_MIN_MS가 지날 때까지는 오버레이를 유지한
// 뒤 걷어낸다. 에러는 그대로 다시 던지므로 호출한 쪽에서 기존 방식대로(에러 배너 등)
// 처리하면 된다 — 이 함수는 BUSY 표시만 책임진다.
// options.label로 표시 문구를 바꿀 수 있고, 진행 중 갱신은 setGlobalBusyLabel()로 한다.
async function withGlobalBusy(task, options = {}) {
  const minMs = options.minMs ?? BUSY_MIN_MS;
  const start = Date.now();
  showGlobalBusy(options.label);
  try {
    return await task();
  } finally {
    const remaining = minMs - (Date.now() - start);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    hideGlobalBusy();
  }
}

// ---------- 저장 안 한 변경사항 확인 (모달을 닫으려 할 때) ----------
//
// 모달/팝업을 열 때 현재 값을 스냅샷으로 남겨두고, 닫으려는 시점에 그 스냅샷과 비교해
// 실제로 바뀐 게 있을 때만 confirm으로 한 번 더 확인한다. 압축기 구성 팝업에서 쓰던
// JSON 문자열 비교 방식을 어떤 모달에도 적용할 수 있게 일반화했다 — 폼 값을 모아주는
// 함수 하나만 넘기면 된다(collectFn은 항상 같은 순서/형태의 순수 객체를 반환해야
// JSON.stringify 비교가 의미 있다).
//
// 사용법:
//   const fooDirty = createDirtyTracker(collectFooPayload);
//   openFoo() 끝에서: fooDirty.capture();
//   closeFoo() 맨 앞에서: if (!confirmDiscardIfDirty(fooDirty)) return;
function createDirtyTracker(collectFn) {
  let snapshot = null;
  return {
    capture() {
      snapshot = JSON.stringify(collectFn());
    },
    isDirty() {
      return snapshot !== null && JSON.stringify(collectFn()) !== snapshot;
    },
    reset() {
      snapshot = null;
    },
  };
}

// ---------- 목록 페이지 나누기 (장비 관리 · 교육훈련 공통) ----------
//
// 목록 API들이 전체를 한 번에 돌려주므로(건수가 많지 않다) 페이지 나누기는 화면에서 한다.
// 사용법:
//   const { pageItems, page } = paginate(rows, state.page, LIST_PAGE_SIZE);
//   state.page = page;                      // 항목이 줄어 페이지가 범위를 벗어나면 보정된 값
//   ...pageItems로 표를 그린 뒤...
//   renderPager(document.getElementById("pager"), {
//     total: rows.length, page: state.page, pageSize: LIST_PAGE_SIZE,
//     onChange: (next) => { state.page = next; render(); },
//   });

const LIST_PAGE_SIZE = 13;

function paginate(items, page, pageSize = LIST_PAGE_SIZE) {
  const lastPage = Math.max(1, Math.ceil(items.length / pageSize));
  // 삭제/필터로 마지막 페이지가 비어버리면 있는 페이지로 당긴다
  const safePage = Math.min(Math.max(1, page || 1), lastPage);
  const start = (safePage - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), page: safePage, lastPage, start, total: items.length };
}

function renderPager(el, { total, page, pageSize = LIST_PAGE_SIZE, onChange }) {
  const lastPage = Math.ceil(total / pageSize);

  if (lastPage <= 1) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }

  const pageButtons = Array.from({ length: lastPage }, (_, i) => i + 1)
    .map((n) => `<button type="button" class="pager-btn${n === page ? " active" : ""}" data-page="${n}">${n}</button>`)
    .join("");

  el.hidden = false;
  el.innerHTML = `
    <span class="pager-info">전체 ${total}건</span>
    <button type="button" class="pager-btn" data-page="${page - 1}" ${page === 1 ? "disabled" : ""}>이전</button>
    ${pageButtons}
    <button type="button" class="pager-btn" data-page="${page + 1}" ${page === lastPage ? "disabled" : ""}>다음</button>
  `;

  el.querySelectorAll(".pager-btn[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      if (onChange) onChange(Number(btn.dataset.page));
    });
  });
}

// ---------- O / X / 해당없음 토글 (점검일지 · 운전일지 공통) ----------
//
// 저장되는 값은 "O" / "X" / "/" / null(미기록) 네 가지이고, 버튼을 누를 때마다
// O → / → X → 미기록 순으로 돈다(사용자 결정 2026-09-29). 화면에는 O / / / X 모양 아이콘으로 보여준다.
// 버튼 마크업: <button class="ox-toggle-btn ${oxCellClass(value)}">${oxToggleSymbol(value)}</button>

function cycleOxValue(current) {
  if (current === "O") return "/";
  if (current === "/") return "X";
  if (current === "X") return null;
  return "O";
}

function oxCellClass(value) {
  if (value === "O") return "cell-O";
  if (value === "X") return "cell-X";
  if (value === "/") return "cell-slash";
  return "";
}

// O / / / X 모양을 SVG로 그린다(사용자 결정 2026-09-29 — 예전엔 ✓ / ✕ / – 글자). 글꼴에 따라 굵기·크기가
// 들쭉날쭉하지 않게 선으로 그리고, 색은 버튼 글자색(currentColor)을 따른다. HTML 문자열이므로 innerHTML로 넣는다.
const OX_ICON_PATHS = {
  O: '<circle cx="12" cy="12" r="8.5" />',
  "/": '<path d="M18 3.5 6 20.5" />',
  X: '<path d="M5 5l14 14M19 5 5 19" />',
};

function oxToggleSymbol(value) {
  const paths = OX_ICON_PATHS[value];
  // <title>에 값을 넣어 두면 셀의 textContent가 "O"/"/"/"X"가 된다 — 마우스를 올리면 값이 뜨고,
  // 표를 글자로 읽는 쪽(스크린리더, 예전 엑셀 저장)도 아이콘 칸의 값을 알 수 있다.
  return paths ? `<svg class="ox-icon" viewBox="0 0 24 24" role="img"><title>${value}</title>${paths}</svg>` : "";
}

function confirmDiscardIfDirty(tracker, message = "저장하지 않은 변경사항이 있습니다. 저장하지 않고 닫으시겠습니까?") {
  if (!tracker.isDirty()) return true;
  return window.confirm(message);
}

// ---------- 문자열 / 날짜·시각 포맷 (여러 페이지 공통) ----------

// ---------- 지구(지역) ----------
//
// 지구 이름은 백엔드 데이터에 있는 값을 그대로 쓴다 — 표기가 "A지구"에서 "A 지구"로 바뀐 적이 있어
// 프론트에 목록을 하드코딩하면 조용히 안 맞게 된다. 화면 순서는 항상 가나다(A→B→C)순.

function compareRegion(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), "ko");
}

// 장비 목록에서 실제로 쓰이는 지구만 뽑아 정렬해서 돌려준다
function collectRegions(equipments) {
  return [...new Set((equipments || []).map((e) => e.region).filter(Boolean))].sort(compareRegion);
}

// 장비명 + 관리번호 — 점검일지·운전일지에서 장비명 옆에 관리번호를 붙인다(2026-10-22 고객사 요청).
// 관리번호가 없는 장비는 이름만. 글자로 쓰는 곳(선택 요약)은 이것, 문서 머리·PDF는 managementNoHtml.
// 좌측 설비 드롭다운은 폭이 좁아 번호가 잘리므로 이름만 둔다(같은 시설동 안 장비명은 겹치지 않는다).
function equipmentNameWithManagementNo(name, managementNumber) {
  return managementNumber ? `${name} (${managementNumber})` : name;
}

function managementNoHtml(managementNumber) {
  return managementNumber ? `<span class="mgmt-no">관리번호 ${escapeHtml(managementNumber)}</span>` : "";
}

function escapeHtml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 오늘 날짜 'yyyy-MM-dd' — 브라우저(=한국) 시간 기준
function todayDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// 'yyyy-MM-dd'를 하루 단위로 앞뒤로 옮긴다
function shiftDateString(dateString, days) {
  const d = new Date(`${dateString}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 서버 시각(UTC ISO)을 한국 시간 하루 중 몇 번째 분(0~1439)인지로 바꾼다
function minuteOfDayKst(iso) {
  const kst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

// 분(0~1439) → "HH:mm"
function minuteLabel(minute) {
  const h = String(Math.floor(minute / 60)).padStart(2, "0");
  const m = String(minute % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// "HH:mm:ss"
function formatTimeOnly(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// "yyyy.MM.dd HH:mm:ss" — 로케일마다 표기가 달라지는 toLocaleString 대신 고정 포맷
function formatDateTimeSeconds(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// 분 → "N시간 M분"
function formatMinutes(minutes) {
  if (!minutes) return "0분";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

// 분 → 숫자는 크게, 단위는 작게(<small>) — 요약 타일 값 표시용
function formatMinutesHtml(minutes) {
  if (!minutes) return "0<small>분</small>";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}<small>분</small>`;
  if (m === 0) return `${h}<small>시간</small>`;
  return `${h}<small>시간</small>${m}<small>분</small>`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------- 장비 운영 상태 (점검일지·운전일지 문서 우측 상단 표시용) ----------
//
// 관리자가 정하는 운영 상태(운영/미운영/수리중 …)를 장비 1건 조회로 새로 읽는다. 문서를 여는 시점의
// 값이며, 읽지 못하면 fallback(목록에서 받아 둔 값)을 쓴다. 문서 표시·PDF 모두 이 값을 글자로 쓴다.
async function fetchEquipmentOperatingStatus(equipmentId, fallback) {
  try {
    const equipment = await apiFetch(`/api/equipments/${equipmentId}`);
    return (equipment && equipment.status) || fallback || "";
  } catch (err) {
    return fallback || "";
  }
}

// ---------- 창(모달) 닫기 공통 규칙 (2026-10-12) ----------
//
// 문서 창은 바깥(어두운 배경)을 눌러도 닫히지 않는다 — 실수로 누르거나, 입력칸에서 글자를 드래그하다
// 창 밖에서 손을 떼면 브라우저가 그걸 "바깥 클릭"으로 처리해 입력 중인 창이 닫혀 버렸다.
// 닫기·× 버튼과 Esc로만 닫는다(교육훈련 일지와 같은 구조).
//
// Esc는 맨 위 창 하나만 닫아야 한다. 상단바의 결재 알림(일괄 결재) 창은 어느 화면에서나 열려
// 그 화면의 문서 창 위에 겹칠 수 있으므로, 그 창이 열려 있으면 화면 쪽 Esc 처리는 건너뛴다.
function isApprovalInboxOpen() {
  const modal = document.getElementById("approvalInboxModal");
  return !!modal && !modal.hidden;
}
