// 일괄 결재 (api-manual.md 72~74번, 2026-09-28)
//
// 상단바 벨 아이콘에 "내가 지금 결재해야 하는 문서 수"를 띄우고, 누르면 팝업에서 문서 그룹별로
// 목록을 보고 한 번에 결재한다. 화면마다 문서를 찾아 들어가던 번거로움을 없애기 위한 기능이다.
//
//   GET  /api/approvals/pending/count  — 배지 숫자(가볍다). 60초마다
//   GET  /api/approvals/pending        — 그룹 + 목록. 팝업을 열 때만
//   POST /api/approvals/bulk           — { docType, ids } → { succeeded, failed[] }
//
// 판정(내 차례인지, 담당 장비인지)은 전부 서버가 한다 — 프론트는 받은 목록을 그대로 보여주고
// 선택한 id만 돌려보낸다. 문서 종류 이름(label)도 서버가 주므로 여기에 한글을 하드코딩하지 않는다.
// 결재 대상이 없는 역할(시스템관리자·일반관리원)은 전 그룹 0건이라 벨 자체가 보이지 않는다.

const APPROVAL_BADGE_POLL_MS = 60000;

const approvalInbox = {
  groups: [], // 72번 응답의 groups
  activeType: null, // 현재 보고 있는 문서 그룹(docType)
  selected: new Set(), // 선택한 문서 id — 그룹을 바꾸면 비운다(한 번에 한 종류만 결재)
  total: 0,
  loading: false,
};

// ---------- 배지 ----------

async function refreshApprovalBadge() {
  const button = document.getElementById("topbarApprovalBtn");
  if (!button) return;
  let count;
  try {
    count = await apiFetch("/api/approvals/pending/count");
  } catch (err) {
    return; // 다음 주기에 재시도 — 배지는 없어도 화면을 쓰는 데 지장이 없다
  }
  approvalInbox.total = count.total ?? 0;
  approvalInbox.byDocType = count.byDocType || {};
  renderApprovalBadge();
}

function renderApprovalBadge() {
  const button = document.getElementById("topbarApprovalBtn");
  if (!button) return;
  const total = approvalInbox.total;
  // 결재할 게 없으면 아예 숨긴다 — 결재 대상이 아닌 역할은 항상 0건이라 벨이 보이지 않는다
  button.hidden = total === 0;
  button.title = `결재할 문서 ${total}건`;
  const badge = button.querySelector(".topbar-approval-count");
  badge.textContent = total > 99 ? "99+" : String(total);
}

function startApprovalBadgePolling() {
  refreshApprovalBadge();
  setInterval(() => {
    // 보이지 않는 탭에서는 굳이 갱신하지 않는다(창을 여러 개 띄워두는 환경이다)
    if (document.visibilityState === "visible") refreshApprovalBadge();
  }, APPROVAL_BADGE_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshApprovalBadge();
  });
}

// ---------- 팝업 ----------

function ensureApprovalModal() {
  let modal = document.getElementById("approvalInboxModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.id = "approvalInboxModal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="modal-box ap-box">
      <div class="modal-header ap-head">
        <div>
          <span class="ap-eyebrow">Approval</span>
          <h2 class="ap-title">일괄 결재</h2>
        </div>
        <span class="ap-head-sub" id="apHeadSub"></span>
        <button type="button" class="modal-close-btn" id="apCloseX" aria-label="닫기">×</button>
      </div>
      <div class="ap-body">
        <div class="ap-groups" id="apGroups"></div>
        <div class="ap-list">
          <div class="ap-list-bar">
            <button type="button" class="ap-check" id="apSelectAll"><span class="ap-box-check"></span>전체 선택</button>
            <span class="ap-count" id="apCount"></span>
          </div>
          <div class="ap-list-scroll" id="apListScroll"></div>
          <div class="ap-foot">
            <span class="ap-foot-info" id="apFootInfo"></span>
            <div class="ap-foot-actions">
              <button type="button" class="btn btn-secondary" id="apCloseBtn">닫기</button>
              <button type="button" class="btn btn-primary" id="apApproveBtn">선택 항목 결재</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector("#apCloseX").addEventListener("click", closeApprovalInbox);
  modal.querySelector("#apCloseBtn").addEventListener("click", closeApprovalInbox);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeApprovalInbox();
  });
  modal.querySelector("#apGroups").addEventListener("click", (event) => {
    const item = event.target.closest("[data-doc-type]");
    if (item) selectApprovalGroup(item.dataset.docType);
  });
  modal.querySelector("#apListScroll").addEventListener("click", (event) => {
    const row = event.target.closest("[data-id]");
    if (row) toggleApprovalItem(Number(row.dataset.id));
  });
  modal.querySelector("#apSelectAll").addEventListener("click", toggleApprovalSelectAll);
  modal.querySelector("#apApproveBtn").addEventListener("click", submitApprovalBulk);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeApprovalInbox();
  });
  return modal;
}

async function openApprovalInbox() {
  const modal = ensureApprovalModal();
  modal.hidden = false;
  const session = getSession();
  const profile = (session && session.profile) || {};
  document.getElementById("apHeadSub").textContent =
    `내 차례인 문서만 보여줍니다 · ${profile.fullName || (session && session.username) || ""}${session && session.role ? `(${session.role})` : ""}`;
  document.getElementById("apListScroll").innerHTML = `<div class="empty-state">불러오는 중...</div>`;
  document.getElementById("apGroups").innerHTML = "";
  await loadApprovalPending();
}

function closeApprovalInbox() {
  const modal = document.getElementById("approvalInboxModal");
  if (modal) modal.hidden = true;
  approvalInbox.selected.clear();
}

async function loadApprovalPending() {
  approvalInbox.loading = true;
  let data;
  try {
    data = await apiFetch("/api/approvals/pending");
  } catch (err) {
    document.getElementById("apListScroll").innerHTML =
      `<div class="empty-state">결재 목록을 불러오지 못했습니다. (${escapeHtml(err.message)})</div>`;
    approvalInbox.loading = false;
    return;
  }
  approvalInbox.loading = false;
  approvalInbox.groups = data.groups || [];
  approvalInbox.total = approvalInbox.groups.reduce((sum, g) => sum + (g.count || 0), 0);
  // 처음 열면 결재할 게 있는 첫 그룹을 보여준다(없으면 첫 그룹)
  const current = approvalInbox.groups.find((g) => g.docType === approvalInbox.activeType);
  if (!current || current.count === 0) {
    const firstWithItems = approvalInbox.groups.find((g) => g.count > 0) || approvalInbox.groups[0];
    approvalInbox.activeType = firstWithItems ? firstWithItems.docType : null;
  }
  approvalInbox.selected.clear();
  renderApprovalBadge();
  renderApprovalGroups();
  renderApprovalList();
}

function renderApprovalGroups() {
  document.getElementById("apGroups").innerHTML =
    `<div class="ap-groups-title">문서 그룹</div>` +
    approvalInbox.groups
      .map(
        (g) => `
        <button type="button" class="ap-group${g.docType === approvalInbox.activeType ? " active" : ""}${g.count === 0 ? " empty" : ""}" data-doc-type="${escapeHtml(g.docType)}">
          ${escapeHtml(g.label)}<em>${g.count}</em>
        </button>
      `
      )
      .join("");
}

function selectApprovalGroup(docType) {
  if (approvalInbox.activeType === docType) return;
  approvalInbox.activeType = docType;
  approvalInbox.selected.clear(); // 결재는 한 번에 한 종류만 보낸다(74번)
  renderApprovalGroups();
  renderApprovalList();
}

function activeApprovalGroup() {
  return approvalInbox.groups.find((g) => g.docType === approvalInbox.activeType) || null;
}

function renderApprovalList() {
  const group = activeApprovalGroup();
  const scroll = document.getElementById("apListScroll");
  const items = group ? group.items || [] : [];

  if (items.length === 0) {
    scroll.innerHTML = `<div class="empty-state">${approvalInbox.total === 0 ? "지금 결재할 문서가 없습니다." : "이 문서 그룹은 결재할 문서가 없습니다."}</div>`;
  } else {
    scroll.innerHTML = `
      <table class="ap-table">
        <colgroup><col style="width: 52px" /><col /><col style="width: 240px" /></colgroup>
        <thead><tr><th></th><th>문서</th><th>일자</th></tr></thead>
        <tbody>
          ${items
            .map((item) => {
              const checked = approvalInbox.selected.has(item.id);
              return `
                <tr data-id="${item.id}" class="${checked ? "selected" : ""}">
                  <td><span class="ap-box-check${checked ? " checked" : ""}">${checked ? "✓" : ""}</span></td>
                  <td>
                    <span class="ap-item-title">${escapeHtml(item.title)}</span>
                    ${item.subtitle ? `<span class="ap-item-sub">${escapeHtml(item.subtitle)}</span>` : ""}
                    ${item.authorName ? `<span class="ap-item-sub">작성자 ${escapeHtml(item.authorName)}</span>` : ""}
                  </td>
                  <td class="ap-item-date">${escapeHtml(item.periodText)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }
  renderApprovalSelectionState();
}

function renderApprovalSelectionState() {
  const group = activeApprovalGroup();
  const items = group ? group.items || [] : [];
  const selectedCount = approvalInbox.selected.size;

  const allCheck = document.querySelector("#apSelectAll .ap-box-check");
  const allSelected = items.length > 0 && selectedCount === items.length;
  allCheck.className = `ap-box-check${allSelected ? " checked" : selectedCount > 0 ? " partial" : ""}`;
  allCheck.textContent = allSelected ? "✓" : "";
  document.getElementById("apSelectAll").disabled = items.length === 0;

  document.getElementById("apCount").innerHTML = group
    ? `${escapeHtml(group.label)} ${items.length}건 중 <b>${selectedCount}건</b> 선택`
    : "";
  document.getElementById("apFootInfo").innerHTML = selectedCount > 0 ? `<b>${selectedCount}건</b> 선택됨` : "결재할 문서를 선택하세요";
  document.getElementById("apApproveBtn").disabled = selectedCount === 0;
}

function toggleApprovalItem(id) {
  if (approvalInbox.selected.has(id)) approvalInbox.selected.delete(id);
  else approvalInbox.selected.add(id);
  renderApprovalList();
}

function toggleApprovalSelectAll() {
  const group = activeApprovalGroup();
  const items = group ? group.items || [] : [];
  if (approvalInbox.selected.size === items.length) approvalInbox.selected.clear();
  else items.forEach((item) => approvalInbox.selected.add(item.id));
  renderApprovalList();
}

// 결재는 건별로 독립 처리되고 일부만 실패할 수 있다(74번) — 결과를 나눠서 알려주고,
// 실패한 것만 목록에 남겨 바로 다시 시도할 수 있게 한다.
async function submitApprovalBulk() {
  const group = activeApprovalGroup();
  if (!group || approvalInbox.selected.size === 0) return;
  const ids = [...approvalInbox.selected];
  if (!window.confirm(`${group.label} ${ids.length}건을 결재합니다. 계속할까요?`)) return;

  let result;
  try {
    result = await withGlobalBusy(
      () => apiFetch("/api/approvals/bulk", { method: "POST", body: JSON.stringify({ docType: group.docType, ids }) }),
      { label: "결재 처리 중..." }
    );
  } catch (err) {
    window.alert(`결재에 실패했습니다. (${err.message})`);
    return;
  }

  const succeeded = result.succeeded || [];
  const failed = result.failed || [];
  if (failed.length > 0) {
    const detail = failed
      .slice(0, 5)
      .map((f) => `· ${f.message}`)
      .join("\n");
    window.alert(`${succeeded.length}건 결재했습니다.\n${failed.length}건은 실패했습니다.\n\n${detail}${failed.length > 5 ? "\n…" : ""}`);
  }

  await loadApprovalPending();
  refreshCurrentPageAfterApproval();
}

// 점검일지·운전일지 화면을 보다가 결재하면 뒤에 있는 달력이 옛 상태로 남는다 — 그 화면이면 다시 불러온다.
function refreshCurrentPageAfterApproval() {
  if (typeof loadCalendar === "function") loadCalendar();
}
