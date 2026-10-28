// The Gmail labels a message carries, as read_email and search_emails report them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTool } from '../dist/tools.js';
import { fakeGmail, message } from './fake-gmail.js';

const text = (result) => result.content.map(c => c.text).join('');

const headers = (subject, from, date) => [
    ['Subject', subject],
    ['From', from],
    ['Date', date],
];

const UPDATES = message({
    id: 'msg-updates',
    threadId: 'thread-updates',
    headers: headers('Nightly build failed', 'builds@example.com', 'Mon, 5 Oct 2026 10:00:00 +0200'),
    text: 'The nightly build failed.',
    labelIds: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'],
});

test('read_email reports the labels among the header lines, before the body', async () => {
    const { gmail } = fakeGmail({ messages: [UPDATES] });
    const out = text(await handleTool(gmail, 'read_email', { messageId: 'msg-updates' }));

    assert.match(out, /^Labels: INBOX, CATEGORY_UPDATES, UNREAD$/m);
    const labelsAt = out.search(/^Labels: /m);
    const bodyAt = out.indexOf('The nightly build failed.');
    assert.ok(labelsAt >= 0, 'read_email printed no Labels line');
    assert.ok(bodyAt > labelsAt, 'the Labels line came after the body');
});

test('search_emails reports each message\'s labels in Gmail order, after its Date line', async () => {
    const personal = message({
        id: 'msg-personal',
        threadId: 'thread-personal',
        headers: headers('Lunch on Friday', 'anna@example.com', 'Tue, 6 Oct 2026 12:00:00 +0200'),
        text: 'Pizza?',
        labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
    });
    const updates = message({
        id: 'msg-custom',
        threadId: 'thread-custom',
        headers: headers('Release notes', 'release@example.com', 'Wed, 7 Oct 2026 09:00:00 +0200'),
        text: 'What changed.',
        labelIds: ['INBOX', 'CATEGORY_UPDATES', 'Label_7'],
    });
    const { gmail } = fakeGmail({ messages: [personal, updates] });
    const out = text(await handleTool(gmail, 'search_emails', { query: 'is:inbox' }));

    const blocks = out.split('\n\n').map(block => block.trimEnd());
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0], [
        'ID: msg-personal',
        'Subject: Lunch on Friday',
        'From: anna@example.com',
        'Date: Tue, 6 Oct 2026 12:00:00 +0200',
        'Labels: INBOX, CATEGORY_PERSONAL',
    ].join('\n'));
    assert.equal(blocks[1], [
        'ID: msg-custom',
        'Subject: Release notes',
        'From: release@example.com',
        'Date: Wed, 7 Oct 2026 09:00:00 +0200',
        'Labels: INBOX, CATEGORY_UPDATES, Label_7',
    ].join('\n'));
});

test('a message with no labels reports Labels: (none) in both tools', async () => {
    const noLabels = message({
        id: 'msg-no-labels',
        threadId: 'thread-no-labels',
        headers: headers('No labels', 'nobody@example.com', 'Thu, 8 Oct 2026 08:00:00 +0200'),
        text: 'Bare message.',
    });
    const emptyLabels = message({
        id: 'msg-empty-labels',
        threadId: 'thread-empty-labels',
        headers: headers('Empty labels', 'nobody@example.com', 'Fri, 9 Oct 2026 08:00:00 +0200'),
        text: 'Empty label list.',
        labelIds: [],
    });

    const { gmail } = fakeGmail({ messages: [noLabels, emptyLabels] });
    const readNoLabels = text(await handleTool(gmail, 'read_email', { messageId: 'msg-no-labels' }));
    const readEmptyLabels = text(await handleTool(gmail, 'read_email', { messageId: 'msg-empty-labels' }));
    assert.match(readNoLabels, /^Labels: \(none\)$/m);
    assert.match(readEmptyLabels, /^Labels: \(none\)$/m);

    const out = text(await handleTool(gmail, 'search_emails', { query: 'is:inbox' }));
    const blocks = out.split('\n\n').map(block => block.trimEnd());
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0], [
        'ID: msg-no-labels',
        'Subject: No labels',
        'From: nobody@example.com',
        'Date: Thu, 8 Oct 2026 08:00:00 +0200',
        'Labels: (none)',
    ].join('\n'));
    assert.equal(blocks[1], [
        'ID: msg-empty-labels',
        'Subject: Empty labels',
        'From: nobody@example.com',
        'Date: Fri, 9 Oct 2026 08:00:00 +0200',
        'Labels: (none)',
    ].join('\n'));
});

test('search_emails still fetches metadata, so labels cost no extra request per message', async () => {
    const personal = message({
        id: 'msg-personal',
        threadId: 'thread-personal',
        headers: headers('Lunch on Friday', 'anna@example.com', 'Tue, 6 Oct 2026 12:00:00 +0200'),
        text: 'Pizza?',
        labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
    });
    const updates = message({
        id: 'msg-updates',
        threadId: 'thread-updates',
        headers: headers('Nightly build failed', 'builds@example.com', 'Mon, 5 Oct 2026 10:00:00 +0200'),
        text: 'The nightly build failed.',
        labelIds: ['INBOX', 'CATEGORY_UPDATES', 'UNREAD'],
    });
    const { gmail, calls } = fakeGmail({ messages: [personal, updates] });
    await handleTool(gmail, 'search_emails', { query: 'is:inbox' });

    assert.equal(calls.get.length, 2);
    for (const call of calls.get) {
        assert.equal(call.format, 'metadata');
    }
});
