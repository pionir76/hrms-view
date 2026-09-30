// 문서 → PDF 저장 공통 모듈 (브라우저 인쇄 기능 사용)
//
// 화면의 입력칸을 그대로 인쇄하면 긴 글이 잘리고 조작 버튼까지 찍히므로, 문서마다 **인쇄 전용
// HTML**을 만들어 넘기면 그것만 A4로 인쇄한다(common/css/pdf-export.css). 사용자는 인쇄 창에서
// 대상 "PDF로 저장"을 고르면 파일이 되고, 프린터를 고르면 종이로 나온다.
// 파일 이름 기본값은 인쇄하는 동안 바꿔 둔 document.title을 브라우저가 쓴다.
//
// 사용법:
//   printPdfDocument({ fileName: "교육훈련일지_2026-09-16_제목", html: "<div class=\"pdf-doc\">...</div>" });
//
// 교육훈련 일지에서 먼저 시험하고, 결과가 좋으면 점검일지·운전일지의 엑셀 저장을 대체한다.

function pdfSafeFileName(parts) {
  return parts
    .filter(Boolean)
    .join("_")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// 인쇄물 맨 아래 "출력: 일시 · 출력자" 문구
function pdfPrintedByText() {
  const session = getSession();
  const name = (session && session.profile && session.profile.fullName) || (session && session.username) || "";
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `출력: ${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${name ? ` · ${name}` : ""}`;
}

function printPdfDocument({ fileName, html }) {
  let root = document.getElementById("pdfPrintRoot");
  if (!root) {
    root = document.createElement("div");
    root.id = "pdfPrintRoot";
    document.body.appendChild(root);
  }
  root.innerHTML = html;

  const originalTitle = document.title;
  document.title = fileName;
  document.body.classList.add("is-pdf-printing");

  const cleanup = () => {
    document.title = originalTitle;
    document.body.classList.remove("is-pdf-printing");
    root.innerHTML = "";
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print(); // 인쇄 창이 닫힐 때까지 멈춘 뒤 afterprint가 온다
}
