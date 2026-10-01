// 실시간 현황 — 맵 모드 (시안 mokup/dashboard_map_v1, 사용자 결정 2026-10-01)
//
// 남양연구소 지도(assets/main_map_f.svg)의 시설동 도형을, 그 시설동에 속한 장비들의 상태로 칠한다.
// 장비 상태는 리스트 모드와 같은 70번 API(dashboard.js가 5초마다 받는 dbState.equipments)를 쓴다.
//
// 지도 파일 규칙(사용자가 Inkscape로 관리 — 같은 파일명으로 덮어쓴다):
//   - 시설동 도형은 "Area_A" / "Area_B" / "Area_C" 레이어(<g inkscape:label="Area_X">) 안의 path/rect
//   - 도형의 <title>이 시설동 이름 — DB buildingName과 **같은 지구 안에서, 띄어쓰기·하이픈을 빼고** 비교한다
//     (예: 지도 "PT 배기환경 시험동" ↔ DB "PT배기환경시험동", "PDI-1동" ↔ "PDI 1동")
//   - 그 밖의 레이어(도로·윤곽선)는 옅은 선으로만 그린다
//
// 시설동 색: 소속 장비 중 가장 나쁜 상태 — 경보·비상정지 > 통신오류 > 운전 > 정지(idle).
// 통신이 끊긴 장비는 서버가 hasAlarm을 항상 false로 주므로(경보 여부를 모름) 통신오류로 본다.
//
// 디자인(시안 mokup/dashboard_map_v2, 2026-10-01): 파스텔 배경이 천천히 흐르고, 캠퍼스 경계(Map_Boundary)는
// 흰 면, 녹지(지도 원본 연두 #c3fcc6)는 민트, 바탕 레이어의 채움 없는 닫힌 도형(트랙·도로)은 연한 회청색으로 채운다.
// 이름(title)이 있는 도형은 모두 작고 옅게 "건물번호(Inkscape 라벨, 예: A1-5) / 이름" 두 줄로 쓰고,
// 장비가 있는 시설동만 조금 진하게 쓴다(사용자 결정 2026-10-01 — 대수 표시는 뺐다). 좌측 상단에 방위(북 N).
// 상태 애니메이션 — 경보: 깜빡임 + 붉은 빛 / 통신오류: 점선 테두리 흐름 / 운전: 숨쉬기 빛 / 정지: 없음.
// 시설동을 누르면 DB 시설동 이름·지도 이름·소속 장비를 간단히 보여준다.
// (DB 시설동 ↔ 지도 이름 맞추기는 2026-10-01 끝나서 테스트용 "시설동 연결 확인" 패널은 뺐다.)

const MAP_SVG_URL = "../../assets/main_map_f.svg";
const MAP_SVG_NS = "http://www.w3.org/2000/svg";
const MAP_STATE_RANK = { alarm: 4, comm: 3, run: 2, idle: 1 };
const MAP_STATE_LABEL = { alarm: "경보", emergency: "비상정지", comm: "통신오류", run: "운전", idle: "정지" };
const MAP_INACTIVE_REFRESH_MS = 5 * 60 * 1000; // 운영 상태는 관리자가 가끔 바꾸는 값이라 5분이면 충분
const MAP_FIT_PADDING = 40; // 지구에 맞출 때 둘레 여백(지도 단위 mm)
const MAP_GREEN_FILL = /fill:\s*#c3fcc6/i; // 지도 원본의 녹지 색 — 파스텔 민트로 바꿔 칠한다
const MAP_LABEL_MIN_SIZE = { w: 8, h: 6 }; // 이보다 작은 도형엔 이름을 쓰지 않는다(지도 단위)
const MAP_BUILDING_CODE = /^[A-Z]\d*-\d+(-\d+)*$/; // 건물번호 형태의 Inkscape 라벨(A-2, A1-5, C5-6-1). "path12" 같은 자동 이름은 제외

// 도형의 건물번호 — Inkscape 라벨이 건물번호 형태일 때만
function mapBuildingCode(el) {
  const label = (el.getAttribute("inkscape:label") || "").trim();
  return MAP_BUILDING_CODE.test(label) ? label : "";
}

const mapState = {
  active: false, // 맵 모드를 보고 있는지 — 리스트 모드일 때는 다시 그리지 않는다
  loading: null, // 지도 파일을 받는 중인 Promise
  svg: null,
  shapes: [], // [{ el, region: "A", title, key }]
  regions: [], // 지도에 있는 지구 ["A", "B", "C"]
  fullViewBox: null, // { x, y, w, h } — 지도 전체
  view: null, // 지금 보고 있는 범위
  tab: "all", // "all" | "A" | "B" | "C"
  selectedKey: null, // 팝업으로 보고 있는 도형 키
  inactive: [], // 운영이 아닌 장비(미운영·수리중 …) — 1번 API, 맵을 열 때 + MAP_INACTIVE_REFRESH_MS마다
  inactiveLoadedAt: 0,
  buildings: {}, // `${region}|${정규화 이름}` → { region, name, items: [장비] }
  drag: null,
};

// 시설동 이름 비교용 — 띄어쓰기·하이픈 제거
function normalizeBuildingName(name) {
  return String(name || "").replace(/[\s-]/g, "");
}

// DB region("A지구", "A 지구" …) → "A"
function regionLetter(region) {
  const m = String(region || "").match(/[A-Za-z]/);
  return m ? m[0].toUpperCase() : "";
}

// 장비 1대의 맵 상태
function equipmentMapState(e) {
  if (e.isEmergencyStopped) return "alarm";
  if (isCommFail(e)) return "comm";
  if (e.hasAlarm) return "alarm";
  if (e.isRunning) return "run";
  return "idle";
}

function equipmentMapLabel(e) {
  if (e.isEmergencyStopped) return MAP_STATE_LABEL.emergency;
  return MAP_STATE_LABEL[equipmentMapState(e)];
}

// ---------- 초기화 ----------

function initDashboardMap() {
  document.querySelectorAll(".db-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setDashboardMode(btn.dataset.mode));
  });
  document.getElementById("dbMapTabs").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tab]");
    if (!btn) return;
    mapState.tab = btn.dataset.tab;
    renderMapTabs();
    fitMapToTab();
    syncDashboardUrl();
  });
  document.getElementById("dbMapZoomIn").addEventListener("click", () => zoomMap(0.8));
  document.getElementById("dbMapZoomOut").addEventListener("click", () => zoomMap(1.25));
  document.getElementById("dbMapFit").addEventListener("click", fitMapToTab);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mapState.selectedKey) hideMapPopupNow();
  });

  // 주소에 맵 상태가 있으면 그대로 연다 — 장비 실시간 화면의 "실시간 현황으로"·브라우저 뒤로 가기로 돌아왔을 때
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "map") {
    const tab = params.get("tab");
    if (tab && /^(all|[A-Z])$/.test(tab)) mapState.tab = tab;
    setDashboardMode("map");
  }
}

// 지금 보기(리스트 / 맵 + 지구 탭)를 주소에 남긴다 — 새로고침·뒤로 가기에도 같은 보기로 돌아오게(히스토리는 늘리지 않음)
function syncDashboardUrl() {
  const url = new URL(window.location.href);
  if (mapState.active) {
    url.searchParams.set("mode", "map");
    url.searchParams.set("tab", mapState.tab);
  } else {
    url.searchParams.delete("mode");
    url.searchParams.delete("tab");
  }
  window.history.replaceState(null, "", url);
}

function setDashboardMode(mode) {
  const map = mode === "map";
  mapState.active = map;
  document.querySelectorAll(".db-mode-btn").forEach((btn) => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  });
  document.querySelector(".db-col-left").classList.toggle("is-map", map);
  syncDashboardUrl();
  if (map) showDashboardMap();
}

async function showDashboardMap() {
  if (!mapState.svg) {
    try {
      await loadMapSvg();
    } catch (err) {
      document.getElementById("dbMapStage").innerHTML = `<div class="empty-state">지도를 불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
      return;
    }
  }
  renderDashboardMap();
  loadInactiveEquipments();
}

// 운영이 아닌 장비(미운영·수리중 …) — 70번(5초 갱신)은 운영 장비만 주므로 1번 전체 목록(약 190KB)에서
// 골라 둔다. 맵을 열 때 한 번, 그 뒤로는 5분이 지났을 때만 다시 받는다(사용자 결정 2026-10-01 방법 1).
// 이 장비들은 수집 대상이 아니라 운전·경보·통신 상태가 없고 운영 상태만 보여준다.
async function loadInactiveEquipments() {
  if (Date.now() - mapState.inactiveLoadedAt < MAP_INACTIVE_REFRESH_MS) return;
  mapState.inactiveLoadedAt = Date.now();
  try {
    const all = await apiFetch("/api/equipments");
    mapState.inactive = (all || []).filter((e) => e.status !== "운영");
    renderDashboardMap();
  } catch (err) {
    mapState.inactiveLoadedAt = 0; // 다음에 맵을 열 때 다시 시도
  }
}

// 지도 파일은 사용자가 같은 이름으로 덮어쓰므로 캐시를 쓰지 않고(서버에 변경 여부만 확인) 받는다
function loadMapSvg() {
  if (mapState.loading) return mapState.loading;
  mapState.loading = (async () => {
    const res = await fetch(MAP_SVG_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`지도 파일 ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.nodeName !== "svg") throw new Error("지도 파일 형식이 올바르지 않습니다");

    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.classList.add("db-map-svg");
    svg.querySelectorAll("sodipodi\\:namedview, namedview").forEach((n) => n.remove());

    const stage = document.getElementById("dbMapStage");
    stage.innerHTML = "";
    stage.appendChild(document.importNode(svg, true));
    mapState.svg = stage.querySelector("svg");
    indexMapShapes();
    wireMapInteraction();

    const vb = mapState.svg.viewBox.baseVal;
    mapState.fullViewBox = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    renderMapTabs();
    fitMapToTab();
  })();
  return mapState.loading;
}

// 레이어 이름으로 지구 도형과 바탕(도로·윤곽선)을 나눈다
function indexMapShapes() {
  mapState.shapes = [];
  mapState.regions = [];
  [...mapState.svg.children]
    .filter((g) => g.tagName === "g")
    .forEach((g) => {
      const label = g.getAttribute("inkscape:label") || "";
      if (label === "Map_Boundary") {
        g.classList.add("db-map-boundary");
        return;
      }
      const m = label.match(/^Area_([A-Za-z])$/);
      if (!m) {
        // 바탕(도로·녹지·시험로) — 녹지는 민트, 채움 없는 닫힌 도형은 도로색, 이름이 있으면 옅게 표시
        g.classList.add("db-map-base");
        g.querySelectorAll("path, rect, polygon, ellipse, circle").forEach((el) => {
          const style = el.getAttribute("style") || "";
          if (MAP_GREEN_FILL.test(style)) el.classList.add("db-map-green");
          else if (/fill:\s*none/i.test(style)) el.classList.add("db-map-road");
          const title = (el.querySelector("title")?.textContent || "").trim();
          if (title) addMapLabel(el, title, mapBuildingCode(el));
        });
        return;
      }
      const region = m[1].toUpperCase();
      g.dataset.region = region;
      mapState.regions.push(region);
      g.querySelectorAll("path, rect, polygon, ellipse, circle").forEach((el, i) => {
        const title = (el.querySelector("title")?.textContent || "").trim();
        const key = `${region}|${el.id || i}`;
        el.classList.add("db-map-bld");
        if (MAP_GREEN_FILL.test(el.getAttribute("style") || "")) el.classList.add("db-map-green");
        el.dataset.key = key;
        mapState.shapes.push({ el, region, title, key, code: mapBuildingCode(el) });
      });
    });
  mapState.regions.sort();
}

// ---------- 다시 그리기 (5초마다 dashboard.js가 부른다) ----------

function renderDashboardMap() {
  if (!mapState.active || !mapState.svg) return;

  // DB 장비를 지구·시설동별로 묶는다
  const buildings = {};
  dbState.equipments.forEach((e) => {
    const region = regionLetter(e.region);
    const key = `${region}|${normalizeBuildingName(e.buildingName)}`;
    if (!buildings[key]) buildings[key] = { region, regionName: e.region, name: e.buildingName, items: [], inactive: [], shapes: [] };
    buildings[key].items.push(e);
  });
  mapState.inactive.forEach((e) => {
    const region = regionLetter(e.region);
    const key = `${region}|${normalizeBuildingName(e.buildingName)}`;
    if (!buildings[key]) buildings[key] = { region, regionName: e.region, name: e.buildingName, items: [], inactive: [], shapes: [] };
    buildings[key].inactive.push(e);
  });

  // 도형 ↔ DB 시설동 연결 + 색
  mapState.svg.querySelectorAll(".db-map-lbl.area").forEach((t) => t.remove());
  mapState.shapes.forEach((s) => {
    const b = s.title ? buildings[`${s.region}|${normalizeBuildingName(s.title)}`] : null;
    s.building = b || null;
    s.el.classList.remove("st-alarm", "st-comm", "st-run", "st-idle", "st-none");
    if (!b) {
      s.el.classList.add("st-none");
      if (s.title) addMapLabel(s.el, s.title, s.code, { area: true });
      return;
    }
    b.shapes.push(s);
    // 운영 장비 없이 운영 외(미운영·수리중 …) 장비만 있으면 "장비 없음" 색 — 팝업에서는 그 장비들을 보여준다
    if (b.items.length === 0) {
      s.el.classList.add("st-none");
      addMapLabel(s.el, s.title, s.code, { area: true });
      return;
    }
    const st = b.items.reduce((worst, e) => {
      const cur = equipmentMapState(e);
      return MAP_STATE_RANK[cur] > MAP_STATE_RANK[worst] ? cur : worst;
    }, "idle");
    s.el.classList.add(`st-${st}`);
    addMapLabel(s.el, s.title, s.code, { area: true, strong: true });
  });

  mapState.buildings = buildings;
  if (mapState.selectedKey) renderMapPopup();
}

// 도형 가운데에 "건물번호 / 이름" 두 줄(번호가 없으면 이름만, 옅게).
// strong: 장비가 있는 시설동이면 조금 진하게 / area: 지구 도형 라벨이면 true — 5초마다 다시 그릴 때
// 이것만 지운다(바탕 라벨은 처음 한 번만)
function addMapLabel(el, name, code, { area = false, strong = false } = {}) {
  const bb = el.getBBox();
  if (bb.width < MAP_LABEL_MIN_SIZE.w || bb.height < MAP_LABEL_MIN_SIZE.h) return;
  const m = el.transform.baseVal.consolidate();
  const tx = m ? m.matrix.e : 0;
  const ty = m ? m.matrix.f : 0;
  const cx = bb.x + bb.width / 2 + tx;
  const cy = bb.y + bb.height / 2 + ty;
  const text = document.createElementNS(MAP_SVG_NS, "text");
  text.setAttribute("class", `db-map-lbl${strong ? " has" : ""}${area ? " area" : ""}`);
  text.setAttribute("x", cx);
  text.setAttribute("y", cy + (code ? -2 : 3));
  if (code) {
    const codeSpan = document.createElementNS(MAP_SVG_NS, "tspan");
    codeSpan.setAttribute("x", cx);
    codeSpan.setAttribute("class", "no");
    codeSpan.textContent = code;
    text.append(codeSpan);
  }
  const nameSpan = document.createElementNS(MAP_SVG_NS, "tspan");
  nameSpan.setAttribute("x", cx);
  if (code) nameSpan.setAttribute("dy", "10");
  nameSpan.textContent = name;
  text.append(nameSpan);
  el.parentNode.appendChild(text);
}

// ---------- 지구 탭 · 확대/이동 ----------

function renderMapTabs() {
  const tabs = ["all", ...mapState.regions];
  document.getElementById("dbMapTabs").innerHTML = tabs
    .map((t) => `<button type="button" class="db-map-tab${t === mapState.tab ? " on" : ""}" data-tab="${t}">${t === "all" ? "전체" : `${t}지구`}</button>`)
    .join("");
}

function fitMapToTab() {
  if (!mapState.svg) return;
  let box = mapState.fullViewBox;
  if (mapState.tab !== "all") {
    const g = mapState.svg.querySelector(`g[data-region="${mapState.tab}"]`);
    const bb = g ? g.getBBox() : null; // 그룹 getBBox는 자식 도형의 transform까지 반영된 값
    if (bb && bb.width > 0 && bb.height > 0) {
      box = { x: bb.x - MAP_FIT_PADDING, y: bb.y - MAP_FIT_PADDING, w: bb.width + MAP_FIT_PADDING * 2, h: bb.height + MAP_FIT_PADDING * 2 };
    }
  }
  setMapView({ ...box });
}

function setMapView(view) {
  mapState.view = view;
  mapState.svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  if (mapState.selectedKey) positionMapPopup();
}

// factor < 1 확대, > 1 축소. (cx, cy)는 지도 좌표 기준 고정점(없으면 가운데)
function zoomMap(factor, cx, cy) {
  const v = mapState.view;
  if (!v) return;
  const full = mapState.fullViewBox;
  const w = Math.min(full.w * 1.5, Math.max(full.w / 60, v.w * factor));
  const h = (v.h / v.w) * w;
  const px = cx ?? v.x + v.w / 2;
  const py = cy ?? v.y + v.h / 2;
  setMapView({ x: px - ((px - v.x) / v.w) * w, y: py - ((py - v.y) / v.h) * h, w, h });
}

// 화면 좌표 → 지도 좌표
function mapPointFromEvent(event) {
  const pt = mapState.svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  return pt.matrixTransform(mapState.svg.getScreenCTM().inverse());
}

function wireMapInteraction() {
  const svg = mapState.svg;
  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const p = mapPointFromEvent(event);
      zoomMap(event.deltaY < 0 ? 0.85 : 1.18, p.x, p.y);
    },
    { passive: false }
  );
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // 누른 시설동을 여기서 기억한다 — 아래 setPointerCapture 뒤에는 pointerup의 target이 도형이 아니라
    // svg 자체가 되어, 떼는 시점에 target으로 시설동을 찾으면 항상 "빈 곳 클릭"이 된다(실제 브라우저 동작)
    const shapeEl = event.target.closest(".db-map-bld");
    mapState.drag = { x: event.clientX, y: event.clientY, view: { ...mapState.view }, moved: false, shapeKey: shapeEl ? shapeEl.dataset.key : null };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    const d = mapState.drag;
    if (!d) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return; // 살짝 흔들린 클릭은 이동으로 보지 않는다
    d.moved = true;
    svg.classList.add("dragging");
    hideMapTip(); // 끌어서 옮기는 동안 툴팁은 치운다
    const scale = d.view.w / svg.clientWidth; // meet라 가로·세로 배율이 같다고 보고 가까운 쪽을 쓴다
    const s = Math.max(scale, d.view.h / svg.clientHeight);
    setMapView({ ...d.view, x: d.view.x - dx * s, y: d.view.y - dy * s });
  });
  svg.addEventListener("pointerup", (event) => {
    const d = mapState.drag;
    mapState.drag = null;
    svg.classList.remove("dragging");
    if (d && d.moved) return;
    // 클릭 — 누를 때의 시설동이면 장비 목록 팝업, 빈 곳이면 닫기
    if (d && d.shapeKey) showMapPopup(d.shapeKey);
    else hideMapPopupNow();
  });

  // 호버 — 마우스를 따라다니는 작은 툴팁(건물번호 + 시설동명). 누를 수 없어 가까운 건물 사이도 방해하지 않는다
  // (호버로 장비 목록 팝업을 띄우던 방식은 시설동이 가까우면 옮기는 도중 다른 건물로 바뀌어 클릭 고정으로 바꿨다 — 사용자 2026-10-01)
  svg.addEventListener("mousemove", (event) => {
    if (mapState.drag && mapState.drag.moved) return;
    const shape = event.target.closest(".db-map-bld");
    if (shape) showMapTip(shape.dataset.key, event);
    else hideMapTip();
  });
  svg.addEventListener("mouseleave", hideMapTip);

  const pop = document.getElementById("dbMapPopup");
  pop.addEventListener("click", (event) => {
    if (event.target.closest(".db-map-pop-x")) return hideMapPopupNow();
    const row = event.target.closest("[data-equipment-id]");
    // 맵에서 들어갔다는 표시(from=map)와 보던 지구를 넘긴다 — 장비 화면의 "실시간 현황으로"가 맵으로 돌아오게
    if (row) window.location.href = `equipment-detail.html?id=${row.dataset.equipmentId}&from=map&tab=${encodeURIComponent(mapState.tab)}`;
  });
}

// ---------- 시설동 툴팁(호버) · 장비 목록 팝업(클릭) ----------
//
// 머리: 건물번호(지도 라벨) + 시설동 이름 / 요약: 상태별 대수(0은 숨김) / 목록: 장비마다 상태 점·이름·
// 압축기 수·상태 태그. 운영이 아닌 장비(미운영·수리중 …)는 맨 아래에 흐리게, 운영 상태만 회색 태그로.
// 장비 행을 누르면 장비 실시간 화면으로 이동한다.

function showMapTip(key, event) {
  const tip = document.getElementById("dbMapTip");
  const shape = mapState.shapes.find((s) => s.key === key);
  if (!shape || !shape.title) return hideMapTip();
  if (tip.dataset.key !== key) {
    const b = shape.building;
    const count = b ? b.items.length + b.inactive.length : 0;
    tip.innerHTML = `${shape.code ? `<span class="no">${escapeHtml(shape.code)}</span>` : ""}<b>${escapeHtml(b ? b.name : shape.title)}</b>${count ? `<small>장비 ${count}대 · 클릭하면 목록</small>` : ""}`;
    tip.dataset.key = key;
  }
  tip.hidden = false;
  const stage = document.getElementById("dbMapStage").getBoundingClientRect();
  let x = event.clientX - stage.left + 14;
  let y = event.clientY - stage.top + 16;
  if (x + tip.offsetWidth > stage.width - 6) x = event.clientX - stage.left - tip.offsetWidth - 10;
  if (y + tip.offsetHeight > stage.height - 6) y = event.clientY - stage.top - tip.offsetHeight - 10;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideMapTip() {
  const tip = document.getElementById("dbMapTip");
  tip.hidden = true;
  delete tip.dataset.key;
}

function showMapPopup(key) {
  if (mapState.selectedKey !== key) {
    mapState.selectedKey = key;
    mapState.svg.querySelectorAll(".db-map-bld.sel").forEach((el) => el.classList.remove("sel"));
    const shape = mapState.shapes.find((s) => s.key === key);
    if (shape) shape.el.classList.add("sel");
  }
  renderMapPopup();
}

function hideMapPopupNow() {
  mapState.selectedKey = null;
  mapState.svg?.querySelectorAll(".db-map-bld.sel").forEach((el) => el.classList.remove("sel"));
  document.getElementById("dbMapPopup").hidden = true;
}

// 장비 1대의 상태 태그 — 경보는 운전/정지와 함께, 통신오류는 단독(경보·운전 여부를 알 수 없음), 비상정지는 따로
function equipmentStateTags(e) {
  if (e.isEmergencyStopped) return [["alarm", "비상정지"]];
  if (isCommFail(e)) return [["comm", "통신오류"]];
  const tags = [];
  if (e.hasAlarm) tags.push(["alarm", "경보"]);
  tags.push(e.isRunning ? ["run", "운전"] : ["idle", "정지"]);
  return tags;
}

function renderMapPopup() {
  const pop = document.getElementById("dbMapPopup");
  const shape = mapState.shapes.find((s) => s.key === mapState.selectedKey);
  if (!shape) return hideMapPopupNow();
  const b = shape.building;
  // 나쁜 상태(경보 → 통신오류 → 운전 → 정지) 먼저, 같은 상태끼리는 이름순
  const items = b
    ? b.items
        .slice()
        .sort(
          (x, y) =>
            MAP_STATE_RANK[equipmentMapState(y)] - MAP_STATE_RANK[equipmentMapState(x)] ||
            String(x.name).localeCompare(String(y.name), "ko")
        )
    : [];
  const inactive = b ? b.inactive.slice().sort((x, y) => String(x.name).localeCompare(String(y.name), "ko")) : [];
  const title = b ? b.name : shape.title || "이름 없는 건물";

  // 상태별 대수 — 시설동 색과 같은 기준(장비마다 가장 나쁜 상태 하나)
  const counts = { alarm: 0, comm: 0, run: 0, idle: 0 };
  items.forEach((e) => counts[equipmentMapState(e)]++);
  const summary = [
    ["alarm", "경보·비상정지"],
    ["comm", "통신오류"],
    ["run", "운전"],
    ["idle", "정지"],
  ]
    .filter(([k]) => counts[k] > 0)
    .map(([k, label]) => `<span class="s-${k}"><i></i>${label} ${counts[k]}</span>`);
  if (inactive.length) summary.push(`<span class="s-off"><i></i>운영 외 ${inactive.length}</span>`);

  const rows = [
    ...items.map((e) => {
      const st = equipmentMapState(e);
      const comp = (e.compressors || []).length;
      return `
        <li data-equipment-id="${e.id}">
          <span class="d c-${st}"></span>
          <span class="nm"><b>${escapeHtml(e.name)}</b>${comp ? `<small>압축기 ${comp}대</small>` : ""}</span>
          <span class="tags">${equipmentStateTags(e).map(([k, t]) => `<span class="t s-${k}">${t}</span>`).join("")}</span>
          <span class="chev" aria-hidden="true">›</span>
        </li>`;
    }),
    ...inactive.map(
      (e) => `
        <li class="off" data-equipment-id="${e.id}">
          <span class="d c-off"></span>
          <span class="nm"><b>${escapeHtml(e.name)}</b></span>
          <span class="tags"><span class="t s-off">${escapeHtml(e.status || "운영 외")}</span></span>
          <span class="chev" aria-hidden="true">›</span>
        </li>`
    ),
  ];

  pop.innerHTML = `
    <div class="db-map-pop-h">
      ${shape.code ? `<span class="db-map-pop-no">${escapeHtml(shape.code)}</span>` : ""}
      <b>${escapeHtml(title)}</b>
      <button type="button" class="db-map-pop-x" aria-label="닫기">×</button>
    </div>
    ${summary.length ? `<div class="db-map-pop-sum">${summary.join("")}</div>` : ""}
    ${rows.length ? `<ul>${rows.join("")}</ul><div class="db-map-pop-f">장비를 누르면 장비 실시간 화면으로 이동합니다</div>` : `<p class="db-map-pop-empty">등록된 장비 없음</p>`}
  `;
  pop.hidden = false;
  positionMapPopup();
}

// 고른 도형 오른쪽에 띄우고, 넘치면 왼쪽으로, 위아래는 화면 안으로
function positionMapPopup() {
  const pop = document.getElementById("dbMapPopup");
  const shape = mapState.shapes.find((s) => s.key === mapState.selectedKey);
  if (!shape || pop.hidden) return;
  const stage = document.getElementById("dbMapStage").getBoundingClientRect();
  const r = shape.el.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = r.right - stage.left + 12;
  if (left + w > stage.width - 8) left = Math.max(8, r.left - stage.left - w - 12);
  let top = r.top - stage.top - 10;
  top = Math.min(Math.max(8, top), Math.max(8, stage.height - h - 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}
