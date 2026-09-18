// 결재 바 공통 모듈
//
// 점검일지 / 운전일지 / 수리보수 및 철거일지 / 교육훈련 일지가 모두 같은 3단계 결재
// (안전관리원 → 안전관리책임자 → 안전관리총괄자)를 쓴다. 문서마다 API 경로와 레벨별 모드
// (해당없음/전결/실제 승인)는 다르지만, **화면에 그리는 방식과 버튼 노출 규칙은 완전히 같다** —
// 그래서 네 페이지에 복사돼 있던 것을 여기로 모았다.
//
// 이 모듈은 "그리기"만 담당한다. 승인/취소 API 호출은 문서마다 경로가 달라서 각 페이지가
// onApprove/onCancel 콜백으로 처리하고, 응답(갱신된 문서)을 받아 다시 renderApprovalBar를
// 부르면 된다.
//
// 사용법:
//   renderApprovalBar(document.getElementById("approvalBar"), doc, {
//     allowApprove: doc.id !== null,   // 저장 전 문서는 결재 자체가 불가능
//     onApprove: (levelKey) => {...},
//     onCancel: (levelKey) => {...},
//   });

const APPROVAL_LEVEL_KEYS = ["level1", "level2", "level3"];
const APPROVAL_LEVEL_ROLE = {
  level1: "안전관리원",
  level2: "안전관리책임자",
  level3: "안전관리총괄자",
};

// 해당없음/전결은 승인 절차가 없을 뿐 "그 단계는 끝난 것"으로 취급한다 — 다음 단계가
// 곧바로 첫 승인자가 되기 때문에 순서 판정에서 완료로 봐야 한다.
function isApprovalLevelDone(level) {
  return !!level && (level.status === "Approved" || level.status === "NotApplicable" || level.status === "Delegated");
}

// 실제로 누군가 승인한 단계가 하나라도 있는지 — 문서 수정 잠금 판단의 기준이다.
function isApprovalStarted(doc) {
  return APPROVAL_LEVEL_KEYS.some((key) => doc?.[key]?.status === "Approved");
}

function isApprovalComplete(doc) {
  return APPROVAL_LEVEL_KEYS.every((key) => isApprovalLevelDone(doc?.[key]));
}

// 결재칸은 폭이 좁아 취소 버튼과 겹치기 쉬워서 시각 없이 날짜만 표시한다.
function formatApprovalDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

// 아직 저장 전(문서 id 없음)이라도 결재란 모양은 그대로 보여주기 위한 기본값.
// 레벨별 모드는 문서유형마다 달라서, 저장 전 모양이 다른 페이지는 emptyDoc 옵션으로 넘긴다.
const APPROVAL_EMPTY_DOC = {
  level1: { status: "Pending" },
  level2: { status: "Pending" },
  level3: { status: "Pending" },
};

function renderApprovalBar(el, doc, options = {}) {
  const { allowApprove = true, onApprove, onCancel, emptyDoc = APPROVAL_EMPTY_DOC } = options;
  const session = getSession();
  const target = doc ?? emptyDoc;

  el.innerHTML = APPROVAL_LEVEL_KEYS.map((key, idx) => {
    const level = target[key];
    const roleLabel = APPROVAL_LEVEL_ROLE[key];
    let inner = "";

    if (level.status === "NotApplicable") {
      inner = `<span class="approval-na">/</span>`;
    } else if (level.status === "Delegated") {
      inner = `<span class="approval-delegated">전결</span>`;
    } else if (level.status === "Approved") {
      // 취소는 본인이 승인한 단계만, 그리고 상위 단계가 아직 승인되지 않았을 때만 가능하다.
      // 로그인 세션에는 성명이 없어 "내가 승인한 것인지"를 프론트가 확정할 수 없으므로,
      // 역할이 같으면 일단 버튼을 보여주고 실제 판정은 서버 403에 맡긴다.
      const higherApproved = APPROVAL_LEVEL_KEYS.slice(idx + 1).some((k) => target[k].status === "Approved");
      const canCancel = !higherApproved && session && session.role === roleLabel;
      inner = `
        <div class="approval-approved">
          ${canCancel ? `<button type="button" class="approval-cancel-btn" data-level="${key}">취소</button>` : ""}
          <span class="approval-approved-date">${formatApprovalDate(level.approvedAt)}</span>
          <div class="approval-approved-name">${level.approverName ?? ""}</div>
        </div>
      `;
    } else {
      const lowerDone = APPROVAL_LEVEL_KEYS.slice(0, idx).every((k) => isApprovalLevelDone(target[k]));
      const canApprove = allowApprove && lowerDone && session && session.role === roleLabel;
      inner = canApprove
        ? `<button type="button" class="btn btn-primary approval-approve-btn" data-level="${key}">결재</button>`
        : `<span class="approval-pending-text">대기</span>`;
    }

    return `
      <div class="approval-slot">
        <div class="approval-slot-header">${roleLabel}</div>
        <div class="approval-slot-body">${inner}</div>
      </div>
    `;
  }).join("");

  el.querySelectorAll(".approval-approve-btn").forEach((btn) => {
    btn.addEventListener("click", () => onApprove && onApprove(btn.dataset.level));
  });
  el.querySelectorAll(".approval-cancel-btn").forEach((btn) => {
    btn.addEventListener("click", () => onCancel && onCancel(btn.dataset.level));
  });
}
