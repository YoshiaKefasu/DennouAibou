import { describeWebSearchProviderContracts } from "../../../test/helpers/plugins/web-search-provider-contract.js";

// DEBLOAT §41: the standalone `brave` plugin was folded into `dennou-websearch`.
describeWebSearchProviderContracts("dennou-websearch", "brave");
