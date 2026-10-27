// 장비 관리 — 검사이력 일괄등록 (시안 mokup/inspection_bulk_v1, 사용자 결정 2026-10-27)
//
// 고객사 요청 "여러 장비에 같은 검사이력을 한 번에". 단순하게 간다(사용자 결정):
//   - 선택한 장비마다 같은 검사이력을 한 건씩 **복사해서** 만든다. 첨부파일도 장비마다 따로 올라간다.
//   - 일괄 수정·삭제·보관(일괄 건 목록)은 없다. 만든 뒤에는 각 장비의 "검사이력"에서 일반 이력처럼 다룬다.
//   - 시스템관리자에게만 버튼을 보인다(서버의 검사이력 등록 권한은 원래 "누구나"라 그대로 둔다).
//   - 대상은 철거가 아닌 장비 전체(전체 선택 / 지역·시설동·장비 단위 선택).
// 백엔드 변경 없이 기존 API만 쓴다: POST /api/equipment-inspection-history(32번) + POST /api/attachments(28번).
// 장비마다 따로 요청하므로 중간에 일부만 실패할 수 있다 — 끝나면 결과를 보여주고 실패한 장비만 다시 시도한다.
// 검사이력은 만들어졌는데 첨부만 실패한 장비는 다시 시도할 때 첨부만 올린다(이력이 두 번 생기지 않게).

const BULK_INSPECTION_EXCLUDED_STATUS = "철거";
const BULK_INSPECTION_OWNER_TYPE = "EquipmentInspectionHistory";

const bulkState = {
  phase: "input", // "input"(작성) | "result"(등록 결과)
  selected: new Set(), // 장비 id
  expanded: new Set(), // 펼친 시설동 key
  visibleIds: [], // 지금 목록에 보이는 장비 id — 전체 선택 대상(검색 중이면 검색 결과만)
  files: [], // 고른 첨부(File)
  draft: null, // 등록할 때의 내용 — 다시 시도에 그대로 쓴다
  results: [], // [{ equipment, recordId, error, ok }]
  running: false,
};

const bulkDirty = createDirtyTracker(() => ({
  date: getValue("bkDate"),
  title: getValue("bkTitle"),
  content: getValue("bkContent"),
  notes: getValue("bkNotes"),
  files: bulkState.files.map((f) => f.name + f.size),
  selected: [...bulkState.selected].sort((a, b) => a - b),
}));

function initBulkInspection() {
  const btn = document.getElementById("eqBulkInspectionBtn");
  btn.hidden = getSession()?.role !== "시스템관리자";
  btn.addEventListener("click", openBulkInspection);

  document.getElementById("bkCloseX").addEventListener("click", closeBulkInspection);
  document.getElementById("bkCloseBtn").addEventListener("click", closeBulkInspection);
  document.getElementById("bkSubmitBtn").addEventListener("click", submitBulkInspection);
  document.getElementById("bkRetryBtn").addEventListener("click", retryBulkFailures);
  document.getElementById("bkSearch").addEventListener("input", renderBulkTargets);
  document.getElementById("bkAll").addEventListener("click", toggleBulkAll);
  document.getElementById("bkFileInput").addEventListener("change", (event) => {
    const files = filterFilesWithinSizeLimit([...event.target.files], showBulkError);
    event.target.value = "";
    if (files.length === 0) return;
    hideBulkError();
    bulkState.files.push(...files);
    renderBulkFiles();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("bulkInspectionModal").hidden) closeBulkInspection();
  });
  // 등록이 도는 동안 창을 닫으려 하면 한 번 묻는다 — 일부 장비만 등록된 채 끝난다
  window.addEventListener("beforeunload", (event) => {
    if (!bulkState.running) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

function bulkTargetEquipments() {
  return state.equipments.filter((e) => e.status !== BULK_INSPECTION_EXCLUDED_STATUS);
}

function openBulkInspection() {
  bulkState.phase = "input";
  bulkState.selected = new Set();
  bulkState.expanded = new Set();
  bulkState.files = [];
  bulkState.results = [];
  bulkState.draft = null;
  setValue("bkDate", todayDateString());
  setValue("bkTitle", "");
  setValue("bkContent", "");
  setValue("bkNotes", "");
  setValue("bkSearch", "");
  hideBulkError();
  renderBulkPhase();
  renderBulkFiles();
  renderBulkTargets();
  bulkDirty.capture();
  openModalOverlay("bulkInspectionModal");
  document.getElementById("bkTitle").focus();
}

function closeBulkInspection() {
  if (bulkState.running) return;
  if (bulkState.phase === "input" && !confirmDiscardIfDirty(bulkDirty)) return;
  bulkDirty.reset();
  closeModalOverlay("bulkInspectionModal");
}

function showBulkError(message) {
  const el = document.getElementById("bkError");
  el.textContent = message;
  el.hidden = false;
}

function hideBulkError() {
  document.getElementById("bkError").hidden = true;
}

// 작성 화면 / 결과 화면 전환 — 머리·바닥 버튼도 같이 바꾼다
function renderBulkPhase() {
  const input = bulkState.phase === "input";
  document.getElementById("bkInput").hidden = !input;
  document.getElementById("bkResult").hidden = input;
  document.getElementById("bkSummary").hidden = !input;
  document.getElementById("bkSubmitBtn").hidden = !input;
  const failed = bulkState.results.filter((r) => !r.ok).length;
  document.getElementById("bkRetryBtn").hidden = input || failed === 0;
  document.getElementById("bkCloseBtn").className = `btn ${input ? "btn-secondary" : "btn-primary"}`;
  updateBulkSummary();
}

function updateBulkSummary() {
  const n = bulkState.selected.size;
  document.getElementById("bkSummary").innerHTML = `대상 <b>${n}대</b> · 첨부 ${bulkState.files.length}개`;
  const btn = document.getElementById("bkSubmitBtn");
  btn.textContent = n > 0 ? `${n}대에 등록` : "등록";
  btn.disabled = n === 0;
}

// ---------- 첨부 ----------

function renderBulkFiles() {
  renderAttachmentList(document.getElementById("bkFileList"), {
    pendingFiles: bulkState.files,
    isPending: true,
    onRemovePending: (idx) => {
      bulkState.files.splice(idx, 1);
      renderBulkFiles();
    },
  });
  updateBulkSummary();
}

// ---------- 대상 장비 (지역 · 시설동으로 묶은 체크 목록 — 조직 관리의 담당장비 선택과 같은 모양) ----------

function groupBulkEquipments(equipments) {
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

function renderBulkTargets() {
  const all = bulkTargetEquipments();
  const keyword = getValue("bkSearch").trim();
  const groups = groupBulkEquipments(all);
  const visibleGroups = groups
    .map((g) => {
      const groupMatches = keyword && `${g.region} ${g.buildingName}`.includes(keyword);
      const items = !keyword || groupMatches ? g.items : g.items.filter((e) => String(e.name).includes(keyword));
      return { ...g, visibleItems: items };
    })
    .filter((g) => g.visibleItems.length > 0);
  bulkState.visibleIds = visibleGroups.flatMap((g) => g.visibleItems.map((e) => e.id));

  document.getElementById("bkCount").textContent = `선택 ${bulkState.selected.size}대 / 전체 ${all.length}대`;
  const excluded = state.equipments.length - all.length;
  const excludedEl = document.getElementById("bkExcluded");
  excludedEl.hidden = excluded === 0;
  excludedEl.textContent = `철거 장비 ${excluded}대는 목록에 없습니다.`;
  renderBulkAllToggle(!!keyword);
  updateBulkSummary();

  const el = document.getElementById("bkGroups");
  if (visibleGroups.length === 0) {
    el.innerHTML = `<div class="bk-empty">${keyword ? "검색 결과가 없습니다." : "등록할 수 있는 장비가 없습니다."}</div>`;
    return;
  }
  el.innerHTML = visibleGroups
    .map((g) => {
      const selected = g.items.filter((e) => bulkState.selected.has(e.id)).length;
      const cb = selected === 0 ? "" : selected === g.items.length ? "on" : "part";
      const expanded = !!keyword || bulkState.expanded.has(g.key);
      return `
        <div class="bk-group${expanded ? " expanded" : ""}" data-key="${escapeHtml(g.key)}">
          <div class="bk-group-head">
            <button type="button" class="bk-cb ${cb}" data-act="toggle-group" aria-label="${escapeHtml(g.buildingName)} 전체 선택"></button>
            <button type="button" class="bk-group-name" data-act="expand">
              <span>${escapeHtml(g.region)} · ${escapeHtml(g.buildingName)}</span>
              <em>${selected}/${g.items.length}</em>
              <i class="bk-chevron"></i>
            </button>
          </div>
          <div class="bk-group-items">
            ${g.visibleItems
              .map(
                (e) => `
                  <label class="bk-item">
                    <input type="checkbox" data-equip="${e.id}" ${bulkState.selected.has(e.id) ? "checked" : ""} />
                    <span>${escapeHtml(e.name)}</span>
                  </label>`
              )
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");

  el.querySelectorAll(".bk-group").forEach((groupEl) => {
    const key = groupEl.dataset.key;
    const group = groups.find((g) => g.key === key);
    groupEl.querySelector('[data-act="expand"]').addEventListener("click", () => {
      if (bulkState.expanded.has(key)) bulkState.expanded.delete(key);
      else bulkState.expanded.add(key);
      renderBulkTargets();
    });
    // 시설동 체크: 전부 선택돼 있으면 전부 해제, 아니면 전부 선택
    groupEl.querySelector('[data-act="toggle-group"]').addEventListener("click", () => {
      const allOn = group.items.every((e) => bulkState.selected.has(e.id));
      group.items.forEach((e) => (allOn ? bulkState.selected.delete(e.id) : bulkState.selected.add(e.id)));
      renderBulkTargets();
    });
    groupEl.querySelectorAll("[data-equip]").forEach((input) => {
      input.addEventListener("change", () => {
        const id = Number(input.dataset.equip);
        if (input.checked) bulkState.selected.add(id);
        else bulkState.selected.delete(id);
        renderBulkTargets();
      });
    });
  });
}

function renderBulkAllToggle(searching) {
  const ids = bulkState.visibleIds;
  const selected = ids.filter((id) => bulkState.selected.has(id)).length;
  document.getElementById("bkAllCb").className = `bk-cb ${selected === 0 ? "" : selected === ids.length ? "on" : "part"}`;
  document.getElementById("bkAllLabel").textContent = searching ? "검색 결과 전체" : "전체 선택";
  document.getElementById("bkAll").disabled = ids.length === 0;
}

function toggleBulkAll() {
  const ids = bulkState.visibleIds;
  const allOn = ids.length > 0 && ids.every((id) => bulkState.selected.has(id));
  ids.forEach((id) => (allOn ? bulkState.selected.delete(id) : bulkState.selected.add(id)));
  renderBulkTargets();
}

// ---------- 등록 ----------

async function submitBulkInspection() {
  hideBulkError();
  const draft = {
    date: getValue("bkDate"),
    title: getValue("bkTitle").trim(),
    content: getValue("bkContent").trim(),
    notes: getValue("bkNotes").trim() || null,
  };
  if (!draft.date) return showBulkError("실시일자를 입력하세요.");
  if (!draft.title) return showBulkError("제목을 입력하세요.");
  if (!draft.content) return showBulkError("검사내용을 입력하세요.");
  const targets = bulkTargetEquipments().filter((e) => bulkState.selected.has(e.id));
  if (targets.length === 0) return showBulkError("대상 장비를 선택하세요.");

  const totalBytes = bulkState.files.reduce((n, f) => n + f.size, 0);
  const fileLine = bulkState.files.length
    ? `\n첨부파일 ${bulkState.files.length}개가 장비마다 함께 올라갑니다(약 ${formatFileSize(totalBytes * targets.length)}).`
    : "";
  if (!window.confirm(`선택한 ${targets.length}대에 같은 검사이력을 한 건씩 등록합니다.${fileLine}\n계속할까요?`)) return;

  bulkState.draft = { ...draft, files: bulkState.files.slice() };
  bulkState.results = targets.map((equipment) => ({ equipment, recordId: null, error: null, ok: false }));
  await runBulkInspection(bulkState.results);
}

async function retryBulkFailures() {
  await runBulkInspection(bulkState.results.filter((r) => !r.ok));
}

// 장비마다 차례로 등록한다 — 검사이력을 만들고(이미 만들어졌으면 건너뜀) 첨부를 올린다.
async function runBulkInspection(items) {
  const draft = bulkState.draft;
  const totalBytes = draft.files.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  const label = (filePercent) =>
    `검사이력 일괄등록 중... ${done}/${items.length}대${filePercent === null ? "" : ` · 첨부 ${filePercent}%`} — 창을 닫지 마세요`;

  bulkState.running = true;
  try {
    await withGlobalBusy(async () => {
      for (const item of items) {
        setGlobalBusyLabel(label(null));
        item.error = null;
        try {
          if (!item.recordId) {
            const created = await apiFetch("/api/equipment-inspection-history", {
              method: "POST",
              body: JSON.stringify({ equipmentId: item.equipment.id, date: draft.date, title: draft.title, content: draft.content, notes: draft.notes }),
            });
            item.recordId = created.id;
          }
          let sentBefore = 0;
          for (const file of draft.files) {
            const formData = new FormData();
            formData.append("file", file);
            await apiUploadWithProgress(
              `/api/attachments?ownerType=${BULK_INSPECTION_OWNER_TYPE}&ownerId=${item.recordId}`,
              formData,
              (loaded, total) => setGlobalBusyLabel(label(Math.floor(((sentBefore + (total ? (loaded / total) * file.size : 0)) / totalBytes) * 100)))
            );
            sentBefore += file.size;
          }
          item.ok = true;
        } catch (err) {
          item.ok = false;
          const reason = !err.status ? "서버와 연결이 끊겼습니다." : err.message;
          item.error = item.recordId ? `첨부파일을 올리지 못했습니다(검사이력은 등록됨). ${reason}` : reason;
        }
        done += 1;
      }
    }, { label: label(null) });
  } finally {
    bulkState.running = false;
  }

  bulkDirty.reset();
  bulkState.phase = "result";
  renderBulkResult();
  renderBulkPhase();
}

function renderBulkResult() {
  const total = bulkState.results.length;
  const ok = bulkState.results.filter((r) => r.ok).length;
  const failed = bulkState.results.filter((r) => !r.ok);
  document.getElementById("bkResult").innerHTML = `
    <div class="bk-result-head">
      <span class="bk-result-count">${ok}<small> / ${total}대 등록</small></span>
      ${failed.length ? `<span class="badge badge-warning">${failed.length}대 실패</span>` : `<span class="badge badge-normal">모두 등록</span>`}
    </div>
    <div class="bk-bar"><i style="width:${total ? (ok / total) * 100 : 0}%"></i></div>
    ${
      failed.length
        ? `<div class="bk-fail">
            <h4>등록하지 못한 장비</h4>
            <ul>${failed
              .map((r) => `<li>${escapeHtml(formatLocation(r.equipment))} · <b>${escapeHtml(r.equipment.name)}</b> — ${escapeHtml(r.error || "")}</li>`)
              .join("")}</ul>
          </div>`
        : ""
    }
    <p class="bk-note">등록된 검사이력은 각 장비의 "검사이력"에서 볼 수 있습니다.${failed.length ? " 실패한 장비는 [실패한 장비 다시 시도]로 다시 올릴 수 있습니다." : ""}</p>
  `;
}

document.addEventListener("DOMContentLoaded", initBulkInspection);
