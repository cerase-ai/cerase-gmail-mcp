// A request Gmail refuses for its per-minute quota is retried after a backoff instead of surfaced:
// on 11 October Gmail refused searches of 200, 100 and 100 results started together with
// «Quota exceeded … Units per minute per user». Nothing here waits on the wall clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTool } from '../dist/tools.js';
import { fakeGmail, message, googleError, fakeClock, PER_MINUTE_QUOTA } from './fake-gmail.js';

const text = (result) => result.content.map(c => c.text).join('');

const MESSAGES = [
    message({ id: 'msg-1', threadId: 'thread-1', headers: [['Subject', 'Budget Q3'], ['From', 'Anna <anna@example.com>'], ['Date', 'Mon, 5 Oct 2026 10:00:00 +0200']], text: 'one' }),
    message({ id: 'msg-2', threadId: 'thread-2', headers: [['Subject', 'Lunch'], ['From', 'Luca <luca@example.com>'], ['Date', 'Tue, 6 Oct 2026 12:00:00 +0200']], text: 'two' }),
    message({ id: 'msg-3', threadId: 'thread-3', headers: [['Subject', 'Deploy'], ['From', 'Giulia <giulia@example.com>'], ['Date', 'Wed, 7 Oct 2026 09:00:00 +0200']], text: 'three' }),
];

// The 4th argument a test gives handleTool: a clock that never really waits.
const retry = (clock, extra = {}) => ({ sleep: clock.sleep, now: clock.now, random: clock.random, ...extra });

test('search_emails retries a per-minute refusal on the list and one on a get, then answers as if nothing was refused', async () => {
    const expected = text(await handleTool(fakeGmail({ messages: MESSAGES }).gmail, 'search_emails', { query: 'label:inbox' }));

    const clock = fakeClock();
    const { gmail, calls } = fakeGmail({
        messages: MESSAGES,
        refusals: {
            'messages.list': [
                googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA }),
                googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA }),
            ],
            'messages.get': [
                googleError({ status: 403, reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }),
            ],
        },
    });
    const out = text(await handleTool(gmail, 'search_emails', { query: 'label:inbox' }, retry(clock)));

    assert.equal(out, expected);
    assert.equal(calls.list.length, 3);
    assert.ok(clock.slept.length >= 3, `retried ${clock.slept.length} times`);
    for (const ms of clock.slept) assert.ok(ms > 0, `waited ${ms}ms between attempts`);
});

test('search_emails gives up when the per-minute refusal never lets up, after waiting about a minute', async () => {
    const clock = fakeClock();
    const { gmail, calls } = fakeGmail({
        messages: MESSAGES,
        refusals: {
            'messages.list': googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA }),
        },
    });
    const out = text(await handleTool(gmail, 'search_emails', { query: 'label:inbox' }, retry(clock)));

    assert.match(out, /^Error: /);
    assert.match(out, /per-minute quota/);
    assert.match(out, /Units per minute per user/);
    assert.ok(calls.list.length > 1, `tried ${calls.list.length} times`);
    const waited = clock.slept.reduce((total, ms) => total + ms, 0);
    assert.ok(waited >= 60000, `waited ${waited}ms`);
    assert.ok(waited <= 90000, `waited ${waited}ms`);
});

test('search_emails does not retry a refusal for missing scopes, which waiting cannot fix', async () => {
    const clock = fakeClock();
    const { gmail, calls } = fakeGmail({
        messages: MESSAGES,
        refusals: {
            'messages.list': googleError({ status: 403, reason: 'insufficientPermissions', message: 'Request had insufficient authentication scopes.' }),
        },
    });
    const out = text(await handleTool(gmail, 'search_emails', { query: 'label:inbox' }, retry(clock)));

    assert.equal(out, 'Error: Request had insufficient authentication scopes.');
    assert.equal(calls.list.length, 1);
    assert.equal(clock.slept.length, 0);
});

test('search_emails does not retry a daily limit that waiting a minute cannot relieve', async () => {
    const clock = fakeClock();
    const { gmail, calls } = fakeGmail({
        messages: MESSAGES,
        refusals: {
            'messages.list': googleError({ status: 403, reason: 'dailyLimitExceeded', message: 'Daily Limit Exceeded' }),
        },
    });
    text(await handleTool(gmail, 'search_emails', { query: 'label:inbox' }, retry(clock)));

    assert.equal(calls.list.length, 1);
    assert.equal(clock.slept.length, 0);
});

test('search_emails honours the delay Gmail asks for in retry-after', async () => {
    const clock = fakeClock();
    const { gmail } = fakeGmail({
        messages: MESSAGES,
        refusals: {
            'messages.list': [
                googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA, retryAfter: 7 }),
            ],
        },
    });
    const out = text(await handleTool(gmail, 'search_emails', { query: 'label:inbox' }, retry(clock)));

    assert.match(out, /^ID: msg-1/m);
    assert.ok(clock.slept[0] >= 7000, `waited ${clock.slept[0]}ms`);
});

test('send_email retries a per-minute refusal and sends once Gmail accepts it', async () => {
    const clock = fakeClock();
    const { gmail, calls } = fakeGmail({
        refusals: {
            'messages.send': [
                googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA }),
            ],
        },
    });
    const out = text(await handleTool(
        gmail,
        'send_email',
        { to: ['dest@example.com'], subject: 'Hi', body: 'Body' },
        retry(clock)
    ));

    assert.equal(out, 'Email sent successfully with ID: sent-1');
    assert.equal(calls.send.length, 2);
});

test('search_emails stops retrying at the given budget instead of waiting out a full minute', async () => {
    const clock = fakeClock();
    const { gmail } = fakeGmail({
        messages: MESSAGES,
        refusals: {
            'messages.list': googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA }),
        },
    });
    const out = text(await handleTool(gmail, 'search_emails', { query: 'label:inbox' }, retry(clock, { budgetMs: 5000 })));

    assert.match(out, /^Error: /);
    const waited = clock.slept.reduce((total, ms) => total + ms, 0);
    assert.ok(clock.slept.length > 0, 'it retried before giving up');
    assert.ok(waited <= 5000, `waited ${waited}ms`);
});
