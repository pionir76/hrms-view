// 환경 설정
//
// API 주소는 화면을 연 주소를 보고 자동으로 고른다(2026-10-02).
//   - 개발 PC(로컬 파일 · localhost · 127.0.0.1)에서 열면 → 로컬 백엔드 http://localhost:80
//   - 그 밖(현장 http://59.16.212.237/ 등)에서 열면 → 상대 경로(/api/...)
// 현장은 백엔드가 화면(이 폴더)과 API를 같은 주소로 서비스하므로 상대 경로면 된다. 예전처럼
// 개발 주소가 고정돼 있으면 현장에서 브라우저가 "사용자 PC의 localhost"로 API를 불러 화면만 뜨고
// 로그인부터 실패한다. 화면과 API가 같은 주소라 현장에서는 CORS 설정도 필요 없다.
//
// 로컬 백엔드 주소: 현장과 같은 방식(포트 80, http)으로 설치한 백엔드 기준(사용자 결정 2026-10-02).
// 예전 개발 서버(https://localhost:7253, 자체 서명 인증서)를 다시 쓸 때는 아래 값을 그 주소로 바꾼다
// — 그때는 http://localhost:5018 같은 http 주소를 쓰면 https로 리다이렉트되며 Authorization 헤더가
// 빠져 401이 나므로 반드시 https 주소를 직접 써야 한다.
//
// 주의: 개발 PC의 화면을 다른 PC에서 내부 IP(예: http://192.168.0.10:5500)로 열면 개발 PC로 보지
// 않아 상대 경로로 부르고 실패한다 — 그런 테스트가 필요하면 아래 조건에 그 주소를 더한다.
const DEV_API_BASE_URL = "http://localhost:80";

function resolveApiBaseUrl() {
    const { protocol, hostname } = window.location;
    const isDevPc = protocol === "file:" || hostname === "localhost" || hostname === "127.0.0.1";
    return isDevPc ? DEV_API_BASE_URL : "";
}

const APP_CONFIG = {
    apiBaseUrl: resolveApiBaseUrl(),
};
