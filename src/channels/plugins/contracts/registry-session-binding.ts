import { expect } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  getSessionBindingService,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { loadBundledPluginPublicSurfaceSync } from "../../../test-utils/bundled-plugin-public-surface.js";
import { createChannelConversationBindingManager } from "../conversation-bindings.js";
import {
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId,
} from "./manifest.js";
import "./registry.js";

type SessionBindingContractEntry = {
  id: string;
  expectedCapabilities: SessionBindingCapabilities;
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
};
function getContractApi<T extends Record<string, unknown>>(pluginId: string): T {
  return loadBundledPluginPublicSurfaceSync<T>({
    pluginId,
    artifactBasename: "contract-api.js",
  });
}

function expectResolvedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }),
  )?.toMatchObject({
    targetSessionKey: params.targetSessionKey,
  });
}

async function unbindAndExpectClearedSessionBinding(binding: SessionBindingRecord) {
  const service = getSessionBindingService();
  const removed = await service.unbind({
    bindingId: binding.bindingId,
    reason: "contract-test",
  });
  expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
  expect(service.resolveByConversation(binding.conversation)).toBeNull();
}

function expectClearedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
    }),
  ).toBeNull();
}

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

const sessionBindingContractEntries: Record<
  SessionBindingContractChannelId,
  Omit<SessionBindingContractEntry, "id">
> = {
  discord: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: async () => {
      const { createThreadBindingManager } = await getContractApi<{
        createThreadBindingManager: (params: {
          accountId: string;
          persist: boolean;
          enableSweeper: boolean;
        }) => unknown;
      }>("discord");
      createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      return getSessionBindingService().getCapabilities({
        channel: "discord",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      const { createThreadBindingManager } = await getContractApi<{
        createThreadBindingManager: (params: {
          accountId: string;
          persist: boolean;
          enableSweeper: boolean;
        }) => unknown;
      }>("discord");
      createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:discord:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:123456789012345678",
        },
        placement: "current",
        metadata: {
          label: "codex-discord",
        },
      });
      expectResolvedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
        targetSessionKey: "agent:discord:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const { createThreadBindingManager } = await getContractApi<{
        createThreadBindingManager: (params: {
          accountId: string;
          persist: boolean;
          enableSweeper: boolean;
        }) => { stop: () => void };
      }>("discord");
      const manager = createThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      manager.stop();
      expectClearedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
      });
    },
  },
  telegram: {
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "telegram",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:main:subagent:child-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100200300:topic:77",
        },
        placement: "current",
        metadata: {
          boundBy: "user-1",
        },
      });
      expectResolvedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
        targetSessionKey: "agent:main:subagent:child-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
      });
    },
  },
};

let sessionBindingContractRegistryCache: SessionBindingContractEntry[] | undefined;

export function getSessionBindingContractRegistry(): SessionBindingContractEntry[] {
  sessionBindingContractRegistryCache ??= sessionBindingContractChannelIds.map((id) => ({
    id,
    ...sessionBindingContractEntries[id],
  }));
  return sessionBindingContractRegistryCache;
}
