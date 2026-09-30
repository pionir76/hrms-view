// 공통 상단바 렌더링. 각 페이지는 body에 data-page 속성을 두고
// 하단에서 requireAuth() + renderLayout()을 호출한다.
// 페이지 폴더 구조가 pages/<slug>/<slug>.html로 통일되어 있어, 메뉴 간 이동은
// 모두 "../<slug>/<slug>.html" 형태의 상대 경로를 쓴다.
//
// 상단바 구성(2026-09-17 개편, 사용자 결정):
//   좌: 네이비 로고 | "남양연구소"(옅게) / "냉동기 중앙통제시스템"(강조) 2단
//   우: 메인 메뉴(선택 메뉴는 밑줄) · 사용자 영역(이름·담당업무·소속팀, 누르면 드롭다운: 내 정보 / 설정 / 로그아웃) | 날짜·시각
//   "내 정보"는 읽기 전용(소속팀·직위·대직자·교육일·선해임 신고서·담당장비), "설정"은 본인이 바꿀 수 있는
//   연락처1·2와 비밀번호 변경(api-manual 61·68·69번), 로그아웃은 확인 모달을 거친다.
//
// 성명·소속팀은 로그인 응답에 없어 GET /api/users/me로 받는다. 받은 값은 세션(profile)에 넣어두고
// 다음 페이지에서는 바로 그리며, 관리자가 바꿨을 수도 있어 페이지를 열 때마다 뒤에서 한 번 새로 받는다.

const MENU = [
  { id: "dashboard", label: "실시간 현황", href: "../dashboard/dashboard.html" },
  { id: "trend", label: "자료 조회", href: "../trend/trend.html" },
  { id: "notice", label: "공지사항", href: "../notice/notice.html" },
  { id: "org", label: "조직 관리", href: "../org/org.html" },
  { id: "equipment", label: "장비 관리", href: "../equipment/equipment.html" },
  { id: "training", label: "교육훈련", href: "../training/training.html" },
  { id: "inspection", label: "점검일지", href: "../inspection/inspection.html" },
  { id: "operation", label: "운전일지", href: "../operation/operation.html" },
];

// 담당업무별 배지 색(조직 관리 화면과 같은 계열)
const ROLE_BADGE_CLASS = {
  시스템관리자: "tb-role-admin",
  안전관리총괄자: "tb-role-1",
  안전관리책임자: "tb-role-2",
  안전관리원: "tb-role-3",
  일반관리원: "tb-role-4",
};

const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];

const TB_ICON_GEAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>`;
const TB_ICON_USER = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>`;
const TB_ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>`;
const TB_ICON_LOGOUT =`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>`;

function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = "../login/login.html";
  }
}

function tbEscape(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// "2026년 1월 23일(금) 12:06"
function formatTopbarDateTime(date) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return {
    date: `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일(${WEEKDAYS_KO[date.getDay()]})`,
    time: `${hh}:${mm}`,
  };
}

// 결재 알림(벨) — 일괄 결재 팝업은 common/js/approval-inbox.js가 그린다
const TB_ICON_APPROVAL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>`;

function buildTopbarHtml(session, activePage) {
  const menuHtml = MENU.map(
    (item) => `<a class="menu-item${item.id === activePage ? " active" : ""}" href="${item.href}">${item.label}</a>`
  ).join("");

  return `
    <a class="topbar-brand" href="../dashboard/dashboard.html" aria-label="냉동기 중앙통제시스템 — 실시간 현황으로">
      <span class="topbar-logo" aria-hidden="true"></span>
      <span class="topbar-title">
        <span class="topbar-title-sub">남양연구소</span>
        <span class="topbar-title-main">냉동기 중앙통제시스템</span>
      </span>
    </a>
    <nav class="topbar-menu">${menuHtml}</nav>
    <button type="button" class="topbar-approval" id="topbarApprovalBtn" hidden aria-label="결재할 문서">
      ${TB_ICON_APPROVAL}<em class="topbar-approval-count">0</em>
    </button>
    <div class="topbar-user" id="topbarUser">${buildUserHtml(session)}</div>
    <span class="topbar-divider" aria-hidden="true"></span>
    <span class="topbar-clock" id="topbarClock"></span>
  `;
}

function buildUserHtml(session) {
  const profile = (session && session.profile) || {};
  const username = session ? session.username : "";
  const role = session ? session.role : "";
  const name = profile.fullName || username;
  const team = profile.department || "";
  const initial = name ? name.charAt(0) : "?";
  const roleBadge = role ? `<span class="topbar-role ${ROLE_BADGE_CLASS[role] || "tb-role-4"}">${tbEscape(role)}</span>` : "";

  return `
    <button type="button" class="topbar-user-btn" id="topbarUserBtn" aria-haspopup="menu" aria-expanded="false">
      <span class="topbar-avatar" aria-hidden="true">${tbEscape(initial)}</span>
      <span class="topbar-user-text">
        <span class="topbar-user-name">${tbEscape(name)}${roleBadge}</span>
        ${team ? `<span class="topbar-user-team">${tbEscape(team)}</span>` : ""}
      </span>
      <span class="topbar-caret" aria-hidden="true"></span>
    </button>
    <div class="topbar-dropdown" id="topbarDropdown" role="menu" hidden>
      <div class="topbar-dropdown-head">
        <b>${tbEscape(name)}</b>
        <span>${tbEscape([username, role].filter(Boolean).join(" · "))}</span>
      </div>
      <button type="button" class="topbar-dropdown-item" data-action="profile" role="menuitem">${TB_ICON_USER}내 정보</button>
      <button type="button" class="topbar-dropdown-item" data-action="settings" role="menuitem">${TB_ICON_GEAR}설정</button>
      <button type="button" class="topbar-dropdown-item danger" data-action="logout" role="menuitem">${TB_ICON_LOGOUT}로그아웃</button>
    </div>
  `;
}

// 시각은 분까지만 보여주므로 분이 바뀌는 순간에 맞춰 갱신한다
function startClock() {
  const clockEl = document.getElementById("topbarClock");
  if (!clockEl) return;

  const tick = () => {
    const { date, time } = formatTopbarDateTime(new Date());
    clockEl.innerHTML = `${date}<b>${time}</b>`;
  };
  tick();
  const now = new Date();
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
  setTimeout(() => {
    tick();
    setInterval(tick, 60 * 1000);
  }, msToNextMinute);
}

function renderLayout() {
  const topbarEl = document.getElementById("topbar");
  if (!topbarEl) return;

  const session = getSession();
  const activePage = document.body.dataset.page;

  topbarEl.innerHTML = buildTopbarHtml(session, activePage);
  bindUserMenu();
  startClock();

  // 결재 알림 — 스크립트를 안 넣은 화면(로그인 등)에서는 조용히 건너뛴다
  if (typeof startApprovalBadgePolling === "function") {
    document.getElementById("topbarApprovalBtn").addEventListener("click", openApprovalInbox);
    startApprovalBadgePolling();
  }

  // 드롭다운 바깥을 누르거나 Esc를 누르면 닫는다(사용자 영역은 다시 그려질 수 있어 document에 한 번만 건다)
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#topbarUser")) closeUserMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeUserMenu();
  });

  refreshProfile();
}

function bindUserMenu() {
  const btn = document.getElementById("topbarUserBtn");
  const dropdown = document.getElementById("topbarDropdown");
  if (!btn || !dropdown) return;

  btn.addEventListener("click", () => {
    if (dropdown.hidden) openUserMenu();
    else closeUserMenu();
  });
  dropdown.querySelectorAll("[data-action]").forEach((item) => {
    item.addEventListener("click", () => {
      closeUserMenu();
      if (item.dataset.action === "profile") openProfileModal();
      else if (item.dataset.action === "settings") openMyInfoModal();
      else if (item.dataset.action === "logout") openLogoutConfirm();
    });
  });
}

function openUserMenu() {
  const dropdown = document.getElementById("topbarDropdown");
  if (!dropdown) return;
  dropdown.hidden = false;
  document.getElementById("topbarUser").classList.add("open");
  document.getElementById("topbarUserBtn").setAttribute("aria-expanded", "true");
}

function closeUserMenu() {
  const dropdown = document.getElementById("topbarDropdown");
  if (!dropdown || dropdown.hidden) return;
  dropdown.hidden = true;
  document.getElementById("topbarUser").classList.remove("open");
  document.getElementById("topbarUserBtn").setAttribute("aria-expanded", "false");
}

// 사용자 영역만 다시 그린다(성명·소속팀을 새로 받았을 때)
function rerenderUserArea() {
  const el = document.getElementById("topbarUser");
  if (!el) return;
  el.innerHTML = buildUserHtml(getSession());
  bindUserMenu();
}

// /me로 성명·소속팀 등을 받아 세션에 저장한다. 실패해도 로그인 ID로 표시가 유지되므로 조용히 넘어간다.
async function refreshProfile() {
  if (typeof apiFetch !== "function") return;
  try {
    const me = await apiFetch("/api/users/me");
    const session = getSession();
    if (!session || !me) return;
    const profile = {
      id: me.id,
      fullName: me.fullName,
      department: me.department,
      position: me.position,
      phone1: me.phone1,
      phone2: me.phone2,
    };
    const changed = JSON.stringify(profile) !== JSON.stringify(session.profile || null) || me.role !== session.role;
    if (!changed) return;
    saveSession({ ...session, role: me.role, profile });
    rerenderUserArea();
  } catch (err) {
    // 표시만 못 바꿀 뿐 화면 사용에는 지장이 없다
  }
}

// ---------- 로그아웃 확인 ----------

function ensureLayoutModal(id, html) {
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement("div");
  el.id = id;
  el.className = "modal-overlay layout-modal";
  el.hidden = true;
  el.innerHTML = html;
  document.body.appendChild(el);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") el.hidden = true;
  });
  return el;
}

function openLogoutConfirm() {
  const modal = ensureLayoutModal(
    "layoutLogoutModal",
    `
    <div class="modal-box layout-logout-box" role="dialog" aria-modal="true">
      <div class="modal-header layout-modal-header">
        <div>
          <span class="layout-modal-eyebrow">Logout</span>
          <h2 class="layout-modal-title">로그아웃</h2>
        </div>
        <button type="button" class="modal-close-btn" data-close aria-label="닫기">×</button>
      </div>
      <div class="modal-body">로그아웃하시겠습니까?</div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close>취소</button>
        <button type="button" class="btn btn-primary" data-confirm>로그아웃</button>
      </div>
    </div>
  `
  );
  if (!modal.dataset.bound) {
    modal.dataset.bound = "1";
    modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", () => (modal.hidden = true)));
    modal.querySelector("[data-confirm]").addEventListener("click", () => logout());
  }
  modal.hidden = false;
  modal.querySelector("[data-confirm]").focus();
}

// ---------- 내 정보 (읽기 전용) ----------

let layoutEquipmentsCache = null; // 담당장비 이름·지역·시설동 매칭용 — 모달을 여러 번 열어도 한 번만 받는다

function openProfileModal() {
  const modal = ensureLayoutModal(
    "layoutProfileModal",
    `
    <div class="modal-box layout-profile-box" role="dialog" aria-modal="true">
      <div class="modal-header layout-modal-header">
        <div>
          <span class="layout-modal-eyebrow">My Account</span>
          <h2 class="layout-modal-title">내 정보</h2>
        </div>
        <button type="button" class="modal-close-btn" data-close aria-label="닫기">×</button>
      </div>
      <div class="modal-body layout-profile-body">
        <div class="myinfo-profile" id="profileCard"></div>
        <dl class="profile-info" id="profileInfo"></dl>
        <div class="profile-equip-head">담당장비 <em id="profileEquipCount"></em></div>
        <div class="profile-equip" id="profileEquipments"><div class="profile-equip-empty">불러오는 중...</div></div>
        <p class="myinfo-msg error" id="profileMsg" hidden></p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close>닫기</button>
      </div>
    </div>
  `
  );

  if (!modal.dataset.bound) {
    modal.dataset.bound = "1";
    modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", () => (modal.hidden = true)));
  }

  const session = getSession();
  renderProfileCard(session);
  renderProfileInfo(null);
  document.getElementById("profileEquipCount").textContent = "";
  document.getElementById("profileEquipments").innerHTML = `<div class="profile-equip-empty">불러오는 중...</div>`;
  document.getElementById("profileMsg").hidden = true;
  modal.hidden = false;

  loadProfileDetail();
}

async function loadProfileDetail() {
  let me;
  try {
    const [meResult, equipments] = await Promise.all([
      apiFetch("/api/users/me"),
      layoutEquipmentsCache ? Promise.resolve(layoutEquipmentsCache) : apiFetch("/api/equipments"),
    ]);
    me = meResult;
    layoutEquipmentsCache = equipments;
  } catch (err) {
    const msg = document.getElementById("profileMsg");
    msg.textContent = `내 정보를 불러오지 못했습니다. (${err.message})`;
    msg.hidden = false;
    document.getElementById("profileEquipments").innerHTML = "";
    return;
  }

  storeProfile(me);
  renderProfileCard(getSession());
  renderProfileInfo(me);
  renderProfileEquipments(me.equipmentIds || []);
  rerenderUserArea();

  // 신고서는 첨부 id만 있어 파일명을 알려면 메타데이터를 한 번 더 받는다
  if (me.appointmentReportId) {
    try {
      const items = await apiFetch(`/api/attachments?ownerType=AppointmentReport&ownerId=${me.id}`);
      const meta = items && items[0];
      const el = document.getElementById("profileReport");
      if (!el) return;
      if (!meta) {
        el.textContent = "미등록";
        return;
      }
      el.innerHTML = `<button type="button" class="profile-file">${TB_ICON_DOWNLOAD}${tbEscape(meta.fileName)}</button>`;
      el.querySelector("button").addEventListener("click", () => downloadLayoutFile(meta.id, meta.fileName));
    } catch (err) {
      const el = document.getElementById("profileReport");
      if (el) el.textContent = "파일 정보를 불러오지 못했습니다.";
    }
  }
}

function storeProfile(me) {
  const session = getSession();
  if (!session || !me) return;
  saveSession({
    ...session,
    role: me.role,
    profile: { id: me.id, fullName: me.fullName, department: me.department, position: me.position, phone1: me.phone1, phone2: me.phone2 },
  });
}

function renderProfileCard(session) {
  const profile = (session && session.profile) || {};
  const name = profile.fullName || (session && session.username) || "";
  const role = session ? session.role : "";
  // 연락처는 카드 오른쪽에 두 줄로 — 정보가 아직 없으면(첫 표시) "-"
  document.getElementById("profileCard").innerHTML = `
    <span class="topbar-avatar myinfo-avatar" aria-hidden="true">${tbEscape(name.charAt(0) || "?")}</span>
    <div>
      <div class="myinfo-name">${tbEscape(name)}${role ? `<span class="topbar-role ${ROLE_BADGE_CLASS[role] || "tb-role-4"}">${tbEscape(role)}</span>` : ""}</div>
      <div class="myinfo-meta">${tbEscape(session && session.username ? `ID ${session.username}` : "")}</div>
    </div>
    <dl class="profile-phones">
      <div><dt>연락처1</dt><dd>${tbEscape(profile.phone1 || "-")}</dd></div>
      <div><dt>연락처2</dt><dd>${tbEscape(profile.phone2 || "-")}</dd></div>
    </dl>
  `;
}

// me가 없으면(불러오는 중) 칸만 그려 둔다
function renderProfileInfo(me) {
  const v = (value) => (me ? tbEscape(value || "-") : "…");
  const reportHtml = !me ? "…" : me.appointmentReportId ? "불러오는 중..." : "미등록";
  const rows = [
    ["소속팀", v(me && me.department)],
    ["직위", v(me && me.position)],
    ["대직자", v(me && me.backupPersonName)],
    ["법정교육일", v(me && me.legalTrainingDate)],
    ["차기교육일", v(me && me.nextTrainingDate)],
    ["선해임 신고서", `<span id="profileReport">${reportHtml}</span>`],
  ];
  document.getElementById("profileInfo").innerHTML = rows.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join("");
}

// 담당장비 — 지역 → 시설동으로 묶고 시설동마다 장비명을 한 줄로 나열(조직 관리 세부정보와 같은 방식)
function renderProfileEquipments(equipmentIds) {
  const byId = new Map((layoutEquipmentsCache || []).map((e) => [e.id, e]));
  const equipments = equipmentIds.map((id) => byId.get(id)).filter(Boolean);
  document.getElementById("profileEquipCount").textContent = `${equipments.length}대`;
  const el = document.getElementById("profileEquipments");
  if (equipments.length === 0) {
    el.innerHTML = `<div class="profile-equip-empty">담당장비가 없습니다.</div>`;
    return;
  }

  equipments.sort(
    (a, b) =>
      compareRegion(a.region, b.region) ||
      String(a.buildingName).localeCompare(String(b.buildingName), "ko") ||
      String(a.name).localeCompare(String(b.name), "ko")
  );
  const groups = [];
  equipments.forEach((e) => {
    const last = groups[groups.length - 1];
    if (last && last.region === e.region && last.buildingName === e.buildingName) last.names.push(e.name);
    else groups.push({ region: e.region, buildingName: e.buildingName, names: [e.name] });
  });

  let lastRegion = null;
  el.innerHTML = groups
    .map((g) => {
      const regionRow = g.region !== lastRegion ? `<div class="profile-equip-region">${tbEscape(g.region)}</div>` : "";
      lastRegion = g.region;
      return `${regionRow}<div class="profile-equip-row"><b>${tbEscape(g.buildingName)}</b><span>${g.names.map(tbEscape).join(" · ")}</span></div>`;
    })
    .join("");
}

// 첨부 받기 — attachments.js가 없는 페이지에서도 쓰도록 여기서 직접 처리한다
async function downloadLayoutFile(attachmentId, fileName) {
  try {
    const blob = await apiFetchBlob(`/api/attachments/${attachmentId}`);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName || "attachment";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    window.alert(`파일을 받지 못했습니다. (${err.message})`);
  }
}

// ---------- 설정 (연락처·비밀번호 변경) ----------

function openMyInfoModal() {
  const modal = ensureLayoutModal(
    "layoutMyInfoModal",
    `
    <div class="modal-box layout-myinfo-box" role="dialog" aria-modal="true">
      <div class="modal-header layout-modal-header">
        <div>
          <span class="layout-modal-eyebrow">Settings</span>
          <h2 class="layout-modal-title">설정</h2>
        </div>
        <button type="button" class="modal-close-btn" data-close aria-label="닫기">×</button>
      </div>
      <div class="modal-body layout-myinfo-body">
        <section class="myinfo-sec">
          <div class="myinfo-sec-head">
            <h3>연락처</h3>
            <button type="button" class="btn btn-primary myinfo-sec-btn" id="myInfoContactSave">연락처 저장</button>
          </div>
          <div class="myinfo-grid">
            <div class="myinfo-field">
              <label for="myInfoPhone1">연락처1</label>
              <input type="text" id="myInfoPhone1" maxlength="30" />
            </div>
            <div class="myinfo-field">
              <label for="myInfoPhone2">연락처2</label>
              <input type="text" id="myInfoPhone2" maxlength="30" />
            </div>
          </div>
          <p class="myinfo-msg" id="myInfoContactMsg" hidden></p>
        </section>

        <!-- 비밀번호 — 처음엔 버튼만 보이고, 누르면 단계별로 진행한다:
             ① 현재 비밀번호 → ② 새 비밀번호(2번 입력) → ③ 완료 메시지 -->
        <section class="myinfo-sec" id="myInfoPwSection" data-step="idle">
          <div class="myinfo-sec-head">
            <h3>비밀번호</h3>
            <button type="button" class="btn btn-secondary myinfo-sec-btn" id="myInfoPwStart">비밀번호 변경</button>
            <span class="myinfo-steps" id="myInfoPwSteps" aria-hidden="true">
              <span data-step-dot="current">1 현재 비밀번호</span>
              <span data-step-dot="new">2 새 비밀번호</span>
              <span data-step-dot="done">3 완료</span>
            </span>
          </div>

          <div class="myinfo-pw-step" data-pw-step="current">
            <div class="myinfo-field">
              <label for="myInfoPwCurrent">현재 비밀번호</label>
              <input type="password" id="myInfoPwCurrent" autocomplete="current-password" />
            </div>
            <div class="myinfo-pw-actions">
              <button type="button" class="btn btn-secondary" data-pw-cancel>취소</button>
              <button type="button" class="btn btn-primary" id="myInfoPwNext">다음</button>
            </div>
          </div>

          <div class="myinfo-pw-step" data-pw-step="new">
            <div class="myinfo-grid">
              <div class="myinfo-field">
                <label for="myInfoPwNew">새 비밀번호</label>
                <input type="password" id="myInfoPwNew" autocomplete="new-password" />
              </div>
              <div class="myinfo-field">
                <label for="myInfoPwConfirm">새 비밀번호 확인</label>
                <input type="password" id="myInfoPwConfirm" autocomplete="new-password" />
              </div>
            </div>
            <div class="myinfo-pw-actions">
              <button type="button" class="btn btn-secondary" id="myInfoPwBack">이전</button>
              <button type="button" class="btn btn-primary" id="myInfoPwSave">변경</button>
            </div>
          </div>

          <div class="myinfo-pw-step myinfo-pw-done" data-pw-step="done">
            <span class="myinfo-done-icon" aria-hidden="true"></span>
            <div>
              <b>비밀번호를 변경했습니다.</b>
              <p>다음 로그인부터 새 비밀번호를 사용하세요.</p>
            </div>
            <button type="button" class="btn btn-secondary" data-pw-cancel>확인</button>
          </div>

          <p class="myinfo-msg" id="myInfoPwMsg" hidden></p>
        </section>

        <p class="myinfo-hint">본인이 바꿀 수 있는 정보는 연락처와 비밀번호뿐입니다. 성명·소속팀·담당업무 등 다른 정보는 시스템관리자에게 수정을 요청하세요.</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-close>닫기</button>
      </div>
    </div>
  `
  );

  if (!modal.dataset.bound) {
    modal.dataset.bound = "1";
    modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", () => (modal.hidden = true)));
    document.getElementById("myInfoContactSave").addEventListener("click", saveMyContact);
    document.getElementById("myInfoPwStart").addEventListener("click", () => setPasswordStep("current"));
    document.getElementById("myInfoPwNext").addEventListener("click", goPasswordNewStep);
    document.getElementById("myInfoPwBack").addEventListener("click", () => setPasswordStep("current"));
    document.getElementById("myInfoPwSave").addEventListener("click", changeMyPassword);
    modal.querySelectorAll("[data-pw-cancel]").forEach((btn) => btn.addEventListener("click", () => setPasswordStep("idle")));
    // Enter로 다음 단계 / 변경
    document.getElementById("myInfoPwCurrent").addEventListener("keydown", (event) => {
      if (event.key === "Enter") goPasswordNewStep();
    });
    document.getElementById("myInfoPwConfirm").addEventListener("keydown", (event) => {
      if (event.key === "Enter") changeMyPassword();
    });
  }

  setMyInfoMsg("myInfoContactMsg", "");
  setPasswordStep("idle");
  renderMyInfo(getSession());
  modal.hidden = false;

  // 연락처는 다른 곳(관리자)에서 바뀌었을 수 있어 열 때마다 최신 값을 받는다
  apiFetch("/api/users/me")
    .then((me) => {
      if (!me) return;
      storeProfile(me);
      renderMyInfo(getSession());
      rerenderUserArea();
    })
    .catch((err) => setMyInfoMsg("myInfoContactMsg", `내 정보를 불러오지 못했습니다. (${err.message})`, true));
}

function renderMyInfo(session) {
  const profile = (session && session.profile) || {};
  document.getElementById("myInfoPhone1").value = profile.phone1 || "";
  document.getElementById("myInfoPhone2").value = profile.phone2 || "";
}

function setMyInfoMsg(id, text, isError = false) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

async function saveMyContact() {
  const btn = document.getElementById("myInfoContactSave");
  btn.disabled = true;
  try {
    const me = await apiFetch("/api/users/me/contact", {
      method: "PUT",
      body: JSON.stringify({
        phone1: document.getElementById("myInfoPhone1").value.trim(),
        phone2: document.getElementById("myInfoPhone2").value.trim(),
      }),
    });
    const session = getSession();
    if (session && me) {
      saveSession({ ...session, profile: { ...(session.profile || {}), phone1: me.phone1, phone2: me.phone2 } });
      renderMyInfo(getSession());
    }
    setMyInfoMsg("myInfoContactMsg", "연락처를 저장했습니다.");
  } catch (err) {
    setMyInfoMsg("myInfoContactMsg", `저장하지 못했습니다. (${err.message})`, true);
  } finally {
    btn.disabled = false;
  }
}

// 비밀번호 변경 단계: idle(버튼만) → current(현재 비밀번호) → new(새 비밀번호) → done(완료)
// idle로 돌아가거나 모달을 새로 열면 입력값을 모두 지운다.
function setPasswordStep(step) {
  const section = document.getElementById("myInfoPwSection");
  section.dataset.step = step;
  if (step === "idle") {
    ["myInfoPwCurrent", "myInfoPwNew", "myInfoPwConfirm"].forEach((id) => (document.getElementById(id).value = ""));
  }
  if (step === "new") {
    document.getElementById("myInfoPwNew").value = "";
    document.getElementById("myInfoPwConfirm").value = "";
  }
  setMyInfoMsg("myInfoPwMsg", "");
  const focusId = step === "current" ? "myInfoPwCurrent" : step === "new" ? "myInfoPwNew" : null;
  if (focusId) document.getElementById(focusId).focus();
}

// 현재 비밀번호만 확인하는 API가 없어(로그인 API로 확인하면 로그인 이력이 남는다) 여기서는 입력 여부만 보고
// 넘어간다. 실제 확인은 마지막 변경 요청에서 서버가 하고, 틀렸으면 이 단계로 되돌린다.
function goPasswordNewStep() {
  if (!document.getElementById("myInfoPwCurrent").value) {
    setMyInfoMsg("myInfoPwMsg", "현재 비밀번호를 입력하세요.", true);
    return;
  }
  setPasswordStep("new");
}

async function changeMyPassword() {
  const current = document.getElementById("myInfoPwCurrent").value;
  const next = document.getElementById("myInfoPwNew").value;
  const confirmValue = document.getElementById("myInfoPwConfirm").value;

  if (!next) return setMyInfoMsg("myInfoPwMsg", "새 비밀번호를 입력하세요.", true);
  if (next !== confirmValue) return setMyInfoMsg("myInfoPwMsg", "새 비밀번호와 확인이 일치하지 않습니다.", true);

  const btn = document.getElementById("myInfoPwSave");
  btn.disabled = true;
  try {
    await apiFetch("/api/users/me/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    ["myInfoPwCurrent", "myInfoPwNew", "myInfoPwConfirm"].forEach((id) => (document.getElementById(id).value = ""));
    setPasswordStep("done");
  } catch (err) {
    // 현재 비밀번호가 틀리면 서버가 400 "현재 비밀번호가 올바르지 않습니다."를 준다 — 1단계로 되돌린다
    const message = err.message || "비밀번호를 변경하지 못했습니다.";
    if (message.includes("현재 비밀번호")) {
      setPasswordStep("current");
      document.getElementById("myInfoPwCurrent").select();
    }
    setMyInfoMsg("myInfoPwMsg", message, true);
  } finally {
    btn.disabled = false;
  }
}
