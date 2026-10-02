// 환경 설정
//
// API 주소는 화면을 연 주소를 보고 자동으로 고른다(2026-10-02).
//   - 개발 PC(로컬 파일 · localhost · 127.0.0.1)에서 열면 → 개발 백엔드 https://localhost:7253
//   - 그 밖(현장 http://59.16.212.237/ 등)에서 열면 → 상대 경로(/api/...)
// 현장은 백엔드가 화면(이 폴더)과 API를 같은 주소로 서비스하므로 상대 경로면 된다. 예전처럼
// 개발 주소가 고정돼 있으면 현장에서 브라우저가 "사용자 PC의 localhost"로 API를 불러 화면만 뜨고
// 로그인부터 실패한다. 화면과 API가 같은 주소라 현장에서는 CORS 설정도 필요 없다.
//
// 개발 주소에 https를 쓰는 이유: http://localhost:5018을 쓰면 서버가 https://localhost:7253으로
// 307 리다이렉트하는데, scheme(http→https)이 바뀌는 리다이렉트에서는 브라우저가 보안상
// Authorization 헤더를 자동으로 제거한다 — 로그인은 되지만 그 직후 토큰이 필요한 API가 전부
// 401로 실패해서 다시 로그인 화면으로 튕긴다. 리다이렉트를 안 거치도록 https 주소를 직접 쓴다.
// 이 주소는 자체 서명 인증서라, 브라우저로 https://localhost:7253에 한 번 직접 접속해서 인증서
// 경고를 수락해야 그 뒤로 이 앱의 fetch 호출이 통과된다.
//
// 주의: 개발 PC의 화면을 다른 PC에서 내부 IP(예: http://192.168.0.10:5500)로 열면 개발 PC로 보지
// 않아 상대 경로로 부르고 실패한다 — 그런 테스트가 필요하면 아래 조건에 그 주소를 더한다.
const DEV_API_BASE_URL = "https://localhost:7253";

function resolveApiBaseUrl() {
  const { protocol, hostname } = window.location;
  const isDevPc = protocol === "file:" || hostname === "localhost" || hostname === "127.0.0.1";
  return isDevPc ? DEV_API_BASE_URL : "";
}

const APP_CONFIG = {
  apiBaseUrl: resolveApiBaseUrl(),
};
