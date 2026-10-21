// read_email's attachment listing and download_attachment's argument handling,
// through the tool handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleTool } from '../dist/tools.js';
import { fakeGmail, message, b64 } from './fake-gmail.js';

const text = (result) => result.content.map(c => c.text).join('');

const ATTACHMENT_ID = 'ANGjdJ8x-Yk_Qz3v';
const BYTES = Buffer.from('%PDF-1.4\nliberatoria\n', 'utf8');

const WITH_ATTACHMENT = message({
    id: 'msg-att',
    threadId: 'thread-att',
    headers: [
        ['Subject', 'Liberatoria'],
        ['From', 'Anna Bianchi <anna@example.com>'],
        ['To', 'owner@example.com'],
        ['Date', 'Mon, 5 Oct 2026 10:00:00 +0200'],
    ],
    parts: [
        { mimeType: 'text/plain', body: { data: b64('Please find the release attached.') } },
        {
            mimeType: 'application/pdf',
            filename: 'liberatoria.pdf',
            body: { attachmentId: ATTACHMENT_ID, size: 20480 },
        },
    ],
});

test('read_email lists the attachment id on its own line with no punctuation touching it', async () => {
    const { gmail } = fakeGmail({ messages: [WITH_ATTACHMENT] });
    const out = text(await handleTool(gmail, 'read_email', { messageId: 'msg-att' }));
    const lines = out.split('\n');

    const idLine = `  Attachment ID: ${ATTACHMENT_ID}`;
    const index = lines.indexOf(idLine);
    assert.notEqual(index, -1, `expected a line ${JSON.stringify(idLine)} in:\n${out}`);
    assert.equal(lines[index - 1], '- liberatoria.pdf (application/pdf, 20 KB)');
    assert.doesNotMatch(out, /ANGjdJ8x-Yk_Qz3v[),.]/);
});

// Download `attachmentId` into a fresh temp dir and check the tool trimmed it
// before asking Gmail, then wrote the attachment bytes.
async function assertDownloads(attachmentId) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-attachment-'));
    try {
        const { gmail, calls } = fakeGmail({
            messages: [WITH_ATTACHMENT],
            attachments: { [ATTACHMENT_ID]: BYTES.toString('base64url') },
        });
        const out = text(await handleTool(gmail, 'download_attachment', {
            messageId: 'msg-att',
            attachmentId,
            savePath: dir,
        }));

        assert.match(out, /^Attachment downloaded successfully/);

        const fileLine = out.split('\n').find(line => line.startsWith('File: '));
        assert.ok(fileLine, `expected a File: line in:\n${out}`);
        const filename = fileLine.slice('File: '.length);
        const fullPath = path.join(dir, filename);
        assert.ok(fs.existsSync(fullPath), `expected ${fullPath} to exist`);
        assert.deepEqual(fs.readFileSync(fullPath), BYTES);

        assert.equal(calls.attachmentGets.length, 1);
        assert.equal(calls.attachmentGets[0].id, ATTACHMENT_ID);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('download_attachment trims a trailing ")" copied with the id', async () => {
    await assertDownloads(`${ATTACHMENT_ID})`);
});

test('download_attachment trims trailing punctuation and surrounding whitespace copied with the id', async () => {
    for (const attachmentId of [
        `${ATTACHMENT_ID},`,
        `${ATTACHMENT_ID}.`,
        ` ${ATTACHMENT_ID} `,
        `${ATTACHMENT_ID}).`,
    ]) {
        await assertDownloads(attachmentId);
    }
});

test('download_attachment still downloads an id with no punctuation', async () => {
    await assertDownloads(ATTACHMENT_ID);
});
