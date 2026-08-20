// Stub: qa-channel extension was removed in DennouAibou debloat.
// qa-lab still references this surface; it will be removed in Step 3.

export const buildQaTarget: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const createQaBusThread: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const deleteQaBusMessage: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const editQaBusMessage: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const getQaBusState: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const injectQaBusInboundMessage: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const normalizeQaTarget: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const parseQaTarget: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const pollQaBus: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const qaChannelPlugin: unknown = {};
export const reactToQaBusMessage: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const readQaBusMessage: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const searchQaBusMessages: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const sendQaBusMessage: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };
export const setQaChannelRuntime: (...args: unknown[]) => unknown = () => { throw new Error("qa-channel removed"); };

// Types preserved for downstream consumers until full removal.
export type QaBusConversation = Record<string, unknown>;
export type QaBusConversationKind = string;
export type QaBusCreateThreadInput = Record<string, unknown>;
export type QaBusDeleteMessageInput = Record<string, unknown>;
export type QaBusEditMessageInput = Record<string, unknown>;
export type QaBusEvent = Record<string, unknown>;
export type QaBusInboundMessageInput = Record<string, unknown>;
export type QaBusMessage = Record<string, unknown>;
export type QaBusOutboundMessageInput = Record<string, unknown>;
export type QaBusPollInput = Record<string, unknown>;
export type QaBusPollResult = Record<string, unknown>;
export type QaBusReactToMessageInput = Record<string, unknown>;
export type QaBusReadMessageInput = Record<string, unknown>;
export type QaBusSearchMessagesInput = Record<string, unknown>;
export type QaBusStateSnapshot = Record<string, unknown>;
export type QaBusThread = Record<string, unknown>;
export type QaBusWaitForInput = Record<string, unknown>;
