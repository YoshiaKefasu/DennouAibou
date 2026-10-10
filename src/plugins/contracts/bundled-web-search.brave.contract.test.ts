import { describeBundledWebSearchFastPathContract } from "../../../test/helpers/plugins/bundled-web-search-fast-path-contract.js";

// DEBLOAT §41: the standalone `brave` plugin was folded into `dennou-websearch`.
describeBundledWebSearchFastPathContract("dennou-websearch", "brave");
