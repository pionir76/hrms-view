// 화면 표 → 엑셀(.xlsx) 저장 공통 모듈
//
// 점검일지·운전일지처럼 "화면에 보이는 표를 그대로" 파일로 남겨야 하는 문서가 공유한다.
// 표 모양(압축기 수에 따라 행이 늘고 줄거나, 항목 묶음에 따라 rowspan이 달라지는 것)은
// 이미 화면에서 계산돼 있으므로, 여기서는 **그려진 <table>을 그대로 훑어서** 옮긴다 —
// 표 구성이 바뀌어도 이 모듈은 고칠 필요가 없다.
//
// 옮기는 것: 셀 값(입력칸은 입력된 값), rowspan/colspan → 셀 병합, 열 너비, 머리글 서식,
//            테두리, 가운데 정렬, 문서 머리(좌측 정보 + 우측 결재란), 표 아래 안내문.
// 옮기지 않는 것: 화면 CSS의 색·둥근 모서리 등 — 엑셀에 대응이 없거나 인쇄에 불필요하다.
//
// 사용법(문서 1건):
//   exportLogToExcel({
//     fileName: "운전일지_A지구_고저온챔버_2026-09-18.xlsx",
//     sheets: [{ name: "2026-09-18", title: "운전일지", info: [["지역", "A 지구"], ...],
//                approvals: [{ role: "안전관리원", name: "홍길동", date: "2026.09.18" }, ...],
//                table: document.querySelector(".op-table"), notes: ["..."] }],
//   });
//
// 한 달치처럼 여러 건을 한 파일로 내보낼 때는 sheets 배열에 여러 개를 넣으면 된다 —
// 날짜별로 시트가 하나씩 생긴다(문서 1건 저장과 같은 코드를 쓴다).

const EXCEL_FONT = "맑은 고딕";
const EXCEL_THIN_BORDER = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };

// 화면의 px 열 너비를 엑셀 열 너비 단위로 옮긴다(엑셀 1 ≒ 기본 글꼴 문자 1개 ≒ 7px).
function pxToExcelWidth(px) {
  return Math.max(6, Math.round((px / 7) * 10) / 10);
}

// 셀에 보이는 값 — 입력칸/선택상자는 화면에 찍힌 글자가 아니라 **입력된 값**을 가져와야 한다.
function excelCellText(cell) {
  const field = cell.querySelector("input, select, textarea");
  if (field) {
    if (field.tagName === "SELECT") return field.options[field.selectedIndex]?.textContent.trim() ?? "";
    if (field.type === "checkbox") return field.checked ? "O" : "";
    return field.value.trim();
  }
  return cell.textContent.replace(/\s+/g, " ").trim();
}

// <table>을 격자로 편다. rowspan/colspan 때문에 "몇 번째 칸"이 행마다 밀리므로,
// 이미 채워진 자리를 표시해두고 빈 자리에만 셀을 놓는다.
function tableToGrid(table) {
  const grid = [];
  const taken = {}; // "행,열" → true
  let columnCount = 0;

  [...table.querySelectorAll("tr")].forEach((tr, rowIndex) => {
    grid[rowIndex] = grid[rowIndex] || [];
    let col = 0;
    [...tr.children].forEach((cell) => {
      while (taken[`${rowIndex},${col}`]) col += 1;
      const rowSpan = cell.rowSpan || 1;
      const colSpan = cell.colSpan || 1;
      grid[rowIndex].push({
        text: excelCellText(cell),
        row: rowIndex,
        col,
        rowSpan,
        colSpan,
        isHeader: cell.tagName === "TH" || cell.closest("thead") !== null,
      });
      for (let r = 0; r < rowSpan; r += 1) {
        for (let c = 0; c < colSpan; c += 1) taken[`${rowIndex + r},${col + c}`] = true;
      }
      col += colSpan;
      columnCount = Math.max(columnCount, col);
    });
  });

  const widths = [...table.querySelectorAll("colgroup col")].map((col) => parseFloat(col.style.width) || 90);
  return { grid, columnCount, widths };
}

function applyExcelCell(cell, { bold = false, fill = null, align = "center", wrap = false, size = 10 } = {}) {
  cell.font = { name: EXCEL_FONT, size, bold };
  cell.alignment = { vertical: "middle", horizontal: align, wrapText: wrap };
  cell.border = EXCEL_THIN_BORDER;
  if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
}

// 문서 머리 — 좌측에 지역/시설동/장비명/날짜, 우측 3칸에 결재란(사용자 결정 2026-09-18).
// 열 수는 표에 맞춰 달라지므로 좌측 정보 영역 폭을 그때그때 나눠 쓴다.
function writeExcelDocumentHead(sheet, { title, info, approvals, columnCount }) {
  const approvalCols = approvals.length; // 3단계
  const leftCols = Math.max(2, columnCount - approvalCols);
  const startRow = sheet.rowCount + 1;

  // 1행: 제목 + 결재 단계 이름
  sheet.mergeCells(startRow, 1, startRow, leftCols);
  const titleCell = sheet.getCell(startRow, 1);
  titleCell.value = title;
  applyExcelCell(titleCell, { bold: true, size: 16 });
  approvals.forEach((a, i) => {
    const cell = sheet.getCell(startRow, leftCols + 1 + i);
    cell.value = a.role;
    applyExcelCell(cell, { bold: true, fill: "FFF1F3F8", size: 9 });
  });
  sheet.getRow(startRow).height = 26;

  // 2~3행: 좌측 정보(한 줄에 2쌍) + 결재 내용(2행 병합)
  const infoRows = [info.slice(0, 2), info.slice(2, 4)];
  infoRows.forEach((pairs, idx) => {
    const rowNo = startRow + 1 + idx;
    const labelWidth = 1;
    const valueWidth = Math.max(1, Math.floor(leftCols / 2) - labelWidth);
    let col = 1;
    pairs.forEach(([label, value], pairIdx) => {
      const isLast = pairIdx === pairs.length - 1;
      const thisValueWidth = isLast ? leftCols - col - labelWidth + 1 : valueWidth;
      const labelCell = sheet.getCell(rowNo, col);
      labelCell.value = label;
      applyExcelCell(labelCell, { bold: true, fill: "FFF8F9FC", size: 9 });
      sheet.mergeCells(rowNo, col + labelWidth, rowNo, col + labelWidth + thisValueWidth - 1);
      const valueCell = sheet.getCell(rowNo, col + labelWidth);
      valueCell.value = value ?? "";
      applyExcelCell(valueCell, { align: "left" });
      col += labelWidth + thisValueWidth;
    });
    sheet.getRow(rowNo).height = 22;
  });

  approvals.forEach((a, i) => {
    const col = leftCols + 1 + i;
    sheet.mergeCells(startRow + 1, col, startRow + 2, col);
    const cell = sheet.getCell(startRow + 1, col);
    cell.value = [a.name, a.date].filter(Boolean).join("\n") || a.status || "";
    applyExcelCell(cell, { wrap: true, size: 9 });
  });

  sheet.addRow([]); // 머리와 표 사이 여백
}

function writeExcelTable(sheet, table) {
  const { grid, columnCount, widths } = tableToGrid(table);
  const startRow = sheet.rowCount + 1;

  widths.forEach((px, i) => {
    sheet.getColumn(i + 1).width = pxToExcelWidth(px);
  });

  grid.forEach((cells, rowIndex) => {
    const rowNo = startRow + rowIndex;
    cells.forEach((c) => {
      if (c.rowSpan > 1 || c.colSpan > 1) {
        sheet.mergeCells(rowNo, c.col + 1, rowNo + c.rowSpan - 1, c.col + c.colSpan);
      }
      const cell = sheet.getCell(rowNo, c.col + 1);
      // 숫자로만 된 값은 숫자로 넣어야 엑셀에서 계산·정렬이 된다("/"나 "O" 같은 표시는 글자 그대로)
      const numeric = c.text !== "" && !Number.isNaN(Number(c.text));
      cell.value = numeric ? Number(c.text) : c.text;
      applyExcelCell(cell, { bold: c.isHeader, fill: c.isHeader ? "FFF1F3F8" : null, wrap: !c.isHeader && c.colSpan > 1 });
    });
    sheet.getRow(rowNo).height = rowIndex === 0 ? 24 : 20;
  });

  return { startRow, endRow: startRow + grid.length - 1, columnCount };
}

function writeExcelNotes(sheet, notes, columnCount) {
  notes.filter(Boolean).forEach((note) => {
    const rowNo = sheet.rowCount + 1;
    sheet.mergeCells(rowNo, 1, rowNo, columnCount);
    const cell = sheet.getCell(rowNo, 1);
    cell.value = note;
    applyExcelCell(cell, { align: "left", wrap: true, size: 9 });
    sheet.getRow(rowNo).height = Math.max(20, Math.ceil(note.length / 60) * 16);
  });
}

// 시트 하나 = 문서 한 건. 한 달치를 내보낼 때도 이 함수를 날짜 수만큼 부르면 된다.
function writeExcelSheet(workbook, { name, title, info = [], approvals = [], table, notes = [] }) {
  const sheet = workbook.addWorksheet(String(name).slice(0, 31).replace(/[*?:/\\[\]]/g, "-"), {
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });

  const columnCount = tableToGrid(table).columnCount;
  writeExcelDocumentHead(sheet, { title, info, approvals, columnCount });
  const { startRow } = writeExcelTable(sheet, table);
  writeExcelNotes(sheet, notes, columnCount);
  sheet.views = [{ state: "frozen", ySplit: startRow }]; // 표 머리글 고정
  return sheet;
}

async function exportLogToExcel({ fileName, sheets }) {
  const workbook = new ExcelJS.Workbook();
  sheets.forEach((s) => writeExcelSheet(workbook, s));
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 결재 바 데이터를 엑셀 결재란 형태로 바꾼다 — 문서마다 상태 문구가 같아서 여기 모은다.
function approvalsForExcel(doc) {
  const label = { NotApplicable: "해당없음", Delegated: "전결", Pending: "대기" };
  return APPROVAL_LEVEL_KEYS.map((key) => {
    const level = doc?.[key] ?? {};
    const approved = level.status === "Approved";
    return {
      role: APPROVAL_LEVEL_ROLE[key],
      name: approved ? level.approverName ?? "" : "",
      date: approved ? formatApprovalDate(level.approvedAt) : "",
      status: approved ? "" : label[level.status] ?? "대기",
    };
  });
}

// 파일명에 쓸 수 없는 글자를 정리한다(윈도우 기준).
function excelFileName(parts) {
  return `${parts.filter(Boolean).join("_").replace(/[\\/:*?"<>|]/g, "-")}.xlsx`;
}
