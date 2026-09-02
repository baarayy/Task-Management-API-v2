# Task Management API

A production-shaped task management backend: TypeScript, Express 5, MongoDB,
Redis, BullMQ and RabbitMQ, with JWT authentication, role-based access control
and an auditable history of every change.

```bash
cp .env.example .env
docker compose up --build
npm install && npm run seed
curl localhost:3000/health
```

That brings up MongoDB (as a single-node replica set, so transactions work),
Redis, RabbitMQ, the API on `:3000` and the background worker, then loads the
seed fixtures.

## Contents

| Document                                     | What is in it                                                       |
| -------------------------------------------- | ------------------------------------------------------------------- |
| [docs/SCHEMA.md](docs/SCHEMA.md)             | Collections, ER diagram, indexing strategy, aggregation pipelines   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System and sequence diagrams, layering, caching, RabbitMQ vs BullMQ |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)     | AWS target architecture, CI/CD pipeline, hardening, cost            |

## Stack

TypeScript (strict) · Express 5 · Mongoose 8 · Zod · ioredis · BullMQ ·
amqplib · argon2 · helmet · pino · Vitest + supertest + mongodb-memory-server.

## Endpoints

All routes are prefixed `/api/v1`. Everything except `/health` and the
registration/login pair requires `Authorization: Bearer <accessToken>`.

### Auth

| Method | Path             | Notes                                               |
| ------ | ---------------- | --------------------------------------------------- |
| `POST` | `/auth/register` | Self-registration; always creates a `user`          |
| `POST` | `/auth/login`    | Returns an access + refresh token pair              |
| `POST` | `/auth/refresh`  | Rotates the refresh token; reuse revokes the family |
| `POST` | `/auth/logout`   | `{ allDevices: true }` kills every session          |
| `GET`  | `/auth/me`       | Current user                                        |

### Tasks

| Method   | Path                     | Who                                                  |
| -------- | ------------------------ | ---------------------------------------------------- |
| `POST`   | `/tasks`                 | Admin, Manager                                       |
| `GET`    | `/tasks/:id`             | Admin, Manager, or a participant                     |
| `PUT`    | `/tasks/:id`             | Admin, Manager (any field); assignee (`status` only) |
| `DELETE` | `/tasks/:id`             | Manager (soft); Admin (`?hard=true`)                 |
| `GET`    | `/tasks/user/:userId`    | Own tasks; Admin/Manager may list anyone's           |
| `GET`    | `/tasks/:id/history`     | Unified timeline (aggregation)                       |
| `GET`    | `/tasks/:id/interactors` | Who touched this task (aggregation)                  |

### Comments, notifications, users

| Method         | Path                             | Who                                                  |
| -------------- | -------------------------------- | ---------------------------------------------------- |
| `POST` / `GET` | `/tasks/:id/comments`            | Any participant                                      |
| `DELETE`       | `/tasks/:id/comments/:commentId` | Author, or Admin/Manager                             |
| `GET`          | `/notifications`                 | Own inbox; `?unreadOnly=true`                        |
| `PATCH`        | `/notifications/:id/read`        | Own notifications                                    |
| `GET`          | `/users`                         | Admin, Manager                                       |
| `POST`         | `/users`                         | Admin — the only way to create a privileged account  |
| `PATCH`        | `/users/:id`                     | Admin; a role or status change revokes live sessions |

### `GET /tasks/user/:userId` query parameters

`page` (≥1) · `limit` (1–100) · `status` · `priority` · `tags` · `dueBefore` ·
`dueAfter` · `q` (full-text) · `sortBy` (`dueDate`, `createdAt`, `updatedAt`,
`priority`, `status`) · `sortOrder` · `includeDeleted`

Responds with `{ data, meta: { page, limit, total, totalPages, hasNext } }` and
an `X-Cache: HIT | MISS` header.

## Walkthrough

Seeded credentials — `admin@taskflow.dev` / `AdminPass123`,
`manager@taskflow.dev` / `ManagerPass123`, `dev1@taskflow.dev` / `UserPass123`.

```bash
API=http://localhost:3000/api/v1

# 1. Log in as the manager
TOKEN=$(curl -s -X POST $API/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"manager@taskflow.dev","password":"ManagerPass123"}' | jq -r .accessToken)

# 2. Create a task assigned to a developer
TASK=$(curl -s -X POST $API/tasks \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Ship the release","priority":"high",
       "assignees":["650000000000000000000003"]}' | jq -r ._id)

# 3. List that developer's tasks - note X-Cache: MISS, then HIT
curl -si "$API/tasks/user/650000000000000000000003?status=todo&limit=5" \
  -H "Authorization: Bearer $TOKEN" | grep -i x-cache

# 4. Update the task - this invalidates the cache and publishes an event
curl -s -X PUT $API/tasks/$TASK \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"in_progress"}' | jq '{status, updatedAt}'

# 5. The unified timeline
curl -s $API/tasks/$TASK/history -H "Authorization: Bearer $TOKEN" \
  | jq '{counts, timeline: [.timeline[] | {type, action, at}]}'

# 6. Who has interacted with it
curl -s $API/tasks/$TASK/interactors -H "Authorization: Bearer $TOKEN" | jq '.data'

# 7. RBAC - a plain user cannot delete
USER_TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"dev1@taskflow.dev","password":"UserPass123"}' | jq -r .accessToken)
curl -s -X DELETE $API/tasks/$TASK -H "Authorization: Bearer $USER_TOKEN" | jq .error
```

Watch the worker consume the event and write the notification:

```bash
docker compose logs -f worker
```

## Development

```bash
npm run dev          # API with reload
npm run dev:worker   # worker with reload
npm run seed         # load fixtures (--keep to skip the wipe)
npm run explain      # explain() over the hot queries - proves the indexes
npm test             # 70 integration tests
npm run test:coverage
npm run lint && npm run typecheck
```

Tests run against an in-memory MongoDB replica set with Redis, BullMQ and
RabbitMQ stubbed at their module boundaries, so `npm test` needs no Docker and
no external services.

## Design decisions

Six choices that shaped the implementation. The reasoning is in the docs; the
short version:

**Refresh tokens are stateful.** They are stored hashed in Redis and rotated on
every use. A purely stateless refresh token stays valid for its full lifetime
once stolen, and logout becomes a lie. Replaying a consumed token revokes the
entire token family — the standard reuse-detection response to a theft you
cannot otherwise distinguish from normal use.

**Authorisation is enforced in the service layer.** Route middleware handles the
coarse question ("may this role call DELETE?"); the row-level rules ("may this
person touch this record?") live next to the loaded document. A route added later
without the right middleware still cannot leak data.

**Assignments are stored twice, deliberately.** `user_tasks` is the source of
truth for assignment metadata and enforces uniqueness at the database level;
`tasks.assignees` is a denormalised read optimisation that turns the hottest
query into one multikey index scan. Both are written in a single transaction.

**Cache invalidation is tag-based.** A user's cached task list can be invalidated
by another user's write, and scanning the keyspace for matching keys does not
scale. Each key is registered in a per-user Redis set, so invalidation is O(live
entries for that user) rather than O(keyspace).

**RabbitMQ and BullMQ both exist because they carry different things.**
RabbitMQ carries facts that any number of unknown consumers may subscribe to;
BullMQ carries work that needs retries, backoff and a dead-letter path. The
worker is the seam between them.

**History is append-only and separate.** Nothing updates or deletes a history
document. That immutability is what makes the collection usable as evidence, and
keeping it out of the task document keeps task reads constant-size.

## Project layout

```
src/
  config/env.ts          Zod-validated environment, fails fast at boot
  lib/                   db, redis, rabbit, cache, logger, errors
  models/                six Mongoose schemas + index declarations
  middleware/            authenticate, rbac, validate, sanitize, rateLimit, errorHandler
  modules/
    auth/                tokens, service, routes
    tasks/               schema, policy, aggregations, service, controller, routes
    comments/  notifications/  users/
  queues/                BullMQ queue + worker
  events/                RabbitMQ publisher + consumer
  app.ts  server.ts  worker.ts
tests/integration/       70 tests
docs/  seed/  scripts/
```
