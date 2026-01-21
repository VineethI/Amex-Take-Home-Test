# challenge-backend (Event Management System)

Node.js + Fastify service that proxies an external "Event API".
In this repo the external API is simulated using **MSW** (Mock Service Worker) in `mock-server/`.

## Requirements

- Node.js 18+ (uses the built-in `fetch`)

## Install

```bash
npm i
```

## Run

```bash
npm start
```

The API listens on: `http://localhost:3000`

## Scripts

- `npm start` - run the service
- `npm run dev` - run with node watch mode
- `npm run lint` - run ESLint
- `npm run format` - run Prettier
- `npm test` - run Node's built-in test runner (placeholder for now)

## Endpoints

- `GET /getUsers` - list users
- `GET /getEvents` - list events
- `GET /getEventsByUserId/:id` - list events for a user
- `POST /addEvent` - schedule a new event

### Example: add event

```bash
curl --location --request POST 'http://localhost:3000/addEvent' \
  --header 'Content-Type: application/json' \
  --data-raw '{
    "name": "hello",
    "userId": "3"
  }'
```

## What was changed (Tasks)

### Task 1: repository configuration

Added baseline "production-ready" project hygiene:

- `README.md` with setup/run/scripts and behaviour notes
- `eslint.config.js` (ESLint) and `.prettierrc.json` (Prettier)
- `.gitignore`
- `package.json` scripts for `dev`, `lint`, `format`, `test`

Notes:
- Linting/formatting is intentionally lightweight to keep the repo small.
- Testing is wired to Node's built-in test runner; no tests were added beyond wiring due to time.

### Task 2: performance improvement (`GET /getEventsByUserId/:id`)

Problem:
- The mock external endpoint `GET http://event.com/getEventById/:id` has an intentional `~500ms` delay.
- The original implementation fetched each event **sequentially**, making total time scale linearly: `N events => ~N * 500ms`.

Fix:
- Fetch event details **in parallel** using `Promise.all`, preserving the intentional per-request delay, but removing unnecessary sequential waiting.

How to validate:
1. Add many events for a user via `POST /addEvent`.
2. Call `GET /getEventsByUserId/:id`.
3. Response time should no longer grow linearly with number of events (it should be closer to the slowest single external call).

### Task 3: resilience improvement (`POST /addEvent`)

The external endpoint `POST http://event.com/addEvent` is mocked to:
- succeed for the first 5 calls
- then fail with `503` for the next 10 calls (repeats)

Implemented a small in-memory circuit breaker + retry/backoff in `services/index.js`:

- Tracks failures in a rolling **30s window**
- Opens the circuit when there are **3+ failures** in that window
- While open:
  - rejects immediately with `503 Service Unavailable`
  - includes `Retry-After` header telling clients when to retry
- After a cooldown:
  - moves to HALF_OPEN and allows a limited "probe" request
  - on success, closes the circuit and resumes normal operation
  - on failure, reopens (with exponential backoff on the open duration)

This reduces load on the external service during failure periods and gradually tests recovery.

## Notes / Limitations

- Circuit breaker state is in-memory: restarting the server resets it.
- No request queueing was added; when the circuit is open, callers get a fast `503` response.
