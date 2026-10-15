# cerase-gmail-mcp

A Gmail MCP server that runs over stdio. It is a fork of
[GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) at release 1.1.11
(`@gongrzhe/server-gmail-autoauth-mcp`, commit `a890d19`).

Every upstream tool keeps its name, its arguments and its behaviour. The server reads the same
credential files and variables as upstream (`~/.gmail-mcp/credentials.json`,
`~/.gmail-mcp/gcp-oauth.keys.json`, `GMAIL_OAUTH_PATH`, `GMAIL_CREDENTIALS_PATH`), so a mailbox
already connected to upstream works without being connected again.

## What the fork changes

**1. `read_email` shows who the mail went to and how to answer everyone.** The header block is,
in this order:

```
Thread ID: 18c2f0a1b2c3d4e5
Message-ID: <CAF123@mail.example.com>
Subject: Budget Q3
From: Anna Bianchi <anna@example.com>
To: Paolo Verdi <paolo@example.com>, Luca Neri <luca@example.com>
Cc: "Rossi, Mario" <mario@example.com>, giulia@example.com
Reply-To: Anna Bianchi <anna.b@example.com>
Date: Mon, 5 Oct 2026 10:00:00 +0200
Reply-all To: Anna Bianchi <anna.b@example.com>, Luca Neri <luca@example.com>
Reply-all Cc: "Rossi, Mario" <mario@example.com>, giulia@example.com
```

followed by a blank line and the body exactly as upstream returns it. `Cc:` and `Reply-To:` appear
only when the mail has them, `Reply-all Cc:` only when it is not empty.

`Reply-all To` is the mail's Reply-To, or its From when it has none, followed by its To;
`Reply-all Cc` is its Cc. When the mailbox owner sent the mail, `Reply-all To` is the mail's To.
The owner's addresses (the profile address and its send-as aliases) are left out, and each address
appears once, compared without case, an address already in To not repeated in Cc. When nobody is
left in To, Cc moves into To. The example above was read from paolo@example.com.

**2. `reply_email` replies in the same conversation to everyone the mail went to.** Its recipients
are the two Reply-all lines above, less the people named in `exclude`, plus the people `to`, `cc`
and `bcc` add; a person already on the reply keeps their place. The subject gets `Re: ` unless it
already starts with a reply prefix, `In-Reply-To` is the mail's Message-ID and `References` its
References followed by its Message-ID, and the reply is sent in the mail's thread. It sends nothing
and answers an error when nobody would receive it, when a recipient is not an email address, or when
`exclude` names someone who is not on the mail. It answers:

```
Reply sent with ID: 18c2f0a9f8e7d6c5
Thread ID: 18c2f0a1b2c3d4e5
To: Anna Bianchi <anna.b@example.com>, Luca Neri <luca@example.com>
Cc: "Rossi, Mario" <mario@example.com>, giulia@example.com
```

with a `Bcc:` line when it has Bcc. `send_email` and `draft_email` are unchanged.

**3. A request Gmail refuses for its per-minute quota is retried.** A refusal with HTTP 429, or with
403 and reason `rateLimitExceeded` or `userRateLimitExceeded`, is sent again after an exponential
backoff with jitter: the n-th wait lasts between half and all of 1, 2, 4, 8, 16 and then 32 seconds,
or longer when Gmail's `Retry-After` asks for more. A request is retried for up to 90 seconds, a
little over the minute the quota is counted on, and then the tool answers
`Error: Gmail refused this request for its per-minute quota and was still refusing after <n> seconds of retries: <Gmail's message>`.
Any other refusal, a missing scope or the daily limit among them, answers at once as upstream does.
Every tool is covered; `search_emails` fetches every result in parallel, and searches of a few
hundred results are where Gmail has refused it.

The reply-all logic is in `src/reply.ts`; the quota retry is in `src/quota-retry.ts`; the tool list
and the tool handler are in `src/tools.ts`; `src/index.ts` authenticates and serves them over stdio.

## Build and run

Needs Node.js 22 or later, which `@googleapis/gmail` 22 requires.

```sh
npm ci
npm run build
npm prune --omit=dev
node dist/index.js
```

`node dist/index.js auth` runs upstream's browser authentication and writes `credentials.json`.

## Test

```sh
npm test
```

builds and runs Node's test runner on `test/*.test.js`. The tool handlers are called with a fake
Gmail client (`test/fake-gmail.js`), and the quota retry also with the real client against a local
HTTP server, so no Google account is involved.

## Licence

MIT, see [LICENSE](LICENSE): upstream's copyright and licence, plus the copyright of the
modifications.
