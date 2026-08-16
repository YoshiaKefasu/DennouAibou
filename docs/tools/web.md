---
title: "Web Search"
sidebarTitle: "Web Search"
summary: "web_search and web_fetch -- search the web or fetch page content"
read_when:
  - You want to enable or configure web_search
  - You need to choose a search provider
  - You want to understand auto-detection and provider fallback
---

# Web Search

The `web_search` tool searches the web using your configured provider and
returns results. Results are cached by query for 15 minutes (configurable).

OpenClaw also includes `web_fetch` for lightweight URL fetching. In this
phase, `web_fetch` stays local while `web_search` queries your configured
provider.

<Info>
  `web_search` is a lightweight HTTP tool, not browser automation. For
  JS-heavy sites or logins, use the [Web Browser](/tools/browser). For
  fetching a specific URL, use [Web Fetch](/tools/web-fetch).
</Info>

## Quick start

<Steps>
  <Step title="Choose a provider">
    Pick a provider and complete any required setup. Some providers are
    key-free, while others use API keys. See the provider pages below for
    details.
  </Step>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    ```
    This stores the provider and any needed credential. You can also set an env
    var (for example `BRAVE_API_KEY`) and skip this step for API-backed
    providers.
  </Step>
  <Step title="Use it">
    The agent can now call `web_search`:

    ```javascript
    await web_search({ query: "OpenClaw plugin SDK" });
    ```

  </Step>
</Steps>

## Choosing a provider

<CardGroup cols={2}>
  <Card title="Brave Search" icon="shield" href="/tools/brave-search">
    Structured results with snippets. Supports `llm-context` mode, country/language filters. Free tier available.
  </Card>
  <Card title="DuckDuckGo" icon="bird" href="/tools/duckduckgo-search">
    Key-free fallback. No API key needed. Unofficial HTML-based integration.
  </Card>
  <Card title="Exa" icon="brain" href="/tools/exa-search">
    Neural + keyword search with content extraction (highlights, text, summaries).
  </Card>
  <Card title="Firecrawl" icon="flame" href="/tools/firecrawl">
    Structured results. Best paired with `firecrawl_search` and `firecrawl_scrape` for deep extraction.
  </Card>
  <Card title="Gemini" icon="sparkles" href="/tools/gemini-search">
    AI-synthesized answers with citations via Google Search grounding.
  </Card>
  <Card title="SearXNG" icon="server" href="/tools/searxng-search">
    Self-hosted meta-search. No API key needed. Aggregates Google, Bing, DuckDuckGo, and more.
  </Card>
  <Card title="Tavily" icon="globe" href="/tools/tavily">
    Structured results with search depth, topic filtering, and `tavily_extract` for URL extraction.
  </Card>
</CardGroup>

### Provider comparison

| Provider                                  | Result style               | Filters                                          | API key                                                                          |
| ----------------------------------------- | -------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| [Brave](/tools/brave-search)              | Structured snippets        | Country, language, time, `llm-context` mode      | `BRAVE_API_KEY`                                                                  |
| [DuckDuckGo](/tools/duckduckgo-search)    | Structured snippets        | --                                               | None (key-free)                                                                  |
| [Exa](/tools/exa-search)                  | Structured + extracted     | Neural/keyword mode, date, content extraction    | `EXA_API_KEY`                                                                    |
| [Firecrawl](/tools/firecrawl)             | Structured snippets        | Via `firecrawl_search` tool                      | `FIRECRAWL_API_KEY`                                                              |
| [Gemini](/tools/gemini-search)            | AI-synthesized + citations | --                                               | `GEMINI_API_KEY`                                                                 |
| [SearXNG](/tools/searxng-search)          | Structured snippets        | Categories, language                             | None (self-hosted)                                                               |
| [Tavily](/tools/tavily)                   | Structured snippets        | Via `tavily_search` tool                         | `TAVILY_API_KEY`                                                                 |

## Auto-detection

## Native Codex web search

Codex-capable models can optionally use the provider-native Responses `web_search` tool instead of OpenClaw's managed `web_search` function.

- Configure it under `tools.web.search.openaiCodex`
- It only activates for Codex-capable models (`openai-codex/*` or providers using `api: "openai-codex-responses"`)
- Managed `web_search` still applies to non-Codex models
- `mode: "cached"` is the default and recommended setting
- `tools.web.search.enabled: false` disables both managed and native search

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        openaiCodex: {
          enabled: true,
          mode: "cached",
          allowedDomains: ["example.com"],
          contextSize: "high",
          userLocation: {
            country: "US",
            city: "New York",
            timezone: "America/New_York",
          },
        },
      },
    },
  },
}
```

If native Codex search is enabled but the current model is not Codex-capable, OpenClaw keeps the normal managed `web_search` behavior.

## Setting up web search

Provider lists in docs and setup flows are alphabetical. Auto-detection keeps a
separate precedence order.

If no `provider` is set, OpenClaw checks providers in this order and uses the
first one that is ready:

API-backed providers first:

1. **Brave** -- `BRAVE_API_KEY` or `plugins.entries.brave.config.webSearch.apiKey` (order 10)
2. **Gemini** -- `GEMINI_API_KEY` or `plugins.entries.google.config.webSearch.apiKey` (order 20)
3. **Firecrawl** -- `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey` (order 60)
4. **Exa** -- `EXA_API_KEY` or `plugins.entries.exa.config.webSearch.apiKey` (order 65)
5. **Tavily** -- `TAVILY_API_KEY` or `plugins.entries.tavily.config.webSearch.apiKey` (order 70)

Key-free fallbacks after that:

6. **DuckDuckGo** -- key-free HTML fallback with no account or API key (order 100)
7. **SearXNG** -- `SEARXNG_BASE_URL` or `plugins.entries.searxng.config.webSearch.baseUrl` (order 200)

If no provider is detected, it falls back to Brave (you will get a missing-key
error prompting you to configure one).

<Note>
  All provider key fields support SecretRef objects. In auto-detect mode,
  OpenClaw resolves only the selected provider key -- non-selected SecretRefs
  stay inactive.
</Note>

## Config

```json5
{
  tools: {
    web: {
      search: {
        enabled: true, // default: true
        provider: "brave", // or omit for auto-detection
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

Provider-specific config (API keys, base URLs, modes) lives under
`plugins.entries.<plugin>.config.webSearch.*`. See the provider pages for
examples.

`web_fetch` fallback provider selection is separate:

- choose it with `tools.web.fetch.provider`
- or omit that field and let OpenClaw auto-detect the first ready web-fetch
  provider from available credentials
- today the bundled web-fetch provider is Firecrawl, configured under
  `plugins.entries.firecrawl.config.webFetch.*`

### Storing API keys

<Tabs>
  <Tab title="Config file">
    Run `openclaw configure --section web` or set the key directly:

    ```json5
    {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "YOUR_KEY", // pragma: allowlist secret
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="Environment variable">
    Set the provider env var in the Gateway process environment:

    ```bash
    export BRAVE_API_KEY="YOUR_KEY"
    ```

    For a gateway install, put it in `~/.openclaw/.env`.
    See [Env vars](/help/faq#env-vars-and-env-loading).

  </Tab>
</Tabs>

## Tool parameters

| Parameter             | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `query`               | Search query (required)                               |
| `count`               | Results to return (1-10, default: 5)                  |
| `country`             | 2-letter ISO country code (e.g. "US", "DE")           |
| `language`            | ISO 639-1 language code (e.g. "en", "de")             |
| `search_lang`         | Search-language code (Brave only)                     |
| `freshness`           | Time filter: `day`, `week`, `month`, or `year`        |
| `date_after`          | Results after this date (YYYY-MM-DD)                  |
| `date_before`         | Results before this date (YYYY-MM-DD)                 |
| `ui_lang`             | UI language code (Brave only)                         |

<Warning>
  Not all parameters work with all providers. Brave `llm-context` mode
  rejects `ui_lang`, `freshness`, `date_after`, and `date_before`.
  Gemini returns one synthesized answer with citations. It
  accepts `count` for shared-tool compatibility, but it does not change the
  grounded answer shape.
  SearXNG accepts `http://` only for trusted private-network or loopback hosts;
  public SearXNG endpoints must use `https://`.
  Firecrawl and Tavily only support `query` and `count` through `web_search`
  -- use their dedicated tools for advanced options.
</Warning>

## Examples

```javascript
// Basic search
await web_search({ query: "OpenClaw plugin SDK" });

// German-specific search
await web_search({ query: "TV online schauen", country: "DE", language: "de" });

// Recent results (past week)
await web_search({ query: "AI developments", freshness: "week" });

// Date range
await web_search({
  query: "climate research",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## Tool profiles

If you use tool profiles or allowlists, add `web_search` or `group:web`:

```json5
{
  tools: {
    allow: ["web_search"],
    // or: allow: ["group:web"]  (includes web_search and web_fetch)
  },
}
```

## Related

- [Web Fetch](/tools/web-fetch) -- fetch a URL and extract readable content
- [Web Browser](/tools/browser) -- full browser automation for JS-heavy sites
