// Gmail counts its per-user quota per minute, and on 11 October it refused searches of 200, 100
// and 100 results started together (and one of 500 alone) with «Quota exceeded … Units per minute
// per user»: a search lists ids then fetches every message in parallel, so one search is hundreds
// of requests at once. Such a refusal is temporary, so retry it with exponential backoff instead of
// letting it end the search with an error. The budget is 90 s: the quota is counted per minute, so a
// wait of a little over a minute lets the window roll over.

export interface QuotaRetryOptions {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    random?: () => number;
    budgetMs?: number;
}

const DEFAULT_BUDGET_MS = 90000;
const MAX_CEILING_MS = 32000;

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

// Gmail's refusals arrive in several shapes across googleapis versions, so read each field from
// wherever it may hide rather than trusting one of them.
function readError(error: unknown): { status?: number; message: string; reasons: string[] } {
    if (error === null || typeof error !== 'object') {
        return { message: String(error), reasons: [] };
    }
    const e = error as any;
    let status: number | undefined;
    for (const candidate of [e.status, e.code, e.response?.status, e.cause?.code]) {
        if (typeof candidate === 'number') {
            status = candidate;
            break;
        }
    }
    const message = typeof e.message === 'string' ? e.message : '';
    const reasons: string[] = [];
    for (const list of [e.cause?.errors, e.response?.data?.error?.errors, e.errors]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (entry && typeof entry.reason === 'string') reasons.push(entry.reason);
        }
    }
    return { status, message, reasons };
}

// Only a refusal that waiting can relieve is retried: Gmail documents 429 and 403
// rateLimitExceeded/userRateLimitExceeded as "retry with exponential backoff", whereas a missing
// scope, another 403, or a daily limit is not cured by waiting.
export function isQuotaRefusal(error: unknown): boolean {
    const { status, message, reasons } = readError(error);
    if (reasons.includes('dailyLimitExceeded')) return false;
    if (status === 429) return true;
    if (status === 403) {
        if (reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')) {
            return true;
        }
        const lower = message.toLowerCase();
        if (lower.includes('quota exceeded') && lower.includes('per minute')) return true;
    }
    return false;
}

// `retry-after` is either a number of seconds or an HTTP date; turn whichever is present into ms.
function retryAfterMs(error: unknown, nowMs: number): number | undefined {
    const headers = (error as any)?.response?.headers;
    if (headers === null || headers === undefined) return undefined;
    let raw: unknown;
    if (typeof headers.get === 'function') {
        raw = headers.get('retry-after');
    } else if (typeof headers === 'object') {
        raw = headers['retry-after'] ?? headers['Retry-After'];
    }
    if (raw === null || raw === undefined) return undefined;
    const text = String(raw).trim();
    if (text === '') return undefined;
    const seconds = Number(text);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const date = Date.parse(text);
    if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
    return undefined;
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    const e = error as any;
    return typeof e?.message === 'string' ? e.message : String(error);
}

// Wraps a client so every method call retries a quota refusal, recursively through its nested
// objects (users.messages.get, users.settings.sendAs.list, …). Each call has its own budget, so
// the hundreds of message fetches of one search each wait out the quota on their own.
export function withQuotaRetry<T extends object>(client: T, options: QuotaRetryOptions = {}): T {
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());
    const random = options.random ?? Math.random;
    const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;

    const wrappers = new WeakMap<object, object>();

    const retryCall = async (fn: (...args: any[]) => unknown, thisArg: unknown, args: any[]): Promise<unknown> => {
        const started = now();
        const deadline = started + budgetMs;
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn.apply(thisArg, args);
            } catch (error) {
                if (!isQuotaRefusal(error)) throw error;
                // Equal jitter: parallel requests refused together spread out instead of returning
                // in lockstep, and the minimum keeps a retry from being immediate.
                const ceiling = Math.min(MAX_CEILING_MS, 1000 * 2 ** attempt);
                let delay = ceiling / 2 + random() * ceiling / 2;
                const asked = retryAfterMs(error, now());
                if (asked !== undefined && asked > delay) delay = asked;
                const remaining = deadline - now();
                if (remaining <= 0) {
                    const seconds = Math.floor((now() - started) / 1000);
                    // `cause` is assigned rather than passed: tsconfig's ES2020 lib predates that option.
                    throw Object.assign(
                        new Error(`Gmail refused this request for its per-minute quota and was still refusing after ${seconds} seconds of retries: ${messageOf(error)}`),
                        { cause: error }
                    );
                }
                await sleep(Math.min(delay, remaining));
            }
        }
    };

    const wrapObject = (obj: object): object => {
        const cached = wrappers.get(obj);
        if (cached !== undefined) return cached;
        // The proxy's target is an empty object, not `obj`: the real client defines `users` as a
        // read-only, non-configurable property, and a proxy may not answer such a property of its
        // target with anything but the property's own value, so wrapping it would throw.
        const proxy = new Proxy({}, {
            get(_, property) {
                const value = Reflect.get(obj, property);
                if (typeof value === 'function') {
                    const fn = value as (...args: any[]) => unknown;
                    return (...args: any[]) => retryCall(fn, obj, args);
                }
                if (value !== null && typeof value === 'object') return wrapObject(value);
                return value;
            },
        });
        wrappers.set(obj, proxy);
        return proxy;
    };

    return wrapObject(client) as T;
}
