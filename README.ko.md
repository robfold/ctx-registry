# ctx-registry

[English](README.md) · 한국어

코딩 에이전트용 비공개 문서 레지스트리입니다. Cloudflare Worker 하나와 R2 버킷 하나로 돌아갑니다.

[`@neuledge/context`](https://github.com/neuledge/context) CLI와 MCP 서버가 이 서버를 씁니다. 문서 패키지를 한 맥에서 한 번 만들어 올리면, 다른 맥과 에이전트가 모두 같은 파일을 받습니다. 내가 갖고 있지 않은 패키지는 Neuledge 공개 레지스트리에서 대신 받아 줍니다. 그래서 CLI가 이 서버 하나만 바라봐도 됩니다.

- **검색은 에이전트의 맥에서 합니다.** 서버는 SQLite 파일만 내줍니다. 설치한 뒤에는 검색 비용이 0이고 오프라인에서도 됩니다.
- **내 문서는 내 버킷에 있습니다.** 비공개 API 문서, 사내 가이드, 고정한 버전을 비밀 주소 뒤에 둡니다.
- **비용이 거의 들지 않습니다.** R2는 내보내기(egress) 요금이 없습니다. 설치 1회는 R2 목록 조회(Class A) 최대 2번과 읽기(Class B) 최대 2번입니다. `docs` 레지스트리도 함께 보기 때문입니다. 정가로 설치 100만 회에 $10 미만입니다. R2 무료 한도는 10GB입니다.

## 동작

`context` CLI는 엔드포인트 두 개만 부르고 인증 헤더를 보내지 않습니다.

```
GET {server}/search?registry=npm&name=next                  -> [{registry, name, version, size, description}, ...]  첫 항목 = 최신
GET {server}/packages/{registry}/{name}/{version}/download  -> 패키지 .db 파일
```

그래서 읽기 잠금은 비밀 경로입니다. `{server}`는 `https://<worker>/t/<READ_TOKEN>`입니다. 다른 경로는 모두 404를 돌려줍니다.

| 요청 | 동작 |
|---|---|
| `search` | 내 버전을 먼저(semver는 새 버전부터, `main` 같은 이름표는 올린 시각 순), 그다음 내가 없는 upstream 버전을 붙입니다. `&local=1`을 붙이면 upstream을 건너뜁니다. |
| `download` | 내 사본이 있으면 그것을, 없으면 upstream에서 받아 그대로 흘려보냅니다. |
| `PUT /packages/{registry}/{name}/{version}` | 게시. `Authorization: Bearer <PUBLISH_TOKEN>`이 필요합니다. 본문은 SQLite 파일이어야 합니다. |
| `DELETE /packages/{registry}/{name}/{version}` | 삭제. 같은 토큰을 씁니다. |
| `GET /index` | 내가 가진 전체 목록. |
| `GET /healthz` | `ok`. 토큰이 필요 없습니다. |

직접 만든 패키지는 레지스트리 이름 `docs` 아래에 둡니다. `npm/next`를 찾거나 받을 때 `docs/next`도 함께 봅니다. 그래서 `context install npm/next@16.4.6`이 직접 만든 사본을 찾습니다.

## 배포

Cloudflare 계정과 Node 22.13 이상이 필요합니다.

```sh
git clone https://github.com/robfold/ctx-registry && cd ctx-registry
npm install
export CLOUDFLARE_ACCOUNT_ID=<계정 ID>
npx wrangler r2 bucket create ctx-registry
npm run cf:deploy          # 타입 검사 + 시험 + wrangler deploy

openssl rand -hex 32 | npx wrangler secret put READ_TOKEN
openssl rand -hex 32 | npx wrangler secret put PUBLISH_TOKEN
```

두 토큰은 비밀번호 관리자에 넣어 둡니다. 두 비밀값을 넣기 전에는 `/healthz` 말고 모든 경로가 404입니다. 32자보다 짧은 토큰은 받지 않습니다.

## CLI 연결

맥마다 `~/.context/config.json`을 고칩니다.

```json
{
  "servers": [
    { "name": "mine", "url": "https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>", "default": true },
    { "name": "neuledge", "url": "https://api.context.neuledge.com" }
  ]
}
```

그러면 `context browse`, `context install`, MCP 도구 `search_packages`·`download_package`가 내 서버를 씁니다. 이 파일에는 읽기 토큰이 들어 있으니 `chmod 600`으로 잠급니다.

## 게시

```sh
export CTX_REGISTRY_URL=https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>
export CTX_PUBLISH_TOKEN=<PUBLISH_TOKEN>

context add https://github.com/honojs/hono --name hono --pkg-version 4.12.27   # 로컬에서 빌드
node bin/ctx-publish.mjs ~/.context/packages/hono@4.12.27.db                  # 파일 하나 게시
node bin/ctx-publish.mjs --all --dry-run                                      # ~/.context/packages 전체 미리보기
node bin/ctx-publish.mjs --all
```

`--all`은 서버에 같은 크기로 이미 있는 패키지를 건너뜁니다. 올리지 않을 패키지는 `~/.config/ctx-registry/exclude`에 한 줄에 정규식 하나씩 적습니다. 각 줄을 `name@version`과 패키지의 출처 URL에 맞춰 봅니다.

## 한계

- 읽기 토큰은 URL과 `~/.context/config.json`에 들어갑니다. API 키처럼 다루고, 새면 `wrangler secret put READ_TOKEN`으로 바꿉니다.
- 사용량 제한이 없습니다. 읽기 토큰을 가진 사람은 얼마든지 받을 수 있습니다.
- 게시 파일을 메모리에 올리므로 패키지는 95MB보다 작아야 합니다(Free·Pro 요청 본문 한도 100MB).
- 패키지 빌드(`context add`)는 Worker가 아니라 내 맥에서 돌아갑니다.

## 시험

```sh
npm run check    # tsc + vitest
```

시험은 메모리 안의 가짜 R2와 가짜 upstream으로 요청 처리기를 돌립니다.

## 라이선스

`@neuledge/context`와 같은 Apache-2.0입니다. 이 프로젝트는 Neuledge와 관계가 없습니다.
