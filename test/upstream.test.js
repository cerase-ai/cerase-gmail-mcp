// Upstream behaviour the fork must keep: the tools it lists, what send_email
// and draft_email compose, and the body read_email returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTools, handleTool } from '../dist/tools.js';
import { fakeGmail, message, decodeRaw } from './fake-gmail.js';

const UPSTREAM_TOOLS = [
    'send_email', 'draft_email', 'read_email', 'search_emails', 'modify_email',
    'delete_email', 'list_email_labels', 'batch_modify_emails', 'batch_delete_emails',
    'create_label', 'update_label', 'delete_label', 'get_or_create_label',
    'create_filter', 'list_filters', 'get_filter', 'delete_filter',
    'create_filter_from_template', 'download_attachment',
];

const text = (result) => result.content.map(c => c.text).join('');

test('every upstream tool is listed, in upstream order', () => {
    const names = listTools().map(t => t.name);
    assert.deepEqual(names.filter(n => UPSTREAM_TOOLS.includes(n)), UPSTREAM_TOOLS);
});

test('send_email keeps the upstream input schema', () => {
    const send = listTools().find(t => t.name === 'send_email');
    assert.deepEqual(Object.keys(send.inputSchema.properties), [
        'to', 'subject', 'body', 'htmlBody', 'mimeType', 'cc', 'bcc', 'threadId', 'inReplyTo', 'attachments',
    ]);
    assert.deepEqual(send.inputSchema.required, ['to', 'subject', 'body']);
});

test('send_email composes the upstream message, with References equal to In-Reply-To', async () => {
    const { gmail, calls } = fakeGmail();
    const result = await handleTool(gmail, 'send_email', {
        to: ['anna@example.com'], cc: ['luca@example.com'], subject: 'Budget', body: 'Hello',
        threadId: 'thread-9', inReplyTo: '<orig@example.com>',
    });
    assert.equal(text(result), 'Email sent successfully with ID: sent-1');
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].requestBody.threadId, 'thread-9');
    assert.equal(decodeRaw(calls.send[0].requestBody.raw), [
        'From: me',
        'To: anna@example.com',
        'Cc: luca@example.com',
        'Subject: Budget',
        'In-Reply-To: <orig@example.com>',
        'References: <orig@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        'Hello',
    ].join('\r\n'));
});

test('send_email without inReplyTo carries no threading headers', async () => {
    const { gmail, calls } = fakeGmail();
    await handleTool(gmail, 'send_email', { to: ['anna@example.com'], subject: 'Budget', body: 'Hello' });
    const raw = decodeRaw(calls.send[0].requestBody.raw);
    assert.doesNotMatch(raw, /In-Reply-To|References/);
    assert.equal(calls.send[0].requestBody.threadId, undefined);
});

test('draft_email creates a draft and answers its id', async () => {
    const { gmail, calls } = fakeGmail();
    const result = await handleTool(gmail, 'draft_email', { to: ['anna@example.com'], subject: 'Budget', body: 'Hello' });
    assert.equal(text(result), 'Email draft created successfully with ID: draft-1');
    assert.equal(calls.drafts.length, 1);
    assert.match(decodeRaw(calls.drafts[0].requestBody.message.raw), /^From: me\r\nTo: anna@example\.com\r\nSubject: Budget\r\n/);
    assert.equal(calls.send.length, 0);
});

test('send_email with an attachment goes through nodemailer and keeps References equal to In-Reply-To', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-test-'));
    const file = path.join(dir, 'report.txt');
    fs.writeFileSync(file, 'figures');
    const { gmail, calls } = fakeGmail();
    const result = await handleTool(gmail, 'send_email', {
        to: ['anna@example.com'], subject: 'Budget', body: 'Hello', inReplyTo: '<orig@example.com>', attachments: [file],
    });
    assert.equal(text(result), 'Email sent successfully with ID: sent-1');
    const raw = decodeRaw(calls.send[0].requestBody.raw);
    assert.match(raw, /^In-Reply-To: <orig@example\.com>$/m);
    assert.match(raw, /^References: <orig@example\.com>$/m);
    assert.match(raw, /filename=report\.txt/);
    fs.rmSync(dir, { recursive: true });
});

test('send_email refuses a recipient that is not an address, as upstream', async () => {
    const { gmail, calls } = fakeGmail();
    const result = await handleTool(gmail, 'send_email', { to: ['Anna Bianchi'], subject: 'x', body: 'y' });
    assert.equal(text(result), 'Error: Recipient email address is invalid: Anna Bianchi');
    assert.equal(calls.send.length, 0);
});

test('read_email returns the upstream body, note and attachments block after the headers', async () => {
    const m = message({
        id: 'msg-1', threadId: 'thread-1',
        headers: [['Subject', 'Budget'], ['From', 'Anna <anna@example.com>'], ['To', 'owner@example.com'], ['Date', 'Mon, 5 Oct 2026 10:00:00 +0200']],
        parts: [
            { mimeType: 'text/html', body: { data: Buffer.from('<p>Hi</p>').toString('base64') } },
            { mimeType: 'application/pdf', filename: 'q3.pdf', body: { attachmentId: 'att-1', size: 2048 } },
        ],
    });
    const { gmail } = fakeGmail({ messages: [m] });
    const out = text(await handleTool(gmail, 'read_email', { messageId: 'msg-1' }));
    const [head, ...rest] = out.split('\n\n');
    assert.equal(rest.join('\n\n'),
        '[Note: This email is HTML-formatted. Plain text version not available.]\n\n<p>Hi</p>\n\nAttachments (1):\n- q3.pdf (application/pdf, 2 KB, ID: att-1)');
    const lines = head.split('\n');
    assert.equal(lines[0], 'Thread ID: thread-1');
    for (const line of ['Subject: Budget', 'From: Anna <anna@example.com>', 'To: owner@example.com', 'Date: Mon, 5 Oct 2026 10:00:00 +0200']) {
        assert.ok(lines.includes(line), `missing line ${line}`);
    }
});

test('an unknown tool answers an error', async () => {
    const { gmail } = fakeGmail();
    assert.equal(text(await handleTool(gmail, 'nope', {})), 'Error: Unknown tool: nope');
});
