// 로그인 페이지 전용 스크립트

document.addEventListener("DOMContentLoaded", () => {
  if (isLoggedIn()) {
    window.location.href = "../dashboard/dashboard.html";
    return;
  }

  const form = document.getElementById("loginForm");
  const errorBox = document.getElementById("loginError");
  const submitBtn = document.getElementById("loginSubmit");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    submitBtn.disabled = true;
    submitBtn.textContent = "로그인 중...";

    try {
      const res = await fetch(APP_CONFIG.apiBaseUrl + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!res.ok) {
        throw new Error("아이디 또는 비밀번호가 올바르지 않습니다.");
      }

      const data = await res.json();
      saveSession({ token: data.token, username: data.username, role: data.role });

      // 로그인 응답에는 성명·소속팀이 없다 — 상단바에 바로 보이도록 본인 정보를 받아 세션에 함께 둔다.
      // 실패해도 로그인은 된 것이므로 넘어간다(상단바가 다음 페이지에서 다시 받는다).
      try {
        const meRes = await fetch(APP_CONFIG.apiBaseUrl + "/api/users/me", {
          headers: { Authorization: "Bearer " + data.token },
        });
        if (meRes.ok) {
          const me = await meRes.json();
          saveSession({
            token: data.token,
            username: data.username,
            role: me.role || data.role,
            profile: { id: me.id, fullName: me.fullName, department: me.department, position: me.position, phone1: me.phone1, phone2: me.phone2 },
          });
        }
      } catch (e) {
        // 무시
      }

      window.location.href = "../dashboard/dashboard.html";
    } catch (err) {
      errorBox.textContent = err.message || "로그인에 실패했습니다.";
      errorBox.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "로그인";
    }
  });
});
