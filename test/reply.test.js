// The pure reply-all logic: address lists, who a reply goes to, subject and threading headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseAddressList, formatAddressList, computeReplyAll, planReplyRecipients,
    replySubject, buildReferences, headerValue, replySource,
} from '../dist/reply.js';

const OWNER = ['owner@example.com'];
const addresses = (list) => list.map(m => m.address);
const displays = (list) => list.map(m => m.display);

test('an address list keeps quoted commas and angle brackets inside one entry', () => {
    const list = parseAddressList('"Rossi, Mario" <mario@example.com>, Anna Bianchi <Anna@Example.com>,luca@example.com');
    assert.deepEqual(list, [
        { display: '"Rossi, Mario" <mario@example.com>', address: 'mario@example.com' },
        { display: 'Anna Bianchi <Anna@Example.com>', address: 'Anna@Example.com' },
        { display: 'luca@example.com', address: 'luca@example.com' },
    ]);
});

test('an address list handles escaped quotes, comments, bare angle addresses and folding', () => {
    const list = parseAddressList('"Mario \\"Rossi, jr\\"" <mario@example.com>,\r\n giulia@example.com (Giulia, Sales), <luca@example.com>');
    assert.deepEqual(addresses(list), ['mario@example.com', 'giulia@example.com', 'luca@example.com']);
    assert.deepEqual(displays(list), ['"Mario \\"Rossi, jr\\"" <mario@example.com>', 'giulia@example.com (Giulia, Sales)', '<luca@example.com>']);
});

test('an address list reads group syntax and returns nothing for an empty one', () => {
    assert.deepEqual(parseAddressList('undisclosed-recipients:;'), []);
    assert.deepEqual(parseAddressList(''), []);
    assert.deepEqual(addresses(parseAddressList('Board: anna@example.com, luca@example.com;, mario@example.com')),
        ['anna@example.com', 'luca@example.com', 'mario@example.com']);
});

test('an address list is written back as in the header, joined with a comma and a space', () => {
    assert.equal(formatAddressList(parseAddressList('"Rossi, Mario" <mario@example.com>,luca@example.com')),
        '"Rossi, Mario" <mario@example.com>, luca@example.com');
    assert.equal(formatAddressList([]), '');
});

test('header lookup ignores the case of the name', () => {
    const headers = [{ name: 'Message-Id', value: '<a@example.com>' }, { name: 'CC', value: 'luca@example.com' }];
    assert.equal(headerValue(headers, 'Message-ID'), '<a@example.com>');
    assert.equal(headerValue(headers, 'cc'), 'luca@example.com');
    assert.equal(headerValue(headers, 'Reply-To'), '');
    assert.deepEqual(replySource(headers), { from: '', to: '', cc: 'luca@example.com', replyTo: '' });
});

test('reply-all goes to the sender and the other To, and keeps both people in Cc', () => {
    const r = computeReplyAll({
        from: 'Anna Bianchi <anna@example.com>',
        to: 'owner@example.com, Luca Neri <luca@example.com>',
        cc: '"Rossi, Mario" <mario@example.com>, giulia@example.com',
        replyTo: '',
    }, OWNER);
    assert.deepEqual(displays(r.to), ['Anna Bianchi <anna@example.com>', 'Luca Neri <luca@example.com>']);
    assert.deepEqual(displays(r.cc), ['"Rossi, Mario" <mario@example.com>', 'giulia@example.com']);
});

test('reply-all leaves out the owner wherever the owner appears, aliases included', () => {
    const r = computeReplyAll({
        from: 'anna@example.com',
        to: 'Owner <OWNER@example.com>',
        cc: 'luca@example.com, Owner Alias <alias@example.com>',
        replyTo: '',
    }, ['owner@example.com', 'Alias@Example.com']);
    assert.deepEqual(addresses(r.to), ['anna@example.com']);
    assert.deepEqual(addresses(r.cc), ['luca@example.com']);
});

test('reply-all to a mail the owner sent goes to its To and Cc', () => {
    const r = computeReplyAll({
        from: 'Owner <owner@example.com>',
        to: 'anna@example.com, luca@example.com',
        cc: 'mario@example.com, owner@example.com',
        replyTo: 'support@example.com',
    }, OWNER);
    assert.deepEqual(addresses(r.to), ['anna@example.com', 'luca@example.com']);
    assert.deepEqual(addresses(r.cc), ['mario@example.com']);
});

test('reply-all prefers Reply-To over From', () => {
    const r = computeReplyAll({
        from: 'Shop <noreply@example.com>',
        to: 'owner@example.com',
        cc: '',
        replyTo: 'Support <support@example.com>',
    }, OWNER);
    assert.deepEqual(displays(r.to), ['Support <support@example.com>']);
    assert.deepEqual(r.cc, []);
});

test('reply-all lists each person once, comparing addresses without case, first occurrence kept', () => {
    const r = computeReplyAll({
        from: 'Anna Bianchi <anna@example.com>',
        to: 'owner@example.com, ANNA@example.com, luca@example.com',
        cc: 'Luca Neri <Luca@Example.com>, mario@example.com, Mario <MARIO@example.com>',
        replyTo: '',
    }, OWNER);
    assert.deepEqual(displays(r.to), ['Anna Bianchi <anna@example.com>', 'luca@example.com']);
    assert.deepEqual(displays(r.cc), ['mario@example.com']);
});

test('reply-all moves Cc into To when nobody is left in To', () => {
    const r = computeReplyAll({ from: 'owner@example.com', to: 'owner@example.com', cc: 'luca@example.com', replyTo: '' }, OWNER);
    assert.deepEqual(addresses(r.to), ['luca@example.com']);
    assert.deepEqual(r.cc, []);
});

const MAIL = {
    from: 'Anna Bianchi <anna@example.com>',
    to: 'owner@example.com, luca@example.com',
    cc: 'Mario Rossi <mario@example.com>, giulia@example.com',
    replyTo: '',
};

test('exclude leaves out only the person it names', () => {
    const r = planReplyRecipients(MAIL, OWNER, { exclude: ['MARIO@example.com'] });
    assert.deepEqual(addresses(r.to), ['anna@example.com', 'luca@example.com']);
    assert.deepEqual(addresses(r.cc), ['giulia@example.com']);
    assert.deepEqual(r.bcc, []);
});

test('exclude naming someone who is not on the mail is refused', () => {
    assert.throws(() => planReplyRecipients(MAIL, OWNER, { exclude: ['mario@exmaple.com'] }), /not on the mail.*mario@exmaple\.com/s);
    assert.throws(() => planReplyRecipients(MAIL, OWNER, { exclude: ['Mario Rossi'] }), /not on the mail/);
});

test('to, cc and bcc add new people and leave people already on the reply where they are', () => {
    const r = planReplyRecipients(MAIL, OWNER, {
        to: ['luca@example.com', 'giulia@example.com', 'New Person <new@example.com>'],
        cc: ['ANNA@example.com', 'boss@example.com'],
        bcc: ['mario@example.com', 'audit@example.com'],
    });
    assert.deepEqual(displays(r.to), ['Anna Bianchi <anna@example.com>', 'luca@example.com', 'New Person <new@example.com>']);
    assert.deepEqual(displays(r.cc), ['Mario Rossi <mario@example.com>', 'giulia@example.com', 'boss@example.com']);
    assert.deepEqual(displays(r.bcc), ['audit@example.com']);
});

test('a reply with nobody left in To and Cc is refused', () => {
    const own = { from: 'owner@example.com', to: 'owner@example.com', cc: '', replyTo: '' };
    assert.throws(() => planReplyRecipients(own, OWNER, {}), /no one/);
    assert.throws(() => planReplyRecipients(own, OWNER, { bcc: ['audit@example.com'] }), /no one/);
    assert.throws(() => planReplyRecipients({ ...MAIL, cc: '' }, OWNER, { exclude: ['anna@example.com', 'luca@example.com'] }), /no one/);
    assert.equal(addresses(planReplyRecipients(own, OWNER, { cc: ['luca@example.com'] }).to)[0], 'luca@example.com');
});

test('a reply to someone who is not an email address is refused', () => {
    assert.throws(() => planReplyRecipients(MAIL, OWNER, { to: ['Luca Neri'] }), /not email addresses: Luca Neri/);
    assert.throws(() => planReplyRecipients({ ...MAIL, cc: 'Sales Team, giulia@example.com' }, OWNER, {}), /not email addresses: Sales Team/);
    const r = planReplyRecipients({ ...MAIL, cc: 'Sales Team, giulia@example.com' }, OWNER, { exclude: ['Sales Team'] });
    assert.deepEqual(addresses(r.cc), ['giulia@example.com']);
});

test('the subject gets one reply prefix', () => {
    assert.equal(replySubject('Budget Q3'), 'Re: Budget Q3');
    for (const s of ['Re: Budget', 'RE: Budget', 're:Budget', 'R: Budget', 'Aw: Budget', 'SV: Budget', 'Antw: Budget', 'Re : Budget']) {
        assert.equal(replySubject(s), s);
    }
    assert.equal(replySubject('Report: Q3'), 'Re: Report: Q3');
    assert.equal(replySubject('Fwd: Budget'), 'Re: Fwd: Budget');
});

test('References is the original References followed by its Message-ID', () => {
    assert.equal(buildReferences('', '<a@example.com>'), '<a@example.com>');
    assert.equal(buildReferences('<r1@example.com>\r\n <r2@example.com>', '<a@example.com>'), '<r1@example.com> <r2@example.com> <a@example.com>');
    assert.equal(buildReferences('<r1@example.com> <a@example.com>', '<a@example.com>'), '<r1@example.com> <a@example.com>');
    assert.equal(buildReferences('<r1@example.com>', ''), '<r1@example.com>');
    assert.equal(buildReferences('', ''), '');
});

test('a long References keeps the first and the latest ids within one header line', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `<thread-message-${String(i).padStart(2, '0')}@mail.example.com>`);
    const refs = buildReferences(ids.slice(0, 39).join(' '), ids[39]).split(' ');
    assert.ok(('References: ' + refs.join(' ')).length <= 998);
    assert.equal(refs[0], ids[0]);
    assert.deepEqual(refs.slice(-3), ids.slice(-3));
});
