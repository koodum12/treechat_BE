# treechat-be

[TreeChat](https://github.com/koodum12/treechat) 확장 프로그램의 기기 간 동기화 서버입니다. Node + Express + PostgreSQL(Neon)로 만들었습니다.

## 계정 없이 동작하는 방식

- 확장 프로그램이 동기화를 켤 때 무작위 256비트 키를 만들어 `chrome.storage.sync`에 저장합니다. 같은 Google 계정으로 로그인한 Chrome에는 이 키가 자동으로 복사되므로, 다른 기기에서는 아무것도 하지 않아도 됩니다.
- 요청할 때 키를 `Authorization: Bearer <key>`로 보냅니다. 서버는 키의 SHA-256 해시만 저장합니다.
- 트리는 사이트 계정별로 나뉩니다. 칸 이름(namespace)은 확장 프로그램이 `HMAC(key, "<site>:<계정 id>")`로 만들어 보내므로, 서버는 ChatGPT 계정 ID나 이메일을 알 수 없습니다.
- 저장되는 것: 트리 구조(대화 ID·경로·제목·분기 지점 80자 발췌). 대화 본문과 ChatGPT 토큰은 받지 않습니다.

## API

모든 `/v1` 요청에는 `Authorization: Bearer <43자 base64url 키>`가 필요합니다. `:ns`는 64자 hex입니다.

| 요청 | 응답 |
| --- | --- |
| `GET /health` | `200 {ok:true}` |
| `GET /v1/trees/:ns` | `200 {data, version, updatedAt}` · `404` |
| `PUT /v1/trees/:ns` `{data, baseVersion}` | `200 {version, updatedAt}` · `409 {data, version, updatedAt}`(다른 기기가 먼저 씀) · `403 too_many_trees` · `413` |
| `DELETE /v1/trees` | `204` (이 키의 트리 전부 삭제) |

- 처음 만들 때는 `baseVersion: null`, 이후에는 마지막으로 받은 `version`을 보냅니다. 버전이 맞지 않으면 409와 함께 현재 트리를 돌려주고, 확장 프로그램이 병합한 뒤 다시 보냅니다.
- 제한: 본문 512KB, 키당 트리 20개, IP당 분당 120회.

## 로컬 실행

```bash
npm install
npm run dev          # DATABASE_URL이 없으면 메모리 저장소로 실행 (재시작하면 사라짐)
npm test             # 메모리 저장소로 API 테스트
TEST_DATABASE_URL=postgresql://... npm test   # PostgreSQL로도 테스트
```

## 배포 (Cloudtype + Neon)

1. **Neon**: [neon.com](https://neon.com)에서 프로젝트 생성 → Connection Details에서 연결 문자열(`postgresql://…?sslmode=require`) 복사. 테이블은 서버가 시작할 때 자동으로 만듭니다.
2. **Cloudtype**: 새 프로젝트 → GitHub 저장소 `treechat_BE` 연결 → Node.js 선택
   - Node 버전: 20 이상
   - Start command: `npm start`
   - Port: `8080`
   - 환경변수: `DATABASE_URL`(1번 값), `NODE_ENV=production`, `TRUST_PROXY=1`
3. 배포된 주소의 `/health`가 `{"ok":true}`인지 확인
4. 확장 프로그램의 `extension/src/core/config.js`의 `SYNC_SERVER_URL`과 `manifest.json`의 `host_permissions`를 배포 주소로 바꿉니다.

연결 문자열에는 DB 비밀번호가 들어 있습니다. 저장소, 이슈, 채팅에 붙여 넣지 말고 Cloudtype 환경변수에만 넣으세요.

## 로그

요청 본문, 키, namespace는 로그에 남기지 않습니다. 오류는 오류 코드만 기록합니다.
