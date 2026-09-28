// 공통 API 호출 래퍼. 토큰 첨부, 401 처리(재로그인 유도)를 담당한다.

// apiFetch/apiFetchBlob/apiUpload가 공유하는 핵심 로직 — 인증 헤더 첨부, 401/오류 처리.
// 응답 파싱(JSON vs Blob)만 호출하는 쪽에서 다르게 한다.
async function apiRequestRaw(path, options = {}) {
  const session = getSession();
  const headers = Object.assign({}, options.headers || {});
  if (session && session.token) {
    headers["Authorization"] = "Bearer " + session.token;
  }

  const res = await fetch(APP_CONFIG.apiBaseUrl + path, Object.assign({}, options, { headers }));

  if (res.status === 401) {
    clearSession();
    window.location.href = "../login/login.html";
    throw new Error("인증이 만료되었습니다. 다시 로그인해 주세요.");
  }

  if (!res.ok) {
    let bodyText = null;
    try {
      bodyText = await res.text();
    } catch {
      // 응답 본문을 못 읽어도 상태코드 기반 메시지로는 처리할 수 있으니 무시한다.
    }
    // 서버 오류(5xx)에는 traceId가 실려 온다(백엔드 2026-09-28) — 서버 로그에서 이 요청을
    // 바로 찾을 수 있는 번호라, 사용자에게 보이는 문구에 같이 붙여준다. 4xx는 원인이 이미
    // 메시지에 있으므로 붙이지 않는다.
    const traceId = parseTraceId(bodyText);
    const message = parseErrorBody(bodyText) || `API 요청 실패 (${res.status})`;
    const err = new Error(traceId && res.status >= 500 ? `${message} [추적번호: ${traceId}]` : message);
    err.status = res.status;
    err.traceId = traceId;
    throw err;
  }

  return res;
}

// BadRequest("메시지") 같은 응답은 그냥 문자열(JSON 문자열 리터럴)로 오거나, 검증 오류일
// 땐 { title, ... } 형태(ProblemDetails)로 온다 — 화면마다 `${err.message}`로 이 실제
// 서버 메시지를 그대로 보여줄 수 있도록 여기서 한 번에 파싱해둔다. 파싱이 안 되면(HTML
// 오류 페이지 등) 원문 텍스트를 그대로 쓰고, 그것도 없으면 null(호출부가 상태코드로 대체).
function parseErrorBody(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      // [ApiController]의 자동 모델 검증 실패(ValidationProblemDetails)는 title이 항상
      // "One or more validation errors occurred." 같은 두루뭉술한 문구라, 진짜 원인은
      // errors에 필드명별로 따로 들어있다 — 예: 타입이 안 맞는 값(문자열을 decimal 필드에
      // 보낸 경우 등)을 보내면 여기 어떤 필드가 문제인지 정확히 나온다.
      if (parsed.errors && typeof parsed.errors === "object") {
        const details = Object.entries(parsed.errors)
          .map(([field, msgs]) => `${field}: ${(Array.isArray(msgs) ? msgs : [msgs]).join(" ")}`)
          .join(" / ");
        if (details) return parsed.title ? `${parsed.title} (${details})` : details;
      }
      if (typeof parsed.message === "string") return parsed.message;
      if (typeof parsed.title === "string") return parsed.title;
    }
    return null;
  } catch {
    return text;
  }
}

// 500 응답의 traceId(ProblemDetails 확장 필드). 대소문자 표기가 바뀌어도 잡히게 둘 다 본다.
function parseTraceId(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const traceId = parsed.traceId ?? parsed.TraceId;
      return typeof traceId === "string" && traceId ? traceId : null;
    }
  } catch {
    // JSON이 아니면 traceId도 없다
  }
  return null;
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  const res = await apiRequestRaw(path, Object.assign({}, options, { headers }));

  if (res.status === 204) {
    return null;
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// 이미지 등 바이너리 응답(예: GET /api/attachments/{id})을 받을 때 쓴다. 이런 API도
// 다른 API와 동일하게 Authorization 헤더가 필요해서 <img src="...">에 URL을 직접 못
// 넣는다 — 이걸로 받은 Blob을 URL.createObjectURL()로 변환해서 <img>에 넣어야 한다.
async function apiFetchBlob(path) {
  const res = await apiRequestRaw(path);
  return res.blob();
}

// 파일 업로드 전용(예: POST /api/attachments). FormData를 보낼 때는 Content-Type을
// 절대 직접 지정하면 안 된다 — 멀티파트 boundary는 브라우저가 자동으로 채워야 한다.
async function apiUpload(path, formData) {
  const res = await apiRequestRaw(path, { method: "POST", body: formData });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
