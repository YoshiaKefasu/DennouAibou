import { definePluginEntry } from "../../src/plugin-sdk/plugin-entry.js";
import { createWebFetchTool } from "./src/web-fetch.js";
import { createWebSearchTool } from "./src/web-search.js";

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
  },
});
