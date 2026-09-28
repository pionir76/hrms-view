// 공지사항 페이지 전용 스크립트 (api-manual.md 51~57번)
//
// 결재가 없는 가장 단순한 문서다 — 교육훈련 일지에서 결재만 뺀 구조라 화면 구성도 동일하게
// 목록 페이지 + 상세 모달로 간다. 목록 API는 필터·페이징이 없어 전체를 한 번에 주고,
// 페이지 나누기는 공통 유틸(common/js/ui.js)로 화면에서 처리한다.
//
// 수정/삭제는 작성자 또는 시스템관리자만 가능하고(canEdit/canDelete로 내려옴),
// 상단 고정(isPinned)은 시스템관리자 전용 별도 엔드포인트로만 바꾼다 — 작성자가 본문을
// 수정할 때 고정 상태가 함께 바뀌지 않도록 백엔드가 PUT 본문에서 아예 뺐다.
// 첨부파일 추가/삭제도 문서 수정 권한과 같은 기준이라 canEdit 하나로 버튼을 제어한다.

const NOTICE_FIELD_IDS = ["ntTitle", "ntContent"];

const state = {
  items: [],
  page: 1,
  selectedId: null,
  isNew: false,
  current: null,
  attachments: [],
  pendingFiles: [], // 신규작성 중(id 없음) 선택한 파일 — 저장 성공 후 한꺼번에 업로드
  canEditSelected: false,
};

const noticeDirty = createDirtyTracker(collectNoticeFormValues);

function initNoticePage() {
  document.getElementById("ntAddNewBtn").addEventListener("click", startNoticeNewDraft);
  document.getElementById("ntModalCloseX").addEventListener("click", closeNoticeModal);
  document.getElementById("ntCancelBtn").addEventListener("click", closeNoticeModal);
  document.getElementById("ntSaveBtn").addEventListener("click", saveNotice);
  document.getElementById("ntDeleteBtn").addEventListener("click", deleteNotice);
  document.getElementById("ntPinBtn").addEventListener("click", toggleNoticePin);
  document.getElementById("ntAttachmentInput").addEventListener("change", (event) => {
    const selected = Array.from(event.target.files);
    event.target.value = ""; // 같은 파일을 다시 선택해도 change가 다시 발생하도록 비워둔다
    const files = filterFilesWithinSizeLimit(selected, showNoticeError);
    if (files.length === 0) return;

    if (state.isNew) {
      state.pendingFiles.push(...files); // 아직 id가 없어 저장 시 한꺼번에 올린다
      renderNoticeAttachments();
    } else if (state.canEditSelected) {
      uploadNoticeAttachments(files);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.getElementById("noticeModal").hidden) closeNoticeModal();
  });

  loadNoticeList();
}

async function loadNoticeList() {
  try {
    await withGlobalBusy(async () => {
      state.items = await apiFetch("/api/notices");
    });
  } catch (err) {
    document.getElementById("ntListBody").innerHTML = `<tr><td colspan="5"><div class="empty-state">불러오지 못했습니다. (${err.message})</div></td></tr>`;
    return;
  }
  renderNoticeList();
}

// 서버와 같은 순서(고정 공지 먼저 → 작성일시 내림차순)로 다시 정렬한다 —
// 새로 등록하거나 고정 상태를 바꾼 뒤에도 순서가 유지되게 하기 위함.
function sortedNoticeItems() {
  return state.items.slice().sort((a, b) => {
    if (!!b.isPinned !== !!a.isPinned) return b.isPinned ? 1 : -1;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });
}

function isSystemAdmin() {
  return getSession()?.role === "시스템관리자";
}

// 서버는 UTC로 주고 화면은 한국시간 날짜로 보여준다
function toKstDateString(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function formatDateTimeKo(dateTimeStr) {
  if (!dateTimeStr) return "-";
  const d = new Date(dateTimeStr);
  if (Number.isNaN(d.getTime())) return dateTimeStr;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderNoticeList() {
  const tbody = document.getElementById("ntListBody");
  const all = sortedNoticeItems();

  if (all.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">등록된 공지사항이 없습니다. "+ 신규작성"으로 추가하세요.</div></td></tr>`;
    renderNoticePager(0);
    return;
  }

  const { pageItems, page } = paginate(all, state.page);
  state.page = page;

  // 고정 공지는 항상 맨 위로 올라와 작성 순서와 어긋나므로 번호를 매기지 않는다(📌로 대신 표시).
  // 나머지는 게시판처럼 최신 글이 가장 큰 번호를 갖는다.
  const normalItems = all.filter((item) => !item.isPinned);

  tbody.innerHTML = pageItems
    .map((item) => {
      const rowNumber = item.isPinned ? "-" : normalItems.length - normalItems.indexOf(item);
      const pinBadge = item.isPinned ? `<span class="nt-pin-badge">📌 고정</span>` : "";
      const clip = item.attachmentCount > 0 ? `<span class="nt-clip">📎 ${item.attachmentCount}</span>` : "-";
      return `
        <tr data-id="${item.id}"${item.isPinned ? ' class="nt-pinned-row"' : ""}>
          <td>${rowNumber}</td>
          <td>${pinBadge}<span class="row-link" data-id="${item.id}">${escapeHtml(item.title) || "-"}</span></td>
          <td>${escapeHtml(item.createdByUserName) || "-"}</td>
          <td>${toKstDateString(item.createdAt) || "-"}</td>
          <td>${clip}</td>
        </tr>
      `;
    })
    .join("");

  // 행 전체가 아니라 제목만 클릭 대상이다(다른 목록 화면과 동일한 규칙)
  tbody.querySelectorAll(".row-link").forEach((el) => {
    el.addEventListener("click", () => openNoticeDetail(el.dataset.id));
  });

  renderNoticePager(all.length);
}

function renderNoticePager(totalCount) {
  renderPager(document.getElementById("ntPager"), {
    total: totalCount,
    page: state.page,
    onChange: (next) => {
      state.page = next;
      renderNoticeList();
    },
  });
}

async function openNoticeDetail(itemId) {
  const item = state.items.find((i) => String(i.id) === String(itemId));
  if (!item) return;

  state.selectedId = item.id;
  state.isNew = false;
  state.current = item;
  state.pendingFiles = [];

  document.getElementById("ntDetailForm").classList.remove("is-new");
  document.getElementById("ntModalError").hidden = true;
  renderNoticeMeta(item);

  fillNoticeForm(item);
  applyNoticePermissions(item);
  openModal();
  noticeDirty.capture(); // 첨부 조회를 기다리는 사이의 입력이 기준값에 섞이지 않게 먼저 잡는다

  await loadNoticeAttachments(item.id);
}

function startNoticeNewDraft() {
  state.selectedId = null;
  state.isNew = true;
  state.current = null;
  state.attachments = [];
  state.pendingFiles = [];
  state.canEditSelected = false;

  document.getElementById("ntDetailForm").classList.add("is-new");
  document.getElementById("ntModalError").hidden = true;
  document.getElementById("ntLockNotice").hidden = true;
  document.getElementById("ntDeleteBtn").hidden = true;
  document.getElementById("ntPinBtn").hidden = true; // 저장돼서 id가 생겨야 고정할 수 있다
  document.getElementById("ntSaveBtn").hidden = false;
  renderNoticeMeta(null);

  fillNoticeForm(null);
  setNoticeFormEditable(true);
  renderNoticeAttachments();
  updateNoticeAttachmentControls();
  openModal();
  noticeDirty.capture();
}

function openModal() {
  document.getElementById("noticeModal").hidden = false;
}

function closeNoticeModal() {
  if (!confirmDiscardIfDirty(noticeDirty)) return;
  noticeDirty.reset();
  document.getElementById("noticeModal").hidden = true;
}

// 작성자/작성일은 표 위에 좌우로 나눠 보여주고, 수정 이력이 있을 때만 폼 아래에 덧붙인다.
// (백엔드 응답에 직책 필드가 없어 작성자는 성명만 표시한다 — api-manual.md 51번)
function renderNoticeMeta(item) {
  document.getElementById("ntMetaAuthor").textContent = item ? `작성자 ${item.createdByUserName}` : "";
  document.getElementById("ntMetaDate").textContent = item ? `작성일 ${formatDateTimeKo(item.createdAt)}` : "";
  document.getElementById("ntAuditInfo").textContent = formatNoticeAuditInfo(item);
}

function formatNoticeAuditInfo(item) {
  if (!item?.updatedByUserName) return "";
  return `수정: ${item.updatedByUserName} · ${formatDateTimeKo(item.updatedAt)}`;
}

function fillNoticeForm(item) {
  setValue("ntTitle", item?.title);
  setValue("ntContent", item?.content);
}

function setValue(id, value) {
  document.getElementById(id).value = value ?? "";
}

function getValue(id) {
  return document.getElementById(id).value;
}

function setNoticeFormEditable(editable) {
  NOTICE_FIELD_IDS.forEach((id) => {
    document.getElementById(id).disabled = !editable;
  });
}

// 수정/삭제 가능 여부는 서버가 계산해 준 canEdit/canDelete를 그대로 따른다.
// 상단 고정은 별도 권한(시스템관리자)이라 역할로 판단한다 — 응답에 해당 플래그가 없다.
function applyNoticePermissions(item) {
  const canEdit = item.canEdit !== false;
  state.canEditSelected = canEdit;

  setNoticeFormEditable(canEdit);
  document.getElementById("ntSaveBtn").hidden = !canEdit;
  document.getElementById("ntDeleteBtn").hidden = item.canDelete !== true;

  const notice = document.getElementById("ntLockNotice");
  notice.hidden = canEdit;
  notice.textContent = "작성자 본인 또는 시스템관리자만 수정할 수 있습니다.";

  renderNoticePinToggle(item);
  updateNoticeAttachmentControls();
}

// 상단 고정 토글 — 켜짐/꺼짐이 아이콘·문구·색으로 모두 드러나게 한다
function renderNoticePinToggle(item) {
  const pinBtn = document.getElementById("ntPinBtn");
  const pinned = !!item.isPinned;

  pinBtn.hidden = !isSystemAdmin();
  pinBtn.classList.toggle("active", pinned);
  pinBtn.setAttribute("aria-pressed", String(pinned));
  pinBtn.title = pinned ? "클릭하면 상단 고정을 해제합니다" : "클릭하면 목록 맨 위에 고정합니다";
  document.getElementById("ntPinIcon").textContent = pinned ? "📌" : "📍";
  document.getElementById("ntPinLabel").textContent = pinned ? "상단 고정됨" : "상단 고정";
}

function collectNoticeFormValues() {
  return {
    title: getValue("ntTitle").trim(),
    content: getValue("ntContent").trim(),
    // 신규작성 중 선택해둔(아직 안 올라간) 파일도 dirty 판정에 포함 — 파일만 고르고 닫으면 사라지기 때문
    pendingFileCount: state.isNew ? state.pendingFiles.length : 0,
  };
}

function noticeSaveErrorMessage(err) {
  if (err.status === 403) return "수정 권한이 없습니다. 작성자 본인 또는 시스템관리자만 수정할 수 있습니다.";
  return `저장하지 못했습니다. (${err.message})`;
}

async function saveNotice() {
  const values = collectNoticeFormValues();
  if (!values.title) {
    showNoticeError("제목은 필수입니다.");
    return;
  }
  if (!window.confirm(state.isNew ? "등록하시겠습니까?" : "저장하시겠습니까?")) return;

  document.getElementById("ntModalError").hidden = true;
  const payload = { title: values.title, content: values.content || null };
  // 저장에 성공하면 모달을 닫는데, 첨부 업로드만 실패한 경우엔 안내를 봐야 하므로 열어둔다
  let keepModalOpen = false;

  try {
    await withGlobalBusy(async () => {
      if (state.isNew) {
        setGlobalBusyLabel("저장 중...");
        const created = await apiFetch("/api/notices", { method: "POST", body: JSON.stringify(payload) });
        state.items.push(created);
        state.isNew = false;
        state.selectedId = created.id;
        state.current = created;
        document.getElementById("ntDetailForm").classList.remove("is-new");
        renderNoticeMeta(created);
        applyNoticePermissions(created);

        // 신규작성 중 미리 선택해둔 파일이 있으면, 방금 생긴 id로 한꺼번에 올린다.
        // 공지 저장 자체는 이미 성공했으므로 업로드 실패는 별도 메시지로 구분한다.
        const pendingFiles = state.pendingFiles;
        state.pendingFiles = [];
        if (pendingFiles.length > 0) {
          try {
            await uploadAttachments("Notice", created.id, pendingFiles);
            await loadNoticeAttachments(created.id);
          } catch (uploadErr) {
            showNoticeError(`공지는 저장되었지만 첨부파일 업로드에 실패했습니다. (${uploadErr.message})`);
            keepModalOpen = true;
          }
        } else {
          state.attachments = [];
          renderNoticeAttachments();
        }
      } else {
        const updated = await apiFetch(`/api/notices/${state.selectedId}`, { method: "PUT", body: JSON.stringify(payload) });
        const idx = state.items.findIndex((i) => String(i.id) === String(state.selectedId));
        if (idx !== -1) state.items[idx] = updated;
        state.current = updated;
        renderNoticeMeta(updated);
        applyNoticePermissions(updated);
      }
      noticeDirty.capture();
      renderNoticeList();
    });

    if (!keepModalOpen) {
      noticeDirty.reset();
      document.getElementById("noticeModal").hidden = true;
    }
  } catch (err) {
    showNoticeError(noticeSaveErrorMessage(err));
  }
}

async function deleteNotice() {
  if (!state.selectedId) return;
  if (!window.confirm("삭제하시겠습니까? 첨부된 파일도 함께 삭제됩니다.")) return;

  try {
    await withGlobalBusy(async () => {
      await apiFetch(`/api/notices/${state.selectedId}`, { method: "DELETE" });
      state.items = state.items.filter((i) => String(i.id) !== String(state.selectedId));
      noticeDirty.reset();
      document.getElementById("noticeModal").hidden = true;
      renderNoticeList();
    });
  } catch (err) {
    const message = err.status === 403 ? "삭제 권한이 없습니다. 작성자 본인 또는 시스템관리자만 삭제할 수 있습니다." : `삭제하지 못했습니다. (${err.message})`;
    showNoticeError(message);
  }
}

// 상단 고정/해제 — 시스템관리자 전용 별도 엔드포인트. 응답은 갱신된 공지 전체라
// 그것으로 목록과 버튼 상태를 다시 맞춘다.
async function toggleNoticePin() {
  const item = state.current;
  if (!item) return;

  const action = item.isPinned ? "unpin" : "pin";
  if (!window.confirm(item.isPinned ? "상단 고정을 해제하시겠습니까?" : "이 공지를 상단에 고정하시겠습니까?")) return;

  try {
    const updated = await withGlobalBusy(() => apiFetch(`/api/notices/${item.id}/${action}`, { method: "POST" }));
    const idx = state.items.findIndex((i) => String(i.id) === String(updated.id));
    if (idx !== -1) state.items[idx] = updated;
    state.current = updated;
    applyNoticePermissions(updated);
    renderNoticeList();
  } catch (err) {
    const message = err.status === 403 ? "시스템관리자만 상단 고정을 바꿀 수 있습니다." : `처리하지 못했습니다. (${err.message})`;
    showNoticeError(message);
  }
}

function showNoticeError(message) {
  const el = document.getElementById("ntModalError");
  el.textContent = message;
  el.hidden = false;
}

// ---------- 첨부파일 (Attachment API, ownerType=Notice) ----------
//
// 신규작성(저장 전, id 없음) 상태에서는 올릴 곳(ownerId)이 없어 pendingFiles에 담아뒀다가
// 저장 성공 후 한꺼번에 올린다. 첨부 추가/삭제 권한은 문서 수정 권한과 같아서(서버도 동일하게
// 검사한다) canEdit 하나로 버튼을 제어한다.

function updateNoticeAttachmentControls() {
  const canAttach = state.isNew || state.canEditSelected;
  document.getElementById("ntAttachmentUploadLabel").hidden = !canAttach;
  document.getElementById("ntAttachmentLimitHint").hidden = !canAttach;
  document.getElementById("ntAttachmentNewNotice").hidden = !state.isNew;
}

async function loadNoticeAttachments(itemId) {
  try {
    state.attachments = await fetchAttachments("Notice", itemId);
  } catch (err) {
    state.attachments = [];
  }
  renderNoticeAttachments();
}

function renderNoticeAttachments() {
  renderAttachmentList(document.getElementById("ntAttachmentList"), {
    items: state.attachments,
    pendingFiles: state.pendingFiles,
    isPending: state.isNew,
    canModify: state.canEditSelected,
    onDownload: downloadNoticeAttachment,
    onDelete: deleteNoticeAttachment,
    onRemovePending: (idx) => {
      state.pendingFiles.splice(idx, 1);
      renderNoticeAttachments();
    },
  });
}

async function uploadNoticeAttachments(files) {
  const itemId = state.selectedId;
  if (!itemId) return;
  document.getElementById("ntModalError").hidden = true;

  try {
    await withGlobalBusy(async () => {
      await uploadAttachments("Notice", itemId, files);
      await loadNoticeAttachments(itemId);
      await refreshNoticeAttachmentCount();
    });
  } catch (err) {
    const message = err.status === 403 ? "첨부파일을 추가할 권한이 없습니다." : `첨부파일 업로드에 실패했습니다. (${err.message})`;
    showNoticeError(message);
  }
}

async function downloadNoticeAttachment(attachmentId) {
  try {
    const meta = state.attachments.find((a) => String(a.id) === String(attachmentId));
    await downloadAttachment(attachmentId, meta?.fileName);
  } catch (err) {
    showNoticeError(`파일을 불러오지 못했습니다. (${err.message})`);
  }
}

async function deleteNoticeAttachment(attachmentId) {
  if (!window.confirm("이 첨부파일을 삭제하시겠습니까?")) return;
  try {
    await withGlobalBusy(async () => {
      await deleteAttachment(attachmentId);
      await loadNoticeAttachments(state.selectedId);
      await refreshNoticeAttachmentCount();
    });
  } catch (err) {
    const message = err.status === 403 ? "첨부파일을 삭제할 권한이 없습니다." : `삭제하지 못했습니다. (${err.message})`;
    showNoticeError(message);
  }
}

// 첨부 개수는 서버가 공지에 같이 실어주는 값이라, 올리거나 지운 뒤 그 공지를 다시 조회해
// 목록의 클립 표시를 맞춘다.
async function refreshNoticeAttachmentCount() {
  try {
    const updated = await apiFetch(`/api/notices/${state.selectedId}`);
    const idx = state.items.findIndex((i) => String(i.id) === String(state.selectedId));
    if (idx !== -1) state.items[idx] = updated;
    state.current = updated;
    renderNoticeList();
  } catch (err) {
    // 실패해도 무시 — 클립 개수 표시만 갱신 안 될 뿐, 실제 데이터는 이미 반영됨
  }
}

document.addEventListener("DOMContentLoaded", initNoticePage);
