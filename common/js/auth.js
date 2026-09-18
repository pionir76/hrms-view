// 로그인 세션 관리 (localStorage 기반). 로그인 폼 자체의 로직은 pages/login/login.js에 있다.

const SESSION_STORAGE_KEY = "hrms_session";

function saveSession(session) {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY));
  } catch (e) {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

function isLoggedIn() {
  const session = getSession();
  return !!(session && session.token);
}

async function logout() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch (e) {
    // 로그아웃 이력 기록 실패는 무시하고 세션은 어차피 비운다.
  }
  clearSession();
  window.location.href = "../login/login.html";
}
