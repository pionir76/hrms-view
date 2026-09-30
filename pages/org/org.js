// 조직 관리 페이지 전용 스크립트
//
// 쓰는 API (api-manual 59~67번 + 첨부 26~29번):
//   GET  /api/users                      — 조직 구성원 전체(비활성 포함, 시스템관리자 제외)
//   GET  /api/users/check-username       — ID 중복확인(시스템관리자)
//   POST /api/users · PUT /api/users/{id} — 등록·수정(시스템관리자). equipmentIds는 목록 전체 교체
//   PUT  /api/users/{id}/password        — 비밀번호 초기화(시스템관리자)
//   POST /api/users/{id}/deactivate|activate — 비활성화·활성화(삭제 API 없음)
//   GET  /api/equipments                 — 담당장비 이름·지역·시설동 매칭용
//   첨부 ownerType=AppointmentReport, ownerId=사용자 id — 선해임 신고서(사용자당 1건, 다시 올리면 교체)
//
// 화면(사용자 결정 2026-09-17):
//   - 첫 화면: 선임(isAppointed) + 활성 인원만 담당업무 단계별(총괄자 → 책임자 → 안전관리원 → 일반관리원)
//     카드로 보여준다. 카드: 담당업무·소속팀·성명·연락처1·2·신고서 받기·세부정보 버튼
//   - 세부정보 팝업: ID를 뺀 전체 정보 + 담당장비(지역 → 시설동으로 묶음)
//   - "관리" 버튼(시스템관리자만): 좌 인원 목록 / 우 정보 수정·신규 작성. 미선임·비활성 인원도 여기서는 보인다
//   - 일반 사용자의 본인 정보 수정은 이 페이지와 무관(별도 "내 정보"에서 예정)

const ORG_ROLES = [
  { role: "안전관리총괄자", cls: "role-1" },
  { role: "안전관리책임자", cls: "role-2" },
  { role: "안전관리원", cls: "role-3" },
  { role: "일반관리원", cls: "role-4" },
];
const REPORT_OWNER_TYPE = "AppointmentReport";

const orgState = {
  users: [],
  equipments: [],
  equipmentById: new Map(),
};

function isSystemAdmin() {
  return getSession()?.role === "시스템관리자";
}

function roleClass(role) {
  return (ORG_ROLES.find((r) => r.role === role) || ORG_ROLES[3]).cls;
}

function roleOrder(role) {
  const i = ORG_ROLES.findIndex((r) => r.role === role);
  return i < 0 ? ORG_ROLES.length : i;
}

function sortUsers(users) {
  return users.slice().sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.fullName.localeCompare(b.fullName, "ko"));
}

async function initOrgPage() {
  const manageBtn = document.getElementById("orgManageBtn");
  manageBtn.hidden = !isSystemAdmin();
  manageBtn.addEventListener("click", openManageModal);

  document.querySelectorAll("[data-close-detail]").forEach((btn) => btn.addEventListener("click", closeDetailModal));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById("orgPwModal").hidden) closePasswordModal();
    else if (!document.getElementById("orgDetailModal").hidden) closeDetailModal();
    else if (!document.getElementById("orgManageModal").hidden) closeManageModal();
  });

  initManageModal();
  initPasswordModal();

  try {
    await withGlobalBusy(async () => {
      const [users, equipments] = await Promise.all([apiFetch("/api/users"), apiFetch("/api/equipments")]);
      orgState.users = sortUsers(users);
      orgState.equipments = equipments;
      orgState.equipmentById = new Map(equipments.map((e) => [e.id, e]));
    });
  } catch (err) {
    showOrgError(`조직 정보를 불러오지 못했습니다. (${err.message})`);
    document.getElementById("orgChart").innerHTML = "";
    return;
  }
  renderOrgChart();
}

function showOrgError(message) {
  const el = document.getElementById("orgError");
  el.textContent = message;
  el.hidden = false;
}

async function reloadUsers() {
  const users = await apiFetch("/api/users");
  orgState.users = sortUsers(users);
  renderOrgChart();
}

// ---------- 첫 화면: 조직도 ----------

const ICON_DOWNLOAD = `<i class="org-icon-download" aria-hidden="true"></i>`;

function renderOrgChart() {
  const el = document.getElementById("orgChart");
  // 선임 + 활성 인원만 — 미선임·비활성 인원은 관리 모달에서만 보인다(사용자 결정)
  const visible = orgState.users.filter((u) => u.isActive && u.isAppointed);

  const tiers = ORG_ROLES.map((r) => ({ ...r, users: visible.filter((u) => u.role === r.role) })).filter((t) => t.users.length > 0);

  if (tiers.length === 0) {
    el.innerHTML = `<div class="panel"><div class="empty-state">선임된 인원이 없습니다.</div></div>`;
    return;
  }

  el.innerHTML = tiers
    .map(
      (tier) => `
        <div class="org-tier">
          <div class="org-cards">${tier.users.map((u) => orgCardHtml(u, tier.cls)).join("")}</div>
        </div>
      `
    )
    .join("");

  el.querySelectorAll("[data-detail]").forEach((btn) => {
    btn.addEventListener("click", () => openDetailModal(Number(btn.dataset.detail)));
  });
  el.querySelectorAll("[data-report]").forEach((btn) => {
    btn.addEventListener("click", () => downloadReport(Number(btn.dataset.report)));
  });
}

// 차기교육일까지 남은 날 — 30일 이내면 주황, 지나면 빨강(오늘은 D-0)
function trainingDdayHtml(dateStr) {
  if (!dateStr) return "";
  const days = Math.round((new Date(dateStr.slice(0, 10)) - new Date(todayDateString())) / 86400000);
  if (Number.isNaN(days)) return "";
  const cls = days < 0 ? "over" : days <= 30 ? "soon" : "";
  return `<span class="org-dday ${cls}">${days < 0 ? `D+${-days}` : `D-${days}`}</span>`;
}

// 인원 카드 — 머리(담당업무 색 면: 담당업무 · 이름 첫 글자 동그라미 + 이름/직위 · 소속팀) +
// 본문(연락처·대직자·담당장비·차기교육일) + 세부정보 버튼. 사용자 결정 2026-09-29(시안 mokup/org_card_v1).
function orgCardHtml(u, cls) {
  const hasReport = !!u.appointmentReportId;
  const initial = String(u.fullName || "?").trim().charAt(0);
  const nextTraining = u.nextTrainingDate ? u.nextTrainingDate.slice(0, 10) : "";
  return `
    <div class="org-card ${cls}">
      <div class="org-card-head">
        <div class="org-card-role">${escapeHtml(u.role)}</div>
        <div class="org-card-who">
          <span class="org-avatar" aria-hidden="true">${escapeHtml(initial)}</span>
          <div>
            <div class="org-name">${escapeHtml(u.fullName)}${u.position ? `<small>${escapeHtml(u.position)}</small>` : ""}</div>
            <div class="org-dept">${escapeHtml(u.department || "소속팀 미지정")}</div>
          </div>
        </div>
        <button type="button" class="org-report-btn" ${hasReport ? `data-report="${u.id}"` : "disabled"}
          title="${hasReport ? "선해임 신고서 받기" : "선해임 신고서 미등록"}" aria-label="선해임 신고서 받기">${ICON_DOWNLOAD}</button>
      </div>
      <dl class="org-card-info">
        <dt>연락처1</dt><dd>${escapeHtml(u.phone1 || "-")}</dd>
        <dt>연락처2</dt><dd>${escapeHtml(u.phone2 || "-")}</dd>
        <dt>대직자</dt><dd>${escapeHtml(u.backupPersonName || "-")}</dd>
        <dt>담당장비</dt><dd>${(u.equipmentIds || []).length}대</dd>
        <dt>차기교육</dt><dd>${nextTraining ? `${escapeHtml(nextTraining.replace(/-/g, "."))} ${trainingDdayHtml(nextTraining)}` : "-"}</dd>
      </dl>
      <button type="button" class="org-detail-btn" data-detail="${u.id}">세부정보</button>
    </div>
  `;
}

// 신고서는 사용자 응답에 첨부 id만 있어 파일명을 알려면 메타데이터를 한 번 받아야 한다
async function fetchReportMeta(userId) {
  const items = await fetchAttachments(REPORT_OWNER_TYPE, userId);
  return items && items.length > 0 ? items[0] : null;
}

async function downloadReport(userId) {
  const user = orgState.users.find((u) => u.id === userId);
  try {
    const meta = await fetchReportMeta(userId);
    if (!meta) {
      window.alert("등록된 선해임 신고서가 없습니다.");
      return;
    }
    await downloadAttachment(meta.id, meta.fileName || `선해임신고서_${user ? user.fullName : userId}`);
  } catch (err) {
    window.alert(`신고서를 받지 못했습니다. (${err.message})`);
  }
}

// ---------- 담당장비 묶기 (지역 → 시설동) ----------

function groupEquipments(equipments) {
  const sorted = equipments
    .slice()
    .sort(
      (a, b) =>
        compareRegion(a.region, b.region) ||
        String(a.buildingName).localeCompare(String(b.buildingName), "ko") ||
        String(a.name).localeCompare(String(b.name), "ko")
    );
  const groups = [];
  sorted.forEach((e) => {
    const key = `${e.region}|${e.buildingName}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, region: e.region, buildingName: e.buildingName, items: [] };
      groups.push(g);
    }
    g.items.push(e);
  });
  return groups;
}

// ---------- 세부정보 팝업 ----------

async function openDetailModal(userId) {
  const u = orgState.users.find((x) => x.id === userId);
  if (!u) return;

  document.getElementById("orgDetailTitle").textContent = `${u.fullName} 세부정보`;
  const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
  const text = (v) => escapeHtml(v || "-");
  const rows = document.getElementById("orgDetailRows");
  rows.innerHTML = [
    row("담당업무", `<span class="org-role org-role-sm ${roleClass(u.role)}">${escapeHtml(u.role)}</span>`),
    row("성명", text(u.fullName)),
    row("소속팀", text(u.department)),
    row("직위", text(u.position)),
    row("연락처1", text(u.phone1)),
    row("연락처2", text(u.phone2)),
    row("대직자", text(u.backupPersonName)),
    row("선임여부", u.isAppointed ? "선임" : "미선임"),
    row("법정교육일", text(u.legalTrainingDate)),
    row("차기교육일", text(u.nextTrainingDate)),
    row("선해임 신고서", `<span id="orgDetailReport">${u.appointmentReportId ? "불러오는 중..." : "미등록"}</span>`),
  ].join("");

  const equipments = u.equipmentIds.map((id) => orgState.equipmentById.get(id)).filter(Boolean);
  document.getElementById("orgDetailEquipCount").textContent = `${equipments.length}대`;
  const equipEl = document.getElementById("orgDetailEquipments");
  if (equipments.length === 0) {
    equipEl.innerHTML = `<div class="org-equip-empty">담당장비가 없습니다.</div>`;
  } else {
    let lastRegion = null;
    equipEl.innerHTML = groupEquipments(equipments)
      .map((g) => {
        const regionRow = g.region !== lastRegion ? `<div class="org-equip-row org-equip-region">${escapeHtml(g.region)}</div>` : "";
        lastRegion = g.region;
        return `${regionRow}
          <div class="org-equip-row">
            <b>${escapeHtml(g.buildingName)}</b>
            <span>${g.items.map((e) => escapeHtml(e.name)).join(" · ")}</span>
          </div>`;
      })
      .join("");
  }

  document.getElementById("orgDetailModal").hidden = false;

  if (u.appointmentReportId) {
    try {
      const meta = await fetchReportMeta(u.id);
      const el = document.getElementById("orgDetailReport");
      if (!el) return;
      if (!meta) {
        el.textContent = "미등록";
        return;
      }
      el.innerHTML = `<button type="button" class="org-file-chip">${ICON_DOWNLOAD}${escapeHtml(meta.fileName)}</button>`;
      el.querySelector("button").addEventListener("click", () => downloadAttachment(meta.id, meta.fileName));
    } catch (err) {
      const el = document.getElementById("orgDetailReport");
      if (el) el.textContent = `불러오지 못했습니다. (${err.message})`;
    }
  }
}

function closeDetailModal() {
  document.getElementById("orgDetailModal").hidden = true;
}

// ---------- 인원 관리 모달 ----------

const om = {
  selectedId: null, // 수정 중인 사용자 id, 신규 작성이면 null
  isNew: false,
  original: null, // 수정 시작 시점의 사용자(담당업무 변경 경고용)
  active: true,
  appointed: true,
  equipmentIds: new Set(),
  expandedGroups: new Set(),
  report: null, // 저장된 신고서 메타데이터 { id, fileName, sizeBytes }
  reportPendingFile: null, // 저장 시 올릴 파일(교체 포함)
  reportDeleteRequested: false,
  usernameChecked: null, // { username, available } — 신규 등록 시 중복확인 결과
};

// 저장 안 한 변경사항 확인용 — 폼 값 전체를 같은 순서의 객체로 모은다
const omDirty = createDirtyTracker(() => ({
  username: om.isNew ? val("omUsername") : "",
  password: om.isNew ? val("omPassword") : "",
  passwordConfirm: om.isNew ? val("omPasswordConfirm") : "",
  ...collectProfile(),
  active: om.active,
  report: om.reportPendingFile ? om.reportPendingFile.name : null,
  reportDelete: om.reportDeleteRequested,
}));

function val(id) {
  return document.getElementById(id).value;
}

function setVal(id, value) {
  document.getElementById(id).value = value ?? "";
}

function collectProfile() {
  const trimOrNull = (id) => {
    const v = val(id).trim();
    return v ? v : null;
  };
  return {
    fullName: val("omFullName").trim(),
    department: trimOrNull("omDepartment"),
    position: trimOrNull("omPosition"),
    role: val("omRole"),
    phone1: trimOrNull("omPhone1"),
    phone2: trimOrNull("omPhone2"),
    backupPersonName: trimOrNull("omBackup"),
    isAppointed: om.appointed,
    legalTrainingDate: val("omLegalDate") || null,
    nextTrainingDate: val("omNextDate") || null,
    equipmentIds: [...om.equipmentIds].sort((a, b) => a - b),
  };
}

function initManageModal() {
  document.getElementById("omCloseX").addEventListener("click", closeManageModal);
  document.getElementById("omCloseBtn").addEventListener("click", closeManageModal);
  document.getElementById("omNewBtn").addEventListener("click", () => {
    if (!confirmDiscardIfDirty(omDirty)) return;
    startNewUser();
  });
  document.getElementById("omSearch").addEventListener("input", renderManageList);
  document.getElementById("omShowInactive").addEventListener("change", renderManageList);
  document.getElementById("omSaveBtn").addEventListener("click", saveUser);
  document.getElementById("omCheckBtn").addEventListener("click", checkUsername);
  document.getElementById("omResetPwBtn").addEventListener("click", openPasswordModal);

  document.getElementById("omUsername").addEventListener("input", () => {
    om.usernameChecked = null;
    document.getElementById("omUsername").classList.remove("om-input-error");
    renderUsernameHint();
  });
  document.getElementById("omRole").addEventListener("change", updateWarnings);
  // 강조된 칸을 다시 입력·선택하면 강조를 푼다
  ["omPassword", "omPasswordConfirm", "omFullName"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => document.getElementById(id).classList.remove("om-input-error"));
  });
  document.getElementById("omRole").addEventListener("change", () => document.getElementById("omRole").classList.remove("om-input-error"));

  bindSegment("omActiveSeg", (v) => {
    om.active = v;
    updateWarnings();
  });
  bindSegment("omAppointedSeg", (v) => {
    om.appointed = v;
  });

  // 신고서: 고른 파일은 저장할 때 올린다(신규 인원은 저장 전에 사용자 id가 없어 바로 올릴 수 없다)
  document.getElementById("omReportFile").addEventListener("change", (event) => {
    const files = filterFilesWithinSizeLimit([...event.target.files], (msg) => showOmError(msg));
    event.target.value = "";
    if (files.length === 0) return;
    om.reportPendingFile = files[0];
    om.reportDeleteRequested = false;
    renderReportField();
  });

  document.getElementById("omEquipSearch").addEventListener("input", renderEquipmentPicker);
  document.getElementById("omEquipAll").addEventListener("click", toggleAllEquipments);
}

function bindSegment(id, onChange) {
  document.getElementById(id).addEventListener("click", (event) => {
    const btn = event.target.closest(".segmented-btn");
    if (!btn) return;
    const value = btn.dataset.value === "true";
    setSegment(id, value);
    onChange(value);
  });
}

function setSegment(id, value) {
  document.querySelectorAll(`#${id} .segmented-btn`).forEach((btn) => {
    btn.classList.toggle("active", (btn.dataset.value === "true") === value);
  });
}

function openManageModal() {
  document.getElementById("omSearch").value = "";
  document.getElementById("omShowInactive").checked = false;
  clearOmMessages();
  showEmptyRight();
  renderManageList();
  document.getElementById("orgManageModal").hidden = false;
}

function closeManageModal() {
  if (!confirmDiscardIfDirty(omDirty)) return;
  omDirty.reset();
  document.getElementById("orgManageModal").hidden = true;
}

function showEmptyRight() {
  om.selectedId = null;
  om.isNew = false;
  document.getElementById("omForm").hidden = true;
  document.getElementById("omEmpty").hidden = false;
  document.getElementById("omSaveBtn").disabled = true;
  omDirty.reset();
}

// 좌측 인원 목록 — 이름 검색, 비활성 포함 여부
function renderManageList() {
  const keyword = val("omSearch").trim();
  const showInactive = document.getElementById("omShowInactive").checked;
  const list = orgState.users.filter((u) => (showInactive || u.isActive) && (!keyword || u.fullName.includes(keyword)));
  const el = document.getElementById("omList");

  if (list.length === 0) {
    el.innerHTML = `<li class="om-list-empty">${keyword ? "검색 결과가 없습니다." : "등록된 인원이 없습니다."}</li>`;
    return;
  }

  el.innerHTML = list
    .map((u) => {
      const sub = [u.department, u.position].filter(Boolean).join(" · ") || "소속팀 미지정";
      return `
        <li class="om-item ${roleClass(u.role)}${u.id === om.selectedId ? " active" : ""}${u.isActive ? "" : " inactive"}" data-id="${u.id}">
          <div class="om-item-top">
            <b>${escapeHtml(u.fullName)}</b>
            <span class="om-tag om-tag-role">${escapeHtml(u.role)}</span>
            ${u.isAppointed ? "" : `<span class="om-tag om-tag-gray">미선임</span>`}
            ${u.isActive ? "" : `<span class="om-tag om-tag-red">비활성</span>`}
          </div>
          <div class="om-item-sub">${escapeHtml(sub)}</div>
        </li>
      `;
    })
    .join("");

  el.querySelectorAll(".om-item").forEach((item) => {
    item.addEventListener("click", () => {
      const id = Number(item.dataset.id);
      if (id === om.selectedId) return;
      if (!confirmDiscardIfDirty(omDirty)) return;
      selectUser(id);
    });
  });
}

function startNewUser() {
  om.selectedId = null;
  om.isNew = true;
  om.original = null;
  om.active = true;
  om.appointed = true;
  om.equipmentIds = new Set();
  om.expandedGroups = new Set();
  om.report = null;
  om.reportPendingFile = null;
  om.reportDeleteRequested = false;
  om.usernameChecked = null;

  ["omUsername", "omPassword", "omPasswordConfirm", "omFullName", "omDepartment", "omPosition", "omRole", "omPhone1", "omPhone2", "omBackup", "omLegalDate", "omNextDate", "omEquipSearch"].forEach((id) =>
    setVal(id, "")
  );
  showForm();
  renderManageList();
  omDirty.capture();
  document.getElementById("omUsername").focus();
}

async function selectUser(userId) {
  const u = orgState.users.find((x) => x.id === userId);
  if (!u) return;

  om.selectedId = u.id;
  om.isNew = false;
  om.original = u;
  om.active = u.isActive;
  om.appointed = u.isAppointed;
  om.equipmentIds = new Set(u.equipmentIds);
  om.expandedGroups = new Set();
  om.report = null;
  om.reportPendingFile = null;
  om.reportDeleteRequested = false;
  om.usernameChecked = null;

  setVal("omUsername", u.username);
  setVal("omPassword", "");
  setVal("omPasswordConfirm", "");
  setVal("omFullName", u.fullName);
  setVal("omDepartment", u.department);
  setVal("omPosition", u.position);
  setVal("omRole", u.role);
  setVal("omPhone1", u.phone1);
  setVal("omPhone2", u.phone2);
  setVal("omBackup", u.backupPersonName);
  setVal("omLegalDate", u.legalTrainingDate);
  setVal("omNextDate", u.nextTrainingDate);
  setVal("omEquipSearch", "");

  clearOmMessages();
  showForm();
  renderManageList();
  omDirty.capture();

  // 신고서 파일명은 메타데이터를 따로 받아야 한다 — 받는 동안에도 나머지 폼은 쓸 수 있다
  if (u.appointmentReportId) {
    om.report = { loading: true };
    renderReportField();
    try {
      const meta = await fetchReportMeta(u.id);
      if (om.selectedId !== u.id) return; // 그새 다른 인원을 골랐으면 버린다
      om.report = meta;
    } catch (err) {
      if (om.selectedId !== u.id) return;
      om.report = null;
      showOmError(`신고서 정보를 불러오지 못했습니다. (${err.message})`);
    }
    renderReportField();
  }
}

function showForm() {
  const form = document.getElementById("omForm");
  form.hidden = false;
  form.classList.toggle("is-new", om.isNew);
  document.getElementById("omEmpty").hidden = true;
  document.getElementById("omSaveBtn").disabled = false;
  clearFieldErrors(); // 다른 인원·신규로 바뀌면 이전 오류 강조는 지운다

  const username = document.getElementById("omUsername");
  username.readOnly = !om.isNew;
  document.getElementById("omCheckBtn").hidden = !om.isNew;
  document.getElementById("omUsernameReq").hidden = !om.isNew;

  setSegment("omActiveSeg", om.active);
  setSegment("omAppointedSeg", om.appointed);
  renderUsernameHint();
  renderReportField();
  renderEquipmentPicker();
  updateWarnings();
  document.querySelector(".om-right").scrollTop = 0;
}

function updateWarnings() {
  document.getElementById("omRoleWarn").hidden = om.isNew || !om.original || val("omRole") === om.original.role;
  document.getElementById("omInactiveWarn").hidden = om.isNew || !om.original || !om.original.isActive || om.active;
}

// ----- 사용자 ID 중복확인 (신규만) -----

function renderUsernameHint() {
  const hint = document.getElementById("omUsernameHint");
  hint.className = "om-hint";
  if (!om.isNew) {
    hint.textContent = "사용자 ID는 바꿀 수 없습니다.";
    return;
  }
  const checked = om.usernameChecked;
  if (!checked || checked.username !== val("omUsername").trim()) {
    hint.textContent = "중복확인이 필요합니다.";
    return;
  }
  hint.textContent = checked.available ? "사용할 수 있는 ID입니다." : "이미 사용 중인 ID입니다.";
  hint.classList.add(checked.available ? "om-hint-ok" : "om-hint-error");
}

async function checkUsername() {
  const username = val("omUsername").trim();
  if (!username) {
    showOmError("사용자 ID를 입력하세요.");
    return;
  }
  try {
    om.usernameChecked = await apiFetch(`/api/users/check-username?username=${encodeURIComponent(username)}`);
    clearOmMessages();
  } catch (err) {
    showOmError(`중복확인에 실패했습니다. (${err.message})`);
  }
  renderUsernameHint();
}

// ----- 선해임 신고서 -----

function renderReportField() {
  const el = document.getElementById("omReport");
  const r = om.report;
  let fileHtml;
  let actions = "";

  if (om.reportPendingFile) {
    fileHtml = `<span class="org-file-chip is-pending" title="저장할 때 올라갑니다">${escapeHtml(om.reportPendingFile.name)}</span>`;
    actions = `<button type="button" class="om-link-btn" data-act="pick">변경</button><button type="button" class="om-link-btn danger" data-act="cancel-pending">취소</button>`;
  } else if (r && r.loading) {
    fileHtml = `<span class="om-report-none">불러오는 중...</span>`;
  } else if (r && !om.reportDeleteRequested) {
    fileHtml = `<button type="button" class="org-file-chip" data-act="download">${ICON_DOWNLOAD}${escapeHtml(r.fileName)}</button>`;
    actions = `<button type="button" class="om-link-btn" data-act="pick">교체</button><button type="button" class="om-link-btn danger" data-act="delete">삭제</button>`;
  } else if (r && om.reportDeleteRequested) {
    fileHtml = `<span class="om-report-none">저장하면 삭제됩니다</span>`;
    actions = `<button type="button" class="om-link-btn" data-act="undo-delete">되돌리기</button>`;
  } else {
    fileHtml = `<span class="om-report-none">미등록</span>`;
    actions = `<button type="button" class="om-link-btn" data-act="pick">올리기</button>`;
  }

  el.innerHTML = `${fileHtml}<span class="om-report-actions">${actions}</span>`;
  el.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      if (act === "pick") document.getElementById("omReportFile").click();
      else if (act === "download" && r) downloadAttachment(r.id, r.fileName);
      else if (act === "delete") om.reportDeleteRequested = true;
      else if (act === "undo-delete") om.reportDeleteRequested = false;
      else if (act === "cancel-pending") om.reportPendingFile = null;
      if (act !== "pick" && act !== "download") renderReportField();
    });
  });
}

// ----- 담당장비 선택 (지역 · 시설동으로 묶은 체크 목록) -----

function renderEquipmentPicker() {
  const keyword = val("omEquipSearch").trim();
  const groups = groupEquipments(orgState.equipments);
  const el = document.getElementById("omEquipGroups");

  document.getElementById("omEquipCount").textContent = `선택 ${om.equipmentIds.size}대 / 전체 ${orgState.equipments.length}대`;

  const visibleGroups = groups
    .map((g) => {
      const groupMatches = keyword && `${g.region} ${g.buildingName}`.includes(keyword);
      const items = !keyword || groupMatches ? g.items : g.items.filter((e) => String(e.name).includes(keyword));
      return { ...g, visibleItems: items };
    })
    .filter((g) => g.visibleItems.length > 0);

  // 전체 선택 대상 — 검색 중이면 검색 결과에 보이는 장비만
  om.visibleEquipIds = visibleGroups.flatMap((g) => g.visibleItems.map((e) => e.id));
  renderEquipAllToggle(!!keyword);

  if (visibleGroups.length === 0) {
    el.innerHTML = `<div class="om-equip-empty">${keyword ? "검색 결과가 없습니다." : "등록된 장비가 없습니다."}</div>`;
    return;
  }

  el.innerHTML = visibleGroups
    .map((g) => {
      const selected = g.items.filter((e) => om.equipmentIds.has(e.id)).length;
      const state = selected === 0 ? "" : selected === g.items.length ? "on" : "part";
      // 검색 중에는 찾은 장비가 보이도록 펼친다
      const expanded = !!keyword || om.expandedGroups.has(g.key);
      return `
        <div class="om-group${expanded ? " expanded" : ""}" data-key="${escapeHtml(g.key)}">
          <div class="om-group-head">
            <button type="button" class="om-cb ${state}" data-act="toggle-group" aria-label="${escapeHtml(g.buildingName)} 전체 선택"></button>
            <button type="button" class="om-group-name" data-act="expand">
              <span>${escapeHtml(g.region)} · ${escapeHtml(g.buildingName)}</span>
              <em>${selected}/${g.items.length}</em>
              <i class="om-chevron"></i>
            </button>
          </div>
          <div class="om-group-items">
            ${g.visibleItems
              .map(
                (e) => `
                  <label class="om-equip-item">
                    <input type="checkbox" data-equip="${e.id}" ${om.equipmentIds.has(e.id) ? "checked" : ""} />
                    <span>${escapeHtml(e.name)}</span>
                  </label>`
              )
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");

  el.querySelectorAll(".om-group").forEach((groupEl) => {
    const key = groupEl.dataset.key;
    const group = groups.find((g) => g.key === key);
    groupEl.querySelector('[data-act="expand"]').addEventListener("click", () => {
      if (om.expandedGroups.has(key)) om.expandedGroups.delete(key);
      else om.expandedGroups.add(key);
      renderEquipmentPicker();
    });
    // 시설동 체크: 전부 선택돼 있으면 전부 해제, 아니면 전부 선택
    groupEl.querySelector('[data-act="toggle-group"]').addEventListener("click", () => {
      const allOn = group.items.every((e) => om.equipmentIds.has(e.id));
      group.items.forEach((e) => (allOn ? om.equipmentIds.delete(e.id) : om.equipmentIds.add(e.id)));
      renderEquipmentPicker();
    });
    groupEl.querySelectorAll("[data-equip]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = Number(cb.dataset.equip);
        if (cb.checked) om.equipmentIds.add(id);
        else om.equipmentIds.delete(id);
        renderEquipmentPicker();
      });
    });
  });
}

// 전체 선택 체크 — 대상(검색 결과 또는 전체) 중 몇 대가 선택됐는지로 빈칸/일부/전부를 그린다
function renderEquipAllToggle(searching) {
  const ids = om.visibleEquipIds || [];
  const selected = ids.filter((id) => om.equipmentIds.has(id)).length;
  const cbState = selected === 0 ? "" : selected === ids.length ? "on" : "part";
  document.getElementById("omEquipAllCb").className = `om-cb ${cbState}`;
  document.getElementById("omEquipAllLabel").textContent = searching ? "검색 결과 전체" : "전체 선택";
  const btn = document.getElementById("omEquipAll");
  btn.disabled = ids.length === 0;
  btn.setAttribute("aria-pressed", String(ids.length > 0 && selected === ids.length));
}

// 시설동 체크와 같은 규칙 — 대상이 전부 선택돼 있으면 전부 해제, 아니면(빈칸·일부) 전부 선택.
// 저장을 눌러야 반영되므로 확인창은 두지 않는다.
function toggleAllEquipments() {
  const ids = om.visibleEquipIds || [];
  if (ids.length === 0) return;
  const allOn = ids.every((id) => om.equipmentIds.has(id));
  ids.forEach((id) => (allOn ? om.equipmentIds.delete(id) : om.equipmentIds.add(id)));
  renderEquipmentPicker();
}

// ----- 저장 -----

function clearOmMessages() {
  document.getElementById("omError").hidden = true;
  document.getElementById("omOk").hidden = true;
}

function showOmError(message) {
  const el = document.getElementById("omError");
  el.textContent = message;
  el.hidden = false;
  document.getElementById("omOk").hidden = true;
}

function showOmOk(message) {
  const el = document.getElementById("omOk");
  el.textContent = message;
  el.hidden = false;
  document.getElementById("omError").hidden = true;
}

// 화면에서 바로 알 수 있는 입력 오류만 본다. ID 중복확인 여부는 저장할 때 ensureUsernameAvailable()이 본다.
// 오류가 있으면 { field: 강조할 칸 id, message }, 없으면 null. 위에서부터 첫 번째 오류 하나만 알려준다.
function validateForm() {
  if (om.isNew) {
    const username = val("omUsername").trim();
    if (!username) return { field: "omUsername", message: "사용자 ID를 입력하세요." };
    if (!val("omPassword")) return { field: "omPassword", message: "비밀번호를 입력하세요." };
    if (val("omPassword") !== val("omPasswordConfirm")) {
      return { field: "omPasswordConfirm", message: "비밀번호와 비밀번호 확인이 일치하지 않습니다." };
    }
  }
  if (!val("omFullName").trim()) return { field: "omFullName", message: "성명을 입력하세요." };
  if (!val("omRole")) return { field: "omRole", message: "담당업무를 선택하세요." };
  return null;
}

// 저장이 막힌 입력칸 — 스크롤·포커스 + 빨간 강조. 그 칸을 다시 입력·선택하면 강조가 풀린다.
const OM_VALIDATED_FIELDS = ["omUsername", "omPassword", "omPasswordConfirm", "omFullName", "omRole"];

function focusFieldError(fieldId, message) {
  OM_VALIDATED_FIELDS.forEach((id) => document.getElementById(id).classList.remove("om-input-error"));
  const input = document.getElementById(fieldId);
  input.classList.add("om-input-error");
  input.scrollIntoView({ block: "center", behavior: "smooth" });
  input.focus();
  if (input.select && input.tagName === "INPUT") input.select();
  showOmError(message);
}

function clearFieldErrors() {
  OM_VALIDATED_FIELDS.forEach((id) => document.getElementById(id).classList.remove("om-input-error"));
}

function userErrorMessage(err) {
  if (err.status === 403) return "권한이 없습니다. 시스템관리자만 인원을 관리할 수 있습니다.";
  if (err.status === 409) return "이미 사용 중인 사용자 ID입니다.";
  if (err.status === 404) return "해당 인원을 찾을 수 없습니다. 목록을 새로고침하세요.";
  return err.message;
}

// 사용자 ID 칸으로 스크롤·포커스하고 빨갛게 강조한다(ID를 다시 입력하면 강조가 풀린다)
function focusUsernameError(message) {
  focusFieldError("omUsername", message);
}

// 신규 등록 시 ID 중복확인 — 사용자가 "중복확인" 버튼으로 직접 확인해야 한다(사용자 결정, 자동 확인 없음).
// 확인하지 않았거나 확인한 뒤 ID를 바꿨으면 저장을 막고 ID 칸으로 안내한다.
// 사용할 수 있으면 true, 아니면 안내하고 false.
function ensureUsernameAvailable() {
  const username = val("omUsername").trim();
  if (!om.usernameChecked || om.usernameChecked.username !== username) {
    focusUsernameError("사용자 ID 중복확인을 해주세요. ID 옆 \"중복확인\" 버튼을 누르세요.");
    return false;
  }
  if (!om.usernameChecked.available) {
    focusUsernameError("이미 사용 중인 사용자 ID입니다. 다른 ID를 입력하세요.");
    return false;
  }
  return true;
}

async function saveUser() {
  clearOmMessages();
  const error = validateForm();
  if (error) {
    focusFieldError(error.field, error.message);
    return;
  }
  if (om.isNew && !ensureUsernameAvailable()) return;

  // 비활성화는 로그인을 막는 동작이라 한 번 더 확인한다
  if (!om.isNew && om.original.isActive && !om.active) {
    const ok = window.confirm(
      `${om.original.fullName} 계정을 비활성화합니다.\n비활성화하면 로그인할 수 없고, 이미 로그인해 있다면 최대 12시간 동안은 계속 사용할 수 있습니다.\n계속하시겠습니까?`
    );
    if (!ok) return;
  }

  const profile = collectProfile();
  const wasNew = om.isNew;
  let savedId = om.selectedId;
  let step = "저장";

  try {
    await withGlobalBusy(
      async () => {
        if (om.isNew) {
          const created = await apiFetch("/api/users", {
            method: "POST",
            body: JSON.stringify({ username: val("omUsername").trim(), password: val("omPassword"), ...profile }),
          });
          savedId = created.id;
        } else {
          await apiFetch(`/api/users/${savedId}`, { method: "PUT", body: JSON.stringify(profile) });
          if (om.active !== om.original.isActive) {
            step = om.active ? "활성화" : "비활성화";
            await apiFetch(`/api/users/${savedId}/${om.active ? "activate" : "deactivate"}`, { method: "POST" });
          }
        }

        // 신고서: 삭제 요청 → 삭제, 새 파일 → 올리기(서버가 사용자당 1건으로 교체 처리)
        if (om.reportDeleteRequested && om.report && om.report.id) {
          step = "신고서 삭제";
          await deleteAttachment(om.report.id);
        }
        if (om.reportPendingFile) {
          step = "신고서 업로드";
          await uploadAttachments(REPORT_OWNER_TYPE, savedId, [om.reportPendingFile]);
        }

        await reloadUsers();
      },
      { label: "저장 중..." }
    );
  } catch (err) {
    // 사용자 등록은 됐는데 신고서 업로드만 실패한 경우 — 등록된 인원으로 전환해 다시 시도할 수 있게 한다
    if (om.isNew && savedId) {
      await reloadUsers().catch(() => {});
      omDirty.reset();
      await selectUser(savedId);
      showOmError(`인원은 등록했지만 ${step}에 실패했습니다. (${userErrorMessage(err)})`);
      return;
    }
    // 확인한 뒤 저장하기 전 사이에 다른 곳에서 같은 ID가 먼저 등록된 경우(409)
    if (wasNew && err.status === 409) {
      om.usernameChecked = { username: val("omUsername").trim(), available: false };
      renderUsernameHint();
      focusUsernameError("이미 사용 중인 사용자 ID입니다. 다른 ID를 입력하세요.");
      return;
    }
    showOmError(`${step}에 실패했습니다. (${userErrorMessage(err)})`);
    return;
  }

  omDirty.reset();
  await selectUser(savedId);
  showOmOk(wasNew ? "등록했습니다." : "저장했습니다.");
}

// ---------- 비밀번호 초기화 ----------

function initPasswordModal() {
  document.getElementById("orgPwCancel").addEventListener("click", closePasswordModal);
  document.getElementById("orgPwSave").addEventListener("click", resetPassword);
}

function openPasswordModal() {
  if (!om.original) return;
  document.getElementById("orgPwTarget").textContent = `— ${om.original.fullName} (${om.original.username})`;
  setVal("orgPwNew", "");
  setVal("orgPwConfirm", "");
  document.getElementById("orgPwError").hidden = true;
  document.getElementById("orgPwModal").hidden = false;
  document.getElementById("orgPwNew").focus();
}

function closePasswordModal() {
  document.getElementById("orgPwModal").hidden = true;
}

async function resetPassword() {
  const errorEl = document.getElementById("orgPwError");
  const next = val("orgPwNew");
  if (!next) {
    errorEl.textContent = "새 비밀번호를 입력하세요.";
    errorEl.hidden = false;
    return;
  }
  if (next !== val("orgPwConfirm")) {
    errorEl.textContent = "새 비밀번호와 확인이 일치하지 않습니다.";
    errorEl.hidden = false;
    return;
  }
  try {
    await withGlobalBusy(() =>
      apiFetch(`/api/users/${om.original.id}/password`, { method: "PUT", body: JSON.stringify({ newPassword: next }) })
    );
  } catch (err) {
    errorEl.textContent = `변경하지 못했습니다. (${userErrorMessage(err)})`;
    errorEl.hidden = false;
    return;
  }
  closePasswordModal();
  showOmOk("비밀번호를 초기화했습니다.");
}

document.addEventListener("DOMContentLoaded", initOrgPage);
