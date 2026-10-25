// How recipients and header values reach the raw message: the Cc line for a
// mail with an attachment, display-name quoting, line breaks in headers, and
// recipients that carry one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleTool } from '../dist/tools.js';
import { fakeGmail, message, decodeRaw } from './fake-gmail.js';

const text = (result) => result.content.map(c => c.text).join('');
const lines = (raw) => raw.split(/\r?\n/);
const headerLine = (raw, name) => lines(raw).find(line => line.startsWith(`${name}:`));
const angleAddress = (line) => line.slice(line.lastIndexOf('<') + 1, line.lastIndexOf('>'));

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

function attachment() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-headers-'));
    const file = path.join(dir, 'attachment.txt');
    fs.writeFileSync(file, 'attachment');
    return { file, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a Cc written for a mail with an attachment names the mailbox a conformant reader names', async () => {
    const { file, remove } = attachment();
    try {
        for (const { cc, domain } of [
            { cc: 'Victim (x(y) <evil@evil.com>) <v@victim.com>' },
            { cc: 'G: (a; <evil@evil.com>) <v@victim.com>;' },
            { cc: '<"a@evil.com>"@good.com>', domain: 'good.com' },
        ]) {
            const { gmail, calls } = fakeGmail();
            await handleTool(gmail, 'send_email', {
                to: ['anna@example.com'], subject: 'S', body: 'B', cc: [cc], attachments: [file],
            });
            const line = headerLine(decodeRaw(calls.send[0].requestBody.raw), 'Cc');
            const address = angleAddress(line);
            if (domain === undefined) {
                assert.equal(address, 'v@victim.com', `Cc written as ${cc} reached the message as ${line}`);
            } else {
                assert.ok(address.endsWith(`@${domain}`), `Cc written as ${cc} reached the message as ${line}`);
            }
            assert.ok(!line.endsWith('@evil.com>'), `Cc written as ${cc} ended with the injected address: ${line}`);
        }
    } finally {
        remove();
    }
});

test('a display name quoting > ; or , is written as the approval shows it', async () => {
    const { file, remove } = attachment();
    try {
        for (const value of ['"a>b" <v@victim.com>', '"a;b" <v@victim.com>', '"Rossi, Mario" <mario@example.com>']) {
            const { gmail, calls } = fakeGmail();
            await handleTool(gmail, 'send_email', {
                to: ['anna@example.com'], subject: 'S', body: 'B', cc: [value], attachments: [file],
            });
            const line = headerLine(decodeRaw(calls.send[0].requestBody.raw), 'Cc');
            assert.equal(line, `Cc: ${value}`);
        }
    } finally {
        remove();
    }
});

test('a line break in the subject or In-Reply-To is written as a space and adds no header', async () => {
    const sent = fakeGmail();
    await handleTool(sent.gmail, 'send_email', {
        to: ['anna@example.com'], subject: 'Budget\r\nBcc: evil@evil.com', body: 'Hello',
    });
    assert.equal(sent.calls.send.length, 1);
    const subjectRaw = decodeRaw(sent.calls.send[0].requestBody.raw);
    assert.ok(!lines(subjectRaw).some(line => line.startsWith('Bcc:')), `a Bcc header was added:\n${subjectRaw}`);
    assert.equal(headerLine(subjectRaw, 'Subject'), 'Subject: Budget Bcc: evil@evil.com');

    const threaded = fakeGmail();
    await handleTool(threaded.gmail, 'send_email', {
        to: ['anna@example.com'], subject: 'S', body: 'Hello', inReplyTo: '<orig@example.com>\r\nBcc: evil@evil.com',
    });
    assert.equal(threaded.calls.send.length, 1);
    const threadedRaw = decodeRaw(threaded.calls.send[0].requestBody.raw);
    assert.ok(!lines(threadedRaw).some(line => line.startsWith('Bcc:')), `a Bcc header was added:\n${threadedRaw}`);
    assert.equal(headerLine(threadedRaw, 'In-Reply-To'), 'In-Reply-To: <orig@example.com> Bcc: evil@evil.com');

    const drafted = fakeGmail();
    await handleTool(drafted.gmail, 'draft_email', {
        to: ['anna@example.com'], subject: 'Budget\r\nBcc: evil@evil.com', body: 'Hello',
    });
    assert.equal(drafted.calls.drafts.length, 1);
    const draftRaw = decodeRaw(drafted.calls.drafts[0].requestBody.message.raw);
    assert.ok(!lines(draftRaw).some(line => line.startsWith('Bcc:')), `a Bcc header was added:\n${draftRaw}`);
    assert.equal(headerLine(draftRaw, 'Subject'), 'Subject: Budget Bcc: evil@evil.com');
});

test('a recipient holding a line break is refused and nothing is sent', async () => {
    for (const [tool, args] of [
        ['send_email', {
            to: ['anna@example.com'], subject: 'S', body: 'B', cc: ['luca@example.com\r\nBcc: evil@evil.com'],
        }],
        ['send_email', {
            to: ['anna@example.com'], subject: 'S', body: 'B', bcc: ['luca@example.com\nX: y'],
        }],
        ['draft_email', {
            to: ['anna@example.com'], subject: 'S', body: 'B', cc: ['luca@example.com\r\nBcc: evil@evil.com'],
        }],
        ['reply_email', {
            messageId: 'msg-1', body: 'B', cc: ['luca@example.com\r\nBcc: evil@evil.com'],
        }],
    ]) {
        const { gmail, calls } = fakeGmail({ messages: [ORIGINAL] });
        const result = await handleTool(gmail, tool, args);
        const label = `${tool} with ${JSON.stringify(args)}`;
        assert.equal(calls.send.length, 0, `${label} sent a message`);
        assert.equal(calls.drafts.length, 0, `${label} created a draft`);
        assert.match(text(result), /line break/, `${label} did not explain the refusal: ${text(result)}`);
    }
});
