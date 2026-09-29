import type { OpenClawConfig } from "../config/config.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import type { MemoryProviderStatus } from "./status.memory-types.js";

export { getTailnetHostname };

type StatusMemoryManager = {
  probeVectorAvailability(): Promise<boolean>;
  status(): MemoryProviderStatus;
  close?(): Promise<void>;
};

export async function getMemorySearchManager(_params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose: "status";
}): Promise<{ manager: StatusMemoryManager | null }> {
  return { manager: null };
}
