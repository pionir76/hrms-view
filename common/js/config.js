// 환경 설정
// 백엔드 개발 서버 기본 주소 (reference/api-manual.md 참고). 배포 시 이 값만 바꾸면 된다.
//
// http://localhost:5018을 쓰면 서버가 https://localhost:7253으로 307 리다이렉트하는데,
// scheme(http→https)이 바뀌는 리다이렉트에서는 브라우저가 보안상 Authorization 헤더를
// 자동으로 제거한다 — 그래서 로그인 자체는 되지만(로그인 요청엔 토큰이 필요 없어서
// 영향이 없음) 그 직후 토큰이 필요한 API가 전부 401로 실패해서 다시 로그인 화면으로
// 튕기는 문제가 있었다. 리다이렉트를 아예 안 거치도록 https 주소를 직접 쓴다.
//
// 주의: 이 주소는 자체 서명 인증서를 쓴다 — 브라우저로 https://localhost:7253에
// 한 번 직접 접속해서 인증서 경고를 수락해야, 그 뒤로 이 앱의 fetch 호출이 통과된다.
const APP_CONFIG = {
  apiBaseUrl: "https://localhost:7253",
};
