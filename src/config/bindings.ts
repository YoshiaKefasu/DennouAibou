import type { OpenClawConfig } from "./config.js";
import type { AgentBinding, AgentRouteBinding } from "./types.agents.js";

export type ConfiguredBindingRule = AgentBinding;

export function isRouteBinding(binding: AgentBinding): binding is AgentRouteBinding {
  return true;
}

export function listConfiguredBindings(cfg: OpenClawConfig): AgentBinding[] {
  return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}

export function listRouteBindings(cfg: OpenClawConfig): AgentRouteBinding[] {
  return listConfiguredBindings(cfg).filter(isRouteBinding);
}
