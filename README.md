# mcp-memory

Agent Studio의 실행이 끝난 뒤에도 프로젝트 결정과 대화 메모리를 보존하는 MCP 서버다.
메모리 저장과 의미 기반 검색만 담당하며 RAG 문서, chunk, Knowledge Graph는
[`agent-memory`](../agent-memory)가 담당한다.

## 기능

| Tool | 역할 |
| --- | --- |
| `recall(query, limit?, mode?)` | 현재 프로젝트와 대화에서 의미가 가까운 메모리를 찾는다 |
| `remember(content, type?, category?, tags?, scope?)` | 프로젝트 또는 현재 대화에 메모리를 저장한다 |
| `list_memories(type?, limit?)` | 볼 수 있는 메모리를 최신순으로 나열한다 |
| `forget(id)` | 현재 프로젝트의 메모리를 삭제한다 |
| `memory_stats()` | 볼 수 있는 메모리를 유형별로 정확히 집계한다 |

`search_docs`는 제공하지 않는다. 문서 검색이 필요하면 Agent Memory의 HTTP/MCP
interface를 사용한다.

## 구조

영속 저장소는 pgvector extension이 설치된 PostgreSQL 하나다. MinIO, S3, S3 Vectors를
사용하지 않는다.

`memories` 테이블은 다음 데이터를 한 행에 둔다.

- 메모리 본문, 유형, category, tags, scope와 conversation
- 의미 검색용 pgvector embedding
- recall 횟수와 마지막 recall 시각

목록은 `created_at` index, 통계는 SQL `GROUP BY`, 사용 횟수는 atomic `UPDATE`로 처리한다.
별도 object index, counter shard, flush timer는 없다. 벡터 열은 차원을 고정하지 않아 다른
차원의 모델로 새 database를 시작할 수 있지만, 한 database 안에서 embedding 차원을 섞을
수는 없다. 모델을 바꾸면 기존 메모리를 비우거나 전부 다시 embedding해야 한다.

서버가 시작될 때 schema를 멱등하게 생성한다. v0.8의 `metadata`/`objects` schema를 발견하면
기존 테이블을 삭제하고 현재 schema를 만든다. 개발 단계의 의도적인 파괴적 전환이며 기존
S3 또는 PostgreSQL 데이터 migration은 제공하지 않는다.

## 요구 사항

- Node.js 24 이상
- PostgreSQL 18과 pgvector
- Bedrock 또는 OpenAI-compatible embedding endpoint

## 설정

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DATABASE_URL` | 없음 | 필수 PostgreSQL connection URL |
| `PORT` | `3000` | HTTP listen port |
| `MCP_API_KEY` | 없음 | 설정하면 `Authorization: Bearer …`를 요구한다 |
| `EMBEDDING_PROVIDER` | `bedrock` | `bedrock` 또는 `openai` |
| `EMBEDDING_BASE_URL` | 없음 | OpenAI-compatible endpoint의 `/v1` base URL |
| `EMBEDDING_API_KEY` | 없음 | OpenAI-compatible endpoint key |
| `EMBEDDING_MODEL` | provider 기본값 | 전송할 embedding model id |
| `EMBEDDING_DIM` | Bedrock `1024`, OpenAI `1536` | 응답 vector 차원 |
| `AWS_REGION` | `ap-northeast-2` | Bedrock을 사용할 때의 region |
| `RECALL_MIN_SIMILARITY` | `0.1` | 무관한 후보를 제거하는 cosine 하한 `(0, 1]` |

`VECTOR_BUCKET`, `VECTOR_INDEX`, `STATE_BUCKET`, `KNOWLEDGE_BASE_ID`, `STATS_FLUSH_MS`,
`STATS_COMPACT_THRESHOLD`는 제거됐다.

IDC에서는 AWS 의존성을 피하기 위해 Agent Studio와 같은 OpenAI-compatible embedding
endpoint를 사용하는 구성을 권장한다.

```bash
export DATABASE_URL=postgres://mcp_memory:mcp_memory@127.0.0.1:5434/mcp_memory
export EMBEDDING_PROVIDER=openai
export EMBEDDING_BASE_URL=http://127.0.0.1:8001/v1
export EMBEDDING_API_KEY=not-required
export EMBEDDING_MODEL=selfhosted/Qwen/Qwen3-Embedding-4B
export EMBEDDING_DIM=2560
```

## 로컬 개발

로컬 PostgreSQL을 시작한다. `docker compose down -v`는 개발 데이터를 삭제하므로 대상을
확인하지 않고 실행하지 마라.

```bash
docker compose up -d postgres
npm ci
DATABASE_URL=postgres://mcp_memory:mcp_memory@127.0.0.1:5434/mcp_memory npm run dev
```

검증은 다음과 같이 실행한다.

```bash
npm run typecheck
npm test
npm run build
TEST_DATABASE_URL=postgres://mcp_memory:mcp_memory@127.0.0.1:5434/mcp_memory npm test
```

## 실행과 health check

```bash
npm run build
DATABASE_URL=postgres://mcp_memory:secret@postgres:5432/mcp_memory npm start
```

- MCP endpoint: `POST /mcp`
- liveness: `GET /health`
- tenant: `X-Tenant-Id` header
- 선택 conversation scope: `X-Conversation-Id` header

브라우저 origin 요청은 거부한다. `MCP_API_KEY`를 설정한 배포는 Bearer token 없이는 MCP
호출을 허용하지 않는다.

## IDC 배포

[`dockpad`](../dockpad)의 IDC 배포처럼 Agent Studio가 소유한 PostgreSQL 18/pgvector와
`agent-studio_default` network를 공유한다. 배포 절차는 다음 계약을 지킨다.

1. 배포 스크립트가 공유 PostgreSQL에 `mcp_memory` database를 만든다.
2. mcp-memory Compose project는 `agent-studio_default` external network에 참여한다.
3. `DATABASE_URL`은 `postgres:5432/mcp_memory`를 가리킨다.
4. embedding은 IDC에서 접근 가능한 OpenAI-compatible endpoint를 사용한다.
5. container health check는 `/health`를 확인한다.
6. backup은 `pg_dump mcp_memory`를 포함한다.

mcp-memory에는 MinIO 환경 변수나 bucket 초기화가 없다. Agent Studio artifact bucket과 Agent
Memory RAG bucket은 각 소유 project가 MinIO에 만들고 별도로 backup한다.

예시 service 설정은 다음과 같다.

```yaml
services:
  mcp-memory:
    image: ${IMAGE_REGISTRY}/mcp-memory:${MCP_MEMORY_TAG}
    restart: unless-stopped
    environment:
      PORT: "80"
      DATABASE_URL: postgres://agent_studio:${POSTGRES_PASSWORD}@postgres:5432/mcp_memory
      EMBEDDING_PROVIDER: openai
      EMBEDDING_BASE_URL: ${EMBEDDING_BASE_URL}
      EMBEDDING_API_KEY: ${EMBEDDING_API_KEY}
      EMBEDDING_MODEL: ${EMBEDDING_MODEL}
      EMBEDDING_DIM: ${EMBEDDING_DIM}
      RECALL_MIN_SIMILARITY: "0.5"
    networks:
      data:
        aliases:
          - mcp-memory.agent-mcps.svc.cluster.local

networks:
  data:
    external: true
    name: agent-studio_default
```

## 데이터 격리

tool argument로 tenant나 conversation을 받지 않는다. 서버가 인증된 요청 header에서 결정한
tenant와 conversation을 모든 SQL 조건에 넣는다. project scope 메모리는 tenant 전체에,
conversation scope 메모리는 같은 tenant와 conversation에만 보인다. 다른 tenant의 id를 알아도
조회하거나 삭제할 수 없다.

메모리 본문은 최대 32,000 bytes, category는 128 bytes, tag는 최대 20개이며 각 64 bytes다.
로그에는 query, 본문, tag, conversation id, embedding을 기록하지 않는다.
