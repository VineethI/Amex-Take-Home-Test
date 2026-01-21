const fastify = require('fastify')({ logger: true });
const listenMock = require('../mock-server');

const eventApiCircuit = {
  state: 'CLOSED', 
  failureTimestamps: [],
  openUntil: 0,
  consecutiveSuccessInHalfOpen: 0,
  halfOpenMaxAttempts: 1,

  failureWindowMs: 30_000,
  failureThreshold: 3,

  baseOpenMs: 1_000,
  maxOpenMs: 30_000,
  openBackoffFactor: 2,
  currentOpenMs: 1_000,

  canRequest(_now = Date.now()) {
    if (this.state === 'CLOSED') return true;

    if (this.state === 'OPEN') {
      if (_now >= this.openUntil) {
        this.state = 'HALF_OPEN';
        this.consecutiveSuccessInHalfOpen = 0;
        return true;
      }
      return false;
    }

    return true;
  },

  recordFailure(now = Date.now()) {
    this.failureTimestamps = this.failureTimestamps.filter((t) => now - t <= this.failureWindowMs);
    this.failureTimestamps.push(now);

    if (this.state === 'HALF_OPEN') {
      this.open(now);
      return;
    }

    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.open(now);
    }
  },

  recordSuccess(_now = Date.now()) {
    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccessInHalfOpen += 1;
      if (this.consecutiveSuccessInHalfOpen >= this.halfOpenMaxAttempts) {
        this.close();
      }
    }
  },

  open(now = Date.now()) {
    this.state = 'OPEN';
    this.openUntil = now + this.currentOpenMs;
    this.currentOpenMs = Math.min(this.maxOpenMs, this.currentOpenMs * this.openBackoffFactor);
  },

  close() {
    this.state = 'CLOSED';
    this.failureTimestamps = [];
    this.openUntil = 0;
    this.consecutiveSuccessInHalfOpen = 0;
    this.currentOpenMs = this.baseOpenMs;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  let data;
  try {
    data = await resp.json();
  } catch (_err) {
    data = null;
  }
  return { resp, data };
}

async function postEventWithRetries(payload) {
  if (!eventApiCircuit.canRequest()) {
    const retryAfterSeconds = Math.max(1, Math.ceil((eventApiCircuit.openUntil - Date.now()) / 1000));
    return {
      ok: false,
      status: 503,
      data: {
        success: false,
        error: 'Service temporarily unavailable',
        message: 'Event API is unavailable (circuit open). Please retry later.'
      },
      retryAfterSeconds
    };
  }

  const maxAttempts = eventApiCircuit.state === 'HALF_OPEN' ? 1 : 3;
  let backoffMs = 200;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { resp, data } = await fetchJson('http://event.com/addEvent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (resp.ok && data && data.success === true) {
        eventApiCircuit.recordSuccess();
        return { ok: true, status: 200, data };
      }

      eventApiCircuit.recordFailure();

      if (attempt === maxAttempts) {
        const status = resp.status || 503;
        return {
          ok: false,
          status: status >= 400 ? status : 503,
          data: data || {
            success: false,
            error: 'Service temporarily unavailable',
            message: 'Event API returned an invalid response'
          }
        };
      }
    } catch (_err) {
      eventApiCircuit.recordFailure();
      if (attempt === maxAttempts) {
        return {
          ok: false,
          status: 503,
          data: {
            success: false,
            error: 'Service temporarily unavailable',
            message: 'Event API request failed'
          }
        };
      }
    }

    await sleep(backoffMs);
    backoffMs *= 2;
  }
}

fastify.get('/getUsers', async (request, reply) => {
  const resp = await fetch('http://event.com/getUsers');
  const data = await resp.json();
  reply.send(data);
});

fastify.post('/addEvent', async (request, reply) => {
  const payload = {
    id: new Date().getTime(),
    ...request.body
  };

  const result = await postEventWithRetries(payload);
  if (!result.ok) {
    if (result.retryAfterSeconds) {
      reply.header('Retry-After', String(result.retryAfterSeconds));
    }
    return reply.code(result.status).send(result.data);
  }

  return reply.send(result.data);
});

fastify.get('/getEvents', async (request, reply) => {
  const resp = await fetch('http://event.com/getEvents');
  const data = await resp.json();
  reply.send(data);
});

fastify.get('/getEventsByUserId/:id', async (request, reply) => {
  const { id } = request.params;

  const userResp = await fetch('http://event.com/getUserById/' + id);
  const userData = await userResp.json();
  const userEvents = Array.isArray(userData?.events) ? userData.events : [];

  const eventArray = await Promise.all(
    userEvents.map(async (eventId) => {
      const eventResp = await fetch('http://event.com/getEventById/' + eventId);
      return eventResp.json();
    })
  );

  reply.send(eventArray);
});

fastify.listen({ port: 3000 }, (err) => {
  listenMock();
  if (err) {
    fastify.log.error(err);
    process.exit();
  }
});
