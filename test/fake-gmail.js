// A stand-in for the googleapis Gmail client: answers the calls the tool
// handlers make and records them, so a test can read what would have been sent.
// It can also refuse a method with a Gmail-shaped error, to test retries.

export function b64(text) {
    return Buffer.from(text, 'utf8').toString('base64');
}

export function decodeRaw(raw) {
    return Buffer.from(raw, 'base64url').toString('utf8');
}

// A message as `users.messages.get` returns it, headers given as [name, value] pairs.
// `labelIds` is left off entirely when not given, as Gmail does for a message with
// no labels in some responses; an explicit empty array is kept as such.
export function message({ id = 'msg-1', threadId = 'thread-1', headers = [], text = 'Hello', html, parts, labelIds } = {}) {
    const payload = {
        mimeType: html !== undefined ? 'multipart/alternative' : 'text/plain',
        headers: headers.map(([name, value]) => ({ name, value })),
    };
    if (parts) {
        payload.mimeType = 'multipart/mixed';
        payload.parts = parts;
    } else if (html !== undefined) {
        payload.parts = [
            ...(text ? [{ mimeType: 'text/plain', body: { data: b64(text) } }] : []),
            { mimeType: 'text/html', body: { data: b64(html) } },
        ];
    } else {
        payload.body = { data: b64(text) };
    }
    const result = { id, threadId, payload };
    if (labelIds !== undefined) result.labelIds = labelIds;
    return result;
}

// A refusal as Gmail denies a request: an Error carrying the HTTP status, the
// API error object and the response headers (which may hold `retry-after`).
export function googleError({ status = 429, reason = 'rateLimitExceeded', message = 'Quota exceeded', retryAfter, domain } = {}) {
    const apiStatuses = {
        400: 'INVALID_ARGUMENT',
        403: 'PERMISSION_DENIED',
        404: 'NOT_FOUND',
        429: 'RESOURCE_EXHAUSTED',
    };
    const apiStatus = apiStatuses[status] ?? 'PERMISSION_DENIED';
    const rateLimited = reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
    const apiError = {
        code: status,
        message,
        status: apiStatus,
        errors: [{ message, domain: domain ?? (rateLimited ? 'usageLimits' : 'global'), reason }],
    };
    const headers = new Headers();
    if (retryAfter !== undefined) headers.set('retry-after', String(retryAfter));
    const error = new Error(message);
    error.status = status;
    error.code = status;
    error.cause = apiError;
    error.response = { status, headers, data: { error: apiError } };
    return error;
}

export const PER_MINUTE_QUOTA = "Quota exceeded for quota metric 'Units' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:000000000000'.";

// A clock whose sleep resolves at once and advances now, so a test of the retry
// waits nothing on the wall clock but can read what it would have waited.
export function fakeClock() {
    let current = 0;
    const slept = [];
    return {
        slept,
        now: () => current,
        sleep: async (ms) => { slept.push(ms); current += ms; },
        random: () => 0.5,
    };
}

// `attachments` is keyed by attachment id, each value the attachment bytes as a
// base64url string; any other id is refused the way Gmail refuses a bad token.
// `refusals` is keyed by method path ('messages.list', 'messages.get', 'drafts.list',
// 'drafts.get', 'drafts.delete', 'drafts.update', ...). An array makes that method throw one error per call
// until spent then answer; a single error makes it throw on every call. Refused calls are
// still recorded.
export function fakeGmail({ messages = [], drafts = [], attachments = {}, profile = 'owner@example.com', sendAs = [], sendAsError = null, sentId = 'sent-1', refusals = {} } = {}) {
    const byId = Object.fromEntries(messages.map(m => [m.id, m]));
    const draftsById = Object.fromEntries(drafts.map(d => [d.id, d]));
    const queues = Object.fromEntries(
        Object.entries(refusals).map(([method, value]) => [method, Array.isArray(value) ? [...value] : value])
    );
    const refuseOrNot = (method) => {
        const value = queues[method];
        if (value === undefined) return;
        if (Array.isArray(value)) {
            if (value.length > 0) throw value.shift();
            return;
        }
        throw value;
    };
    const calls = { list: [], get: [], send: [], modify: [], deletes: [], drafts: [], draftLists: [], draftGets: [], draftDeletes: [], draftUpdates: [], attachmentGets: [], getProfile: 0, sendAsList: 0 };
    const gmail = {
        users: {
            getProfile: async () => {
                calls.getProfile++;
                return { data: { emailAddress: profile } };
            },
            settings: {
                sendAs: {
                    list: async () => {
                        calls.sendAsList++;
                        if (sendAsError) throw sendAsError;
                        return { data: { sendAs: sendAs.map(sendAsEmail => ({ sendAsEmail })) } };
                    },
                },
            },
            messages: {
                list: async (params) => {
                    calls.list.push(params);
                    refuseOrNot('messages.list');
                    const max = params.maxResults === undefined ? messages.length : params.maxResults;
                    return { data: { messages: messages.slice(0, max).map(m => ({ id: m.id, threadId: m.threadId })) } };
                },
                get: async (params) => {
                    calls.get.push(params);
                    refuseOrNot('messages.get');
                    const found = byId[params.id];
                    if (!found) throw googleError({ status: 404, reason: 'notFound', message: 'Requested entity was not found.' });
                    return { data: found };
                },
                send: async (params) => {
                    calls.send.push(params);
                    refuseOrNot('messages.send');
                    return { data: { id: sentId, threadId: params.requestBody.threadId || 'thread-new' } };
                },
                modify: async (params) => {
                    calls.modify.push(params);
                    refuseOrNot('messages.modify');
                    const found = byId[params.id];
                    if (!found) throw googleError({ status: 404, reason: 'notFound', message: 'Requested entity was not found.' });
                    return { data: { id: params.id, labelIds: [] } };
                },
                delete: async (params) => {
                    calls.deletes.push(params);
                    refuseOrNot('messages.delete');
                    const found = byId[params.id];
                    if (!found) throw googleError({ status: 404, reason: 'notFound', message: 'Requested entity was not found.' });
                    return { data: '' };
                },
                attachments: {
                    get: async (params) => {
                        calls.attachmentGets.push(params);
                        const data = attachments[params.id];
                        if (data === undefined) throw googleError({ status: 400, reason: 'invalidArgument', message: 'Invalid attachment token' });
                        return { data: { data } };
                    },
                },
            },
            drafts: {
                create: async (params) => {
                    calls.drafts.push(params);
                    return { data: { id: 'draft-1' } };
                },
                list: async (params) => {
                    calls.draftLists.push(params);
                    refuseOrNot('drafts.list');
                    if (drafts.length === 0) return { data: {} };
                    const max = params.maxResults === undefined ? drafts.length : params.maxResults;
                    return { data: { drafts: drafts.slice(0, max).map(d => ({ id: d.id, message: { id: d.message.id, threadId: d.message.threadId } })) } };
                },
                get: async (params) => {
                    calls.draftGets.push(params);
                    refuseOrNot('drafts.get');
                    const found = draftsById[params.id];
                    if (!found) throw googleError({ status: 404, reason: 'notFound', message: 'Requested entity was not found.' });
                    return { data: { id: found.id, message: found.message } };
                },
                delete: async (params) => {
                    calls.draftDeletes.push(params);
                    refuseOrNot('drafts.delete');
                    const found = draftsById[params.id];
                    if (!found) throw googleError({ status: 404, reason: 'notFound', message: 'Requested entity was not found.' });
                    return { data: '' };
                },
                update: async (params) => {
                    calls.draftUpdates.push(params);
                    refuseOrNot('drafts.update');
                    const found = draftsById[params.id];
                    if (!found) throw googleError({ status: 404, reason: 'notFound', message: 'Requested entity was not found.' });
                    return { data: { id: params.id, message: { id: 'm-updated', threadId: params.requestBody.message.threadId } } };
                },
            },
        },
    };
    return { gmail, calls };
}

// A client whose every leaf method refuses with `error` and records the dotted
// path it was called on, so a test can prove a failure came from Gmail and not
// from argument validation. Namespaces are plain objects, as withQuotaRetry
// requires: it reads each property and wraps a function as a plain wrapper.
export function refusingGmail(error) {
    const called = [];
    const paths = [
        'users.getProfile',
        'users.messages.list',
        'users.messages.get',
        'users.messages.send',
        'users.messages.modify',
        'users.messages.delete',
        'users.messages.batchModify',
        'users.messages.batchDelete',
        'users.messages.attachments.get',
        'users.drafts.create',
        'users.drafts.list',
        'users.drafts.get',
        'users.drafts.update',
        'users.drafts.delete',
        'users.drafts.send',
        'users.labels.list',
        'users.labels.get',
        'users.labels.create',
        'users.labels.update',
        'users.labels.patch',
        'users.labels.delete',
        'users.settings.sendAs.list',
        'users.settings.filters.list',
        'users.settings.filters.get',
        'users.settings.filters.create',
        'users.settings.filters.delete',
    ];
    const gmail = {};
    for (const path of paths) {
        const parts = path.split('.');
        let node = gmail;
        for (const part of parts.slice(0, -1)) {
            node[part] = node[part] || {};
            node = node[part];
        }
        node[parts[parts.length - 1]] = async () => {
            called.push(path);
            throw error;
        };
    }
    return { gmail, called };
}
