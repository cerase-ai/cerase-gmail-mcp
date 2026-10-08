// A stand-in for the googleapis Gmail client: answers the calls the tool
// handlers make and records them, so a test can read what would have been sent.

export function b64(text) {
    return Buffer.from(text, 'utf8').toString('base64');
}

export function decodeRaw(raw) {
    return Buffer.from(raw, 'base64url').toString('utf8');
}

// A message as `users.messages.get` returns it, headers given as [name, value] pairs.
export function message({ id = 'msg-1', threadId = 'thread-1', headers = [], text = 'Hello', html, parts } = {}) {
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
    return { id, threadId, payload };
}

export function fakeGmail({ messages = [], profile = 'owner@example.com', sendAs = [], sendAsError = null, sentId = 'sent-1' } = {}) {
    const byId = Object.fromEntries(messages.map(m => [m.id, m]));
    const calls = { get: [], send: [], drafts: [], getProfile: 0, sendAsList: 0 };
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
                get: async (params) => {
                    calls.get.push(params);
                    const found = byId[params.id];
                    if (!found) throw new Error('Requested entity was not found.');
                    return { data: found };
                },
                send: async (params) => {
                    calls.send.push(params);
                    return { data: { id: sentId, threadId: params.requestBody.threadId || 'thread-new' } };
                },
            },
            drafts: {
                create: async (params) => {
                    calls.drafts.push(params);
                    return { data: { id: 'draft-1' } };
                },
            },
        },
    };
    return { gmail, calls };
}
