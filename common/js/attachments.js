// 첨부파일 공통 모듈 (Attachment API — api-manual.md 26~29번)
//
// 슬롯 없는 다건 첨부를 쓰는 화면(장비 검사이력, 교육훈련 일지 …)이 공유한다. 화면마다
// ownerType만 다르고 나머지 동작(용량 제한, 목록 표시, 업로드 진행 표시, 내려받기, 삭제)은
// 같아서 여기로 모았다. 장비 이력카드의 사진 슬롯(ownerType=EquipmentPhoto)은 슬롯 개념과
// 이미지 미리보기가 있는 다른 UI라 여기 포함하지 않는다.
//
// 저장 전(문서 id 없음) 상태에서 고른 파일은 올릴 곳이 없으므로, 각 페이지가 pendingFiles
// 배열에 담아뒀다가 저장 성공 후 uploadAttachments()로 한꺼번에 올린다.

const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // 서버 제한과 동일(초과 시 400)

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// 서버까지 갔다가 400으로 돌아오면 큰 파일일수록 기다린 시간이 아깝다 — 선택 즉시 거른다.
// 초과한 파일이 있으면 onReject(메시지)로 알려주고, 통과한 파일만 돌려준다.
function filterFilesWithinSizeLimit(files, onReject) {
  const tooLarge = files.filter((f) => f.size > ATTACHMENT_MAX_BYTES);
  if (tooLarge.length > 0 && onReject) {
    const names = tooLarge.map((f) => `${f.name} (${formatFileSize(f.size)})`).join(", ");
    onReject(`파일 하나당 최대 10MB까지 첨부할 수 있습니다. 제외된 파일: ${names}`);
  }
  return files.filter((f) => f.size <= ATTACHMENT_MAX_BYTES);
}

function fetchAttachments(ownerType, ownerId) {
  return apiFetch(`/api/attachments?ownerType=${ownerType}&ownerId=${ownerId}`);
}

// 한 번에 여러 개를 받는 API가 없어 파일 수만큼 호출한다. 용량이 큰 파일은 몇 초씩 걸려서
// 스피너만 돌면 멈춘 것처럼 보이므로, 끝난 개수를 BUSY 문구로 갱신한다.
// (호출하는 쪽이 withGlobalBusy로 감싸야 문구가 보인다.)
async function uploadAttachments(ownerType, ownerId, files) {
  let uploaded = 0;
  const showProgress = () => setGlobalBusyLabel(`첨부파일 업로드 중... (${uploaded}/${files.length})`);
  showProgress();
  await Promise.all(
    files.map((file) => {
      const formData = new FormData();
      formData.append("file", file);
      return apiUpload(`/api/attachments?ownerType=${ownerType}&ownerId=${ownerId}`, formData).then((res) => {
        uploaded += 1;
        showProgress();
        return res;
      });
    })
  );
}

// Authorization 헤더가 필요해 <a href>로 바로 받을 수 없다 — Blob으로 받아 임시 링크로 내려받는다.
async function downloadAttachment(attachmentId, fileName) {
  const blob = await withGlobalBusy(() => apiFetchBlob(`/api/attachments/${attachmentId}`), { label: "파일 받는 중..." });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || "attachment";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function deleteAttachment(attachmentId) {
  return apiFetch(`/api/attachments/${attachmentId}`, { method: "DELETE" });
}

function escapeAttachmentText(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ATTACHMENT_EMPTY_HTML = `
  <div class="attachment-item empty">
    <span class="attachment-name">첨부파일 없음</span>
  </div>
`;

// 첨부 목록을 그린다. 저장 전(pending) 목록과 저장된 목록은 한 화면에서 동시에 나오지 않으므로
// 같은 컨테이너에 모양만 바꿔 그린다 — 첨부가 없을 때도 같은 회색 박스를 유지해서 칸이
// 사라졌다 나타나며 높이가 출렁이지 않게 한다.
//
// options:
//   items         저장된 첨부 목록(서버 응답)
//   pendingFiles  저장 전 고른 File 목록 — 있으면 이쪽을 그린다
//   isPending     저장 전 모드인지(파일이 0개여도 pending 모드를 유지해야 할 때)
//   canModify     삭제 버튼 노출 여부
//   onDownload(attachmentId) / onDelete(attachmentId) / onRemovePending(index)
function renderAttachmentList(container, options = {}) {
  const { items = [], pendingFiles = [], isPending = false, canModify = false, onDownload, onDelete, onRemovePending } = options;

  if (isPending) {
    if (pendingFiles.length === 0) {
      container.innerHTML = ATTACHMENT_EMPTY_HTML;
      return;
    }
    container.innerHTML = pendingFiles
      .map(
        (file, idx) => `
        <div class="attachment-item" data-idx="${idx}">
          <span class="attachment-name">${escapeAttachmentText(file.name)}</span>
          <span class="attachment-meta">${formatFileSize(file.size)} · 저장 대기중</span>
          <button type="button" class="attachment-action icon-delete" data-action="remove-pending" title="제거" aria-label="제거"></button>
        </div>
      `
      )
      .join("");
    container.querySelectorAll('[data-action="remove-pending"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.closest("[data-idx]").dataset.idx);
        if (onRemovePending) onRemovePending(idx);
      });
    });
    return;
  }

  if (items.length === 0) {
    container.innerHTML = ATTACHMENT_EMPTY_HTML;
    return;
  }

  container.innerHTML = items
    .map(
      (a) => `
        <div class="attachment-item" data-id="${a.id}">
          <span class="attachment-name">${escapeAttachmentText(a.fileName)}</span>
          <span class="attachment-meta">${formatFileSize(a.sizeBytes)} · ${escapeAttachmentText(a.uploadedByUserName)}</span>
          <button type="button" class="attachment-action icon-download" data-action="download" title="내려받기" aria-label="내려받기"></button>
          <button type="button" class="attachment-action icon-delete" data-action="delete" title="삭제" aria-label="삭제" ${canModify ? "" : "hidden"}></button>
        </div>
      `
    )
    .join("");

  container.querySelectorAll(".attachment-item[data-id]").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('[data-action="download"]').addEventListener("click", () => onDownload && onDownload(id));
    const deleteBtn = el.querySelector('[data-action="delete"]');
    if (deleteBtn) deleteBtn.addEventListener("click", () => onDelete && onDelete(id));
  });
}
