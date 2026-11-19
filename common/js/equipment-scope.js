// 일지 화면의 조회 범위(내 장비 / 전체 장비) — 점검일지·운전일지 공통(2026-11-19 고객사 요청)
//
// 일지는 담당이 아닌 장비 것도 볼 수 있다. 작성·수정·결재·미가동 전환은 담당 장비만 된다(서버도 담당이
// 아니면 403). 목록은 GET /api/equipments(전체), 담당 여부는 GET /api/equipments?mine=true의 id로 판정한다.
// 시스템관리자는 전체 권한이라 모든 장비를 "담당"으로 보고 전환 버튼도 숨긴다.
// (장비 관리 화면은 같은 동작을 equipment.js에 따로 갖고 있다.)
//
// 쓰는 쪽: 페이지 HTML에 <div class="scope-switch" id="scopeSwitch" hidden>…</div>를 두고,
// loadEquipmentScope() → initScopeSwitch(저장 키, 바뀔 때 콜백) 순서로 부른다.

const JOURNAL_VIEW_ONLY_MESSAGE = "담당 장비가 아니라 조회만 할 수 있습니다.";

const equipmentScope = {
  all: [], // 전체 장비(GET /api/equipments)
  myIds: new Set(), // 담당 장비 id(문자열)
  scope: "mine", // "mine" | "all"
};

function isSystemAdminSession() {
  return getSession()?.role === "시스템관리자";
}

async function loadEquipmentScope() {
  if (isSystemAdminSession()) {
    equipmentScope.all = await apiFetch("/api/equipments");
    return;
  }
  const [all, mine] = await Promise.all([apiFetch("/api/equipments"), apiFetch("/api/equipments?mine=true")]);
  equipmentScope.all = all;
  equipmentScope.myIds = new Set(mine.map((e) => String(e.id)));
}

function isMyEquipment(equipmentId) {
  return isSystemAdminSession() || equipmentScope.myIds.has(String(equipmentId));
}

// 지금 범위에서 고를 수 있는 장비
function scopedEquipments() {
  if (equipmentScope.scope === "all" || isSystemAdminSession()) return equipmentScope.all;
  return equipmentScope.all.filter((e) => isMyEquipment(e.id));
}

// 전체 장비를 볼 때 설비 선택지에서 내 담당 장비를 구분하는 꼬리표
function equipmentOptionLabel(e) {
  const mark = equipmentScope.scope === "all" && !isSystemAdminSession() && isMyEquipment(e.id) ? " · 담당" : "";
  return `${e.name}${mark}`;
}

// 처음엔 "내 장비", 마지막 선택은 브라우저에 기억한다(장비 관리 화면과 같은 방식). 저장소를 못 쓰면 기본값.
function initScopeSwitch(storageKey, onChange) {
  const el = document.getElementById("scopeSwitch");
  if (isSystemAdminSession()) {
    equipmentScope.scope = "all";
    el.hidden = true;
    return;
  }
  try {
    equipmentScope.scope = window.localStorage.getItem(storageKey) === "all" ? "all" : "mine";
  } catch (err) {
    equipmentScope.scope = "mine";
  }
  el.hidden = false;
  renderScopeSwitch();
  el.querySelectorAll(".scope-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.scope === equipmentScope.scope) return;
      equipmentScope.scope = btn.dataset.scope;
      try {
        window.localStorage.setItem(storageKey, equipmentScope.scope);
      } catch (err) {
        // 저장 못 해도 이번 화면에서는 그대로 동작한다
      }
      renderScopeSwitch();
      onChange();
    });
  });
}

function renderScopeSwitch() {
  document.querySelectorAll("#scopeSwitch .scope-opt").forEach((btn) => {
    const active = btn.dataset.scope === equipmentScope.scope;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}
