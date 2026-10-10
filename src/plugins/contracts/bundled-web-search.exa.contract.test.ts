import { describeBundledWebSearchFastPathContract } from "../../../test/helpers/plugins/bundled-web-search-fast-path-contract.js";

// DEBLOAT §41: the standalone `exa` plugin was folded into `dennou-websearch`.
describeBundledWebSearchFastPathContract("dennou-websearch", "exa");
