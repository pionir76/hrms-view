namespace HRMS.Modules.SystemStatus.Models;

// server.status / api.status 판정 결과. 다른 enum과 같이 한글 문자열로 내려간다.
public enum HealthStatus
{
    정상,
    주의,
    오류
}
