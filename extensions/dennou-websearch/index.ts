import { definePluginEntry } from "../../src/plugin-sdk/plugin-entry.js";
import { createBraveWebSearchProvider } from "./src/brave-web-search-provider.js";
import { createExaWebSearchProvider } from "./src/exa-web-search-provider.js";
import { createWebFetchTool } from "./src/web-fetch.js";
import { createWebSearchTool } from "./src/web-search.js";

export { createBraveWebSearchProvider } from "./src/brave-web-search-provider.js";
export { createExaWebSearchProvider } from "./src/exa-web-search-provider.js";
export { createWebFetchTool } from "./src/web-fetch.js";
export { createWebSearchTool } from "./src/web-search.js";

export default definePluginEntry({
  id: "dennou-websearch",
  name: "dennou-websearch",
  description: "Web search and fetch tools",
  register(api) {
    api.registerTool((ctx) => createWebSearchTool({ config: ctx.config }), {
      names: ["web_search"],
    });
    api.registerTool((ctx) => createWebFetchTool({ config: ctx.config }), {
      names: ["web_fetch"],
    });
    // DEBLOAT §41: the standalone `exa` and `brave` plugins were folded in here,
    // so both providers are registered from this single plugin entrypoint.
    api.registerWebSearchProvider(createExaWebSearchProvider());
    api.registerWebSearchProvider(createBraveWebSearchProvider());
  },
});
