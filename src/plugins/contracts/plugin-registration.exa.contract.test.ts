import { pluginRegistrationContractCases } from "../../../test/helpers/plugins/plugin-registration-contract-cases.js";
import { describePluginRegistrationContract } from "../../../test/helpers/plugins/plugin-registration-contract.js";

// DEBLOAT §41: `exa` is now owned by the `dennou-websearch` plugin.
describePluginRegistrationContract(pluginRegistrationContractCases["dennou-websearch"]);
