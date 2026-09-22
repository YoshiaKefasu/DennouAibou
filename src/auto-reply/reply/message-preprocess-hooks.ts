import type { OpenClawConfig } from "../../config/config.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessagePreprocessedContext,
  toInternalMessageTranscribedContext,
} from "../../hooks/message-hook-mappers.js";
import type { FinalizedMsgContext } from "../templating.js";

export type EmitPreAgentMessageHooksDeps = {
  fireAndForgetHook: typeof fireAndForgetHook;
  createInternalHookEvent: typeof createInternalHookEvent;
  triggerInternalHook: typeof triggerInternalHook;
};

const defaultEmitPreAgentMessageHooksDeps: EmitPreAgentMessageHooksDeps = {
  fireAndForgetHook,
  createInternalHookEvent,
  triggerInternalHook,
};

export function emitPreAgentMessageHooks(
  params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    isFastTestEnv: boolean;
  },
  deps: Partial<EmitPreAgentMessageHooksDeps> = {},
): void {
  const resolvedDeps = { ...defaultEmitPreAgentMessageHooksDeps, ...deps };
  const fireAndForgetHookFn = resolvedDeps.fireAndForgetHook;
  const createInternalHookEventFn = resolvedDeps.createInternalHookEvent;
  const triggerInternalHookFn = resolvedDeps.triggerInternalHook;
  if (params.isFastTestEnv) {
    return;
  }
  const sessionKey = params.ctx.SessionKey?.trim();
  if (!sessionKey) {
    return;
  }

  const canonical = deriveInboundMessageHookContext(params.ctx);
  if (canonical.transcript) {
    fireAndForgetHookFn(
      triggerInternalHookFn(
        createInternalHookEventFn(
          "message",
          "transcribed",
          sessionKey,
          toInternalMessageTranscribedContext(canonical, params.cfg),
        ),
      ),
      "get-reply: message:transcribed internal hook failed",
    );
  }

  fireAndForgetHookFn(
    triggerInternalHookFn(
      createInternalHookEventFn(
        "message",
        "preprocessed",
        sessionKey,
        toInternalMessagePreprocessedContext(canonical, params.cfg),
      ),
    ),
    "get-reply: message:preprocessed internal hook failed",
  );
}
