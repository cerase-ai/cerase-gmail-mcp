// Reply-all: who a reply to everyone goes to, and the headers that thread it.
// Every function here is pure; the tool handlers in tools.ts fetch the mail and
// the mailbox owner's addresses and pass them in.

import { validateEmail } from "./utl.js";

// One entry of an address-list header: `display` as written in the header
// (`Name <addr>` or `addr`), `address` the bare address inside it.
export interface Mailbox {
    display: string;
    address: string;
}

// The headers of the mail being answered, as raw header values.
export interface ReplySource {
    from: string;
    to: string;
    cc: string;
    replyTo: string;
}

// What the caller changes on top of reply-all: people to add, people to leave out.
export interface ReplyChanges {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    exclude?: string[];
}

export interface ReplyRecipients {
    to: Mailbox[];
    cc: Mailbox[];
    bcc: Mailbox[];
}

type Header = { name?: string | null; value?: string | null };

// RFC 5322 header lines may never exceed 998 characters.
const MAX_HEADER_LINE = 998;

// Undo header folding: a line break followed by whitespace is the whitespace.
export function unfold(value: string): string {
    return (value || '').replace(/\r?\n([ \t])/g, '$1').replace(/[\r\n]+/g, ' ');
}

// The value of the first header called `name`, compared without case; '' when absent.
export function headerValue(headers: Header[] | undefined, name: string): string {
    const wanted = name.toLowerCase();
    const found = (headers || []).find(h => (h.name || '').toLowerCase() === wanted);
    return found?.value || '';
}

export function replySource(headers: Header[] | undefined): ReplySource {
    return {
        from: headerValue(headers, 'From'),
        to: headerValue(headers, 'To'),
        cc: headerValue(headers, 'Cc'),
        replyTo: headerValue(headers, 'Reply-To'),
    };
}

// Split an address-list header into its entries. Commas inside a quoted display
// name, a comment or angle brackets do not split; a group (`Name: a, b;`) yields
// its members, so `undisclosed-recipients:;` yields nothing.
export function parseAddressList(value: string): Mailbox[] {
    const text = unfold(value);
    const entries: string[] = [];
    let current = '';
    let inQuote = false;
    let comment = 0;
    let nested = 0; // inside <...> or [...]
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuote || comment > 0) {
            current += c;
            if (c === '\\' && i + 1 < text.length) {
                current += text[++i];
            } else if (inQuote && c === '"') {
                inQuote = false;
            } else if (!inQuote && c === '(') {
                comment++;
            } else if (!inQuote && c === ')') {
                comment--;
            }
            continue;
        }
        if (c === '"') inQuote = true;
        else if (c === '(') comment = 1;
        else if (c === '<' || c === '[') nested++;
        else if ((c === '>' || c === ']') && nested > 0) nested--;
        else if (nested === 0 && (c === ',' || c === ';')) {
            entries.push(current);
            current = '';
            continue;
        } else if (nested === 0 && c === ':') {
            current = ''; // a group's display name
            continue;
        }
        current += c;
    }
    entries.push(current);
    return entries
        .map(entry => entry.trim())
        .filter(Boolean)
        .map(display => ({ display, address: bareAddress(display) }));
}

// The address inside one entry: the angle-addr when there is one, otherwise the
// entry without its comments.
function bareAddress(display: string): string {
    let withoutComments = '';
    let angle: string | null = null;
    let collecting: string | null = null;
    let inQuote = false;
    let comment = 0;
    for (let i = 0; i < display.length; i++) {
        const c = display[i];
        if (comment > 0) {
            if (c === '\\') i++;
            else if (c === '(') comment++;
            else if (c === ')') comment--;
            continue;
        }
        let chunk = c;
        if (inQuote) {
            if (c === '\\' && i + 1 < display.length) chunk += display[++i];
            else if (c === '"') inQuote = false;
        } else if (c === '"') {
            inQuote = true;
        } else if (c === '(') {
            comment = 1;
            continue;
        } else if (c === '<') {
            collecting = '';
            withoutComments += c;
            continue;
        } else if (c === '>' && collecting !== null) {
            angle = collecting;
            collecting = null;
            withoutComments += c;
            continue;
        }
        if (collecting !== null) collecting += chunk;
        withoutComments += chunk;
    }
    return (angle !== null ? angle : withoutComments).trim();
}

export function formatAddressList(list: Mailbox[]): string {
    return list.map(m => m.display).join(', ');
}

const key = (m: Mailbox) => m.address.toLowerCase();

// A reply needs someone in To: when nobody is left there, Cc takes its place.
function withTo(to: Mailbox[], cc: Mailbox[]): { to: Mailbox[]; cc: Mailbox[] } {
    return to.length > 0 ? { to, cc } : { to: cc, cc: [] };
}

// Who a reply to everyone goes to. To: the mail's Reply-To, or its From when it
// has none, then its To; Cc: its Cc. When the owner sent the mail, To is its To.
// The owner's own addresses are left out and each address appears once, first
// occurrence kept, an address already in To not repeated in Cc.
export function computeReplyAll(source: ReplySource, ownAddresses: string[]): { to: Mailbox[]; cc: Mailbox[] } {
    const own = new Set(ownAddresses.filter(Boolean).map(a => a.trim().toLowerCase()));
    const isOwn = (m: Mailbox) => own.has(key(m));
    const from = parseAddressList(source.from);
    const replyTo = parseAddressList(source.replyTo);
    const to = parseAddressList(source.to);
    const sentByOwner = from.some(isOwn);
    const toCandidates = sentByOwner ? to : [...(replyTo.length > 0 ? replyTo : from), ...to];
    const seen = new Set<string>();
    const keep = (list: Mailbox[]) => list.filter(m => {
        if (isOwn(m) || seen.has(key(m))) return false;
        seen.add(key(m));
        return true;
    });
    const replyAllTo = keep(toCandidates);
    const replyAllCc = keep(parseAddressList(source.cc));
    return withTo(replyAllTo, replyAllCc);
}

// The recipients of reply_email: reply-all, less the people `exclude` names,
// plus the people `to`, `cc` and `bcc` add. Throws, so that nothing is sent,
// when exclude names someone not on the mail, when no one is left in To and Cc,
// or when a recipient is not an email address.
export function planReplyRecipients(source: ReplySource, ownAddresses: string[], changes: ReplyChanges): ReplyRecipients {
    let { to, cc } = computeReplyAll(source, ownAddresses);
    const bcc: Mailbox[] = [];

    const exclude = (changes.exclude || []).flatMap(entry => parseAddressList(entry));
    if (exclude.length > 0) {
        const onMail = [source.from, source.replyTo, source.to, source.cc].flatMap(parseAddressList);
        const onMailKeys = new Set(onMail.map(key));
        const strangers = exclude.filter(m => !onMailKeys.has(key(m)));
        if (strangers.length > 0) {
            const people = onMail.filter((m, i) => onMail.findIndex(o => key(o) === key(m)) === i);
            throw new Error(`Reply not sent: "exclude" names someone who is not on the mail: ${formatAddressList(strangers)}. People on the mail: ${formatAddressList(people)}.`);
        }
        const excluded = new Set(exclude.map(key));
        to = to.filter(m => !excluded.has(key(m)));
        cc = cc.filter(m => !excluded.has(key(m)));
    }

    const present = new Set([...to, ...cc].map(key));
    const add = (entries: string[] | undefined, list: Mailbox[]) => {
        for (const m of (entries || []).flatMap(entry => parseAddressList(entry))) {
            if (present.has(key(m))) continue;
            present.add(key(m));
            list.push(m);
        }
    };
    add(changes.to, to);
    add(changes.cc, cc);
    add(changes.bcc, bcc);

    const recipients = { ...withTo(to, cc), bcc };
    if (recipients.to.length === 0) {
        throw new Error('Reply not sent: it would go to no one. The mail went only to the mailbox owner, or everyone on it was excluded; name who should receive the reply in "to" or "cc".');
    }
    const invalid = [...recipients.to, ...recipients.cc, ...recipients.bcc].filter(m => !validateEmail(m.address));
    if (invalid.length > 0) {
        throw new Error(`Reply not sent: these recipients are not email addresses: ${formatAddressList(invalid)}. Leave them out with "exclude", and add the right address in "to" or "cc" if it is known.`);
    }
    return recipients;
}

// The original subject with `Re: ` in front, unless it already starts with a reply prefix.
export function replySubject(subject: string): string {
    const original = subject || '';
    return /^\s*(re|r|aw|sv|antw)\s*:/i.test(original) ? original : `Re: ${original}`;
}

// The original References followed by its Message-ID, space-separated. When the
// header would pass the line limit, the first id and the latest ones are kept.
export function buildReferences(references: string, messageId: string): string {
    const text = unfold(references).trim();
    let ids: string[] = text.match(/<[^<>\s]+>/g) || text.split(/\s+/).filter(Boolean);
    const id = unfold(messageId).trim();
    if (id && !ids.includes(id)) ids = [...ids, id];
    const limit = MAX_HEADER_LINE - 'References: '.length;
    if (ids.join(' ').length > limit) {
        const kept = [ids[0]];
        let length = ids[0].length;
        const latest: string[] = [];
        for (let i = ids.length - 1; i > 0 && length + 1 + ids[i].length <= limit; i--) {
            latest.unshift(ids[i]);
            length += 1 + ids[i].length;
        }
        ids = [...kept, ...latest];
    }
    return ids.join(' ');
}
