// The list_drafts and delete_draft tools, through the tool handler: against the fake client for
// the argument handling and errors, and against the real @googleapis/gmail client on a local HTTP
// server for the calls that would really go out.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gmail as gmailClient } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { listTools, handleTool } from '../dist/tools.js';
import { fakeGmail, message, decodeRaw, googleError, fakeClock, PER_MINUTE_QUOTA } from './fake-gmail.js';

const text = (result) => result.content.map(c => c.text).join('');

const DRAFT_ONE = {
    id: 'r-1',
    message: message({
        id: 'm-1',
        threadId: 't-1',
        headers: [
            ['Subject', 'Budget'],
            ['To', 'anna@example.com'],
            ['Date', 'Mon, 5 Oct 2026 10:00:00 +0200'],
        ],
    }),
};

// A lowercase `subject` header to prove the lookup ignores case, and no To at all.
const DRAFT_TWO = {
    id: 'r-2',
    message: message({
        id: 'm-2',
        threadId: 't-2',
        headers: [
            ['subject', 'Lunch'],
            ['Date', 'Tue, 6 Oct 2026 12:00:00 +0200'],
        ],
    }),
};

// A reply draft, with the threading headers a reply carries.
const REPLY_DRAFT = {
    id: 'r-7',
    message: message({
        id: 'm-7',
        threadId: 't-7',
        headers: [
            ['In-Reply-To', '<orig@example.com>'],
            ['References', '<a@example.com> <orig@example.com>'],
        ],
    }),
};

const TWO_DRAFTS = [DRAFT_ONE, DRAFT_TWO];

const EXPECTED_TWO_DRAFTS = [
    'ID: r-1',
    'Subject: Budget',
    'To: anna@example.com',
    'Date: Mon, 5 Oct 2026 10:00:00 +0200',
    '',
    'ID: r-2',
    'Subject: Lunch',
    'To: ',
    'Date: Tue, 6 Oct 2026 12:00:00 +0200',
    '',
].join('\n');

const EMPTY_DRAFT_ID = 'Error: draftId is empty: give the draft\'s ID, as draft_email or list_drafts answer it';

test('delete_draft calls drafts.delete and answers the draft id', async () => {
    const draft = { id: 'r-123', message: message({ id: 'm-123', threadId: 't-123' }) };
    const { gmail, calls } = fakeGmail({ drafts: [draft] });
    const result = await handleTool(gmail, 'delete_draft', { draftId: 'r-123' });
    assert.equal(text(result), 'Draft r-123 deleted successfully');
    assert.equal(calls.draftDeletes.length, 1);
    assert.deepEqual(calls.draftDeletes[0], { userId: 'me', id: 'r-123' });
});

test('delete_draft refuses an empty draft id without calling Gmail', async () => {
    const { gmail, calls } = fakeGmail();
    for (const draftId of ['', '   ']) {
        assert.equal(text(await handleTool(gmail, 'delete_draft', { draftId })), EMPTY_DRAFT_ID);
    }
    assert.match(text(await handleTool(gmail, 'delete_draft', {})), /^Error:/);
    assert.equal(calls.draftDeletes.length, 0);
});

test('delete_draft answers a Gmail error', async () => {
    const { gmail } = fakeGmail();
    assert.equal(text(await handleTool(gmail, 'delete_draft', { draftId: 'nope' })), 'Error: Requested entity was not found.');
});

test('delete_draft retries a per-minute quota refusal', async () => {
    const clock = fakeClock();
    const { gmail, calls } = fakeGmail({
        drafts: [DRAFT_ONE],
        refusals: { 'drafts.delete': [googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA })] },
    });
    const result = await handleTool(gmail, 'delete_draft', { draftId: 'r-1' }, { sleep: clock.sleep, now: clock.now, random: clock.random });
    assert.equal(text(result), 'Draft r-1 deleted successfully');
    assert.equal(calls.draftDeletes.length, 2);
    assert.equal(clock.slept.length, 1);
});

test('list_drafts answers one block per draft, in the listed order', async () => {
    const { gmail, calls } = fakeGmail({ drafts: TWO_DRAFTS });
    const result = await handleTool(gmail, 'list_drafts', {});
    assert.equal(text(result), EXPECTED_TWO_DRAFTS);
    assert.equal(calls.draftLists.length, 1);
    assert.equal(calls.draftLists[0].maxResults, 20);
    assert.deepEqual(calls.draftGets.map(c => c.id), ['r-1', 'r-2']);
    for (const c of calls.draftGets) assert.equal(c.format, 'metadata');
});

test('list_drafts clamps maxResults to the API range', async () => {
    const low = fakeGmail({ drafts: TWO_DRAFTS });
    await handleTool(low.gmail, 'list_drafts', { maxResults: 5 });
    assert.equal(low.calls.draftLists[0].maxResults, 5);

    const high = fakeGmail({ drafts: TWO_DRAFTS });
    await handleTool(high.gmail, 'list_drafts', { maxResults: 500 });
    assert.equal(high.calls.draftLists[0].maxResults, 100);
});

test('list_drafts reports an empty mailbox and fetches nothing', async () => {
    const { gmail, calls } = fakeGmail();
    assert.equal(text(await handleTool(gmail, 'list_drafts', {})), 'No drafts in the mailbox.');
    assert.equal(calls.draftGets.length, 0);
});

test('get_draft answers one block in the form list_drafts uses', async () => {
    const { gmail, calls } = fakeGmail({ drafts: [DRAFT_ONE] });
    const result = await handleTool(gmail, 'get_draft', { draftId: 'r-1' });
    assert.equal(text(result), [
        'ID: r-1',
        'Subject: Budget',
        'To: anna@example.com',
        'Date: Mon, 5 Oct 2026 10:00:00 +0200',
        '',
    ].join('\n'));
    assert.deepEqual(calls.draftGets, [{ userId: 'me', id: 'r-1', format: 'metadata' }]);
});

test('get_draft refuses an empty draft id without calling Gmail', async () => {
    const { gmail, calls } = fakeGmail();
    for (const draftId of ['', '   ']) {
        assert.equal(text(await handleTool(gmail, 'get_draft', { draftId })), EMPTY_DRAFT_ID);
    }
    assert.match(text(await handleTool(gmail, 'get_draft', {})), /^Error:/);
    assert.equal(calls.draftGets.length, 0);
});

test('get_draft answers a Gmail error', async () => {
    const { gmail } = fakeGmail();
    assert.equal(text(await handleTool(gmail, 'get_draft', { draftId: 'nope' })), 'Error: Requested entity was not found.');
});

test('update_draft calls drafts.update with the trimmed draft id and the new message', async () => {
    const { gmail, calls } = fakeGmail({ drafts: [DRAFT_ONE] });
    const result = await handleTool(gmail, 'update_draft', {
        draftId: ' r-1 ',
        to: ['luca@example.com'],
        subject: 'New budget',
        body: 'Here it is.',
    });
    assert.equal(text(result), 'Email draft updated successfully with ID: r-1\nThread ID: t-1');
    assert.equal(calls.draftUpdates.length, 1);
    const call = calls.draftUpdates[0];
    assert.equal(call.userId, 'me');
    assert.equal(call.id, 'r-1');
    assert.equal(call.requestBody.id, 'r-1');
    const raw = decodeRaw(call.requestBody.message.raw);
    assert.match(raw, /^To: luca@example\.com\r?$/m);
    assert.match(raw, /^Subject: New budget\r?$/m);
    assert.match(raw, /^Here it is\.\r?$/m);
});

test('update_draft keeps a reply draft in its conversation', async () => {
    const { gmail, calls } = fakeGmail({ drafts: [REPLY_DRAFT] });
    const result = await handleTool(gmail, 'update_draft', {
        draftId: 'r-7',
        to: ['anna@example.com'],
        subject: 'Re: Budget',
        body: 'New reply.',
    });
    assert.equal(text(result), 'Email draft updated successfully with ID: r-7\nThread ID: t-7');
    assert.equal(calls.draftGets.length, 1);
    assert.equal(calls.draftGets[0].format, 'metadata');
    assert.equal(calls.draftUpdates[0].requestBody.message.threadId, 't-7');
    const raw = decodeRaw(calls.draftUpdates[0].requestBody.message.raw);
    assert.match(raw, /^In-Reply-To: <orig@example\.com>\r?$/m);
    assert.match(raw, /^References: <a@example\.com> <orig@example\.com>\r?$/m);
});

test("update_draft lets a caller's threadId and inReplyTo win over the draft's", async () => {
    const { gmail, calls } = fakeGmail({ drafts: [REPLY_DRAFT] });
    await handleTool(gmail, 'update_draft', {
        draftId: 'r-7',
        to: ['anna@example.com'],
        subject: 'Re: Budget',
        body: 'New reply.',
        threadId: 't-8',
        inReplyTo: '<new@example.com>',
    });
    assert.equal(calls.draftUpdates[0].requestBody.message.threadId, 't-8');
    const raw = decodeRaw(calls.draftUpdates[0].requestBody.message.raw);
    assert.match(raw, /^In-Reply-To: <new@example\.com>\r?$/m);
    assert.doesNotMatch(raw, /^In-Reply-To: <orig@example\.com>\r?$/m);
});

test('update_draft carries an HTML body as text/html', async () => {
    const { gmail, calls } = fakeGmail({ drafts: [DRAFT_ONE] });
    await handleTool(gmail, 'update_draft', {
        draftId: 'r-1',
        to: ['anna@example.com'],
        subject: 'Budget',
        body: 'Budget',
        htmlBody: '<p>Budget</p>',
        mimeType: 'text/html',
    });
    const raw = decodeRaw(calls.draftUpdates[0].requestBody.message.raw);
    assert.match(raw, /^Content-Type: text\/html/m);
    assert.match(raw, /<p>Budget<\/p>/);
});

test('update_draft refuses an empty draft id without calling Gmail', async () => {
    const { gmail, calls } = fakeGmail({ drafts: [DRAFT_ONE] });
    const content = { to: ['anna@example.com'], subject: 'Budget', body: 'Body' };
    for (const draftId of ['', '   ']) {
        assert.equal(text(await handleTool(gmail, 'update_draft', { draftId, ...content })), EMPTY_DRAFT_ID);
    }
    assert.match(text(await handleTool(gmail, 'update_draft', content)), /^Error:/);
    assert.equal(calls.draftUpdates.length, 0);
    assert.equal(calls.draftGets.length, 0);
});

test('update_draft answers a Gmail error for an unknown draft', async () => {
    const { gmail, calls } = fakeGmail();
    const result = await handleTool(gmail, 'update_draft', {
        draftId: 'nope',
        to: ['anna@example.com'],
        subject: 'Budget',
        body: 'Body',
    });
    assert.equal(text(result), 'Error: Requested entity was not found.');
    assert.equal(calls.draftUpdates.length, 0);
});

test('update_draft retries a per-minute quota refusal', async () => {
    const clock = fakeClock();
    const { gmail, calls } = fakeGmail({
        drafts: [DRAFT_ONE],
        refusals: { 'drafts.update': [googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA })] },
    });
    const result = await handleTool(
        gmail,
        'update_draft',
        { draftId: 'r-1', to: ['anna@example.com'], subject: 'Budget', body: 'New body' },
        { sleep: clock.sleep, now: clock.now, random: clock.random }
    );
    assert.equal(text(result), 'Email draft updated successfully with ID: r-1\nThread ID: t-1');
    assert.equal(calls.draftUpdates.length, 2);
    assert.equal(clock.slept.length, 1);
});

test('update_draft keeps its input schema and description', () => {
    const tool = listTools().find(t => t.name === 'update_draft');
    assert.ok(tool, 'update_draft is listed');
    assert.deepEqual(Object.keys(tool.inputSchema.properties), [
        'draftId', 'to', 'subject', 'body', 'htmlBody', 'mimeType', 'cc', 'bcc', 'threadId', 'inReplyTo', 'attachments',
    ]);
    for (const key of ['draftId', 'to', 'subject', 'body']) {
        assert.ok(tool.inputSchema.required.includes(key), `${key} is required`);
    }
    assert.match(tool.description, /draft_email/);
    assert.match(tool.description, /list_drafts/);
    assert.match(tool.description, /conversation/i);
});

test('list_drafts, delete_draft, get_draft and update_draft are listed right after reply_email', () => {
    const names = listTools().map(t => t.name);
    assert.equal(names.length, 24);
    const at = names.indexOf('reply_email');
    assert.equal(names[at + 1], 'list_drafts');
    assert.equal(names[at + 2], 'delete_draft');
    assert.equal(names[at + 3], 'get_draft');
    assert.equal(names[at + 4], 'update_draft');
});

test('delete_draft keeps its input schema and description', () => {
    const tool = listTools().find(t => t.name === 'delete_draft');
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['draftId']);
    assert.deepEqual(tool.inputSchema.required, ['draftId']);
    assert.equal(tool.inputSchema.properties.draftId.type, 'string');
    assert.match(tool.description, /permanently/i);
    assert.match(tool.description, /Trash/);
    assert.match(tool.description, /list_drafts/);
});

test('list_drafts keeps its input schema and description', () => {
    const tool = listTools().find(t => t.name === 'list_drafts');
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['maxResults']);
    assert.equal(tool.inputSchema.properties.maxResults.type, 'number');
    assert.ok(!tool.inputSchema.required || tool.inputSchema.required.length === 0);
    assert.match(tool.description, /delete_draft/);
});

test('get_draft keeps its input schema and description', () => {
    const tool = listTools().find(t => t.name === 'get_draft');
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['draftId']);
    assert.deepEqual(tool.inputSchema.required, ['draftId']);
    assert.equal(tool.inputSchema.properties.draftId.type, 'string');
    assert.match(tool.description, /list_drafts/);
});

// The real client: a local server stands in for Gmail, so the tests read the requests the
// googleapis client would really put on the wire.
let requests = [];
const reset = () => { requests = []; };

function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}

const REAL_HEADERS = [
    { name: 'Subject', value: 'Budget' },
    { name: 'To', value: 'anna@example.com' },
    { name: 'Date', value: 'Mon, 5 Oct 2026 10:00:00 +0200' },
];

const handler = (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const request = { method: req.method, path: url.pathname, query: url.searchParams };

    if (req.method === 'PUT') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            requests.push({ ...request, body });
            if (url.pathname.endsWith('/users/me/drafts/r-9')) {
                sendJson(res, 200, { id: 'r-9', message: { id: 'm-10', threadId: 't-9' } });
            } else {
                sendJson(res, 404, { error: { message: `unexpected request ${req.method} ${url.pathname}` } });
            }
        });
        return;
    }

    requests.push(request);

    if (req.method === 'DELETE' && url.pathname.endsWith('/users/me/drafts/r-9')) {
        res.writeHead(204);
        res.end();
    } else if (req.method === 'GET' && url.pathname.endsWith('/users/me/drafts/r-9')) {
        sendJson(res, 200, { id: 'r-9', message: { id: 'm-9', threadId: 't-9', payload: { headers: REAL_HEADERS } } });
    } else if (req.method === 'GET' && url.pathname.endsWith('/users/me/drafts')) {
        sendJson(res, 200, { drafts: [{ id: 'r-9', message: { id: 'm-9', threadId: 't-9' } }] });
    } else {
        sendJson(res, 404, { error: { message: `unexpected request ${req.method} ${url.pathname}` } });
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

test('delete_draft sends one DELETE to the draft URL', async () => {
    reset();
    const result = await handleTool(gmail, 'delete_draft', { draftId: 'r-9' });
    assert.equal(text(result), 'Draft r-9 deleted successfully');
    const deletes = requests.filter(r => r.method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.ok(deletes[0].path.endsWith('/gmail/v1/users/me/drafts/r-9'), deletes[0].path);
});

test('list_drafts lists the drafts and fetches each one metadata', async () => {
    reset();
    const result = await handleTool(gmail, 'list_drafts', {});
    assert.equal(text(result), [
        'ID: r-9',
        'Subject: Budget',
        'To: anna@example.com',
        'Date: Mon, 5 Oct 2026 10:00:00 +0200',
        '',
    ].join('\n'));

    const listed = requests.find(r => r.method === 'GET' && r.path.endsWith('/gmail/v1/users/me/drafts'));
    assert.ok(listed, JSON.stringify(requests));
    assert.equal(listed.query.get('maxResults'), '20');

    const fetched = requests.find(r => r.method === 'GET' && r.path.endsWith('/gmail/v1/users/me/drafts/r-9'));
    assert.ok(fetched, JSON.stringify(requests));
    assert.equal(fetched.query.get('format'), 'metadata');
});

test('get_draft sends one GET to the draft URL, metadata', async () => {
    reset();
    const result = await handleTool(gmail, 'get_draft', { draftId: 'r-9' });
    assert.equal(text(result), [
        'ID: r-9',
        'Subject: Budget',
        'To: anna@example.com',
        'Date: Mon, 5 Oct 2026 10:00:00 +0200',
        '',
    ].join('\n'));

    const fetched = requests.find(r => r.method === 'GET' && r.path.endsWith('/gmail/v1/users/me/drafts/r-9'));
    assert.ok(fetched, JSON.stringify(requests));
    assert.equal(fetched.query.get('format'), 'metadata');
});

test('update_draft sends one metadata GET and one PUT with the new raw message', async () => {
    reset();
    const result = await handleTool(gmail, 'update_draft', {
        draftId: 'r-9',
        to: ['anna@example.com'],
        subject: 'Budget',
        body: 'New body',
    });
    assert.equal(text(result), 'Email draft updated successfully with ID: r-9\nThread ID: t-9');

    const fetched = requests.find(r => r.method === 'GET' && r.path.endsWith('/gmail/v1/users/me/drafts/r-9'));
    assert.ok(fetched, JSON.stringify(requests));
    assert.equal(fetched.query.get('format'), 'metadata');

    const puts = requests.filter(r => r.method === 'PUT');
    assert.equal(puts.length, 1);
    assert.ok(puts[0].path.endsWith('/gmail/v1/users/me/drafts/r-9'), puts[0].path);
    const body = JSON.parse(puts[0].body);
    assert.equal(body.id, 'r-9');
    assert.equal(body.message.threadId, 't-9');
    assert.equal(typeof body.message.raw, 'string');
});
