import { describeWebSearchProviderContracts } from "../../../test/helpers/plugins/web-search-provider-contract.js";

// DEBLOAT §41: the standalone `exa` plugin was folded into `dennou-websearch`.
describeWebSearchProviderContracts("dennou-websearch", "exa");
