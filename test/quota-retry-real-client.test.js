// Drives the real @googleapis/gmail client against a local HTTP server instead of the fake: the
// retry must read the errors the real client throws, and wrap objects whose properties are
// read-only and non-configurable, which a plain fake object never is.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gmail as gmailClient } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { handleTool } from '../dist/tools.js';
import { fakeClock, PER_MINUTE_QUOTA } from './fake-gmail.js';

const text = (result) => result.content.map(c => c.text).join('');

// The 4th argument a test gives handleTool: a clock that never really waits.
const retry = (clock, extra = {}) => ({ sleep: clock.sleep, now: clock.now, random: clock.random, ...extra });

// `refusals` is consumed one per request before the handler answers normally; `alwaysRefuse`
// refuses every request, for the case that never lets up. `requests` records what was asked.
let refusals = [];
let alwaysRefuse = null;
let requests = [];

const reset = () => { refusals = []; alwaysRefuse = null; requests = []; };

function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}

// How Gmail denies a request: a status, an error object with the reason under usageLimits, and
// optionally a retry-after header.
function sendRefusal(res, { status, reason, message, retryAfter }) {
    sendJson(res, status, {
        error: {
            code: status,
            message,
            errors: [{ message, domain: 'usageLimits', reason }],
            status: status === 429 ? 'RESOURCE_EXHAUSTED' : 'PERMISSION_DENIED',
        },
    }, retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) });
}

const MESSAGE = {
    id: 'm-1',
    threadId: 't-1',
    payload: {
        headers: [
            { name: 'Subject', value: 'Budget' },
            { name: 'From', value: 'anna@example.com' },
            { name: 'Date', value: 'Mon, 5 Oct 2026 10:00:00 +0200' },
        ],
    },
};

const handler = (req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: pathname });

    const refusal = alwaysRefuse ?? refusals.shift();
    if (refusal) {
        sendRefusal(res, refusal);
        return;
    }

    if (req.method === 'POST' && pathname.endsWith('/messages/send')) {
        sendJson(res, 200, { id: 'sent-9', threadId: 't-1' });
    } else if (req.method === 'GET' && pathname.endsWith('/messages/m-1')) {
        sendJson(res, 200, MESSAGE);
    } else if (req.method === 'GET' && pathname.endsWith('/messages')) {
        sendJson(res, 200, { messages: [{ id: 'm-1', threadId: 't-1' }] });
    } else {
        sendJson(res, 404, { error: { message: `unexpected request ${req.method} ${pathname}` } });
    }
};

const server = http.createServer(handler);
let gmail;

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const auth = new OAuth2Client('id', 'secret');
    auth.setCredentials({ access_token: 'token', expiry_date: Date.now() + 3600e3 });
    gmail = gmailClient({ version: 'v1', auth, rootUrl: `http://127.0.0.1:${server.address().port}/` });
});

after(() => new Promise((resolve) => server.close(resolve)));

const sends = () => requests.filter(r => r.method === 'POST' && r.path.endsWith('/messages/send'));
const lists = () => requests.filter(r => r.method === 'GET' && r.path.endsWith('/messages'));

const EMAIL = { to: ['dest@example.com'], subject: 'Hi', body: 'Body' };

test('send_email retries a 429 refusal on send and then answers with the sent id', async () => {
    reset();
    refusals.push({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA });
    const clock = fakeClock();
    const out = text(await handleTool(gmail, 'send_email', EMAIL, retry(clock)));

    assert.equal(out, 'Email sent successfully with ID: sent-9');
    assert.equal(sends().length, 2);
    assert.equal(clock.slept.length, 1);
});

test('send_email waits the retry-after Gmail asks for', async () => {
    reset();
    refusals.push({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA, retryAfter: 7 });
    const clock = fakeClock();
    const out = text(await handleTool(gmail, 'send_email', EMAIL, retry(clock)));

    assert.equal(out, 'Email sent successfully with ID: sent-9');
    assert.ok(clock.slept[0] >= 7000, `waited ${clock.slept[0]}ms`);
});

test('search_emails retries a 403 rateLimitExceeded on the list and then answers the message', async () => {
    reset();
    refusals.push({ status: 403, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA });
    const clock = fakeClock();
    const out = text(await handleTool(gmail, 'search_emails', { query: 'label:inbox' }, retry(clock)));

    assert.match(out, /ID: m-1/);
    assert.match(out, /Subject: Budget/);
    assert.equal(lists().length, 2);
});

test('send_email does not retry a refusal for missing scopes', async () => {
    reset();
    refusals.push({ status: 403, reason: 'insufficientPermissions', message: 'Request had insufficient authentication scopes.' });
    const clock = fakeClock();
    const out = text(await handleTool(gmail, 'send_email', EMAIL, retry(clock)));

    assert.equal(out, 'Error: Request had insufficient authentication scopes.');
    assert.equal(sends().length, 1);
    assert.equal(clock.slept.length, 0);
});

test('send_email gives up at the budget when the 429 never lets up', async () => {
    reset();
    alwaysRefuse = { status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA };
    const clock = fakeClock();
    const out = text(await handleTool(gmail, 'send_email', EMAIL, retry(clock, { budgetMs: 3000 })));

    assert.match(out, /^Error: Gmail refused this request for its per-minute quota/);
    assert.match(out, /Units per minute per user/);
    const waited = clock.slept.reduce((total, ms) => total + ms, 0);
    assert.ok(waited <= 3000, `waited ${waited}ms`);
});
