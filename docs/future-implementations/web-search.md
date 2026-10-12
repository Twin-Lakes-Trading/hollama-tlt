# Web search for Scipio LLM

**Status:** built (2026-10-11). This was the plan; where the code differs, the code wins. The toggle is the globe button in the prompt toolbar, the server side is [src/lib/server/webTools.ts](../../src/lib/server/webTools.ts), and the tool loop is in [the session page](../../src/routes/sessions/[id]/+page.svelte). SearXNG is installed by [deploy/install-searxng.sh](../../deploy/install-searxng.sh) and runs under Granian, as SearXNG's own container does.

## Goal

Let `scipio-think` research a question: search the web, read a few pages, and answer with sources. People turn it on per session with a **Web search** toggle, so normal chats stay fast and nothing leaves the mini unless they ask for it.

## What we already know

Checked against the Mac mini on 2026-10-11 (`/api/show` and `/api/version`):

| Fact                        | Value                                              |
| --------------------------- | -------------------------------------------------- |
| Ollama version              | 0.33.0                                             |
| `scipio-think` capabilities | `completion`, `tools`, `thinking`                  |
| `scipio-code` capabilities  | `completion`, `tools`                              |
| `num_ctx` (both models)     | 16384, set in their Modelfiles                     |
| Model max context           | 262144 (don't raise `num_ctx` past 16K, see below) |

Both models support tool calling, so no model changes are needed. The work is all in Scipio UI and on the mini.

## How it works

```
Browser (Scipio UI)                    Node server (mini)        SearXNG (mini)
 1. /api/chat with tools ──► Ollama
 2. ◄── message.tool_calls
 3. POST /api/tools/search ──────────► search(query) ─────────► /search?format=json
 4. ◄── results ◄──────────────────────────────────────────────
 5. /api/chat with tool result ──► Ollama
 6. …repeat until the model answers without a tool call
```

1. When web search is on, the browser sends `/api/chat` with a `tools` array describing `web_search` and `fetch_page`.
2. If the model wants a tool, the response contains `message.tool_calls` instead of (or alongside) content.
3. The browser sends each tool call to a new endpoint on the Scipio UI Node server. The browser can't do this itself: SearXNG isn't exposed, and most websites block cross-origin requests.
4. The server runs the search or fetches the page and returns trimmed text.
5. The browser appends a `role: "tool"` message with the result and calls `/api/chat` again.
6. The loop ends when the model replies without tool calls, or when a limit is hit.

The loop runs in the browser because that's where chats already run (`handleCompletion` in the session page). The server endpoints are stateless helpers.

### Tools

| Tool         | Arguments       | Returns                                                            |
| ------------ | --------------- | ------------------------------------------------------------------ |
| `web_search` | `query: string` | Top 5 results: title, URL, snippet                                 |
| `fetch_page` | `url: string`   | Readable page text, trimmed to about 8,000 characters (~2K tokens) |

## Changes in Scipio UI

| Area               | File                                                                                                                                                        | Change                                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat request types | [src/lib/chat/index.ts](../../src/lib/chat/index.ts)                                                                                                        | Add `tools` to `ChatRequest`, `tool` role and `tool_calls` to `Message`, `toolCalls` to `ChatChunk`                                                                                          |
| Ollama streaming   | [src/lib/chat/ollama.ts](../../src/lib/chat/ollama.ts)                                                                                                      | `handleChatLine` passes `message.tool_calls` through. Add a helper that reads `/api/show` `capabilities` so the toggle only appears for models with `tools`                                  |
| Completion loop    | [src/routes/sessions/[id]/+page.svelte](../../src/routes/sessions/[id]/+page.svelte)                                                                        | Wrap `strategy.chat` in the tool loop, with the limits below. Keep the existing loading state and abort handling                                                                             |
| Session data       | [src/lib/sessions.ts](../../src/lib/sessions.ts)                                                                                                            | Store `webSearch: boolean` on the session, and keep tool calls and results in the message history so a reloaded session shows its sources                                                    |
| Tool steps display | [src/routes/sessions/[id]/Article.svelte](../../src/routes/sessions/[id]/Article.svelte), [Messages.svelte](../../src/routes/sessions/[id]/Messages.svelte) | Show each step ("Searching: …", "Reading: example.com"), collapsible like reasoning, plus the sources used                                                                                   |
| Toggle             | Session Controls or the prompt bar                                                                                                                          | **Web search** on/off per session, hidden when the model lacks `tools`                                                                                                                       |
| Server endpoints   | New `src/routes/api/tools/search/+server.ts` and `src/routes/api/tools/fetch/+server.ts`                                                                    | Call SearXNG, and fetch and extract pages. Read the SearXNG URL from an env var (for example `SEARXNG_URL=http://127.0.0.1:8888`)                                                            |
| Strings            | [src/i18n/en/index.ts](../../src/i18n/en/index.ts)                                                                                                          | Labels for the toggle and steps, then regenerate types with `npx typesafe-i18n --no-watch`                                                                                                   |
| Tests              | `tests/web-search.test.ts`                                                                                                                                  | Mock `/api/chat` returning `tool_calls`, and mock the tool endpoints. Cover a search → fetch → answer loop, the limits, abort mid-loop, and the toggle being hidden for models without tools |

The server endpoints only exist in the Node build (`PUBLIC_ADAPTER=docker-node`), which is how the mini runs it. The browser should show a clear error if they're missing.

## SearXNG on the mini

- **Install without Docker**, for the same memory reason as the UI (see [DEPLOY.md](../DEPLOY.md)): a Python virtualenv under the user's home, following SearXNG's "installation-searxng" guide. It uses roughly 150MB of memory.
- **Bind to `127.0.0.1:8888`**, not the WireGuard address. Only the Node server on the same machine calls it, so it never needs to be reachable from outside the mini.
- **Enable JSON output** in `settings.yml`: `search.formats` must include `json`, or `/search?format=json` returns 403.
- **Set a `server.secret_key`** and turn off the rate limiter, since only the local Node server uses it.
- **Run it as a launch agent** (`com.tlt.searxng`), matching `com.tlt.ollama` and `com.tlt.scipio-ui`: a template in `deploy/` plus a `deploy/install-searxng.sh` that waits for the old agent to be removed before starting, and checks that the server responds.
- Add a `SEARXNG_URL` entry to the Scipio UI launch agent template.

## Limits and context budget

`num_ctx` is 16384 tokens, and raising it risks going over the GPU memory limit (KV cache). Search eats context fast, so cap it:

- At most **3 searches and 3 page reads** per answer. When the limit is reached, tell the model to answer with what it has.
- Search results: **5 results**, snippets only.
- Page text: **about 8,000 characters**, from the main content (strip navigation, scripts and styles).
- Don't send earlier turns' tool results back in later requests. Keep a short "Sources: …" list in their place.

Rough budget for one researched answer: system prompt and question ~1K tokens, 3 searches ~1.5K, 3 pages ~6K, thinking and answer ~6K. That's close to 16K, so the caps matter. Expect a minute or two per researched answer on the M4.

## Security

- **Page fetching is the main risk.** The Node server runs on the mini, so a URL like `http://10.20.0.1/` or `http://127.0.0.1:11434/` would let a model (or a web page steering it) reach the router, Ollama or other machines on the VPN. `fetch_page` must:
  - allow only `http` and `https`
  - resolve the hostname and refuse loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local and WireGuard addresses, including after redirects
  - time out after about 10 seconds and stop reading after about 2MB
- **Web pages are untrusted input.** A page can contain instructions aimed at the model. Keep tools read-only and don't add tools that change anything.
- Searches go out from SearXNG to Google, Bing etc. without identifying the person, but the search terms still reach those engines.

## Open questions

- Should `scipio-code` get the toggle too? It supports tools, but has no thinking mode, so it may search less carefully.
- Which SearXNG engines to enable (fewer engines respond faster).
- Should the final answer cite sources inline (`[1]`), or list them below the answer?
