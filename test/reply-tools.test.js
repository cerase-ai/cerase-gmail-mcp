// read_email's reply-all lines and the reply_email tool, through the tool handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTools, handleTool } from '../dist/tools.js';
import { fakeGmail, message, decodeRaw } from './fake-gmail.js';

const text = (result) => result.content.map(c => c.text).join('');

const ORIGINAL = message({
    id: 'msg-1',
    threadId: 'thread-1',
    headers: [
        ['Subject', 'Budget Q3'],
        ['From', 'Anna Bianchi <anna@example.com>'],
        ['To', 'Paolo Verdi <owner@example.com>, Luca Neri <luca@example.com>'],
        ['Cc', '"Rossi, Mario" <mario@example.com>, giulia@example.com'],
        ['Reply-To', 'Anna Bianchi <anna.b@example.com>'],
        ['Date', 'Mon, 5 Oct 2026 10:00:00 +0200'],
        ['Message-Id', '<CAF123@mail.example.com>'],
        ['References', '<r1@mail.example.com> <r2@mail.example.com>'],
    ],
    text: 'Can we close the budget on Friday?',
});

const PLAIN = message({
    id: 'msg-2',
    threadId: 'thread-2',
    headers: [
        ['Subject', 'Re: Lunch'],
        ['From', 'luca@example.com'],
        ['To', 'owner@example.com'],
        ['Date', 'Tue, 6 Oct 2026 12:00:00 +0200'],
        ['Message-ID', '<lunch@example.com>'],
    ],
    text: 'Pizza?',
});

test('read_email shows Message-ID, Cc, Reply-To and who a reply to everyone goes to', async () => {
    const { gmail } = fakeGmail({ messages: [ORIGINAL] });
    assert.equal(text(await handleTool(gmail, 'read_email', { messageId: 'msg-1' })), [
        'Thread ID: thread-1',
        'Message-ID: <CAF123@mail.example.com>',
        'Subject: Budget Q3',
        'From: Anna Bianchi <anna@example.com>',
        'To: Paolo Verdi <owner@example.com>, Luca Neri <luca@example.com>',
        'Cc: "Rossi, Mario" <mario@example.com>, giulia@example.com',
        'Reply-To: Anna Bianchi <anna.b@example.com>',
        'Date: Mon, 5 Oct 2026 10:00:00 +0200',
        'Reply-all To: Anna Bianchi <anna.b@example.com>, Luca Neri <luca@example.com>',
        'Reply-all Cc: "Rossi, Mario" <mario@example.com>, giulia@example.com',
        '',
        'Can we close the budget on Friday?',
    ].join('\n'));
});

test('read_email of a mail without Cc or Reply-To omits those lines and keeps Reply-all To', async () => {
    const { gmail } = fakeGmail({ messages: [PLAIN] });
    assert.equal(text(await handleTool(gmail, 'read_email', { messageId: 'msg-2' })), [
        'Thread ID: thread-2',
        'Message-ID: <lunch@example.com>',
        'Subject: Re: Lunch',
        'From: luca@example.com',
        'To: owner@example.com',
        'Date: Tue, 6 Oct 2026 12:00:00 +0200',
        'Reply-all To: luca@example.com',
        '',
        'Pizza?',
    ].join('\n'));
});

test('read_email leaves out a send-as alias, and still answers when the send-as list fails', async () => {
    const mail = message({ id: 'msg-3', headers: [['From', 'anna@example.com'], ['To', 'alias@example.com'], ['Cc', 'owner@example.com, luca@example.com']] });
    const withAlias = fakeGmail({ messages: [mail], sendAs: ['owner@example.com', 'alias@example.com'] });
    const out = text(await handleTool(withAlias.gmail, 'read_email', { messageId: 'msg-3' }));
    assert.match(out, /^Reply-all To: anna@example\.com$/m);
    assert.match(out, /^Reply-all Cc: luca@example\.com$/m);

    const failing = fakeGmail({ messages: [mail], sendAsError: new Error('Insufficient Permission') });
    const out2 = text(await handleTool(failing.gmail, 'read_email', { messageId: 'msg-3' }));
    assert.match(out2, /^Reply-all To: anna@example\.com, alias@example\.com$/m);
    assert.match(out2, /^Reply-all Cc: luca@example\.com$/m);
});

test('reply_email is listed right after draft_email with its input schema', () => {
    const tools = listTools();
    const names = tools.map(t => t.name);
    assert.equal(names.length, 22);
    assert.equal(names[names.indexOf('draft_email') + 1], 'reply_email');
    const reply = tools.find(t => t.name === 'reply_email');
    assert.match(reply.description, /conversation/);
    assert.match(reply.description, /exclude/);
    const schema = reply.inputSchema;
    assert.equal(schema.type, 'object');
    assert.deepEqual(Object.keys(schema.properties), ['messageId', 'body', 'htmlBody', 'mimeType', 'to', 'cc', 'bcc', 'exclude', 'attachments']);
    assert.deepEqual(schema.required, ['messageId', 'body']);
    assert.deepEqual(schema.properties.mimeType.enum, ['text/plain', 'text/html', 'multipart/alternative']);
    assert.equal(schema.properties.mimeType.default, 'text/plain');
    for (const list of ['to', 'cc', 'bcc', 'exclude', 'attachments']) {
        assert.equal(schema.properties[list].type, 'array');
        assert.equal(schema.properties[list].items.type, 'string');
    }
    const send = tools.find(t => t.name === 'send_email');
    assert.deepEqual(schema.properties.mimeType, send.inputSchema.properties.mimeType);
});

test('reply_email sends to everyone in the conversation with the threading headers', async () => {
    const { gmail, calls } = fakeGmail({ messages: [ORIGINAL] });
    const result = await handleTool(gmail, 'reply_email', { messageId: 'msg-1', body: 'Friday works.' });
    assert.equal(text(result), [
        'Reply sent with ID: sent-1',
        'Thread ID: thread-1',
        'To: Anna Bianchi <anna.b@example.com>, Luca Neri <luca@example.com>',
        'Cc: "Rossi, Mario" <mario@example.com>, giulia@example.com',
    ].join('\n'));
    assert.equal(calls.get[0].format, 'metadata');
    assert.deepEqual(calls.get[0].metadataHeaders, ['Subject', 'From', 'To', 'Cc', 'Reply-To', 'Message-ID', 'References']);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0].requestBody.threadId, 'thread-1');
    assert.equal(decodeRaw(calls.send[0].requestBody.raw), [
        'From: me',
        'To: anna.b@example.com, luca@example.com',
        'Cc: mario@example.com, giulia@example.com',
        'Subject: Re: Budget Q3',
        'In-Reply-To: <CAF123@mail.example.com>',
        'References: <r1@mail.example.com> <r2@mail.example.com> <CAF123@mail.example.com>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        'Friday works.',
    ].join('\r\n'));
});

test('reply_email applies exclude and additions, and reports Bcc', async () => {
    const { gmail, calls } = fakeGmail({ messages: [ORIGINAL] });
    const result = await handleTool(gmail, 'reply_email', {
        messageId: 'msg-1', body: 'Friday works.',
        exclude: ['giulia@example.com'], cc: ['boss@example.com'], bcc: ['audit@example.com'],
    });
    assert.equal(text(result), [
        'Reply sent with ID: sent-1',
        'Thread ID: thread-1',
        'To: Anna Bianchi <anna.b@example.com>, Luca Neri <luca@example.com>',
        'Cc: "Rossi, Mario" <mario@example.com>, boss@example.com',
        'Bcc: audit@example.com',
    ].join('\n'));
    const raw = decodeRaw(calls.send[0].requestBody.raw);
    assert.match(raw, /^Cc: mario@example\.com, boss@example\.com\r$/m);
    assert.match(raw, /^Bcc: audit@example\.com\r$/m);
});

test('reply_email with an attachment threads the message composed by nodemailer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-test-'));
    const file = path.join(dir, 'budget.txt');
    fs.writeFileSync(file, 'figures');
    const { gmail, calls } = fakeGmail({ messages: [ORIGINAL] });
    const result = await handleTool(gmail, 'reply_email', { messageId: 'msg-1', body: 'Attached.', attachments: [file] });
    assert.match(text(result), /^Reply sent with ID: sent-1\n/);
    assert.equal(calls.send[0].requestBody.threadId, 'thread-1');
    const raw = decodeRaw(calls.send[0].requestBody.raw);
    assert.match(raw, /^To: anna\.b@example\.com, luca@example\.com$/m);
    assert.match(raw, /^Cc: mario@example\.com, giulia@example\.com$/m);
    assert.match(raw, /^Subject: Re: Budget Q3$/m);
    assert.match(raw, /^In-Reply-To: <CAF123@mail\.example\.com>$/m);
    assert.match(raw, /^References: <r1@mail\.example\.com> <r2@mail\.example\.com>\s+<CAF123@mail\.example\.com>$/m);
    assert.match(raw, /filename=budget\.txt/);
    fs.rmSync(dir, { recursive: true });
});

test('reply_email keeps an existing reply prefix and threads a mail without References', async () => {
    const { gmail, calls } = fakeGmail({ messages: [PLAIN] });
    await handleTool(gmail, 'reply_email', { messageId: 'msg-2', body: 'Yes.' });
    const raw = decodeRaw(calls.send[0].requestBody.raw);
    assert.match(raw, /^To: luca@example\.com\r$/m);
    assert.doesNotMatch(raw, /^Cc:/m);
    assert.match(raw, /^Subject: Re: Lunch\r$/m);
    assert.match(raw, /^In-Reply-To: <lunch@example\.com>\r$/m);
    assert.match(raw, /^References: <lunch@example\.com>\r$/m);
});

test('reply_email refuses and sends nothing when no one would receive it or a recipient is not an address', async () => {
    const selfNote = message({ id: 'msg-4', headers: [['From', 'owner@example.com'], ['To', 'owner@example.com'], ['Subject', 'note']] });
    const { gmail, calls } = fakeGmail({ messages: [selfNote, ORIGINAL] });
    const nobody = text(await handleTool(gmail, 'reply_email', { messageId: 'msg-4', body: 'x' }));
    assert.match(nobody, /^Error: Reply not sent: .*no one/);
    const invalid = text(await handleTool(gmail, 'reply_email', { messageId: 'msg-1', body: 'x', to: ['Luca Neri'] }));
    assert.match(invalid, /^Error: Reply not sent: .*not email addresses: Luca Neri/);
    const stranger = text(await handleTool(gmail, 'reply_email', { messageId: 'msg-1', body: 'x', exclude: ['nobody@example.com'] }));
    assert.match(stranger, /^Error: Reply not sent: .*not on the mail/);
    assert.equal(calls.send.length, 0);
});
