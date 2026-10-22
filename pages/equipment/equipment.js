// 장비 관리 페이지 전용 스크립트
//
// 이 화면이 쓰는 API는 전부 실제로 구현되어 있다 — 장비/압축기/채널 설정(21~25번),
// 첨부파일(26~29번), 장비 검사이력(30~34번), 수리보수 및 철거일지(35~42번).
// "있다고 가정"하고 작성했던 코드는 남아있지 않다.
//
// 장비·압축기 계약 (api-manual.md 1~5-1, 21~25번):
//   GET  /api/equipments                          — 장비 속성 전체(40여 개 필드) + isRunning/communicationStatus/hasAlarm
//   GET  /api/equipments/{id}                     — 위와 동일한 필드의 단건
//   POST /api/equipments                          — 시스템관리자 전용. { equipment, compressors[] } 형태로 장비+압축기를
//                                                    한 번에 등록. compressors는 최소 1개 이상 필수(0개면 400).
//                                                    압축기마다 CH01~07 채널 설정이 기본값으로 자동 생성됨.
//                                                    (buildingName, name) 중복 시 409.
//   PUT  /api/equipments/{id}                     — 담당 장비만(시스템관리자는 전체) 수정 가능(그 외 403).
//                                                    "삭제" 개념 없음 — status: "철거"로 대체.
//                                                    본문은 id/isRunning/communicationStatus/hasAlarm 제외한 전체 필드.
//   GET  /api/equipments/{id}/compressors         — 압축기 목록(순번순 정렬)
//   PUT  /api/compressors/{id}                    — { ipAddress, macAddress, sequenceNo } 수정. 담당 장비만(403).
//                                                    압축기 추가/삭제 API 자체가 없음 — 장비 등록 시점에만 개수 확정.
//   GET  /api/compressors/{id}/channel-settings   — 채널 7개 설정 조회
//   PUT  /api/compressors/{id}/channel-settings/{channelNo} — 채널 "1개씩" 수정(배열 전체 교체 아님). 담당 장비만(403).
//
// 검사이력 / 수리보수 및 철거일지 (api-manual.md 30~42번) — 둘 다 장비 하위 중첩 경로가
// 아니라 최상위 리소스이고, 장비는 equipmentId(목록은 쿼리, 등록은 본문)로 지정한다:
//   GET/POST       /api/equipment-inspection-history       (+ PUT/DELETE /{id})
//   GET/POST       /api/repair-logs                        (+ PUT/DELETE /{id})
//   POST           /api/repair-logs/{id}/approve           (+ /approve/cancel, /approvals/reset)

const EQUIPMENT_STATUSES = ["운영", "미운영", "수리중", "점검중", "철거예정", "철거", "사용중지", "기타"];

const state = {
  equipments: [], // GET /api/equipments
  page: 1, // 목록 페이지(공통 paginate/renderPager 사용)
};

// ---------- 초기화 ----------

async function initEquipmentPage() {
  wireEquipmentModal();
  wireRangeModal();
  wireCompressorPopup();
  wireInspectionPopup();
  wireRepairPopup();
  wireEscapeKey();

  // 지역/시설동 필터도 이 목록에서 파생되므로(초기화 아래쪽 참고), 이 한 번의 BUSY로
  // "장비 목록 + 지역/시설동" 모두를 함께 덮는다.
  await withGlobalBusy(loadEquipments);
  initEquipmentFilters();
  renderEquipmentList();
  await openChannelFromUrl();
}

// 이벤트 상세 창의 "경보 범위 설정 ↗" 링크로 들어온 경우(?equipment=&compressor=&channel=, 2026-10-22) —
// 그 장비의 압축기 창을 열고 해당 압축기를 고른 뒤, 그 채널 줄을 강조하고 하한 칸에 커서를 둔다.
// 목록(담당 장비)에 없는 장비면 고칠 권한이 없는 것이라 안내만 한다. 새로 고침해도 다시 열리지 않게 주소는 비운다.
async function openChannelFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const equipmentId = params.get("equipment");
  if (!equipmentId) return;
  const compressorId = params.get("compressor");
  const channelNo = params.get("channel");
  window.history.replaceState(null, "", window.location.pathname);

  if (!findEquipment(equipmentId)) {
    window.alert("이 장비의 경보 범위를 설정할 권한이 없거나 장비를 찾을 수 없습니다.");
    return;
  }
  await openCompressorPopup(equipmentId);
  const exists = compressorPopupState.compressors.some((c) => String(c.id) === String(compressorId));
  if (exists && String(compressorPopupState.selectedId) !== String(compressorId)) {
    await openCompressorDetail(compressorId);
    renderCompressorSeqList();
  }
  if (exists && channelNo) highlightChannelRow(channelNo);
}

function highlightChannelRow(channelNo) {
  const row = document.querySelector(`#cmChannelBody tr[data-channel="${channelNo}"]`);
  if (!row) return;
  row.classList.add("eq-ch-target");
  row.scrollIntoView({ block: "center" });
  const lower = row.querySelector(".eq-ch-lower");
  if (lower && !lower.disabled) lower.focus();
}

// 모달/팝업이 하나라도 열려있는 동안 배경(장비 관리 메인 목록)의 마우스 휠 스크롤이
// 같이 움직이는 걸 막는다. 냉각수 설정 팝업처럼 모달 위에 모달이 겹쳐 뜨는 경우도 있어
// 단순 boolean이 아니라 카운터로 관리한다 — 마지막 모달까지 다 닫혀야 잠금을 푼다.
let openModalCount = 0;

function openModalOverlay(id) {
  document.getElementById(id).hidden = false;
  openModalCount += 1;
  document.body.classList.add("eq-modal-open");
}

function closeModalOverlay(id) {
  document.getElementById(id).hidden = true;
  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount === 0) document.body.classList.remove("eq-modal-open");
}

// ESC 키를 그 모달의 닫기 버튼과 동일하게 취급한다. 배경 클릭으로 닫는 기능은 없앴지만
// (사용자 지시), ESC는 키보드 사용자를 위해 남겨둔다. rangeSettingsModal은 equipmentModal
// 위에 얹혀서 뜨는 유일한 중첩 케이스라 제일 먼저 검사한다 — 나머지 4개는 목록에서 각자
// 독립적으로 열려서 동시에 열려 있을 일이 없다.
function wireEscapeKey() {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById("rangeSettingsModal").hidden) return closeRangeModal();
    if (!document.getElementById("equipmentModal").hidden) return closeEquipmentModal();
    if (!document.getElementById("compressorPopup").hidden) return closeCompressorPopup();
    if (!document.getElementById("inspectionPopup").hidden) return closeInspectionPopup();
    if (!document.getElementById("repairPopup").hidden) return closeRepairPopup();
  });
}

async function loadEquipments() {
  try {
    // 담당 장비만 — 수정 권한이 담당 기준이라 목록도 같은 기준으로 맞춘다(백엔드 2026-09-28).
    // 시스템관리자는 mine=true여도 서버가 전체를 준다(담당 배정이 없는 게 보통이라).
    state.equipments = await apiFetch("/api/equipments?mine=true");
  } catch (err) {
    document.getElementById("equipmentListBody").innerHTML =
      `<tr><td colspan="7"><div class="empty-state">불러오지 못했습니다. (${escapeHtml(err.message)})</div></td></tr>`;
  }
}

// 압축기 수는 GET /api/equipments 응답의 registeredCompressorCount(실제 등록된 압축기 행 수)를 쓴다(전체 합 246).
// compressorCount는 이력카드의 "압축기수량" 사양 칸이라 글자도 들어갈 수 있다(2026-10-22 string으로 변경).
//
// 예전엔 GET /api/compressors(4번)를 한 번 더 불러 (시설동, 장비명)으로 묶어 세었는데, 4번이
// 2026-09-17부터 **운영 장비의 압축기만** 내려주게 바뀌면서 미운영 장비가 전부 COMP#0으로
// 보였다(예: PDI 1동 실차환경챔버 #1은 실제 2대). 장비관리는 운영/미운영을 가리지 않고 등록
// 정보를 보여주는 화면이라 1번 응답 값이 맞다.

// ---------- 공통 유틸 ----------

function setValue(id, value) {
  document.getElementById(id).value = value ?? "";
}

function getValue(id) {
  return document.getElementById(id).value;
}

function setChecked(id, checked) {
  document.getElementById(id).checked = !!checked;
}

function getChecked(id) {
  return document.getElementById(id).checked;
}

function numOrNull(v) {
  return v === "" || v === null || v === undefined ? null : Number(v);
}

function intOrNull(v) {
  return v === "" || v === null || v === undefined ? null : parseInt(v, 10);
}

// 장비 이력카드 사양 칸(냉동능력·용량·수량·압력·전압·전류 등)은 숫자 외 글자도 받는다
// (2026-10-22 고객사 요청, 백엔드도 string으로 변경) — 앞뒤 공백만 정리하고 빈 칸은 null
function textOrNull(v) {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

function statusBadge(status) {
  const warningSet = ["수리중", "점검중", "철거예정"];
  const mutedSet = ["미운영", "철거", "사용중지", "기타"];
  const cls = status === "운영" ? "badge-normal" : warningSet.includes(status) ? "badge-warning" : mutedSet.includes(status) ? "badge-muted" : "badge-muted";
  return `<span class="badge ${cls}">${escapeHtml(status ?? "-")}</span>`;
}

function formatDateTimeKo(dateTimeStr) {
  if (!dateTimeStr) return "-";
  const d = new Date(dateTimeStr);
  if (Number.isNaN(d.getTime())) return dateTimeStr;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function findEquipment(equipmentId) {
  return state.equipments.find((e) => String(e.id) === String(equipmentId));
}

// ========================================================================
// 장비 목록
// ========================================================================

// 필터 선택지 갱신 — 저장 후에도 불리므로 리스너를 붙이지 않는다.
// (예전엔 저장할 때마다 initEquipmentFilters를 다시 불러서 change/click 리스너가 중복
//  등록됐고, "+ 신규 등록"이 두 번 실행돼 모달 열림 카운터가 어긋나면서 배경 스크롤이
//  영영 안 풀리는 문제가 있었다.)
function refreshEquipmentFilterOptions() {
  const regionSelect = document.getElementById("eqFilterRegion");
  const availableRegions = collectRegions(state.equipments);
  regionSelect.innerHTML = `<option value="">전체</option>` + availableRegions.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");

  const statusSelect = document.getElementById("eqFilterStatus");
  statusSelect.innerHTML = `<option value="">전체</option>` + EQUIPMENT_STATUSES.map((s) => `<option value="${s}">${s}</option>`).join("");

  updateEquipmentBuildingFilter();
}

// 화면 진입 때 한 번만 부른다(선택지 채우기 + 리스너 등록)
function initEquipmentFilters() {
  refreshEquipmentFilterOptions();
  const regionSelect = document.getElementById("eqFilterRegion");

  // 지역/시설동/상태 필터는 백엔드 호출 없이 이미 불러온 목록(state.equipments)을
  // 다시 그리는 것뿐이라 BUSY를 적용하지 않는다 — 대기할 이유가 없는데 억지로 최소
  // 표시 시간을 넣으면 자주 반복하는 가벼운 조작이 오히려 굼떠 보인다.
  regionSelect.addEventListener("change", () => {
    updateEquipmentBuildingFilter();
    renderEquipmentListFromFirstPage();
  });
  document.getElementById("eqFilterBuilding").addEventListener("change", renderEquipmentListFromFirstPage);
  document.getElementById("eqFilterStatus").addEventListener("change", renderEquipmentListFromFirstPage);
  document.getElementById("eqFilterSearch").addEventListener("input", renderEquipmentListFromFirstPage);
  document.getElementById("eqAddBtn").addEventListener("click", () => openEquipmentModal(null));
}

function updateEquipmentBuildingFilter() {
  const region = document.getElementById("eqFilterRegion").value;
  const buildingSelect = document.getElementById("eqFilterBuilding");
  const pool = region ? state.equipments.filter((e) => e.region === region) : state.equipments;
  const buildings = [...new Set(pool.map((e) => e.buildingName))].sort((a, b) => a.localeCompare(b, "ko"));
  const current = buildingSelect.value;
  buildingSelect.innerHTML = `<option value="">전체</option>` + buildings.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
  if (buildings.includes(current)) buildingSelect.value = current;
}

function formatLocation(e) {
  return [e.region, e.buildingName, e.location].filter(Boolean).join(" · ");
}

function renderEquipmentList() {
  const region = document.getElementById("eqFilterRegion").value;
  const buildingName = document.getElementById("eqFilterBuilding").value;
  const status = document.getElementById("eqFilterStatus").value;
  const search = document.getElementById("eqFilterSearch").value.trim().toLowerCase();

  const rows = state.equipments
    .filter((e) => !region || e.region === region)
    .filter((e) => !buildingName || e.buildingName === buildingName)
    .filter((e) => !status || e.status === status)
    .filter((e) => !search || e.name.toLowerCase().includes(search))
    // 지구 → 시설동 → 장비명 순 — 실시간 현황·자료 조회·조직 관리와 같은 기준이다
    // (compareRegion은 common/js/ui.js. 지구 표기가 "A 지구"처럼 바뀌어도 가나다순으로 따라간다)
    .sort(
      (a, b) =>
        compareRegion(a.region, b.region) ||
        a.buildingName.localeCompare(b.buildingName, "ko") ||
        a.name.localeCompare(b.name, "ko")
    );

  const tbody = document.getElementById("equipmentListBody");
  if (rows.length === 0) {
    // 담당 장비 자체가 없는 경우와 필터 결과가 없는 경우를 구분해서 알려준다
    const message = state.equipments.length === 0 ? "담당 장비가 없습니다. 시스템관리자에게 담당 장비 등록을 요청하세요." : "조건에 맞는 장비가 없습니다.";
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">${message}</div></td></tr>`;
    renderEquipmentPager(0);
    return;
  }

  const { pageItems, page, start } = paginate(rows, state.page);
  state.page = page;

  tbody.innerHTML = pageItems
    .map((e, i) => {
      // 실제 등록된 압축기 수 — compressorCount는 이력카드의 사양 글자 칸이라 쓰지 않는다(2026-10-22)
      const compressorCount = e.registeredCompressorCount ?? 0;
      // 열 폭이 고정이라 긴 위치·장비명은 잘린다 — 잘린 내용을 마우스로 확인할 수 있게 통째로 단다
      const fullLabel = escapeHtml(`${formatLocation(e)} · ${e.name}`);
      return `
        <tr data-id="${e.id}">
          <td>${start + i + 1}</td>
          <td title="${fullLabel}">${escapeHtml(formatLocation(e))}</td>
          <td title="${fullLabel}"><span class="row-link" data-id="${e.id}">${escapeHtml(e.name)}</span></td>
          <td>${escapeHtml(e.managementNumber ?? "-")}</td>
          <td>${statusBadge(e.status)}</td>
          <td><button type="button" class="eq-count-btn${compressorCount === 0 ? " eq-count-zero" : ""}" data-kind="compressor" data-id="${e.id}">COMP#${compressorCount}</button></td>
          <td><button type="button" class="eq-count-btn" data-kind="inspection" data-id="${e.id}">검사이력</button></td>
          <td><button type="button" class="eq-count-btn" data-kind="repair" data-id="${e.id}">수리일지</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll(".row-link").forEach((el) => {
    el.addEventListener("click", () => openEquipmentModal(el.dataset.id));
  });
  tbody.querySelectorAll(".eq-count-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (btn.dataset.kind === "compressor") openCompressorPopup(btn.dataset.id);
      else if (btn.dataset.kind === "inspection") openInspectionPopup(btn.dataset.id);
      else openRepairPopup(btn.dataset.id);
    });
  });

  renderEquipmentPager(rows.length);
}

function renderEquipmentPager(totalCount) {
  renderPager(document.getElementById("eqPager"), {
    total: totalCount,
    page: state.page,
    onChange: (next) => {
      state.page = next;
      renderEquipmentList();
    },
  });
}

// 필터를 바꾸면 결과가 완전히 달라지므로 항상 1페이지부터 다시 본다
function renderEquipmentListFromFirstPage() {
  state.page = 1;
  renderEquipmentList();
}

// ========================================================================
// 장비 상세/등록 모달
// ========================================================================

const equipmentModalState = {
  id: null,
  isNew: true,
  rangeSettings: defaultRangeSettings(),
  runningCurrentThresholdDecimalPlaces: null, // GET 응답 전용 필드 — 1번 압축기 CH07의 decimalPlaces
  photos: { equipment: null, installation: null }, // 슬롯별 { id, objectUrl } | "loading" | null
};

// 저장 안 한 변경사항이 있는 채로 모달을 닫으려 하면 confirm으로 한 번 더 확인한다
// (common/js/ui.js의 createDirtyTracker/confirmDiscardIfDirty — 압축기 팝업에서 쓰던
// 방식을 공용 유틸로 뽑아서 재사용). openEquipmentModal 끝에서 capture(), 닫을 때
// confirmDiscardIfDirty로 확인한다.
const equipmentModalDirty = createDirtyTracker(collectEquipmentModalSnapshotPayload);

// 장비 이력카드의 "장비 사진"/"설치 위치도" 2슬롯. Attachment API(ownerType=EquipmentPhoto)와
// 연동한다 — 슬롯당 파일 1개, 재업로드 시 덮어쓰기(첨부 id 유지).
const PHOTO_SLOTS = {
  equipment: {
    label: "장비 사진",
    bodyId: "fEquipmentPhotoBody",
    inputId: "fEquipmentPhotoInput",
    deleteBtnId: "fEquipmentPhotoDeleteBtn",
    uploadLabelId: "fEquipmentPhotoUploadLabel",
  },
  installation: {
    label: "설치 위치도",
    bodyId: "fInstallationPhotoBody",
    inputId: "fInstallationPhotoInput",
    deleteBtnId: "fInstallationPhotoDeleteBtn",
    uploadLabelId: "fInstallationPhotoUploadLabel",
  },
};

function wireEquipmentModal() {
  document.getElementById("equipmentModalCloseX").addEventListener("click", closeEquipmentModal);
  document.getElementById("equipmentModalCancelBtn").addEventListener("click", closeEquipmentModal);
  document.getElementById("equipmentSaveBtn").addEventListener("click", saveEquipment);
  document.getElementById("rangeSettingsOpenBtn").addEventListener("click", openRangeModal);
  document.getElementById("addCompressorRowBtn").addEventListener("click", () => addNewCompressorRow());

  // 경보하한/상한과 같은 이유로, decimalPlaces 자리수에 맞춰 정정 표기한다(예: "100" → "100.0").
  document.getElementById("fRunningCurrentThreshold").addEventListener("blur", (event) => {
    if (event.target.value === "") return;
    const n = Number(event.target.value);
    if (Number.isNaN(n)) return;
    event.target.value = n.toFixed(equipmentModalState.runningCurrentThresholdDecimalPlaces ?? 0);
  });

  Object.keys(PHOTO_SLOTS).forEach((slot) => {
    const cfg = PHOTO_SLOTS[slot];
    document.getElementById(cfg.inputId).addEventListener("change", (event) => {
      const file = event.target.files[0];
      event.target.value = ""; // 같은 파일을 다시 선택해도 change가 다시 발생하도록 비워둔다
      if (file) handlePhotoFileSelected(slot, file);
    });
    document.getElementById(cfg.deleteBtnId).addEventListener("click", () => handlePhotoDelete(slot));
  });
}

function openEquipmentModal(equipmentId) {
  const equipment = equipmentId ? findEquipment(equipmentId) : null;
  equipmentModalState.id = equipment ? equipment.id : null;
  equipmentModalState.isNew = !equipment;
  equipmentModalState.rangeSettings = equipment ? extractRangeSettings(equipment) : defaultRangeSettings();
  // 신규 등록은 아직 압축기·채널 설정이 없어 서버가 알려줄 자리수도 없다 — 서버가 새 압축기
  // CH07에 넣을 기본값(전류 1자리)을 그대로 가정해야 raw 변환이 어긋나지 않는다.
  equipmentModalState.runningCurrentThresholdDecimalPlaces =
    equipment?.runningCurrentThresholdDecimalPlaces ?? defaultDecimalPlacesForChannel("CH07");

  document.getElementById("equipmentModalTitle").textContent = equipment ? equipment.name : "신규 장비 등록";
  document.getElementById("rangeSettingsOpenBtn").hidden = !equipment;
  document.getElementById("newCompressorSection").hidden = !!equipment; // 등록 후엔 압축기 개수를 바꿀 방법이 없어 신규일 때만 노출
  if (!equipment) resetNewCompressorRows();
  hideFormError();
  fillEquipmentForm(equipment);
  resetPhotoSlots(equipment ? equipment.id : null);
  equipmentModalDirty.capture();

  openModalOverlay("equipmentModal");
}

// ---------- 신규 등록 시 압축기 IP/MAC 입력 리스트 ----------
// 압축기 추가/삭제 API가 아예 없어(api-manual.md 21번) 등록 후엔 개수를 바꿀 수 없다 —
// 그래서 이 리스트는 "신규 등록" 모달에서만 보이고, 여기서 정한 개수가 그 장비의 압축기 수로 영구 고정된다.

function resetNewCompressorRows() {
  const container = document.getElementById("newCompressorRows");
  container.innerHTML = "";
  addNewCompressorRow();
}

function addNewCompressorRow() {
  const container = document.getElementById("newCompressorRows");
  const row = document.createElement("div");
  row.className = "eq-new-compressor-row";
  row.innerHTML = `
    <input type="text" class="eq-new-compressor-ip" placeholder="IP 주소" />
    <input type="text" class="eq-new-compressor-mac" placeholder="MAC 주소" />
    <button type="button" class="eq-new-compressor-remove-btn" aria-label="제거">✕</button>
  `;
  row.querySelector(".eq-new-compressor-remove-btn").addEventListener("click", () => row.remove());
  container.appendChild(row);
}

function collectNewCompressorRows() {
  return Array.from(document.querySelectorAll("#newCompressorRows .eq-new-compressor-row")).map((row) => ({
    ipAddress: row.querySelector(".eq-new-compressor-ip").value.trim() || null,
    macAddress: row.querySelector(".eq-new-compressor-mac").value.trim() || null,
  }));
}

function closeEquipmentModal() {
  if (!confirmDiscardIfDirty(equipmentModalDirty)) return;
  Object.keys(PHOTO_SLOTS).forEach(revokePhotoSlot);
  closeModalOverlay("equipmentModal");
}

// ---------- 장비 사진 / 설치 위치도 (Attachment API, ownerType=EquipmentPhoto) ----------
//
// 신규 등록(장비 id 없음) 상태에서는 올릴 곳(ownerId)이 없어 업로드 자체가 불가능하다.
// 기존 장비면 모달을 열 때 두 슬롯의 메타데이터를 한 번에 조회(GET /api/attachments)한 뒤,
// 있는 슬롯만 실제 이미지를 받아(GET /api/attachments/{id}) Blob → objectURL로 미리보기를
// 만든다 — <img src="...">에 API URL을 직접 넣으면 Authorization 헤더가 없어 401이 난다.

function resetPhotoSlots(equipmentId) {
  Object.keys(PHOTO_SLOTS).forEach((slot) => {
    const prev = equipmentModalState.photos[slot];
    if (prev && prev !== "loading" && prev.objectUrl) URL.revokeObjectURL(prev.objectUrl);
    equipmentModalState.photos[slot] = equipmentId ? "loading" : null;
    renderPhotoSlot(slot);
  });
  if (equipmentId) loadEquipmentPhotos(equipmentId);
}

function revokePhotoSlot(slot) {
  const photo = equipmentModalState.photos[slot];
  if (photo && photo !== "loading" && photo.objectUrl) URL.revokeObjectURL(photo.objectUrl);
  equipmentModalState.photos[slot] = null;
  renderPhotoSlot(slot);
}

function renderPhotoSlot(slot) {
  const cfg = PHOTO_SLOTS[slot];
  const body = document.getElementById(cfg.bodyId);
  const deleteBtn = document.getElementById(cfg.deleteBtnId);
  const uploadLabel = document.getElementById(cfg.uploadLabelId);
  const photo = equipmentModalState.photos[slot];

  if (!equipmentModalState.id) {
    body.innerHTML = `<div class="empty-state">장비를 먼저 등록해야 사진을 올릴 수 있습니다.</div>`;
    deleteBtn.hidden = true;
    uploadLabel.hidden = true;
    return;
  }

  uploadLabel.hidden = false;
  if (photo === "loading") {
    body.innerHTML = `<div class="empty-state">불러오는 중...</div>`;
    deleteBtn.hidden = true;
  } else if (photo) {
    body.innerHTML = `<img class="eq-photo-preview-img" src="${photo.objectUrl}" alt="${escapeHtml(cfg.label)}" />`;
    deleteBtn.hidden = false;
  } else {
    body.innerHTML = `<div class="empty-state">등록된 사진이 없습니다.</div>`;
    deleteBtn.hidden = true;
  }
}

async function loadEquipmentPhotos(equipmentId) {
  try {
    const list = await apiFetch(`/api/attachments?ownerType=EquipmentPhoto&ownerId=${equipmentId}`);
    await Promise.all(
      Object.keys(PHOTO_SLOTS).map(async (slot) => {
        const meta = list.find((a) => a.slot === slot);
        if (meta) await showPhotoSlot(slot, meta);
        else {
          equipmentModalState.photos[slot] = null;
          renderPhotoSlot(slot);
        }
      })
    );
  } catch (err) {
    // 실패해도 무시한다 — 두 슬롯 다 "없음" 상태로 남고, 이력카드 나머지는 그대로 쓸 수 있다.
    Object.keys(PHOTO_SLOTS).forEach((slot) => {
      equipmentModalState.photos[slot] = null;
      renderPhotoSlot(slot);
    });
  }
}

async function showPhotoSlot(slot, meta) {
  try {
    const blob = await apiFetchBlob(`/api/attachments/${meta.id}`);
    equipmentModalState.photos[slot] = { id: meta.id, objectUrl: URL.createObjectURL(blob) };
  } catch (err) {
    equipmentModalState.photos[slot] = null;
  }
  renderPhotoSlot(slot);
}

function photoErrorMessage(err) {
  if (err.status === 403) return "권한이 없습니다. 시스템관리자이거나 이 장비의 담당자만 사진을 등록/삭제할 수 있습니다.";
  if (err.status === 400) return "jpg, jpeg, png 이미지만 업로드할 수 있고, 파일 용량은 10MB를 넘을 수 없습니다.";
  if (err.status === 404) return "장비 또는 파일을 찾을 수 없습니다.";
  // 응답 없이 연결이 끊긴 경우(fetch 자체 실패) — 서버가 약 28MB 넘는 요청은 받기 전에 끊어 "Failed to fetch"만
  // 남는다(2026-10-22 고객사 문의 재현). 크기는 아래에서 미리 거르므로 여기 오면 대개 네트워크 문제다.
  if (!err.status) return "서버와 연결이 끊겨 사진을 올리지 못했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.";
  return `사진 처리에 실패했습니다. (${err.message})`;
}

const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png"]; // 서버 허용 확장자와 같다

async function handlePhotoFileSelected(slot, file) {
  if (!equipmentModalState.id) return;
  hideFormError();

  // 서버까지 보내기 전에 거른다 — 큰 휴대폰 사진(30MB 넘는 고화소)은 서버가 응답 없이 끊어
  // 원인을 알 수 없는 "Failed to fetch"로만 보였다
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!PHOTO_EXTENSIONS.includes(ext)) {
    showFormError(`jpg, jpeg, png 이미지만 올릴 수 있습니다. (선택한 파일: ${file.name})`);
    return;
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    const message = `사진 용량이 ${formatFileSize(file.size)}로 10MB를 넘어 올릴 수 없습니다. 해상도를 낮추거나 압축해서 10MB 이하로 줄인 뒤 다시 올려 주세요.`;
    showFormError(message);
    window.alert(message);
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    await withGlobalBusy(
      async () => {
        const meta = await apiUpload(`/api/attachments?ownerType=EquipmentPhoto&ownerId=${equipmentModalState.id}&slot=${slot}`, formData);
        await showPhotoSlot(slot, meta);
      },
      { label: "사진 업로드 중..." }
    );
  } catch (err) {
    showFormError(photoErrorMessage(err));
  }
}

async function handlePhotoDelete(slot) {
  const photo = equipmentModalState.photos[slot];
  if (!photo || photo === "loading") return;
  if (!window.confirm(`${PHOTO_SLOTS[slot].label}을(를) 삭제하시겠습니까?`)) return;

  hideFormError();
  try {
    await withGlobalBusy(async () => {
      await apiFetch(`/api/attachments/${photo.id}`, { method: "DELETE" });
      revokePhotoSlot(slot);
    });
  } catch (err) {
    showFormError(photoErrorMessage(err));
  }
}

// GET 응답에 아직 없는 필드는 ?? ""로 방어 — 백엔드가 필드를 채워 내려주는 대로 그대로 표시된다.
function fillEquipmentForm(e) {
  // 지역 선택지는 등록된 장비들이 실제로 쓰는 지구로 채운다(표기가 바뀌어도 따라간다)
  const regions = collectRegions(state.equipments);
  if (e?.region && !regions.includes(e.region)) regions.push(e.region);
  document.getElementById("fRegion").innerHTML = regions.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");
  setValue("fRegion", e?.region ?? regions[0] ?? "");
  setValue("fBuildingNumber", e?.buildingNumber);
  setValue("fBuildingName", e?.buildingName);
  setValue("fLocation", e?.location);
  setValue("fName", e?.name);
  setValue("fStatus", e?.status ?? "운영");
  setValue("fModelName", e?.modelName);
  setValue("fManufacturer", e?.manufacturer);
  setValue("fPermitNumber", e?.permitNumber);
  setValue("fManagementNumber", e?.managementNumber);
  setValue("fLegalCapacity", e?.legalRefrigerationCapacity);
  setValue("fUsCapacity", e?.usRefrigerationCapacity);
  setValue("fRefrigerant", e?.refrigerant);
  setValue("fChargeAmount", e?.chargeAmount);
  setValue("fCompManufacturer", e?.compressorManufacturer);
  setValue("fCompType", e?.compressorType);
  setValue("fCompCount", e?.compressorCount);
  setValue("fCompCapacity", e?.compressorCapacity);
  setValue("fTowerManufacturer", e?.coolingTowerManufacturer);
  setValue("fTowerType", e?.coolingTowerType);
  setValue("fTowerCount", e?.coolingTowerCount);
  setValue("fTowerCapacity", e?.coolingTowerCapacity);
  setValue("fCondenserType", e?.condenserType);
  setValue("fEvaporatorType", e?.evaporatorType);
  setValue("fDesignPressure", e?.designPressure);
  setValue("fOverPressureCutoff", e?.overPressureCutoff);
  setValue("fRatedVoltage", e?.ratedVoltage);
  setValue("fRatedCurrent", e?.ratedCurrent);
  setValue("fSafetyValve", e?.safetyValve);
  setValue("fNotes", e?.notes);
  setValue("fRunningCurrentThreshold", rawToActualInputValue(e?.runningCurrentThreshold, e?.runningCurrentThresholdDecimalPlaces));
}

function collectVisibleEquipmentFields() {
  return {
    region: getValue("fRegion"),
    buildingNumber: getValue("fBuildingNumber") || null,
    buildingName: getValue("fBuildingName").trim(),
    location: getValue("fLocation") || null,
    name: getValue("fName").trim(),
    status: getValue("fStatus"),
    modelName: getValue("fModelName") || null,
    manufacturer: getValue("fManufacturer") || null,
    permitNumber: getValue("fPermitNumber") || null,
    managementNumber: getValue("fManagementNumber") || null,
    legalRefrigerationCapacity: textOrNull(getValue("fLegalCapacity")),
    usRefrigerationCapacity: textOrNull(getValue("fUsCapacity")),
    refrigerant: getValue("fRefrigerant") || null,
    chargeAmount: textOrNull(getValue("fChargeAmount")),
    compressorManufacturer: getValue("fCompManufacturer") || null,
    compressorType: getValue("fCompType") || null,
    compressorCount: textOrNull(getValue("fCompCount")),
    compressorCapacity: textOrNull(getValue("fCompCapacity")),
    coolingTowerManufacturer: getValue("fTowerManufacturer") || null,
    coolingTowerType: getValue("fTowerType") || null,
    coolingTowerCount: textOrNull(getValue("fTowerCount")),
    coolingTowerCapacity: textOrNull(getValue("fTowerCapacity")),
    condenserType: getValue("fCondenserType") || null,
    evaporatorType: getValue("fEvaporatorType") || null,
    designPressure: textOrNull(getValue("fDesignPressure")),
    overPressureCutoff: textOrNull(getValue("fOverPressureCutoff")),
    ratedVoltage: textOrNull(getValue("fRatedVoltage")),
    ratedCurrent: textOrNull(getValue("fRatedCurrent")),
    safetyValve: getValue("fSafetyValve").trim() || null,
    notes: getValue("fNotes") || null,
    runningCurrentThreshold: toRawValue(numOrNull(getValue("fRunningCurrentThreshold")), equipmentModalState.runningCurrentThresholdDecimalPlaces),
  };
}

function collectEquipmentPayload() {
  return { ...collectVisibleEquipmentFields(), ...normalizeRangeSettings(equipmentModalState.rangeSettings) };
}

// equipmentModalDirty(위쪽)가 스냅샷 비교에 쓰는 값 — 신규 등록일 때는 압축기 입력
//리스트도 사용자가 입력한 값이라 같이 포함해야 "저장 안 한 변경사항"을 놓치지 않는다.
function collectEquipmentModalSnapshotPayload() {
  const payload = collectEquipmentPayload();
  if (equipmentModalState.isNew) payload.compressors = collectNewCompressorRows();
  return payload;
}

function showFormError(message) {
  const el = document.getElementById("equipmentFormError");
  el.textContent = message;
  el.hidden = false;
}

function hideFormError() {
  document.getElementById("equipmentFormError").hidden = true;
}

// 403/409/400/404를 사람이 읽을 수 있는 안내로 바꾼다 — 담당 장비 여부를 사전에 알 방법이
// 없어(GET /api/equipments엔 담당자 정보가 없음) 결재 시스템과 동일하게 "버튼은 항상 노출하고
// 서버 오류로 안내"하는 방식을 쓴다.
function equipmentSaveErrorMessage(err) {
  if (err.status === 403) return "권한이 없습니다. 시스템관리자이거나 이 장비의 담당자만 수정할 수 있습니다.";
  if (err.status === 409) return "같은 시설동에 동일한 장비명이 이미 있습니다.";
  // apiFetch가 이제 서버가 BadRequest(...)로 보낸 실제 메시지를 err.message에 담아준다
  // (예: "압축기를 1대 이상 등록해야 합니다." / "올바르지 않은 상태값입니다.") — 두 가지
  // 원인 중 어느 쪽인지 추측하던 문구는 서버 메시지가 없을 때의 대체용으로만 남긴다.
  if (err.status === 400) return err.message || "입력값을 확인해주세요. (상태값 또는 압축기 목록)";
  if (err.status === 404) return "장비를 찾을 수 없습니다.";
  return `저장하지 못했습니다. (${err.message})`;
}

async function saveEquipment() {
  const buildingName = getValue("fBuildingName").trim();
  const name = getValue("fName").trim();

  if (!buildingName || !name) {
    showFormError("건물이름(시설동)과 장비명은 필수입니다.");
    return;
  }

  if (equipmentModalState.isNew) {
    const compressors = collectNewCompressorRows();
    if (compressors.length === 0) {
      showFormError("압축기를 최소 1개 이상 등록해야 합니다.");
      return;
    }
    if (!window.confirm("등록하시겠습니까? 등록 후에는 압축기 개수를 변경할 수 없습니다.")) return;

    try {
      await withGlobalBusy(async () => {
        const created = await apiFetch("/api/equipments", {
          method: "POST",
          body: JSON.stringify({ equipment: collectEquipmentPayload(), compressors }),
        });
        created.registeredCompressorCount = compressors.length; // 방금 등록한 개수를 바로 반영 — 다시 불러올 필요 없음
        state.equipments.push(created);
        equipmentModalDirty.reset(); // 방금 저장한 내용을 "저장 안 한 변경사항"으로 다시 묻지 않도록
        closeEquipmentModal();
        refreshEquipmentFilterOptions();
        renderEquipmentList();
      });
    } catch (err) {
      showFormError(equipmentSaveErrorMessage(err));
    }
    return;
  }

  if (!window.confirm("저장하시겠습니까?")) return;

  try {
    await withGlobalBusy(async () => {
      const updated = await apiFetch(`/api/equipments/${equipmentModalState.id}`, {
        method: "PUT",
        body: JSON.stringify(collectEquipmentPayload()),
      });
      const idx = state.equipments.findIndex((e) => String(e.id) === String(equipmentModalState.id));
      if (idx !== -1) state.equipments[idx] = updated;
      equipmentModalDirty.reset(); // 방금 저장한 내용을 "저장 안 한 변경사항"으로 다시 묻지 않도록
      closeEquipmentModal();
      refreshEquipmentFilterOptions();
      renderEquipmentList();
    });
  } catch (err) {
    showFormError(equipmentSaveErrorMessage(err));
  }
}

// ---------- 냉각수 · 브라인 · 전압 설정 팝업 (장비 모달 위에 얹힘) ----------
//
// 이 값들은 운전일지 자동 기록(장비설정 기반 랜덤값)에만 쓰이며, 사용자 요청에 따라
// 장비 상세/등록 폼 어디에도 노출하지 않는다 — 이 팝업이 유일한 진입점이다. 저장도
// 메인 폼과 별개로 이 팝업 단독으로 즉시 PUT한다(전체 필드를 함께 보내는 방식이라
// 메인 폼의 현재 입력값도 함께 실어 보낸다 — 장비 PUT은 항상 전체 교체이기 때문).

function defaultRangeSettings() {
  return {
    hasCoolingWater: false,
    coolingWaterInletMin: "",
    coolingWaterInletMax: "",
    coolingWaterOutletMin: "",
    coolingWaterOutletMax: "",
    hasBrine: false,
    brineInletMin: "",
    brineInletMax: "",
    brineOutletMin: "",
    brineOutletMax: "",
    hasVoltage: false,
    voltageMin: "",
    voltageMax: "",
  };
}

function extractRangeSettings(e) {
  return {
    hasCoolingWater: !!e.hasCoolingWater,
    coolingWaterInletMin: e.coolingWaterInletMin ?? "",
    coolingWaterInletMax: e.coolingWaterInletMax ?? "",
    coolingWaterOutletMin: e.coolingWaterOutletMin ?? "",
    coolingWaterOutletMax: e.coolingWaterOutletMax ?? "",
    hasBrine: !!e.hasBrine,
    brineInletMin: e.brineInletMin ?? "",
    brineInletMax: e.brineInletMax ?? "",
    brineOutletMin: e.brineOutletMin ?? "",
    brineOutletMax: e.brineOutletMax ?? "",
    hasVoltage: !!e.hasVoltage,
    voltageMin: e.voltageMin ?? "",
    voltageMax: e.voltageMax ?? "",
  };
}

function normalizeRangeSettings(r) {
  return {
    hasCoolingWater: !!r.hasCoolingWater,
    coolingWaterInletMin: numOrNull(r.coolingWaterInletMin),
    coolingWaterInletMax: numOrNull(r.coolingWaterInletMax),
    coolingWaterOutletMin: numOrNull(r.coolingWaterOutletMin),
    coolingWaterOutletMax: numOrNull(r.coolingWaterOutletMax),
    hasBrine: !!r.hasBrine,
    brineInletMin: numOrNull(r.brineInletMin),
    brineInletMax: numOrNull(r.brineInletMax),
    brineOutletMin: numOrNull(r.brineOutletMin),
    brineOutletMax: numOrNull(r.brineOutletMax),
    hasVoltage: !!r.hasVoltage,
    voltageMin: numOrNull(r.voltageMin),
    voltageMax: numOrNull(r.voltageMax),
  };
}

// 장비 모달과 같은 공용 dirty-tracker 패턴(common/js/ui.js) — 저장 안 한 변경사항이
// 있는 채로 이 팝업을 닫으려 하면 확인한다.
const rangeModalDirty = createDirtyTracker(collectRangeFormValues);

// 백엔드가 정한 물리량별 기본 소수점 자리수(2026-09-14 확정) — 압축기 채널값처럼 raw를
// 변환하는 게 아니라(이 값들은 Equipment에 decimal로 그대로 저장됨), 입력/표시 자릿수를
// 이 규칙에 맞춰 정정 표기만 한다. 냉각수·브라인은 온도(°C), 전압은 전압(V) 기준.
const DECIMAL_PLACES_BY_UNIT = {
  pressure: 2, // MPa
  temperature: 1, // ℃
  voltage: 1, // V
  current: 1, // A
};

const RANGE_TEMPERATURE_FIELD_IDS = [
  "rCoolingWaterInletMin",
  "rCoolingWaterInletMax",
  "rCoolingWaterOutletMin",
  "rCoolingWaterOutletMax",
  "rBrineInletMin",
  "rBrineInletMax",
  "rBrineOutletMin",
  "rBrineOutletMax",
];
const RANGE_VOLTAGE_FIELD_IDS = ["rVoltageMin", "rVoltageMax"];

function formatDecimalOrEmpty(value, decimalPlaces) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (Number.isNaN(n)) return "";
  return n.toFixed(decimalPlaces);
}

function reformatFixedDecimalInput(input, decimalPlaces) {
  if (input.value === "") return;
  const n = Number(input.value);
  if (Number.isNaN(n)) return;
  input.value = n.toFixed(decimalPlaces);
}

function wireRangeModal() {
  document.getElementById("rangeSettingsCancelBtn").addEventListener("click", closeRangeModal);
  document.getElementById("rangeSettingsSaveBtn").addEventListener("click", saveRangeSettings);
  ["rHasCoolingWater", "rHasBrine", "rHasVoltage"].forEach((id) => {
    document.getElementById(id).addEventListener("change", updateRangeFieldsEnabled);
  });
  RANGE_TEMPERATURE_FIELD_IDS.forEach((id) => {
    document.getElementById(id).addEventListener("blur", (event) => reformatFixedDecimalInput(event.target, DECIMAL_PLACES_BY_UNIT.temperature));
  });
  RANGE_VOLTAGE_FIELD_IDS.forEach((id) => {
    document.getElementById(id).addEventListener("blur", (event) => reformatFixedDecimalInput(event.target, DECIMAL_PLACES_BY_UNIT.voltage));
  });
}

function openRangeModal() {
  const r = equipmentModalState.rangeSettings;
  const dp = DECIMAL_PLACES_BY_UNIT.temperature;
  setChecked("rHasCoolingWater", r.hasCoolingWater);
  setValue("rCoolingWaterInletMin", formatDecimalOrEmpty(r.coolingWaterInletMin, dp));
  setValue("rCoolingWaterInletMax", formatDecimalOrEmpty(r.coolingWaterInletMax, dp));
  setValue("rCoolingWaterOutletMin", formatDecimalOrEmpty(r.coolingWaterOutletMin, dp));
  setValue("rCoolingWaterOutletMax", formatDecimalOrEmpty(r.coolingWaterOutletMax, dp));
  setChecked("rHasBrine", r.hasBrine);
  setValue("rBrineInletMin", formatDecimalOrEmpty(r.brineInletMin, dp));
  setValue("rBrineInletMax", formatDecimalOrEmpty(r.brineInletMax, dp));
  setValue("rBrineOutletMin", formatDecimalOrEmpty(r.brineOutletMin, dp));
  setValue("rBrineOutletMax", formatDecimalOrEmpty(r.brineOutletMax, dp));
  setChecked("rHasVoltage", r.hasVoltage);
  setValue("rVoltageMin", formatDecimalOrEmpty(r.voltageMin, DECIMAL_PLACES_BY_UNIT.voltage));
  setValue("rVoltageMax", formatDecimalOrEmpty(r.voltageMax, DECIMAL_PLACES_BY_UNIT.voltage));

  updateRangeFieldsEnabled();
  document.getElementById("rangeSettingsError").hidden = true;
  rangeModalDirty.capture();
  openModalOverlay("rangeSettingsModal");
}

function closeRangeModal() {
  if (!confirmDiscardIfDirty(rangeModalDirty)) return;
  closeModalOverlay("rangeSettingsModal");
}

function updateRangeFieldsEnabled() {
  document.getElementById("rCoolingWaterFields").dataset.disabled = String(!getChecked("rHasCoolingWater"));
  document.getElementById("rBrineFields").dataset.disabled = String(!getChecked("rHasBrine"));
  document.getElementById("rVoltageFields").dataset.disabled = String(!getChecked("rHasVoltage"));
}

// saveRangeSettings/openRangeModal(스냅샷 비교)이 공유하는 폼 값 수집 함수.
function collectRangeFormValues() {
  return {
    hasCoolingWater: getChecked("rHasCoolingWater"),
    coolingWaterInletMin: getValue("rCoolingWaterInletMin"),
    coolingWaterInletMax: getValue("rCoolingWaterInletMax"),
    coolingWaterOutletMin: getValue("rCoolingWaterOutletMin"),
    coolingWaterOutletMax: getValue("rCoolingWaterOutletMax"),
    hasBrine: getChecked("rHasBrine"),
    brineInletMin: getValue("rBrineInletMin"),
    brineInletMax: getValue("rBrineInletMax"),
    brineOutletMin: getValue("rBrineOutletMin"),
    brineOutletMax: getValue("rBrineOutletMax"),
    hasVoltage: getChecked("rHasVoltage"),
    voltageMin: getValue("rVoltageMin"),
    voltageMax: getValue("rVoltageMax"),
  };
}

async function saveRangeSettings() {
  if (!window.confirm("저장하시겠습니까?")) return;

  const newRangeSettings = collectRangeFormValues();
  const payload = { ...collectVisibleEquipmentFields(), ...normalizeRangeSettings(newRangeSettings) };

  try {
    const updated = await apiFetch(`/api/equipments/${equipmentModalState.id}`, { method: "PUT", body: JSON.stringify(payload) });
    const idx = state.equipments.findIndex((e) => String(e.id) === String(equipmentModalState.id));
    if (idx !== -1) state.equipments[idx] = updated;
    equipmentModalState.rangeSettings = newRangeSettings;
    equipmentModalDirty.capture(); // 방금 별도로 저장된 범위 설정을 새 기준선으로 — 장비 모달을 닫을 때 이미 저장된 걸로 다시 묻지 않게
    rangeModalDirty.reset(); // 방금 저장한 내용을 이 팝업에서도 "저장 안 한 변경사항"으로 다시 묻지 않도록
    closeRangeModal();
  } catch (err) {
    const el = document.getElementById("rangeSettingsError");
    el.textContent = `저장하지 못했습니다. (${err.message})`;
    el.hidden = false;
  }
}

// ========================================================================
// 압축기 관리 팝업 (좌: 순번 리스트 / 우: 상세 편집, 항상 둘 다 표시)
//
// 압축기 추가/삭제는 이 팝업에서 다루지 않는다(장비 등록 화면에서 처리할 예정 — 아직 미착수).
//
// 저장은 명시적 "저장" 버튼으로만 한다(원래는 전환/닫기 시 자동저장이었으나, 저장이
// 실패해도(403 등) 그냥 다음 동작을 계속 진행해버려서 값이 조용히 유실되는 문제가 있어
// 이 앱의 다른 모달(장비 상세/범위 설정)과 같은 명시적 저장 방식으로 통일했다). 대신
// 저장하지 않은 변경사항이 있는 채로 다른 압축기를 선택하거나 팝업을 닫으려 하면
// confirm으로 한 번 더 확인한다 — hasUnsavedCompressorChanges/confirmDiscardUnsavedIfAny 참고.
// ========================================================================

const compressorPopupState = {
  equipmentId: null,
  compressors: [],
  selectedId: null,
  detailSnapshot: null, // 현재 선택된 압축기를 불러온 직후의 상태(JSON 문자열) — 변경 여부 판정용
};

function wireCompressorPopup() {
  document.getElementById("cmpPopupCloseX").addEventListener("click", closeCompressorPopup);
  document.getElementById("cmpPopupCancelBtn").addEventListener("click", closeCompressorPopup);
  document.getElementById("cmpSaveBtn").addEventListener("click", saveCurrentCompressorDetail);
}

// 압축기 목록 + 첫 압축기의 채널 설정까지 다 불러온 뒤에야 팝업을 띄운다 — 팝업부터
// 열고 그 안에서 "불러오는 중"을 보여주면, 열리자마자 내용물이 다시 한 번 바뀌면서
// 깜빡이는 느낌을 줬다. 그 대신 로딩하는 동안은 화면 전체 BUSY 오버레이(스핀 컨트롤)를
// 보여준다 — 팝업 DOM은 아직 hidden 상태에서 미리 다 채워두고, 끝나면 한 번에 보여준다.
async function openCompressorPopup(equipmentId) {
  compressorPopupState.equipmentId = equipmentId;
  compressorPopupState.selectedId = null;
  compressorPopupState.detailSnapshot = null;
  document.getElementById("cmpPopupError").hidden = true;

  const equipment = findEquipment(equipmentId);
  document.getElementById("cmpPopupEquipmentSubtitle").textContent = equipment ? formatLocation(equipment) + " · " + equipment.name : "";
  document.getElementById("cmpDetailEmpty").hidden = true;
  document.getElementById("cmpDetailForm").hidden = true;
  document.getElementById("cmpSaveBtn").disabled = true;

  try {
    await withGlobalBusy(async () => {
      compressorPopupState.compressors = await apiFetch(`/api/equipments/${equipmentId}/compressors`);
      if (compressorPopupState.compressors.length > 0) {
        // api-manual.md엔 "sequenceNo로 정렬된 목록"이라 되어 있지만, 배열 순서를 그대로
        // 믿지 않고 sequenceNo가 가장 작은 압축기를 직접 찾아 기본 선택한다 — 배열 순서가
        // 어긋나 있으면(예: id 생성 순서) 엉뚱한 압축기가 먼저 열려 보이는 문제가 있었다.
        const first = [...compressorPopupState.compressors].sort((a, b) => a.sequenceNo - b.sequenceNo)[0];
        await openCompressorDetail(first.id);
      }
    });
  } catch (err) {
    document.getElementById("cmpPopupError").textContent = `압축기 정보를 불러오지 못했습니다. (${err.message})`;
    document.getElementById("cmpPopupError").hidden = false;
    document.getElementById("cmpSeqList").innerHTML = `<li class="empty-state">불러오지 못했습니다.</li>`;
    openModalOverlay("compressorPopup");
    return;
  }

  renderCompressorSeqList();
  if (compressorPopupState.compressors.length === 0) {
    document.getElementById("cmpDetailEmpty").hidden = false;
  }
  openModalOverlay("compressorPopup");
}

// 저장 안 된 변경사항이 있는 채로 다른 압축기를 고르거나 팝업을 닫으려 하면 한 번 더
// 확인한다 — 저장 버튼을 명시적으로 눌러야만 저장되는 방식이라, 확인 없이 그냥
// 넘어가면 입력한 값이 조용히 사라져 버린다.
function hasUnsavedCompressorChanges() {
  if (!compressorPopupState.selectedId || !compressorPopupState.detailSnapshot) return false;
  return JSON.stringify(collectCompressorDetailPayload()) !== compressorPopupState.detailSnapshot;
}

function confirmDiscardUnsavedIfAny() {
  if (!hasUnsavedCompressorChanges()) return true;
  return window.confirm("저장하지 않은 변경사항이 있습니다. 저장하지 않고 이동하시겠습니까?");
}

function closeCompressorPopup() {
  if (!confirmDiscardUnsavedIfAny()) return;
  closeModalOverlay("compressorPopup");
}

function renderCompressorSeqList() {
  const list = document.getElementById("cmpSeqList");
  const sorted = [...compressorPopupState.compressors].sort((a, b) => a.sequenceNo - b.sequenceNo);
  list.innerHTML = sorted
    .map(
      (c) => `
        <li class="eq-compressor-seq-item${String(c.id) === String(compressorPopupState.selectedId) ? " active" : ""}" data-id="${c.id}">COMP #${escapeHtml(c.sequenceNo)}</li>
      `
    )
    .join("");

  list.querySelectorAll("li[data-id]").forEach((li) => {
    li.addEventListener("click", () => selectCompressor(li.dataset.id));
  });
}

async function selectCompressor(compressorId) {
  if (String(compressorId) === String(compressorPopupState.selectedId)) return;
  if (!confirmDiscardUnsavedIfAny()) return;
  await openCompressorDetail(compressorId);
  renderCompressorSeqList();
}

async function openCompressorDetail(compressorId) {
  compressorPopupState.selectedId = compressorId;
  compressorPopupState.detailSnapshot = null;
  const compressor = compressorPopupState.compressors.find((c) => String(c.id) === String(compressorId));

  document.getElementById("cmpDetailEmpty").hidden = true;
  document.getElementById("cmpDetailForm").hidden = false;
  document.getElementById("cmpPopupError").hidden = true;
  document.getElementById("cmpSaveBtn").disabled = true;
  setValue("cmSeq", compressor.sequenceNo);
  setValue("cmIp", compressor.ipAddress);
  setValue("cmMac", compressor.macAddress);

  // 압축기를 바꿀 때마다 표를 "불러오는 중" 한 줄로 통째로 비웠다가 새로 채우면, 표
  // 높이가 7행 → 1행 → 7행으로 출렁여서 화면이 깜빡이는 것처럼 보인다(캐시가 없어
  // 실제 네트워크 왕복이 걸리는 첫 조회에서 특히 눈에 띈다). 이미 표에 행이 있으면
  // 비우지 않고 옅게(dim)만 처리해서 높이를 그대로 유지하고, 새 데이터가 도착하면
  // 그제서야 통째로 갈아 끼운다 — 캐시로 즉시 오면 dim이 걸렸다 풀리는 것도 안 보일
  // 만큼 빠르다.
  const tbody = document.getElementById("cmChannelBody");
  if (tbody.querySelector("tr[data-channel]")) tbody.classList.add("eq-channel-loading");
  else tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state">불러오는 중...</div></td></tr>`;

  try {
    const settings = await getChannelSettings(compressorId);
    renderChannelSettingsTable(settings);
    tbody.classList.remove("eq-channel-loading");
  } catch (err) {
    tbody.classList.remove("eq-channel-loading");
    tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state">불러오지 못했습니다. (${escapeHtml(err.message)})</div></td></tr>`;
    return;
  }

  // 채널 표까지 다 그려진 뒤의 상태를 "원본"으로 스냅샷 — 이후 이 값과 달라지면 변경된 것으로 본다.
  compressorPopupState.detailSnapshot = JSON.stringify(collectCompressorDetailPayload());
  document.getElementById("cmpSaveBtn").disabled = false;
}

// 순번(sequenceNo)은 읽기 전용 입력칸(cmSeq)이라 사용자가 값을 바꿀 수 없다 — 그래도
// PUT 24번 요청에는 필드가 필요해서, 불러온 원래 값을 그대로 되돌려보낸다.
function collectCompressorDetailPayload() {
  return {
    sequenceNo: intOrNull(getValue("cmSeq")),
    ipAddress: getValue("cmIp").trim() || null,
    macAddress: getValue("cmMac").trim() || null,
    channelSettings: collectChannelSettingsPayload(),
  };
}

// 경보하한이 경보상한보다 크면(혹은 반대로 상한이 하한보다 작으면) AlarmEvaluator의
// 판정식(value >= 하한 && value <= 상한)이 어떤 값에도 참이 될 수 없어 그 채널이
// 항상 "범위 밖"으로 판정돼 버린다 — 실제로 시드 데이터에서 이 문제가 발견된 적이
// 있어(강설&강우챔버 압축기 115번 CH01) 저장 전에 반드시 막는다.
function validateChannelLimits(channelSettings) {
  for (const ch of channelSettings) {
    if (ch.lowerLimit !== null && ch.upperLimit !== null && ch.lowerLimit > ch.upperLimit) {
      return `${ch.channelNo}(${ch.channelName}): 경보하한은 경보상한보다 클 수 없습니다.`;
    }
    // 서버도 같은 조건을 400으로 막지만(25번), 저장 버튼 단계에서 먼저 알려준다
    if (ch.enabled && ch.registerAddress === null) {
      return `${ch.channelNo}(${ch.channelName}): 채널을 사용하려면 레지스터 주소를 입력해야 합니다.`;
    }
  }
  return null;
}

// 채널 설정은 배열 전체가 아니라 채널 1개씩 PUT하는 API라(api-manual.md 25번), CH01~07을
// 개별 호출로 저장한다. IP/MAC은 압축기 자체 PUT(24번)으로 별도 저장(순번은 읽기 전용이라
// 바뀌지 않지만, API가 요구하는 필드라 원래 값 그대로 함께 보낸다).
//
// "저장" 버튼 클릭으로만 호출된다(예전엔 압축기 전환/팝업 닫기 시 자동 저장이었으나,
// 저장이 실패해도 그냥 다음 동작을 진행해버리는 문제가 있어 명시적 저장으로 바꿨다).
// 처리 중 표시는 공통 BUSY UI(common/js/ui.js의 withGlobalBusy — 화면 전체를 덮는
// 오버레이+스핀 컨트롤)에 맡긴다 — 실패하면 팝업은 그대로 열려 있어 다시 시도할 수 있다.
async function saveCurrentCompressorDetail() {
  if (!compressorPopupState.selectedId) return;

  const payload = collectCompressorDetailPayload();
  document.getElementById("cmpPopupError").hidden = true;

  const limitError = validateChannelLimits(payload.channelSettings);
  if (limitError) {
    showCompressorPopupError(limitError);
    return;
  }

  try {
    await withGlobalBusy(async () => {
      const updated = await apiFetch(`/api/compressors/${compressorPopupState.selectedId}`, {
        method: "PUT",
        body: JSON.stringify({ ipAddress: payload.ipAddress, macAddress: payload.macAddress, sequenceNo: payload.sequenceNo }),
      });
      const idx = compressorPopupState.compressors.findIndex((c) => String(c.id) === String(compressorPopupState.selectedId));
      if (idx !== -1) compressorPopupState.compressors[idx] = updated;

      await Promise.all(
        payload.channelSettings.map((ch) =>
          apiFetch(`/api/compressors/${compressorPopupState.selectedId}/channel-settings/${ch.channelNo}`, {
            method: "PUT",
            body: JSON.stringify({
              channelName: ch.channelName,
              unit: ch.unit,
              enabled: ch.enabled,
              lowerLimit: ch.lowerLimit,
              upperLimit: ch.upperLimit,
              alarmEnabled: ch.alarmEnabled,
              alarmDelaySeconds: ch.alarmDelaySeconds,
              // 채널을 끄고 보내면 서버가 주소를 null로 지운다(보낸 값 무시)
              registerAddress: ch.registerAddress,
              alarmClearDelaySeconds: ch.alarmClearDelaySeconds,
              decimalPlaces: ch.decimalPlaces,
            }),
          })
        )
      );
      invalidateChannelSettingsCache(compressorPopupState.selectedId);

      // 꺼진 채널의 주소는 서버가 지운다(25번 API) — 화면에도 그대로 반영해서 서버 값과
      // 어긋나지 않게 한다. 다시 켜면 표준 주소가 제안된다.
      document.querySelectorAll("#cmChannelBody tr[data-channel]").forEach((row) => {
        const enabled = row.querySelector('.eq-ch-toggle-btn[data-field="enabled"]').dataset.checked === "true";
        if (!enabled) row.querySelector(".eq-ch-register").value = "";
      });
      payload.channelSettings.forEach((ch) => {
        if (!ch.enabled) ch.registerAddress = null;
      });
      compressorPopupState.detailSnapshot = JSON.stringify(payload);

      // 채널 설정(특히 CH07 소수점)이 장비 쪽 파생값(runningCurrentThresholdDecimalPlaces)에
      // 영향을 줄 수도 있다 — 어떤 압축기/채널을 고쳤는지 따지지 않고 그냥 장비를 다시
      // 조회해서 캐시(state.equipments)를 갱신한다. 단건 조회라 가볍고, 저장 버튼을 눌렀을
      // 때만 한 번 나가는 호출이라 조건을 따로 두는 것보다 이 편이 더 간단하다.
      const updatedEquipment = await apiFetch(`/api/equipments/${compressorPopupState.equipmentId}`);
      const equipmentIdx = state.equipments.findIndex((e) => String(e.id) === String(compressorPopupState.equipmentId));
      if (equipmentIdx !== -1) state.equipments[equipmentIdx] = updatedEquipment;
    });
  } catch (err) {
    showCompressorPopupError(err.status === 403 ? "권한이 없습니다. 시스템관리자이거나 이 장비의 담당자만 수정할 수 있습니다." : `저장에 실패했습니다. (${err.message})`);
  }
}

// 사용/경보사용은 네이티브 체크박스 대신, 운전일지(O/X 토글 버튼)와 같은 디자인 언어로
// 통일한 커스텀 토글 버튼을 쓴다 — collectChannelSettingsPayload에서 data-checked로 값을 읽는다.
// 체크마크(✓) span은 항상 DOM에 존재하고 CSS visibility로만 켜고 끈다 — on/off를
// textContent로 바꾸면(빈 문자열 ↔ "✓") 버튼의 내용 유무에 따라 인라인 베이스라인 계산이
// 미묘하게 달라져 행 높이가 흔들리는 브라우저 버그가 있었다. 내용을 아예 안 바꾸면
// 이 문제 자체가 발생할 수 없다.
function channelToggleButton(field, checked) {
  return `<button type="button" class="eq-ch-toggle-btn${checked ? " eq-ch-toggle-on" : ""}" data-field="${field}" data-checked="${checked ? "true" : "false"}"><span class="eq-ch-toggle-mark">✓</span></button>`;
}

// 경보하한/경보상한 입력칸은 raw가 아니라 "18.5℃" 같은 실제 값으로 보여준다(사용자 입력
// 편의를 위해서다). AlarmEvaluator/EquipmentStatusAggregator는 raw끼리만 비교하므로
// 소수점 처리는 100% 프론트 책임 — 항상 decimalPlaces 자리수에 맞춰 고정 표기하고
// (예: decimalPlaces=1일 때 raw 100 → "10.0"), 저장 시 collectChannelSettingsPayload에서
// 다시 raw로 변환해 보낸다(백엔드 의견 반영).
function rawToActualInputValue(rawValue, decimalPlaces) {
  if (rawValue === null || rawValue === undefined) return "";
  return formatRawValue(rawValue, decimalPlaces);
}

// 사용자가 "100"이나 "100.00"을 입력해도 decimalPlaces 자리수로 맞춰 "100.0"처럼
// 정정 표기한다 — 화면에 보이는 자리수가 곧 백엔드로 변환될 때 쓰일 자리수이므로,
// 저장 전에 미리 눈으로 확인시켜주기 위함이다.
function reformatLimitInputs(row) {
  const decimalPlaces = intOrNull(row.querySelector(".eq-ch-decimal").value) ?? 0;
  row.querySelectorAll(".eq-ch-lower, .eq-ch-upper").forEach((input) => {
    if (input.value === "") return;
    const n = Number(input.value);
    if (Number.isNaN(n)) return;
    input.value = n.toFixed(decimalPlaces);
  });
}

// 소수점/발생지연/해제지연은 스핀 화살표가 있는 숫자 입력칸 대신 정해진 값 중에서만
// 고르는 셀렉트로 바꾼다. 시간(지연)은 초 단위 raw 값이 옵션 값이고, 60초 이상부터는
// "1분"/"5분"/"10분"처럼 사람이 읽기 편한 라벨을 붙인다.
const DECIMAL_PLACES_OPTIONS = [0, 1, 2, 3];
const DELAY_SECONDS_OPTIONS = [
  { value: 0, label: "0초" },
  { value: 30, label: "30초" },
  { value: 60, label: "1분" },
  { value: 300, label: "5분" },
  { value: 600, label: "10분" },
];

// 기존 데이터가 정해진 옵션 목록에 없는 값(예: 과거에 다른 값으로 저장된 경우)이면
// 값이 사라지지 않도록 그 값을 담은 옵션을 목록 끝에 추가해 선택된 상태로 보여준다.
function selectOptionsHtml(options, currentValue, fallbackLabel) {
  const list = options.some((o) => o.value === currentValue)
    ? options
    : [...options, { value: currentValue, label: fallbackLabel ? fallbackLabel(currentValue) : String(currentValue) }];
  return list.map((o) => `<option value="${o.value}"${o.value === currentValue ? " selected" : ""}>${o.label}</option>`).join("");
}

function decimalPlacesOptionsHtml(currentValue) {
  return selectOptionsHtml(
    DECIMAL_PLACES_OPTIONS.map((v) => ({ value: v, label: String(v) })),
    currentValue ?? 0
  );
}

function delaySecondsOptionsHtml(currentValue) {
  return selectOptionsHtml(DELAY_SECONDS_OPTIONS, currentValue ?? 0, (v) => `${v}초`);
}

function renderChannelSettingsTable(settings) {
  const tbody = document.getElementById("cmChannelBody");
  tbody.innerHTML = CHANNELS.map((meta) => {
    const s = findChannelSetting(settings, meta.no) ?? {};
    const unit = s.unit ?? meta.unit;
    return `
      <tr data-channel="${meta.no}">
        <td>${channelToggleButton("enabled", !!s.enabled)}</td>
        <td>${meta.no}</td>
        <td class="eq-channel-name">${escapeHtml(s.channelName ?? meta.label)}</td>
        <td>${escapeHtml(unit)}</td>
        <td><select class="eq-ch-decimal">${decimalPlacesOptionsHtml(s.decimalPlaces)}</select></td>
        <td>${channelToggleButton("alarmEnabled", !!s.alarmEnabled)}</td>
        <td>
          <div class="eq-ch-value-with-unit">
            <input type="number" step="any" class="eq-ch-lower" value="${rawToActualInputValue(s.lowerLimit, s.decimalPlaces)}" />
            <span class="eq-ch-unit-suffix">${escapeHtml(unit)}</span>
          </div>
        </td>
        <td>
          <div class="eq-ch-value-with-unit">
            <input type="number" step="any" class="eq-ch-upper" value="${rawToActualInputValue(s.upperLimit, s.decimalPlaces)}" />
            <span class="eq-ch-unit-suffix">${escapeHtml(unit)}</span>
          </div>
        </td>
        <td><select class="eq-ch-alarm-delay">${delaySecondsOptionsHtml(s.alarmDelaySeconds)}</select></td>
        <td><select class="eq-ch-alarm-clear-delay">${delaySecondsOptionsHtml(s.alarmClearDelaySeconds)}</select></td>
        <td><input type="number" step="1" min="0" class="eq-ch-register" value="${s.registerAddress ?? ""}" /></td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".eq-ch-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const next = btn.dataset.checked !== "true";
      btn.dataset.checked = String(next);
      btn.classList.toggle("eq-ch-toggle-on", next);
      const row = btn.closest("tr");
      // 채널을 끄면 서버가 주소를 지우므로(25번 API), 다시 켤 때 빈 칸이면 표준 주소를 채워준다.
      // 장비 종류를 가리지 않고 같은 제안값을 넣는다 — 맞지 않으면 담당자가 고쳐서 저장하면 된다.
      if (btn.dataset.field === "enabled" && next) {
        const input = row.querySelector(".eq-ch-register");
        if (!input.value) input.value = STANDARD_REGISTER_ADDRESSES[row.dataset.channel] ?? "";
      }
      updateChannelRowDisabledState(row);
    });
  });

  tbody.querySelectorAll("tr[data-channel]").forEach((row) => {
    updateChannelRowDisabledState(row);
    row.querySelectorAll(".eq-ch-lower, .eq-ch-upper").forEach((input) => {
      input.addEventListener("blur", () => reformatLimitInputs(row));
    });
    row.querySelector(".eq-ch-decimal").addEventListener("change", () => reformatLimitInputs(row));
  });
}

// 채널 "사용"이 꺼지면 그 행 전체(소수점/경보사용/경보하한/경보상한/발생지연/해제지연)를
// 비활성화하고, "경보사용"이 꺼지면 경보 관련 항목(경보하한/경보상한/발생지연/해제지연)만
// 비활성화한다. 값 자체는 지우지 않고 disabled만 걸어서, 다시 켰을 때 이전 설정이 그대로
// 남아 있게 한다.
function updateChannelRowDisabledState(row) {
  const enabled = row.querySelector('.eq-ch-toggle-btn[data-field="enabled"]').dataset.checked === "true";
  const alarmBtn = row.querySelector('.eq-ch-toggle-btn[data-field="alarmEnabled"]');
  const alarmEnabled = alarmBtn.dataset.checked === "true";

  alarmBtn.disabled = !enabled;
  row.querySelector(".eq-ch-decimal").disabled = !enabled;
  // 사용/주소는 한 쌍이다 — 끄면 서버가 주소를 null로 지운다(api-manual.md 25번)
  row.querySelector(".eq-ch-register").disabled = !enabled;

  const alarmFieldsDisabled = !enabled || !alarmEnabled;
  row.querySelector(".eq-ch-lower").disabled = alarmFieldsDisabled;
  row.querySelector(".eq-ch-upper").disabled = alarmFieldsDisabled;
  row.querySelector(".eq-ch-alarm-delay").disabled = alarmFieldsDisabled;
  row.querySelector(".eq-ch-alarm-clear-delay").disabled = alarmFieldsDisabled;
}

function collectChannelSettingsPayload() {
  const rows = document.querySelectorAll("#cmChannelBody tr[data-channel]");
  return CHANNELS.map((meta, idx) => {
    const row = rows[idx];
    const decimalPlaces = intOrNull(row.querySelector(".eq-ch-decimal").value);
    return {
      channelNo: meta.no,
      channelName: meta.label,
      unit: meta.unit,
      enabled: row.querySelector('.eq-ch-toggle-btn[data-field="enabled"]').dataset.checked === "true",
      lowerLimit: toRawValue(numOrNull(row.querySelector(".eq-ch-lower").value), decimalPlaces),
      upperLimit: toRawValue(numOrNull(row.querySelector(".eq-ch-upper").value), decimalPlaces),
      alarmEnabled: row.querySelector('.eq-ch-toggle-btn[data-field="alarmEnabled"]').dataset.checked === "true",
      alarmDelaySeconds: intOrNull(row.querySelector(".eq-ch-alarm-delay").value),
      alarmClearDelaySeconds: intOrNull(row.querySelector(".eq-ch-alarm-clear-delay").value),
      decimalPlaces,
      registerAddress: intOrNull(row.querySelector(".eq-ch-register").value),
    };
  });
}

function showCompressorPopupError(message) {
  const el = document.getElementById("cmpPopupError");
  el.textContent = message;
  el.hidden = false;
}

// ========================================================================
// 검사이력 팝업 (좌: 목록 / 우: 상세, 항상 둘 다 표시 — 압축기 구성 팝업과 같은 구조)
//
// 기존 InspectionReport(점검일지, 주간 O/X 체크리스트+결재)와는 무관한 별개 기능이다.
// 결재 없음, 담당 장비 제약 없음(로그인한 누구나 조회/작성/편집 가능) — 단 삭제만
// 시스템관리자로 제한(사용자 결정, 백엔드 반영 완료). 첨부파일은 슬롯 없는 다건
// 첨부(ownerType=EquipmentInspectionHistory) — 파일마다 별도 업로드 호출.
// ========================================================================

const inspectionPopupState = {
  equipmentId: null,
  items: [],
  selectedId: null,
  isNew: false,
  attachments: [],
  pendingFiles: [], // 신규작성 중(id 없음) 선택한 파일 — 저장 성공 후 한꺼번에 업로드
  canEditSelected: false, // 선택한 이력의 수정 권한(서버가 준 canEdit) — 첨부 추가/삭제 가능 여부와 동일하게 본다
};

// 압축기 팝업과 같은 공용 dirty-tracker 패턴 — 폼 값(날짜/제목/검사내용/비고)만 대상으로
// 한다. 첨부파일은 올리거나 지우는 즉시 저장되는 별개 동작이라 여기 포함하지 않는다.
const inspectionDirty = createDirtyTracker(collectInspectionFormValues);

function wireInspectionPopup() {
  document.getElementById("ihPopupCloseX").addEventListener("click", closeInspectionPopup);
  document.getElementById("ihCancelBtn").addEventListener("click", closeInspectionPopup);
  document.getElementById("ihAddNewBtn").addEventListener("click", startInspectionNewDraft);
  document.getElementById("ihSaveBtn").addEventListener("click", saveInspection);
  document.getElementById("ihDeleteBtn").addEventListener("click", deleteInspection);
  document.getElementById("ihAttachmentInput").addEventListener("change", (event) => {
    const selected = Array.from(event.target.files);
    event.target.value = ""; // 같은 파일을 다시 선택해도 change가 다시 발생하도록 비워둔다
    const files = filterFilesWithinSizeLimit(selected, showInspectionPopupError);
    if (files.length === 0) return;

    if (inspectionPopupState.isNew) {
      inspectionPopupState.pendingFiles.push(...files); // 아직 id가 없어 저장 시 한꺼번에 올린다
      renderInspectionAttachments();
    } else if (inspectionPopupState.canEditSelected) {
      handleInspectionAttachmentFilesSelected(files);
    }
  });
}

function canDeleteInspection() {
  return getSession()?.role === "시스템관리자";
}

async function openInspectionPopup(equipmentId) {
  inspectionPopupState.equipmentId = equipmentId;
  inspectionPopupState.selectedId = null;
  inspectionPopupState.isNew = false;
  inspectionPopupState.items = []; // 남겨두면 조회 실패 시 직전 장비 이력이 그대로 보이고 수정까지 된다
  inspectionPopupState.attachments = [];
  document.getElementById("ihPopupError").hidden = true;

  const equipment = findEquipment(equipmentId);
  document.getElementById("ihPopupEquipmentSubtitle").textContent = equipment ? formatLocation(equipment) + " · " + equipment.name : "";
  document.getElementById("ihList").innerHTML = `<li class="empty-state">불러오는 중...</li>`;
  document.getElementById("ihDetailEmpty").hidden = true;
  document.getElementById("ihDetailForm").hidden = true;
  document.getElementById("ihSaveBtn").disabled = true;
  document.getElementById("ihDeleteBtn").hidden = true;
  openModalOverlay("inspectionPopup");

  try {
    inspectionPopupState.items = await apiFetch(`/api/equipment-inspection-history?equipmentId=${equipmentId}`);
  } catch (err) {
    document.getElementById("ihList").innerHTML = `<li class="empty-state">불러오지 못했습니다.</li>`;
    return;
  }

  const items = sortedInspectionItems();
  if (items.length > 0) {
    // 목록을 먼저 그리면 선택 표시가 비어 보인다 — 상세를 열어 selectedId를 정한 뒤 그린다
    await openInspectionDetail(items[0].id);
    renderInspectionList();
  } else {
    renderInspectionList();
    document.getElementById("ihDetailEmpty").hidden = false;
  }
}

// 목록 표시 순서(최신 날짜 먼저) — 팝업을 열 때 기본 선택도 이 순서의 첫 항목으로 맞춘다
function sortedInspectionItems() {
  return inspectionPopupState.items.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

function closeInspectionPopup() {
  if (!confirmDiscardIfDirty(inspectionDirty)) return;
  closeModalOverlay("inspectionPopup");
}

function renderInspectionList() {
  const list = document.getElementById("ihList");
  const items = inspectionPopupState.items.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  if (items.length === 0) {
    list.innerHTML = `<li class="empty-state">등록된 검사 이력이 없습니다.</li>`;
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const active = String(item.id) === String(inspectionPopupState.selectedId) && !inspectionPopupState.isNew;
      const notes = escapeHtml(item.notes ?? "");
      const clip = item.attachmentCount > 0 ? `<span class="eq-inspection-clip">📎 ${item.attachmentCount}</span>` : "";
      return `
        <li class="eq-inspection-list-item${active ? " active" : ""}" data-id="${item.id}">
          <div class="eq-inspection-list-date"><span>${escapeHtml(item.date ?? "-")}</span><span class="eq-inspection-list-author">${escapeHtml(item.createdByUserName ?? "")}</span></div>
          <div class="eq-inspection-list-title">${escapeHtml(item.title ?? "-")}</div>
          <div class="eq-inspection-list-notes"><span>${notes}</span>${clip}</div>
        </li>
      `;
    })
    .join("");

  list.querySelectorAll("li[data-id]").forEach((li) => {
    li.addEventListener("click", () => selectInspectionItem(li.dataset.id));
  });
}

async function selectInspectionItem(itemId) {
  if (!inspectionPopupState.isNew && String(itemId) === String(inspectionPopupState.selectedId)) return;
  if (!confirmDiscardIfDirty(inspectionDirty)) return;
  await openInspectionDetail(itemId);
  renderInspectionList();
}

async function openInspectionDetail(itemId) {
  const item = inspectionPopupState.items.find((i) => String(i.id) === String(itemId));
  inspectionPopupState.selectedId = itemId;
  inspectionPopupState.isNew = false;

  document.getElementById("ihDetailEmpty").hidden = true;
  document.getElementById("ihDetailForm").hidden = false;
  document.getElementById("ihPopupError").hidden = true;
  document.getElementById("ihSaveBtn").disabled = true;
  document.getElementById("ihDeleteBtn").hidden = !canDeleteInspection();
  setValue("ihDate", item.date);
  setValue("ihTitle", item.title);
  setValue("ihContent", item.content);
  setValue("ihNotes", item.notes);
  document.getElementById("ihAuditInfo").textContent = formatInspectionAuditInfo(item);

  inspectionPopupState.canEditSelected = canEditInspection(item);
  applyInspectionNewMode(false);
  setInspectionFormEditable(inspectionPopupState.canEditSelected);
  await loadInspectionAttachments(itemId);

  inspectionDirty.capture();
  document.getElementById("ihSaveBtn").disabled = !inspectionPopupState.canEditSelected;
}

// 수정 권한은 서버가 계산해서 `canEdit`으로 내려준다(작성자 본인 또는 시스템관리자).
// 필드가 없는 구버전 응답이면 막지 않는다 — 어차피 서버가 403으로 최종 판정한다.
function canEditInspection(item) {
  return item?.canEdit !== false;
}

function setInspectionFormEditable(editable) {
  ["ihDate", "ihTitle", "ihContent", "ihNotes"].forEach((id) => {
    document.getElementById(id).disabled = !editable;
  });
  document.getElementById("ihSaveBtn").hidden = !editable;
  document.getElementById("ihReadonlyNotice").hidden = editable;
}

function startInspectionNewDraft() {
  if (!confirmDiscardIfDirty(inspectionDirty)) return;

  inspectionPopupState.selectedId = null;
  inspectionPopupState.isNew = true;
  inspectionPopupState.attachments = [];
  inspectionPopupState.pendingFiles = [];
  inspectionPopupState.canEditSelected = false; // 아직 저장 전 — 첨부는 pendingFiles로만 다룬다

  document.getElementById("ihDetailEmpty").hidden = true;
  document.getElementById("ihDetailForm").hidden = false;
  document.getElementById("ihPopupError").hidden = true;
  document.getElementById("ihDeleteBtn").hidden = true;
  setValue("ihDate", "");
  setValue("ihTitle", "");
  setValue("ihContent", "");
  setValue("ihNotes", "");
  document.getElementById("ihAuditInfo").textContent = "";

  applyInspectionNewMode(true);
  setInspectionFormEditable(true);
  renderInspectionAttachments();
  renderInspectionList();

  inspectionDirty.capture();
  document.getElementById("ihSaveBtn").disabled = false;
}

function formatInspectionAuditInfo(item) {
  const created = `등록: ${item.createdByUserName} · ${formatDateTimeKo(item.createdAt)}`;
  if (!item.updatedByUserName) return created;
  return `${created} / 수정: ${item.updatedByUserName} · ${formatDateTimeKo(item.updatedAt)}`;
}

function collectInspectionFormValues() {
  return {
    date: getValue("ihDate"),
    title: getValue("ihTitle").trim(),
    content: getValue("ihContent").trim(),
    notes: getValue("ihNotes").trim(),
    // 신규작성 중 선택해둔(아직 안 올라간) 파일도 dirty 판정에 포함 — 텍스트 필드를
    // 하나도 안 건드리고 파일만 선택한 채 닫으면 그대로 사라져버리는 것을 막는다.
    pendingFileCount: inspectionPopupState.isNew ? inspectionPopupState.pendingFiles.length : 0,
  };
}

async function saveInspection() {
  const { date, title, content, notes } = collectInspectionFormValues();

  if (!date || !title || !content) {
    showInspectionPopupError("실시일자, 제목, 검사내용은 필수입니다.");
    return;
  }
  if (!window.confirm(inspectionPopupState.isNew ? "등록하시겠습니까?" : "저장하시겠습니까?")) return;

  document.getElementById("ihPopupError").hidden = true;

  try {
    await withGlobalBusy(async () => {
      if (inspectionPopupState.isNew) {
        setGlobalBusyLabel("저장 중...");
        const created = await apiFetch("/api/equipment-inspection-history", {
          method: "POST",
          body: JSON.stringify({ equipmentId: inspectionPopupState.equipmentId, date, title, content, notes: notes || null }),
        });
        inspectionPopupState.items.push(created);
        inspectionPopupState.isNew = false;
        inspectionPopupState.selectedId = created.id;
        document.getElementById("ihDeleteBtn").hidden = !canDeleteInspection();
        document.getElementById("ihAuditInfo").textContent = formatInspectionAuditInfo(created);
        inspectionPopupState.canEditSelected = canEditInspection(created); // 방금 내가 만든 글 — 이어서 첨부 추가 가능
        applyInspectionNewMode(false);

        // 신규작성 중 미리 선택해둔 파일이 있으면, 방금 생긴 id로 한꺼번에 업로드한다
        // (일괄 저장 요청사항 — 저장 전에는 ownerId가 없어 개별 업로드가 불가능했다).
        // 레코드 저장 자체는 이미 성공했으므로, 업로드 실패는 별도 메시지로 구분한다.
        const pendingFiles = inspectionPopupState.pendingFiles;
        inspectionPopupState.pendingFiles = [];
        if (pendingFiles.length > 0) {
          try {
            // 용량이 큰 파일은 몇 초씩 걸려서 스피너만 돌면 멈춘 것처럼 보인다 — 끝난 개수를 문구로 알린다
            let uploaded = 0;
            const showUploadProgress = () =>
              setGlobalBusyLabel(`첨부파일 업로드 중... (${uploaded}/${pendingFiles.length})`);
            showUploadProgress();
            await Promise.all(
              pendingFiles.map((file) => {
                const formData = new FormData();
                formData.append("file", file);
                return apiUpload(`/api/attachments?ownerType=EquipmentInspectionHistory&ownerId=${created.id}`, formData).then((res) => {
                  uploaded += 1;
                  showUploadProgress();
                  return res;
                });
              })
            );
            await loadInspectionAttachments(created.id);
            await refreshInspectionAttachmentCount();
          } catch (uploadErr) {
            showInspectionPopupError(`이력은 저장되었지만 첨부파일 업로드에 실패했습니다. (${uploadErr.message})`);
          }
        } else {
          renderInspectionAttachments(); // 첨부 없이 저장 — 빈 상태로 렌더
        }
      } else {
        const updated = await apiFetch(`/api/equipment-inspection-history/${inspectionPopupState.selectedId}`, {
          method: "PUT",
          body: JSON.stringify({ date, title, content, notes: notes || null }),
        });
        const idx = inspectionPopupState.items.findIndex((i) => String(i.id) === String(inspectionPopupState.selectedId));
        if (idx !== -1) inspectionPopupState.items[idx] = updated;
        document.getElementById("ihAuditInfo").textContent = formatInspectionAuditInfo(updated);
      }
      inspectionDirty.capture(); // 방금 저장한 내용을 새 기준선으로 — 다시 "저장 안 한 변경사항"으로 묻지 않도록
      renderInspectionList();
    });
  } catch (err) {
    // 403은 서버가 본문 없이 상태코드만 준다 — 그대로 보여주면 "API 요청 실패 (403)"이라 안내가 안 됨
    if (err.status === 403) {
      showInspectionPopupError("수정 권한이 없습니다. 작성자 본인 또는 시스템관리자만 수정할 수 있습니다.");
      return;
    }
    showInspectionPopupError(`저장하지 못했습니다. (${err.message})`);
  }
}

async function deleteInspection() {
  if (!inspectionPopupState.selectedId) return;
  if (!window.confirm("삭제하시겠습니까? 첨부된 파일도 함께 삭제됩니다.")) return;

  try {
    await withGlobalBusy(async () => {
      await apiFetch(`/api/equipment-inspection-history/${inspectionPopupState.selectedId}`, { method: "DELETE" });
      inspectionPopupState.items = inspectionPopupState.items.filter(
        (i) => String(i.id) !== String(inspectionPopupState.selectedId)
      );
      inspectionDirty.reset();
      renderInspectionList();
      if (inspectionPopupState.items.length > 0) {
        await openInspectionDetail(inspectionPopupState.items[0].id);
        renderInspectionList();
      } else {
        inspectionPopupState.selectedId = null;
        document.getElementById("ihDetailForm").hidden = true;
        document.getElementById("ihDetailEmpty").hidden = false;
        document.getElementById("ihDeleteBtn").hidden = true;
        document.getElementById("ihSaveBtn").disabled = true;
      }
    });
  } catch (err) {
    showInspectionPopupError(`삭제하지 못했습니다. (${err.message})`);
  }
}

function showInspectionPopupError(message) {
  const el = document.getElementById("ihPopupError");
  el.textContent = message;
  el.hidden = false;
}

// ---------- 첨부파일 (Attachment API, ownerType=EquipmentInspectionHistory) ----------
//
// 슬롯 개념이 없는 다건 첨부다 — 파일마다 새 행이 생기고, 한 번에 여러 개를 받는 API가
// 없어 선택한 파일 수만큼 반복 호출한다. 신규작성(아직 저장 전, id 없음) 상태에서는
// 올릴 곳(ownerId)이 없어, 선택한 파일을 바로 업로드하지 않고 `pendingFiles`에 담아뒀다가
// 저장 성공 시 생긴 id로 한꺼번에 업로드한다(일괄 저장). 저장된 이력은 수정 권한이 있을
// 때(canEdit)만 파일을 추가/삭제할 수 있게 한다 — 첨부 API 자체엔 권한 검사가 없어서
// (로그인만 하면 남의 이력에도 올라간다) 이 제한은 전적으로 프론트 판단이다.
// 목록 표시·업로드·내려받기·삭제 같은 공통 동작은 common/js/attachments.js에 있다.

function applyInspectionNewMode(isNew) {
  document.getElementById("ihDetailForm").classList.toggle("is-new", isNew);
  document.getElementById("ihAttachmentNewNotice").hidden = !isNew;
  document.getElementById("ihAttachmentLimitHint").hidden = !isNew;
  document.getElementById("ihAttachmentUploadLabel").hidden = !(isNew || inspectionPopupState.canEditSelected);
}

// 이미 저장된 이력(id 있음)에 파일을 바로 올린다 — 신규작성의 pendingFiles 경로와 반대편.
async function handleInspectionAttachmentFilesSelected(files) {
  const itemId = inspectionPopupState.selectedId;
  if (!itemId) return;
  document.getElementById("ihPopupError").hidden = true;

  try {
    await withGlobalBusy(async () => {
      await uploadAttachments("EquipmentInspectionHistory", itemId, files);
      await loadInspectionAttachments(itemId);
      await refreshInspectionAttachmentCount();
    });
  } catch (err) {
    showInspectionPopupError(`첨부파일 업로드에 실패했습니다. (${err.message})`);
  }
}

async function loadInspectionAttachments(itemId) {
  try {
    inspectionPopupState.attachments = await fetchAttachments("EquipmentInspectionHistory", itemId);
  } catch (err) {
    inspectionPopupState.attachments = [];
  }
  renderInspectionAttachments();
}

function renderInspectionAttachments() {
  renderAttachmentList(document.getElementById("ihAttachmentList"), {
    items: inspectionPopupState.attachments,
    pendingFiles: inspectionPopupState.pendingFiles,
    isPending: inspectionPopupState.isNew,
    canModify: inspectionPopupState.canEditSelected,
    onDownload: handleInspectionAttachmentDownload,
    onDelete: handleInspectionAttachmentDelete,
    onRemovePending: (idx) => {
      inspectionPopupState.pendingFiles.splice(idx, 1);
      renderInspectionAttachments();
    },
  });
}

async function handleInspectionAttachmentDownload(attachmentId) {
  try {
    const meta = inspectionPopupState.attachments.find((a) => String(a.id) === String(attachmentId));
    await downloadAttachment(attachmentId, meta?.fileName);
  } catch (err) {
    showInspectionPopupError(`파일을 불러오지 못했습니다. (${err.message})`);
  }
}

async function handleInspectionAttachmentDelete(attachmentId) {
  if (!window.confirm("이 첨부파일을 삭제하시겠습니까?")) return;
  try {
    await withGlobalBusy(async () => {
      await deleteAttachment(attachmentId);
      await loadInspectionAttachments(inspectionPopupState.selectedId);
      await refreshInspectionAttachmentCount();
    });
  } catch (err) {
    showInspectionPopupError(`삭제하지 못했습니다. (${err.message})`);
  }
}

// 첨부 개수는 서버가 이력 레코드 자체에 같이 내려주는 값(attachmentCount)이라, 파일을
// 올리거나 지운 뒤 그 레코드를 다시 조회해서 목록의 클립 표시를 정확히 맞춘다.
async function refreshInspectionAttachmentCount() {
  try {
    const updated = await apiFetch(`/api/equipment-inspection-history/${inspectionPopupState.selectedId}`);
    const idx = inspectionPopupState.items.findIndex((i) => String(i.id) === String(inspectionPopupState.selectedId));
    if (idx !== -1) inspectionPopupState.items[idx] = updated;
    renderInspectionList();
  } catch (err) {
    // 실패해도 무시 — 클립 개수 표시만 갱신 안 될 뿐, 실제 데이터는 이미 반영됨
  }
}

// ========================================================================
// 수리보수 및 철거일지 팝업 (좌: 목록 / 우: 상세 — 검사이력과 동일 구조, 결재 포함)
// ========================================================================
//
// 실제 API는 api-manual.md 35~42번. 결재는 점검일지·운전일지와 같은 3단계(안전관리원 → 안전관리책임자 →
// 안전관리총괄자)다 — 2026-10-22 고객사 요청으로 안전관리원 단계가 생겼다(예전엔 "해당없음"). 한 단계라도 승인되면 서버가
// 수정을 409로 막고 삭제는 시스템관리자만 가능해지는데, 그 판정 결과가 응답의
// canEdit/canDelete다(작성자 id가 응답에 없어 프론트가 직접 판단할 수 없다 — 검사이력과 동일).
//
// 일시(performedAt)는 서버가 UTC로 저장·응답하고 화면은 한국시간 날짜로 다룬다.
// 실물 양식이 날짜까지만 적게 되어 있어 입력도 날짜만 받고 시각은 0시(KST)로 보낸다.

const REPAIR_FIELD_IDS = [
  "rlTitle",
  "rlPerformedAt",
  "rlLocation",
  "rlPerformedBy",
  "rlTarget",
  "rlStateBefore",
  "rlStateAfter",
  "rlResult",
  "rlFailureCause",
  "rlPreventiveAction",
  "rlOpinion",
];

const repairPopupState = {
  equipmentId: null,
  items: [],
  selectedId: null,
  isNew: false,
  current: null,
};

const repairDirty = createDirtyTracker(collectRepairFormValues);

function wireRepairPopup() {
  document.getElementById("rlPopupCloseX").addEventListener("click", closeRepairPopup);
  document.getElementById("rlCancelBtn").addEventListener("click", closeRepairPopup);
  document.getElementById("rlAddNewBtn").addEventListener("click", startRepairNewDraft);
  document.getElementById("rlSaveBtn").addEventListener("click", saveRepair);
  document.getElementById("rlDeleteBtn").addEventListener("click", deleteRepair);
  document.getElementById("rlResetApprovalsBtn").addEventListener("click", resetRepairApprovals);
}

async function openRepairPopup(equipmentId) {
  repairPopupState.equipmentId = equipmentId;
  repairPopupState.selectedId = null;
  repairPopupState.isNew = false;
  repairPopupState.current = null;
  repairPopupState.items = []; // 검사이력과 같은 이유 — 조회 실패 시 직전 장비 일지가 남으면 안 된다

  const equipment = findEquipment(equipmentId);
  document.getElementById("rlPopupEquipmentSubtitle").textContent = equipment ? formatLocation(equipment) + " · " + equipment.name : "";
  document.getElementById("rlPopupError").hidden = true;
  document.getElementById("rlList").innerHTML = `<li class="empty-state">불러오는 중...</li>`;
  document.getElementById("rlDetailEmpty").hidden = true;
  document.getElementById("rlDetailForm").hidden = true;
  document.getElementById("rlDeleteBtn").hidden = true;
  document.getElementById("rlSaveBtn").hidden = true;
  openModalOverlay("repairPopup");

  try {
    repairPopupState.items = await apiFetch(`/api/repair-logs?equipmentId=${equipmentId}`);
  } catch (err) {
    document.getElementById("rlList").innerHTML = `<li class="empty-state">불러오지 못했습니다.</li>`;
    return;
  }

  const items = sortedRepairItems();
  if (items.length > 0) {
    // 목록을 먼저 그리면 선택 표시가 비어 보인다 — 상세를 열어 selectedId를 정한 뒤 그린다
    openRepairDetail(items[0].id);
  } else {
    document.getElementById("rlDetailEmpty").hidden = false;
  }
  renderRepairList();
}

function closeRepairPopup() {
  if (!confirmDiscardIfDirty(repairDirty)) return;
  closeModalOverlay("repairPopup");
}

// 서버도 performedAt 내림차순으로 주지만, 새로 등록한 항목을 끼워넣은 뒤에도 순서가
// 유지되도록 화면에서 한 번 더 정렬한다(기본 선택도 이 순서의 첫 항목).
function sortedRepairItems() {
  return repairPopupState.items.slice().sort((a, b) => (b.performedAt || "").localeCompare(a.performedAt || ""));
}

// 결재 3단계(안전관리원 → 책임자 → 총괄자) 중 지금 기다리는 단계. 승인 외에 해당없음·전결도 "끝난 단계"로 본다
// (isApprovalLevelDone, common/js/approval.js) — 서버 규칙이 다시 바뀌어도 배지가 맞게 따라간다.
function repairApprovalStatus(item) {
  if (isApprovalLevelDone(item.level3)) return { label: "완료", className: "badge-normal" };
  if (isApprovalLevelDone(item.level2)) return { label: "총괄자 결재 대기", className: "badge-warning" };
  if (isApprovalLevelDone(item.level1)) return { label: "책임자 결재 대기", className: "badge-warning" };
  return { label: "안전관리원 결재 대기", className: "badge-muted" };
}

// 서버는 UTC(예: 2025-11-27T15:00:00+00:00)로 주고 화면은 한국시간 날짜로 보여준다.
function toKstDateString(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function renderRepairList() {
  const list = document.getElementById("rlList");
  const items = sortedRepairItems();

  if (items.length === 0) {
    list.innerHTML = `<li class="empty-state">등록된 수리보수 및 철거일지가 없습니다.</li>`;
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const active = String(item.id) === String(repairPopupState.selectedId) && !repairPopupState.isNew;
      const status = repairApprovalStatus(item);
      return `
        <li class="eq-inspection-list-item${active ? " active" : ""}" data-id="${item.id}">
          <div class="eq-inspection-list-date"><span>${escapeHtml(toKstDateString(item.performedAt) || "-")}</span><span class="badge ${status.className}">${status.label}</span></div>
          <div class="eq-repair-list-author">${escapeHtml(item.createdByUserName ?? "")}</div>
          <div class="eq-inspection-list-title">${escapeHtml(item.title ?? "-")}</div>
        </li>
      `;
    })
    .join("");

  list.querySelectorAll("li[data-id]").forEach((li) => {
    li.addEventListener("click", () => selectRepairItem(li.dataset.id));
  });
}

function selectRepairItem(itemId) {
  if (!repairPopupState.isNew && String(itemId) === String(repairPopupState.selectedId)) return;
  if (!confirmDiscardIfDirty(repairDirty)) return;
  openRepairDetail(itemId);
  renderRepairList();
}

function openRepairDetail(itemId) {
  const item = repairPopupState.items.find((i) => String(i.id) === String(itemId));
  repairPopupState.selectedId = itemId;
  repairPopupState.isNew = false;
  repairPopupState.current = item;

  document.getElementById("rlDetailEmpty").hidden = true;
  document.getElementById("rlDetailForm").hidden = false;
  document.getElementById("rlDetailForm").classList.remove("is-new");
  document.getElementById("rlPopupError").hidden = true;
  document.getElementById("rlAuditInfo").textContent = formatRepairAuditInfo(item);

  fillRepairForm(item);
  renderRepairApprovalBar();
  applyRepairPermissions(item);
  repairDirty.capture();
}

function startRepairNewDraft() {
  if (!confirmDiscardIfDirty(repairDirty)) return;

  repairPopupState.selectedId = null;
  repairPopupState.isNew = true;
  repairPopupState.current = null;

  document.getElementById("rlDetailEmpty").hidden = true;
  document.getElementById("rlDetailForm").hidden = false;
  document.getElementById("rlDetailForm").classList.add("is-new");
  document.getElementById("rlPopupError").hidden = true;
  document.getElementById("rlLockNotice").hidden = true;
  document.getElementById("rlDeleteBtn").hidden = true;
  document.getElementById("rlResetApprovalsBtn").hidden = true;
  document.getElementById("rlSaveBtn").hidden = false;
  document.getElementById("rlAuditInfo").textContent = "";

  fillRepairForm(null);
  setRepairFormEditable(true);
  renderRepairApprovalBar(); // 저장 전에도 같은 결재란을 보여준다(결재 버튼 없이 "대기"만)
  renderRepairList();
  repairDirty.capture();
}

function formatRepairAuditInfo(item) {
  const created = `등록: ${item.createdByUserName} · ${formatDateTimeKo(item.createdAt)}`;
  if (!item.updatedByUserName) return created;
  return `${created} / 수정: ${item.updatedByUserName} · ${formatDateTimeKo(item.updatedAt)}`;
}

function fillRepairForm(item) {
  setValue("rlTitle", item?.title);
  setValue("rlPerformedAt", toKstDateString(item?.performedAt));
  setValue("rlLocation", item?.location);
  setValue("rlPerformedBy", item?.performedBy);
  setValue("rlTarget", item?.target);
  setValue("rlStateBefore", item?.stateBefore);
  setValue("rlStateAfter", item?.stateAfter);
  setValue("rlResult", item?.result);
  setValue("rlFailureCause", item?.failureCause);
  setValue("rlPreventiveAction", item?.preventiveAction);
  setValue("rlOpinion", item?.opinion);
}

function setRepairFormEditable(editable) {
  REPAIR_FIELD_IDS.forEach((id) => {
    document.getElementById(id).disabled = !editable;
  });
}

// 수정/삭제 가능 여부는 서버가 계산해 준 canEdit/canDelete를 그대로 따른다.
// 못 고치는 이유는 둘 중 하나라 안내 문구를 구분한다: 결재가 시작됐거나(409), 남의 글이거나(403).
function applyRepairPermissions(item) {
  const canEdit = item.canEdit !== false;
  setRepairFormEditable(canEdit);
  document.getElementById("rlSaveBtn").hidden = !canEdit;
  document.getElementById("rlDeleteBtn").hidden = item.canDelete !== true;

  const notice = document.getElementById("rlLockNotice");
  notice.hidden = canEdit;
  notice.textContent = isApprovalStarted(item)
    ? "결재가 진행된 문서는 수정할 수 없습니다. 시스템관리자가 결재를 리셋하면 다시 수정할 수 있습니다."
    : "작성자 본인 또는 시스템관리자만 수정할 수 있습니다.";

  const isSystemAdmin = getSession()?.role === "시스템관리자";
  document.getElementById("rlResetApprovalsBtn").hidden = !(isSystemAdmin && isApprovalStarted(item));
}

function collectRepairFormValues() {
  return {
    title: getValue("rlTitle").trim(),
    performedAt: getValue("rlPerformedAt"),
    location: getValue("rlLocation").trim(),
    performedBy: getValue("rlPerformedBy").trim(),
    target: getValue("rlTarget").trim(),
    stateBefore: getValue("rlStateBefore").trim(),
    stateAfter: getValue("rlStateAfter").trim(),
    result: getValue("rlResult").trim(),
    failureCause: getValue("rlFailureCause").trim(),
    preventiveAction: getValue("rlPreventiveAction").trim(),
    opinion: getValue("rlOpinion").trim(),
  };
}

function buildRepairPayload(values) {
  return {
    title: values.title,
    // 날짜만 입력받으므로 시각은 한국시간 0시로 보낸다 — 서버가 UTC로 정규화해 저장한다
    performedAt: `${values.performedAt}T00:00:00+09:00`,
    location: values.location || null,
    performedBy: values.performedBy || null,
    target: values.target || null,
    stateBefore: values.stateBefore || null,
    stateAfter: values.stateAfter || null,
    result: values.result || null,
    failureCause: values.failureCause || null,
    preventiveAction: values.preventiveAction || null,
    opinion: values.opinion || null,
  };
}

function repairSaveErrorMessage(err) {
  if (err.status === 403) return "수정 권한이 없습니다. 작성자 본인 또는 시스템관리자만 수정할 수 있습니다.";
  if (err.status === 409) return "결재가 진행된 문서는 수정할 수 없습니다. 시스템관리자가 결재를 리셋해야 합니다.";
  return `저장하지 못했습니다. (${err.message})`;
}

async function saveRepair() {
  const values = collectRepairFormValues();
  if (!values.title || !values.performedAt) {
    showRepairPopupError("제목과 일시는 필수입니다.");
    return;
  }
  if (!window.confirm(repairPopupState.isNew ? "등록하시겠습니까?" : "저장하시겠습니까?")) return;

  document.getElementById("rlPopupError").hidden = true;
  const payload = buildRepairPayload(values);

  try {
    await withGlobalBusy(async () => {
      if (repairPopupState.isNew) {
        const created = await apiFetch("/api/repair-logs", {
          method: "POST",
          body: JSON.stringify({ equipmentId: Number(repairPopupState.equipmentId), ...payload }),
        });
        repairPopupState.items.push(created);
        // 등록 직후 그 자리에서 결재까지 이어갈 수 있게 상세 화면으로 전환한다
        openRepairDetail(created.id);
      } else {
        const updated = await apiFetch(`/api/repair-logs/${repairPopupState.selectedId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        const idx = repairPopupState.items.findIndex((i) => String(i.id) === String(repairPopupState.selectedId));
        if (idx !== -1) repairPopupState.items[idx] = updated;
        repairPopupState.current = updated;
        document.getElementById("rlAuditInfo").textContent = formatRepairAuditInfo(updated);
        applyRepairPermissions(updated);
        repairDirty.capture();
      }
      renderRepairList();
    });
  } catch (err) {
    showRepairPopupError(repairSaveErrorMessage(err));
  }
}

async function deleteRepair() {
  if (!repairPopupState.selectedId) return;
  if (!window.confirm("삭제하시겠습니까?")) return;

  try {
    await withGlobalBusy(async () => {
      await apiFetch(`/api/repair-logs/${repairPopupState.selectedId}`, { method: "DELETE" });
      repairPopupState.items = repairPopupState.items.filter((i) => String(i.id) !== String(repairPopupState.selectedId));
      repairDirty.reset();

      const remaining = sortedRepairItems();
      if (remaining.length > 0) {
        openRepairDetail(remaining[0].id);
      } else {
        repairPopupState.selectedId = null;
        repairPopupState.current = null;
        document.getElementById("rlDetailForm").hidden = true;
        document.getElementById("rlDetailEmpty").hidden = false;
        document.getElementById("rlDeleteBtn").hidden = true;
        document.getElementById("rlSaveBtn").hidden = true;
      }
      renderRepairList();
    });
  } catch (err) {
    const message = err.status === 403 ? "삭제 권한이 없습니다. (결재가 진행된 문서는 시스템관리자만 삭제할 수 있습니다.)" : `삭제하지 못했습니다. (${err.message})`;
    showRepairPopupError(message);
  }
}

function showRepairPopupError(message) {
  const el = document.getElementById("rlPopupError");
  el.textContent = message;
  el.hidden = false;
}

// ---------- 수리보수일지 결재 바 (점검일지 · 운전일지와 동일 규칙) ----------

// 신규작성 중에도 같은 결재란을 보여줘서 문서 전체 모양이 항상 같게 유지한다
// (저장 전에는 문서 id가 없어 결재 버튼 없이 "대기"로만 표시된다).
// 3단계 모두 결재 대상이라 저장 전에는 전부 "대기"로 그린다.
const REPAIR_EMPTY_APPROVAL = {
  level1: { status: "Pending" },
  level2: { status: "Pending" },
  level3: { status: "Pending" },
};

function renderRepairApprovalBar() {
  renderApprovalBar(document.getElementById("rlApprovalBar"), repairPopupState.current, {
    allowApprove: repairPopupState.current !== null,
    emptyDoc: REPAIR_EMPTY_APPROVAL,
    onApprove: approveRepairLevel,
    onCancel: cancelRepairLevel,
  });
}

// 승인/취소/리셋 응답은 전부 갱신된 문서 전체라, 결재 바뿐 아니라 수정 잠금(canEdit)과
// 목록 배지까지 이 응답 하나로 다시 맞춘다.
function applyRepairApprovalUpdate(updated) {
  repairPopupState.current = updated;
  const idx = repairPopupState.items.findIndex((i) => String(i.id) === String(updated.id));
  if (idx !== -1) repairPopupState.items[idx] = updated;
  renderRepairApprovalBar();
  applyRepairPermissions(updated);
  renderRepairList();
}

async function approveRepairLevel() {
  if (!window.confirm("결재하시겠습니까?")) return;
  try {
    const updated = await withGlobalBusy(() => apiFetch(`/api/repair-logs/${repairPopupState.selectedId}/approve`, { method: "POST" }));
    applyRepairApprovalUpdate(updated);
  } catch (err) {
    let message = err.message;
    if (err.status === 403) message = "권한이 없습니다. (역할 또는 담당 장비 등록 여부를 확인하세요.)";
    if (err.status === 409) message = "처리할 수 없습니다. 결재 순서를 다시 확인하세요.";
    showRepairPopupError(message);
  }
}

async function cancelRepairLevel() {
  if (!window.confirm("결재를 취소하시겠습니까?")) return;
  try {
    const updated = await withGlobalBusy(() => apiFetch(`/api/repair-logs/${repairPopupState.selectedId}/approve/cancel`, { method: "POST" }));
    applyRepairApprovalUpdate(updated);
  } catch (err) {
    let message = err.message;
    if (err.status === 403) message = "본인이 결재한 단계만 취소할 수 있습니다.";
    if (err.status === 409) message = "상위 단계가 이미 결재되어 취소할 수 없습니다.";
    showRepairPopupError(message);
  }
}

// 결재를 전부 무효화한다(시스템관리자 전용) — 수정 잠금도 같이 풀린다.
async function resetRepairApprovals() {
  if (!window.confirm("이 문서의 결재를 전부 취소하시겠습니까? 되돌릴 수 없습니다.")) return;
  try {
    const updated = await withGlobalBusy(() => apiFetch(`/api/repair-logs/${repairPopupState.selectedId}/approvals/reset`, { method: "POST" }));
    applyRepairApprovalUpdate(updated);
  } catch (err) {
    const message = err.status === 403 ? "시스템관리자만 결재를 리셋할 수 있습니다." : `처리하지 못했습니다. (${err.message})`;
    showRepairPopupError(message);
  }
}

document.addEventListener("DOMContentLoaded", initEquipmentPage);
