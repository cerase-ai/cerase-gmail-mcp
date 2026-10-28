// Every tool call that fails comes back as an MCP tool result with isError true:
// a refusal from Gmail, a retry that ran out, a batch where every item failed,
// and an argument refused before Gmail is reached. A call that succeeds and a
// batch that only partly failed stay ordinary results.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gmail as gmailClient } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { listTools, handleTool } from '../dist/tools.js';
import { fakeGmail, message, googleError, refusingGmail, fakeClock, PER_MINUTE_QUOTA } from './fake-gmail.js';

const text = (result) => result.content.map(c => c.text).join('');

// The 4th argument a test gives handleTool: a clock that never really waits.
const retry = (clock, extra = {}) => ({ sleep: clock.sleep, now: clock.now, random: clock.random, ...extra });

const DOWNLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-failures-'));
after(() => fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true }));

// Minimal arguments that pass each tool's schema.
const VALID_ARGS = {
    send_email: { to: ['anna@example.com'], subject: 'Hi', body: 'Body' },
    draft_email: { to: ['anna@example.com'], subject: 'Hi', body: 'Body' },
    reply_email: { messageId: 'msg-1', body: 'Body' },
    list_drafts: {},
    delete_draft: { draftId: 'draft-1' },
    get_draft: { draftId: 'draft-1' },
    update_draft: { draftId: 'draft-1', to: ['anna@example.com'], subject: 'Hi', body: 'Body' },
    read_email: { messageId: 'msg-1' },
    search_emails: { query: 'from:anna@example.com' },
    modify_email: { messageId: 'msg-1', addLabelIds: ['Label_1'] },
    delete_email: { messageId: 'msg-1' },
    list_email_labels: {},
    batch_modify_emails: { messageIds: ['msg-1', 'msg-2'], addLabelIds: ['Label_1'] },
    batch_delete_emails: { messageIds: ['msg-1', 'msg-2'] },
    create_label: { name: 'Label_1' },
    update_label: { id: 'Label_1', name: 'Label 1' },
    delete_label: { id: 'Label_1' },
    get_or_create_label: { name: 'Label_1' },
    create_filter: { criteria: { from: 'anna@example.com' }, action: { addLabelIds: ['Label_1'] } },
    list_filters: {},
    get_filter: { filterId: 'filter-1' },
    delete_filter: { filterId: 'filter-1' },
    create_filter_from_template: { template: 'fromSender', parameters: { senderEmail: 'anna@example.com' } },
    download_attachment: { messageId: 'msg-1', attachmentId: 'att-1', savePath: DOWNLOAD_DIR },
};

test('every tool answers a refusal from Gmail as an error', async (t) => {
    assert.deepEqual(Object.keys(VALID_ARGS).sort(), listTools().map(tool => tool.name).sort());

    const refusal = googleError({
        status: 403,
        reason: 'insufficientPermissions',
        message: 'Request had insufficient authentication scopes.',
    });

    for (const [name, args] of Object.entries(VALID_ARGS)) {
        await t.test(name, async () => {
            const { gmail, called } = refusingGmail(refusal);
            const result = await handleTool(gmail, name, args, retry(fakeClock()));

            assert.equal(result.isError, true, name);
            assert.match(text(result), /Request had insufficient authentication scopes\./, name);
            assert.ok(called.length >= 1, `${name} reached Gmail`);
        });
    }
});

const TWO_MESSAGES = [
    message({ id: 'msg-1', threadId: 'thread-1' }),
    message({ id: 'msg-2', threadId: 'thread-2' }),
];

const ONE_MESSAGE = [message({
    id: 'msg-1',
    threadId: 'thread-1',
    headers: [
        ['Subject', 'Budget'],
        ['From', 'anna@example.com'],
        ['To', 'owner@example.com'],
        ['Date', 'Mon, 5 Oct 2026 10:00:00 +0200'],
    ],
    text: 'Hello',
})];

test('a retry that runs out is an error', async () => {
    const clock = fakeClock();
    const { gmail } = fakeGmail({
        refusals: {
            'messages.list': googleError({ status: 429, reason: 'rateLimitExceeded', message: PER_MINUTE_QUOTA }),
        },
    });

    const result = await handleTool(gmail, 'search_emails', { query: 'from:anna@example.com' }, retry(clock, { budgetMs: 1000 }));

    assert.equal(result.isError, true);
    assert.match(text(result), /^Error: Gmail refused this request for its per-minute quota/);
});

test('a batch that partly failed is a result naming the failed items', async () => {
    const modified = await handleTool(fakeGmail({ messages: TWO_MESSAGES }).gmail, 'batch_modify_emails', {
        messageIds: ['msg-1', 'gone-1', 'msg-2'],
        addLabelIds: ['Label_1'],
    });
    assert.notEqual(modified.isError, true);
    const modifyText = text(modified);
    assert.match(modifyText, /Successfully processed: 2 messages/);
    assert.match(modifyText, /Failed to process: 1 messages/);
    assert.match(modifyText, /^- gone-1\.\.\. \(Requested entity was not found\.\)$/m);

    const deleted = await handleTool(fakeGmail({ messages: TWO_MESSAGES }).gmail, 'batch_delete_emails', {
        messageIds: ['msg-1', 'gone-1', 'msg-2'],
    });
    assert.notEqual(deleted.isError, true);
    const deleteText = text(deleted);
    assert.match(deleteText, /Successfully deleted: 2 messages/);
    assert.match(deleteText, /Failed to delete: 1 messages/);
    assert.match(deleteText, /^- gone-1\.\.\. \(Requested entity was not found\.\)$/m);
});

test('a batch where Gmail refused every item is an error', async () => {
    const result = await handleTool(fakeGmail().gmail, 'batch_delete_emails', {
        messageIds: ['gone-1', 'gone-2'],
    });

    assert.equal(result.isError, true);
    const out = text(result);
    assert.match(out, /gone-1/);
    assert.match(out, /gone-2/);
});

test('a call refused before it reaches Gmail is an error', async () => {
    const { gmail } = fakeGmail();

    const unknown = await handleTool(gmail, 'nope', {});
    assert.equal(unknown.isError, true);
    assert.equal(text(unknown), 'Error: Unknown tool: nope');

    const missingTo = await handleTool(gmail, 'send_email', { subject: 'Hi', body: 'Body' });
    assert.equal(missingTo.isError, true);

    const emptyDraft = await handleTool(gmail, 'delete_draft', { draftId: '   ' });
    assert.equal(emptyDraft.isError, true);
    assert.match(text(emptyDraft), /draftId is empty/);

    const lineBreak = await handleTool(gmail, 'send_email', {
        to: ['anna@example.com\r\nBcc: x@example.com'],
        subject: 'Hi',
        body: 'Body',
    });
    assert.equal(lineBreak.isError, true);
});

test('a call that succeeds is not marked an error', async () => {
    const { gmail } = fakeGmail({ messages: ONE_MESSAGE });

    const read = await handleTool(gmail, 'read_email', { messageId: 'msg-1' });
    assert.notEqual(read.isError, true);

    const search = await handleTool(gmail, 'search_emails', { query: 'from:anna@example.com' });
    assert.notEqual(search.isError, true);

    const batch = await handleTool(gmail, 'batch_modify_emails', {
        messageIds: ['msg-1'],
        addLabelIds: ['Label_1'],
    });
    assert.notEqual(batch.isError, true);
});

// The real client: a local server stands in for Gmail, so the tests read the
// errors the googleapis client really throws.
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

const NOT_FOUND = {
    error: {
        code: 404,
        message: 'Requested entity was not found.',
        errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }],
        status: 'NOT_FOUND',
    },
};

const INVALID_TOKEN = {
    error: {
        code: 400,
        message: 'Invalid attachment token',
        errors: [{ message: 'Invalid attachment token', domain: 'global', reason: 'invalidArgument' }],
        status: 'INVALID_ARGUMENT',
    },
};

const handler = (req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && pathname.endsWith('/users/me/profile')) {
        sendJson(res, 200, { emailAddress: 'owner@example.com' });
    } else if (req.method === 'GET' && pathname.endsWith('/users/me/settings/sendAs')) {
        sendJson(res, 200, { sendAs: [] });
    } else if (req.method === 'GET' && pathname.endsWith('/users/me/messages/gone')) {
        sendJson(res, 404, NOT_FOUND);
    } else if (req.method === 'GET' && pathname.includes('/users/me/messages/msg-1/attachments/')) {
        sendJson(res, 400, INVALID_TOKEN);
    } else if (req.method === 'POST' && pathname.endsWith('/users/me/messages/send')) {
        sendJson(res, 200, { id: 'sent-9', threadId: 't-1' });
    } else {
        sendJson(res, 404, { error: { message: `unexpected request ${req.method} ${pathname}` } });
    }
};

const server = http.createServer(handler);
let realGmail;

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const auth = new OAuth2Client('id', 'secret');
    auth.setCredentials({ access_token: 'token', expiry_date: Date.now() + 3600e3 });
    realGmail = gmailClient({ version: 'v1', auth, rootUrl: `http://127.0.0.1:${server.address().port}/` });
});

after(() => new Promise((resolve) => server.close(resolve)));

test('a 404 from the real googleapis client makes read_email an error', async () => {
    const result = await handleTool(realGmail, 'read_email', { messageId: 'gone' });

    assert.equal(result.isError, true);
    assert.equal(text(result), 'Error: Requested entity was not found.');
});

test('a 400 from the real googleapis client makes download_attachment an error', async () => {
    const result = await handleTool(realGmail, 'download_attachment', {
        messageId: 'msg-1',
        attachmentId: 'att-1',
        filename: 'attachment.pdf',
        savePath: DOWNLOAD_DIR,
    });

    assert.equal(result.isError, true);
    assert.equal(text(result), 'Failed to download attachment: Invalid attachment token');
});

test('a send the real googleapis client accepted is not an error', async () => {
    const result = await handleTool(realGmail, 'send_email', {
        to: ['anna@example.com'],
        subject: 'Hi',
        body: 'Body',
    });

    assert.notEqual(result.isError, true);
    assert.equal(text(result), 'Email sent successfully with ID: sent-9');
});
