// 교육훈련 일지 페이지 전용 스크립트 (api-manual.md 43~50번)
//
// 다른 결재 문서(점검/운전/수리일지)와 달리 장비에 매달리지 않는 전사 문서다 — equipmentId가
// 없고, 목록 API도 필터 없이 전체를 performedAt 내림차순으로 돌려준다. 그래서 장비 선택
// 없이 목록 페이지 하나로 구성하고, 항목을 누르면 상세 모달을 띄운다.
//
// 결재는 안전관리원(level1)이 항상 "해당없음"이라 실제 승인은 책임자 → 총괄자 2단계다.
// 이 문서만의 예외로 **담당 장비를 검사하지 않고 역할만으로** 승인 권한을 판정한다.
// 한 단계라도 승인되면 문서 수정은 물론 **첨부파일 추가/삭제까지 막힌다(409)** — 그 판정
// 결과가 응답의 canEdit/canDelete이므로 프론트는 이 값만 보고 버튼을 노출한다.
//
// 일시는 날짜만 입력받고(사용자 결정) 시각은 한국시간 0시로 보낸다. 서버는 UTC로 정규화해
// 저장하고 응답도 UTC라, 화면에 보일 때 다시 KST 날짜로 바꾼다.

// 결재 바는 common/js/approval.js, 첨부파일은 common/js/attachments.js를 쓴다.
const TRAINING_FIELD_IDS = ["trTitle", "trPerformedAt", "trLocation", "trInstructor", "trContent", "trAttendees"];

// 페이지 나누기는 공통 유틸(common/js/ui.js의 paginate/renderPager, 한 페이지 LIST_PAGE_SIZE건)을 쓴다

// 이 문서유형은 level1(안전관리원)이 항상 "해당없음"이라, 저장 전 결재란도 그 모양으로 보여준다
const TRAINING_EMPTY_APPROVAL = {
  level1: { status: "NotApplicable" },
  level2: { status: "Pending" },
  level3: { status: "Pending" },
};

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

const trainingDirty = createDirtyTracker(collectTrainingFormValues);

function initTrainingPage() {
  document.getElementById("trAddNewBtn").addEventListener("click", startTrainingNewDraft);
  document.getElementById("trModalCloseX").addEventListener("click", closeTrainingModal);
  document.getElementById("trCancelBtn").addEventListener("click", closeTrainingModal);
  document.getElementById("trSaveBtn").addEventListener("click", saveTraining);
  document.getElementById("trDeleteBtn").addEventListener("click", deleteTraining);
  document.getElementById("trPdfBtn").addEventListener("click", exportTrainingPdf);
  document.getElementById("trResetApprovalsBtn").addEventListener("click", resetTrainingApprovals);
  document.getElementById("trAttachmentInput").addEventListener("change", (event) => {
    const selected = Array.from(event.target.files);
    event.target.value = ""; // 같은 파일을 다시 선택해도 change가 다시 발생하도록 비워둔다
    const files = filterFilesWithinSizeLimit(selected, showTrainingError);
    if (files.length === 0) return;

    if (state.isNew) {
      state.pendingFiles.push(...files); // 아직 id가 없어 저장 시 한꺼번에 올린다
      renderTrainingAttachments();
    } else if (state.canEditSelected) {
      uploadTrainingAttachments(files);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || isApprovalInboxOpen()) return; // 결재 알림 창이 위에 있으면 그 창만 닫힌다
    if (!document.getElementById("trainingModal").hidden) closeTrainingModal();
  });

  loadTrainingList();
}

async function loadTrainingList() {
  try {
    await withGlobalBusy(async () => {
      state.items = await apiFetch("/api/training-logs");
    });
  } catch (err) {
    document.getElementById("trListBody").innerHTML = `<tr><td colspan="7"><div class="empty-state">불러오지 못했습니다. (${err.message})</div></td></tr>`;
    return;
  }
  renderTrainingList();
}

// 서버도 performedAt 내림차순으로 주지만, 새로 등록한 항목을 끼워넣은 뒤에도 순서가 유지되도록 다시 정렬한다
function sortedTrainingItems() {
  return state.items.slice().sort((a, b) => (b.performedAt || "").localeCompare(a.performedAt || ""));
}

// 이 문서유형은 level1(안전관리원)이 항상 "해당없음"이라 실제 단계는 책임자 → 총괄자 2개다
function trainingApprovalStatus(item) {
  // 전결·해당없음도 "그 단계는 끝난 것"이라 isApprovalLevelDone으로 판정한다 — 직접 "Approved"만
  // 비교하면 문서유형 설정이 바뀌었을 때 목록이 영영 "대기"로 남는다(approval.js 참고).
  if (isApprovalComplete(item)) return { label: "완료", className: "badge-normal" };
  if (isApprovalLevelDone(item.level2)) return { label: "총괄자 결재 대기", className: "badge-warning" };
  return { label: "책임자 결재 대기", className: "badge-muted" };
}

// 서버는 UTC로 주고(예: 2026-09-15T15:00:00+00:00) 화면은 한국시간 날짜로 보여준다
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

function renderTrainingList() {
  const tbody = document.getElementById("trListBody");
  const all = sortedTrainingItems();

  if (all.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">등록된 교육훈련 일지가 없습니다. "+ 신규작성"으로 추가하세요.</div></td></tr>`;
    renderTrainingPager(0);
    return;
  }

  const { pageItems, page, start } = paginate(all, state.page);
  state.page = page;

  tbody.innerHTML = pageItems
    .map((item, i) => {
      const status = trainingApprovalStatus(item);
      // 순번은 게시판처럼 전체 기준 내림차순 — 최신 글이 가장 큰 번호를 갖는다
      const rowNumber = all.length - (start + i);
      return `
        <tr data-id="${item.id}">
          <td>${rowNumber}</td>
          <td><span class="row-link" data-id="${item.id}">${escapeHtml(item.title) || "-"}</span></td>
          <td>${escapeHtml(item.createdByUserName) || "-"}</td>
          <td>${toKstDateString(item.performedAt) || "-"}</td>
          <td><span class="badge ${status.className}">${status.label}</span></td>
        </tr>
      `;
    })
    .join("");

  // 행 전체가 아니라 제목만 클릭 대상이다(장비 관리 목록과 동일한 규칙)
  tbody.querySelectorAll(".row-link").forEach((el) => {
    el.addEventListener("click", () => openTrainingDetail(el.dataset.id));
  });

  renderTrainingPager(all.length);
}

function renderTrainingPager(totalCount) {
  renderPager(document.getElementById("trPager"), {
    total: totalCount,
    page: state.page,
    onChange: (next) => {
      state.page = next;
      renderTrainingList();
    },
  });
}

async function openTrainingDetail(itemId) {
  const item = state.items.find((i) => String(i.id) === String(itemId));
  if (!item) return;

  state.selectedId = item.id;
  state.isNew = false;
  state.current = item;
  state.pendingFiles = [];

  document.getElementById("trDetailForm").classList.remove("is-new");
  document.getElementById("trModalError").hidden = true;
  document.getElementById("trAuditInfo").textContent = formatTrainingAuditInfo(item);

  fillTrainingForm(item);
  renderTrainingApprovalBar();
  applyTrainingPermissions(item);
  openModal();
  trainingDirty.capture(); // 첨부 조회를 기다리는 사이의 입력이 기준값에 섞이지 않게 먼저 잡는다

  await loadTrainingAttachments(item.id);
}

function startTrainingNewDraft() {
  state.selectedId = null;
  state.isNew = true;
  state.current = null;
  state.attachments = [];
  state.pendingFiles = [];
  state.canEditSelected = false;

  document.getElementById("trDetailForm").classList.add("is-new");
  document.getElementById("trModalError").hidden = true;
  document.getElementById("trLockNotice").hidden = true;
  document.getElementById("trDeleteBtn").hidden = true;
  document.getElementById("trResetApprovalsBtn").hidden = true;
  document.getElementById("trPdfBtn").hidden = true; // 저장 전 문서는 PDF 대상이 아니다
  document.getElementById("trSaveBtn").hidden = false;
  document.getElementById("trAuditInfo").textContent = "";

  fillTrainingForm(null);
  setTrainingFormEditable(true);
  renderTrainingApprovalBar(); // 저장 전에도 같은 결재란을 보여준다(결재 버튼 없이 "대기"만)
  renderTrainingAttachments();
  updateTrainingAttachmentControls();
  openModal();
  trainingDirty.capture();
}

function openModal() {
  document.getElementById("trainingModal").hidden = false;
}

function closeTrainingModal() {
  if (!confirmDiscardIfDirty(trainingDirty)) return;
  trainingDirty.reset();
  document.getElementById("trainingModal").hidden = true;
}

function formatTrainingAuditInfo(item) {
  const created = `등록: ${item.createdByUserName} · ${formatDateTimeKo(item.createdAt)}`;
  if (!item.updatedByUserName) return created;
  return `${created} / 수정: ${item.updatedByUserName} · ${formatDateTimeKo(item.updatedAt)}`;
}

function fillTrainingForm(item) {
  setValue("trTitle", item?.title);
  setValue("trPerformedAt", toKstDateString(item?.performedAt));
  setValue("trLocation", item?.location);
  setValue("trInstructor", item?.instructor);
  setValue("trContent", item?.content);
  setValue("trAttendees", item?.attendees);
}

function setValue(id, value) {
  document.getElementById(id).value = value ?? "";
}

function getValue(id) {
  return document.getElementById(id).value;
}

function setTrainingFormEditable(editable) {
  TRAINING_FIELD_IDS.forEach((id) => {
    document.getElementById(id).disabled = !editable;
  });
}

// 수정/삭제 가능 여부는 서버가 계산해 준 canEdit/canDelete를 그대로 따른다.
// 못 고치는 이유는 둘 중 하나라 안내 문구를 구분한다: 결재가 시작됐거나(409), 남의 글이거나(403).
function applyTrainingPermissions(item) {
  const canEdit = item.canEdit !== false;
  state.canEditSelected = canEdit;

  setTrainingFormEditable(canEdit);
  document.getElementById("trSaveBtn").hidden = !canEdit;
  document.getElementById("trDeleteBtn").hidden = item.canDelete !== true;

  const notice = document.getElementById("trLockNotice");
  notice.hidden = canEdit;
  notice.textContent = isApprovalStarted(item)
    ? "결재가 진행된 문서는 수정·첨부 변경을 할 수 없습니다. 시스템관리자가 결재를 리셋하면 다시 수정할 수 있습니다."
    : "작성자 본인 또는 시스템관리자만 수정할 수 있습니다.";

  const isSystemAdmin = getSession()?.role === "시스템관리자";
  document.getElementById("trResetApprovalsBtn").hidden = !(isSystemAdmin && isApprovalStarted(item));

  // PDF는 결재가 끝난 문서만(사용자 결정 2026-09-29) — 버튼은 보이되 잠가서 기능이 있음을 알린다
  const pdfBtn = document.getElementById("trPdfBtn");
  const complete = isApprovalComplete(item);
  pdfBtn.hidden = false;
  pdfBtn.disabled = !complete;
  pdfBtn.title = complete ? "" : "결재가 완료된 문서만 PDF로 저장할 수 있습니다";
  updateTrainingAttachmentControls();
}

function collectTrainingFormValues() {
  return {
    title: getValue("trTitle").trim(),
    performedAt: getValue("trPerformedAt"),
    location: getValue("trLocation").trim(),
    instructor: getValue("trInstructor").trim(),
    content: getValue("trContent").trim(),
    attendees: getValue("trAttendees").trim(),
    // 신규작성 중 선택해둔(아직 안 올라간) 파일도 dirty 판정에 포함 — 파일만 고르고 닫으면 사라지기 때문
    pendingFileCount: state.isNew ? state.pendingFiles.length : 0,
  };
}

function buildTrainingPayload(values) {
  return {
    title: values.title,
    // 날짜만 입력받으므로 시각은 한국시간 0시로 보낸다 — 서버가 UTC로 정규화해 저장한다
    performedAt: `${values.performedAt}T00:00:00+09:00`,
    location: values.location || null,
    instructor: values.instructor || null,
    content: values.content || null,
    attendees: values.attendees || null,
  };
}

function trainingSaveErrorMessage(err) {
  if (err.status === 403) return "수정 권한이 없습니다. 작성자 본인 또는 시스템관리자만 수정할 수 있습니다.";
  if (err.status === 409) return "결재가 진행된 문서는 수정할 수 없습니다. 시스템관리자가 결재를 리셋해야 합니다.";
  return `저장하지 못했습니다. (${err.message})`;
}

async function saveTraining() {
  const values = collectTrainingFormValues();
  if (!values.title || !values.performedAt) {
    showTrainingError("제목과 일시는 필수입니다.");
    return;
  }
  if (!window.confirm(state.isNew ? "등록하시겠습니까?" : "저장하시겠습니까?")) return;

  document.getElementById("trModalError").hidden = true;
  const payload = buildTrainingPayload(values);
  // 저장에 성공하면 모달을 닫는데, 첨부 업로드만 실패한 경우엔 안내를 봐야 하므로 열어둔다
  let keepModalOpen = false;

  try {
    await withGlobalBusy(async () => {
      if (state.isNew) {
        setGlobalBusyLabel("저장 중...");
        const created = await apiFetch("/api/training-logs", { method: "POST", body: JSON.stringify(payload) });
        state.items.push(created);
        state.isNew = false;
        state.selectedId = created.id;
        state.current = created;
        document.getElementById("trDetailForm").classList.remove("is-new");
        document.getElementById("trAuditInfo").textContent = formatTrainingAuditInfo(created);
        renderTrainingApprovalBar();
        applyTrainingPermissions(created);

        // 신규작성 중 미리 선택해둔 파일이 있으면, 방금 생긴 id로 한꺼번에 올린다.
        // 레코드 저장 자체는 이미 성공했으므로 업로드 실패는 별도 메시지로 구분한다.
        const pendingFiles = state.pendingFiles;
        state.pendingFiles = [];
        if (pendingFiles.length > 0) {
          try {
            await uploadAttachments("TrainingLog", created.id, pendingFiles);
            await loadTrainingAttachments(created.id);
          } catch (uploadErr) {
            showTrainingError(`일지는 저장되었지만 첨부파일 업로드에 실패했습니다. (${uploadErr.message})`);
            keepModalOpen = true;
          }
        } else {
          state.attachments = [];
          renderTrainingAttachments();
        }
      } else {
        const updated = await apiFetch(`/api/training-logs/${state.selectedId}`, { method: "PUT", body: JSON.stringify(payload) });
        const idx = state.items.findIndex((i) => String(i.id) === String(state.selectedId));
        if (idx !== -1) state.items[idx] = updated;
        state.current = updated;
        document.getElementById("trAuditInfo").textContent = formatTrainingAuditInfo(updated);
        applyTrainingPermissions(updated);
      }
      trainingDirty.capture();
      renderTrainingList();
    });

    if (!keepModalOpen) {
      trainingDirty.reset();
      document.getElementById("trainingModal").hidden = true;
    }
  } catch (err) {
    showTrainingError(trainingSaveErrorMessage(err));
  }
}

async function deleteTraining() {
  if (!state.selectedId) return;
  if (!window.confirm("삭제하시겠습니까? 첨부된 파일도 함께 삭제됩니다.")) return;

  try {
    await withGlobalBusy(async () => {
      await apiFetch(`/api/training-logs/${state.selectedId}`, { method: "DELETE" });
      state.items = state.items.filter((i) => String(i.id) !== String(state.selectedId));
      trainingDirty.reset();
      document.getElementById("trainingModal").hidden = true;
      renderTrainingList();
    });
  } catch (err) {
    const message = err.status === 403 ? "삭제 권한이 없습니다. (결재가 진행된 문서는 시스템관리자만 삭제할 수 있습니다.)" : `삭제하지 못했습니다. (${err.message})`;
    showTrainingError(message);
  }
}

function showTrainingError(message) {
  const el = document.getElementById("trModalError");
  el.textContent = message;
  el.hidden = false;
}

// ---------- PDF 저장 (common/js/pdf-export.js) ----------
//
// 결재 완료 문서는 수정이 막혀 있으므로 화면 입력칸이 아니라 저장된 문서(state.current)로 만든다.
// 첨부 목록은 모달을 연 직후 비동기로 받아 오므로, 누른 시점에 다시 받아 빠짐없이 넣는다.

async function exportTrainingPdf() {
  const item = state.current;
  if (!item || !isApprovalComplete(item)) return;

  let attachments = state.attachments;
  try {
    attachments = await fetchAttachments("TrainingLog", item.id);
  } catch (err) {
    // 다시 받기 실패 시 화면에 떠 있는 목록으로 대신한다
  }

  // 결재란은 화면과 같은 공통 모듈로 그리고, 조작 버튼(취소)만 걷어낸다
  const approvalEl = document.createElement("div");
  approvalEl.className = "approval-bar";
  renderApprovalBar(approvalEl, item, { allowApprove: false, emptyDoc: TRAINING_EMPTY_APPROVAL });
  approvalEl.querySelectorAll("button").forEach((btn) => btn.remove());

  const performedAt = toKstDateString(item.performedAt);
  const text = (value) => escapeHtml(value ?? "");
  const attachmentHtml = attachments.length
    ? `<ul>${attachments
        .map((a) => `<li>${text(a.fileName)}<span>${formatFileSize(a.sizeBytes)}</span></li>`)
        .join("")}</ul>`
    : `<ul><li>없음</li></ul>`;

  printPdfDocument({
    fileName: pdfSafeFileName(["교육훈련일지", performedAt, item.title]),
    html: `
      <div class="pdf-doc">
        <div class="pdf-head">
          <h1 class="pdf-title"><small>TRAINING</small>교육훈련 일지</h1>
          ${approvalEl.outerHTML}
        </div>
        <table class="pdf-table">
          <colgroup><col style="width:16%" /><col style="width:34%" /><col style="width:16%" /><col style="width:34%" /></colgroup>
          <tbody>
            <tr><th>제목</th><td colspan="3">${text(item.title)}</td></tr>
            <tr><th>일시</th><td>${text(performedAt)}</td><th>장소</th><td>${text(item.location)}</td></tr>
            <tr><th>강사</th><td colspan="3">${text(item.instructor)}</td></tr>
            <tr class="pdf-row-free"><th>교육내용</th><td colspan="3" class="pdf-tall">${text(item.content)}</td></tr>
            <tr class="pdf-row-free"><th>참석자 명단</th><td colspan="3">${text(item.attendees)}</td></tr>
          </tbody>
        </table>
        <div class="pdf-attach">
          <div class="pdf-attach-title">첨부파일 (${attachments.length})</div>
          ${attachmentHtml}
        </div>
        <div class="pdf-foot">
          <span>${text(formatTrainingAuditInfo(item))}</span>
          <span>${text(pdfPrintedByText())}</span>
        </div>
      </div>
    `,
  });
}

// ---------- 결재 (그리기는 common/js/approval.js, API 호출만 여기서) ----------

function renderTrainingApprovalBar() {
  renderApprovalBar(document.getElementById("trApprovalBar"), state.current, {
    allowApprove: state.current !== null, // 저장 전에는 문서 id가 없어 결재할 수 없다
    emptyDoc: TRAINING_EMPTY_APPROVAL,
    onApprove: approveTrainingLevel,
    onCancel: cancelTrainingApproval,
  });
}

// 승인/취소/리셋 응답은 전부 갱신된 문서 전체라, 결재 바뿐 아니라 수정 잠금과 목록까지
// 이 응답 하나로 다시 맞춘다.
function applyTrainingApprovalUpdate(updated) {
  state.current = updated;
  const idx = state.items.findIndex((i) => String(i.id) === String(updated.id));
  if (idx !== -1) state.items[idx] = updated;
  renderTrainingApprovalBar();
  applyTrainingPermissions(updated);
  renderTrainingAttachments();
  renderTrainingList();
}

async function approveTrainingLevel() {
  if (!window.confirm("결재하시겠습니까?")) return;
  try {
    const updated = await withGlobalBusy(() => apiFetch(`/api/training-logs/${state.selectedId}/approve`, { method: "POST" }));
    applyTrainingApprovalUpdate(updated);
  } catch (err) {
    let message = err.message;
    if (err.status === 403) message = "결재 권한이 없습니다. (안전관리책임자 또는 안전관리총괄자만 결재할 수 있습니다.)";
    if (err.status === 409) message = "처리할 수 없습니다. 결재 순서를 다시 확인하세요.";
    showTrainingError(message);
  }
}

async function cancelTrainingApproval() {
  if (!window.confirm("결재를 취소하시겠습니까?")) return;
  try {
    const updated = await withGlobalBusy(() => apiFetch(`/api/training-logs/${state.selectedId}/approve/cancel`, { method: "POST" }));
    applyTrainingApprovalUpdate(updated);
  } catch (err) {
    let message = err.message;
    if (err.status === 403) message = "본인이 결재한 단계만 취소할 수 있습니다.";
    if (err.status === 409) message = "상위 단계가 이미 결재되어 취소할 수 없습니다.";
    showTrainingError(message);
  }
}

// 결재를 전부 무효화한다(시스템관리자 전용) — 수정·첨부 잠금도 같이 풀린다.
async function resetTrainingApprovals() {
  if (!window.confirm("이 문서의 결재를 전부 취소하시겠습니까? 되돌릴 수 없습니다.")) return;
  try {
    const updated = await withGlobalBusy(() => apiFetch(`/api/training-logs/${state.selectedId}/approvals/reset`, { method: "POST" }));
    applyTrainingApprovalUpdate(updated);
  } catch (err) {
    const message = err.status === 403 ? "시스템관리자만 결재를 리셋할 수 있습니다." : `처리하지 못했습니다. (${err.message})`;
    showTrainingError(message);
  }
}

// ---------- 첨부파일 (Attachment API, ownerType=TrainingLog) ----------
//
// 슬롯 없는 다건 첨부다 — 파일마다 새 행이 생기고, 한 번에 여러 개를 받는 API가 없어 선택한
// 파일 수만큼 반복 호출한다. 신규작성(저장 전, id 없음) 상태에서는 올릴 곳(ownerId)이 없어
// pendingFiles에 담아뒀다가 저장 성공 후 한꺼번에 올린다.
// 이 문서유형은 결재가 시작되면 서버가 첨부 추가/삭제도 409로 막으므로, canEdit 기준으로
// 버튼을 숨긴다(= 문서 수정 가능 여부와 첨부 변경 가능 여부가 항상 같다).

function updateTrainingAttachmentControls() {
  const canAttach = state.isNew || state.canEditSelected;
  document.getElementById("trAttachmentUploadLabel").hidden = !canAttach;
  document.getElementById("trAttachmentLimitHint").hidden = !canAttach;
  document.getElementById("trAttachmentNewNotice").hidden = !state.isNew;
}

async function loadTrainingAttachments(itemId) {
  try {
    state.attachments = await fetchAttachments("TrainingLog", itemId);
  } catch (err) {
    state.attachments = [];
  }
  renderTrainingAttachments();
}

function renderTrainingAttachments() {
  renderAttachmentList(document.getElementById("trAttachmentList"), {
    items: state.attachments,
    pendingFiles: state.pendingFiles,
    isPending: state.isNew,
    canModify: state.canEditSelected,
    onDownload: downloadTrainingAttachment,
    onDelete: deleteTrainingAttachment,
    onRemovePending: (idx) => {
      state.pendingFiles.splice(idx, 1);
      renderTrainingAttachments();
    },
  });
}

async function uploadTrainingAttachments(files) {
  const itemId = state.selectedId;
  if (!itemId) return;
  document.getElementById("trModalError").hidden = true;

  try {
    await withGlobalBusy(async () => {
      await uploadAttachments("TrainingLog", itemId, files);
      await loadTrainingAttachments(itemId);
      await refreshTrainingAttachmentCount();
    });
  } catch (err) {
    const message = err.status === 409 ? "결재가 진행된 문서에는 첨부파일을 추가할 수 없습니다." : `첨부파일 업로드에 실패했습니다. (${err.message})`;
    showTrainingError(message);
  }
}

async function downloadTrainingAttachment(attachmentId) {
  try {
    const meta = state.attachments.find((a) => String(a.id) === String(attachmentId));
    await downloadAttachment(attachmentId, meta?.fileName);
  } catch (err) {
    showTrainingError(`파일을 불러오지 못했습니다. (${err.message})`);
  }
}

async function deleteTrainingAttachment(attachmentId) {
  if (!window.confirm("이 첨부파일을 삭제하시겠습니까?")) return;
  try {
    await withGlobalBusy(async () => {
      await deleteAttachment(attachmentId);
      await loadTrainingAttachments(state.selectedId);
      await refreshTrainingAttachmentCount();
    });
  } catch (err) {
    const message = err.status === 409 ? "결재가 진행된 문서의 첨부파일은 삭제할 수 없습니다." : `삭제하지 못했습니다. (${err.message})`;
    showTrainingError(message);
  }
}

// 첨부 개수는 서버가 문서에 같이 실어주는 값이라, 올리거나 지운 뒤 그 문서를 다시 조회해
// 목록의 클립 표시를 맞춘다.
async function refreshTrainingAttachmentCount() {
  try {
    const updated = await apiFetch(`/api/training-logs/${state.selectedId}`);
    const idx = state.items.findIndex((i) => String(i.id) === String(state.selectedId));
    if (idx !== -1) state.items[idx] = updated;
    state.current = updated;
    renderTrainingList();
  } catch (err) {
    // 실패해도 무시 — 클립 개수 표시만 갱신 안 될 뿐, 실제 데이터는 이미 반영됨
  }
}

document.addEventListener("DOMContentLoaded", initTrainingPage);
