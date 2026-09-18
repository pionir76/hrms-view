# HRMS

현대 남양 연구소 냉동기 모니터링 시스템 (Hyundai Namyang Refrigerator Monitoring System)

## 개요

현대 남양 연구소 내 냉동 관련 장비와 압축기의 운전 상태 및 센서 정보를 중앙 서버에서 통합 수집하고,
웹 기반 모니터링 시스템을 통해 확인할 수 있도록 하는 시스템입니다.

자세한 요구사항은 [Doc/overview.md](Doc/overview.md) 문서를,
개발 진행 항목은 [Doc/development_todo.md](Doc/development_todo.md) 문서를 참고하세요.

## 기술 스택

- C# / ASP.NET Core (.NET 10.0)
- Windows Service 형태로 운영
- TCP/IP 기반 압축기 통신
- REST API
- PostgreSQL