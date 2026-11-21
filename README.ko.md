# ctx-registry

[English](README.md) · 한국어

내 Cloudflare 계정에서 도는 오픈소스 Context7 대안입니다.

코딩 에이전트가 MCP 주소 하나에 연결해 질문하면, 라이브러리 공식 문서에서 맞는 절을 찾아 돌려줍니다. Context7과 같은 도구 두 개(`resolve-library-id`, `query-docs`)를 써서, Context7용으로 쓴 프롬프트가 그대로 통합니다. Cloudflare Worker 하나와 D1(단어 검색), Vectorize(의미 검색), Workers AI(임베딩)로 돕니다. 월 한도가 없고, Cloudflare 정가로 질문 100만 개에 약 11달러입니다.

- **단어 검색과 의미 검색을 함께 씁니다.** 둘을 동시에 돌려 순위를 합칩니다. 정확한 API 이름은 글자 그대로, 평소 말로 쓴 질문은 의미로 맞춥니다. "refresh a fetch every minute"를 물으면 Next.js 재검증 문서가 먼저 나옵니다.
- **출처와 버전을 내가 정합니다.** [`@neuledge/context`](https://github.com/neuledge/context) CLI로 메인테이너의 저장소나 문서 사이트에서 패키지를 만듭니다. `next@16.2.9`와 `next@16.4.6`을 나란히 둡니다.
- **원하면 오프라인 사본도 됩니다.** 같은 서버가 `context` CLI용 패키지 레지스트리도 겸합니다. 맥에서 패키지를 한 번 받아 로컬에서 검색할 수 있습니다.

## 동작

```
에이전트 ──MCP──▶ Worker ──┬─▶ D1 (FTS5)                  단어 순위
                           └─▶ Workers AI ─▶ Vectorize      의미 순위
                            ◀── 합친 순위(RRF), 토큰 한도에 맞춰 자름
```

| 경로 | 하는 일 |
|---|---|
| `POST /t/<READ_TOKEN>/mcp` | Streamable HTTP 방식 MCP(JSON 응답, 세션 없음). 도구: `resolve-library-id`, `query-docs` |
| `POST /mcp` + `Authorization: Bearer <READ_TOKEN>` | 같은 기능. 헤더를 보낼 수 있는 클라이언트용 |
| `PUT /t/<READ_TOKEN>/index/{name}/{version}` | 절 묶음 색인. `Authorization: Bearer <PUBLISH_TOKEN>` 필요. `bin/ctx-index.mjs`가 씀 |
| `GET /t/<READ_TOKEN>/libraries` | 색인된 라이브러리와 절 수 |
| `GET /t/<READ_TOKEN>/search`, `.../packages/...` | `context` CLI용 패키지 레지스트리(받아서 오프라인 검색) |
| `GET /healthz` | `ok`. 토큰 불필요 |

`query-docs`의 `libraryId`는 `name@version`, 버전 없는 `name`(최신판), 또는 Context7식 `/org/project`를 받습니다. `/org/project`는 라이브러리 출처 URL과 맞춰 봅니다. 다른 경로는 모두 404입니다.

## 배포

Workers Paid 플랜의 Cloudflare 계정과 Node 22.13 이상이 필요합니다.

```sh
git clone https://github.com/robfold/ctx-registry && cd ctx-registry
npm install
npx wrangler d1 create ctx-docs                      # 나온 ID를 wrangler.jsonc에 붙여 넣기
npx wrangler d1 migrations apply ctx-docs --remote
npx wrangler vectorize create ctx-docs-vectors --dimensions=1024 --metric=cosine
npx wrangler r2 bucket create ctx-registry
npm run cf:deploy                                    # 타입 검사 + 시험 + wrangler deploy
openssl rand -hex 32 | npx wrangler secret put READ_TOKEN
openssl rand -hex 32 | npx wrangler secret put PUBLISH_TOKEN
```

두 토큰은 비밀번호 관리자에 보관합니다. 두 비밀값을 넣기 전에는 `/healthz` 말고 모든 경로가 404입니다. 32자보다 짧은 토큰은 받지 않습니다. 단어 검색만 쓰려면 `wrangler.jsonc`에서 `ai`와 `vectorize` 항목을 지웁니다.

## 에이전트 연결

Claude Code:

```sh
claude mcp add --transport http docs https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>/mcp
```

다른 MCP 클라이언트:

```json
{ "mcpServers": { "docs": { "url": "https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>/mcp" } } }
```

## 문서 올리기

```sh
export CTX_REGISTRY_URL=https://ctx-registry.<subdomain>.workers.dev/t/<READ_TOKEN>
export CTX_PUBLISH_TOKEN=<PUBLISH_TOKEN>

context add https://github.com/honojs/hono       # 내 맥에서 패키지 만들기
node bin/ctx-index.mjs --all                      # ~/.context/packages 전체를 MCP 검색용으로 색인
node bin/ctx-publish.mjs --all                    # 선택: 오프라인 다운로드용 파일도 올리기
```

두 스크립트 모두 서버에 이미 있는 것은 건너뜁니다. `ctx-index --force`는 전부 다시 보냅니다(예: 의미 검색을 켠 뒤). 올리지 않을 패키지는 `~/.config/ctx-registry/exclude`에 한 줄에 정규식 하나씩 적습니다. 각 줄을 `name@version`과 패키지 출처 URL에 맞춰 봅니다.

## 비용

Cloudflare 정가로 질문 1개는 1,024차원 Vectorize 조회 1번(조회 차원 100만당 $0.01), 질문 임베딩 1번(`@cf/baai/bge-m3`, 100만 토큰당 $0.012), Worker 요청 1번입니다. 질문 100만 개에 약 11달러이고, Workers Paid 월 $5가 따로 듭니다. 절 임베딩도 토큰당 같은 값이라, 절 10만 개 색인(절마다 앞 2,000자까지 임베딩)이 1달러 미만입니다.

## 한계

- 답은 문서 원래의 절입니다. Context7은 코드 예시마다 제목과 요약을 따로 써 둡니다. 그래서 "protect a dashboard route"처럼 할 일로 묻는 질문에는 아직 Context7의 상위 답이 더 정확합니다.
- 라이브러리는 내가 골라 올립니다. 자동 재빌드는 이번 판에 없습니다.
- 읽기 토큰은 API 키처럼 동작하고, 토큰을 가진 쪽에는 사용량 제한이 없습니다. 새면 `wrangler secret put READ_TOKEN`으로 바꿉니다.
- 색인 묶음 하나는 절 200개까지입니다. `ctx-index`가 알아서 나눕니다.

## 시험

```sh
npm run check    # tsc + vitest
```

시험은 Node 내장 SQLite에 실제 마이그레이션(FTS5, 트리거, bm25)을 적용해 처리기를 돌립니다. Workers AI와 Vectorize는 대역으로 바꾸되, Vectorize의 호출당 한도는 그대로 지킵니다.

## 라이선스

Apache-2.0. 패키지는 `@neuledge/context`(Apache-2.0)로 만듭니다. Context7, Upstash, Neuledge와 관계가 없습니다.
