import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createOpenAICompletionsTransportStreamFn } from "./openai-transport-stream.js";
import { getModelProviderRequestTransport } from "./provider-request-config.js";

const SUPPORTED_TRANSPORT_APIS = new Set<Api>(["openai-completions"]);

const SIMPLE_TRANSPORT_API_ALIAS: Record<string, Api> = {
  "openai-completions": "openclaw-openai-completions-transport",
};

function createSupportedTransportStreamFn(api: Api): StreamFn | undefined {
  switch (api) {
    case "openai-completions":
      return createOpenAICompletionsTransportStreamFn();
    default:
      return undefined;
  }
}

function hasTransportOverrides(model: Model<Api>): boolean {
  const request = getModelProviderRequestTransport(model);
  return Boolean(request?.proxy || request?.tls);
}

export function isTransportAwareApiSupported(api: Api): boolean {
  return SUPPORTED_TRANSPORT_APIS.has(api);
}

export function resolveTransportAwareSimpleApi(api: Api): Api | undefined {
  return SIMPLE_TRANSPORT_API_ALIAS[api];
}

export function createTransportAwareStreamFnForModel(model: Model<Api>): StreamFn | undefined {
  if (!hasTransportOverrides(model)) {
    return undefined;
  }
  if (!isTransportAwareApiSupported(model.api)) {
    throw new Error(
      `Model-provider request.proxy/request.tls is not yet supported for api "${model.api}"`,
    );
  }
  return createSupportedTransportStreamFn(model.api);
}

export function createBoundaryAwareStreamFnForModel(model: Model<Api>): StreamFn | undefined {
  if (!isTransportAwareApiSupported(model.api)) {
    return undefined;
  }
  return createSupportedTransportStreamFn(model.api);
}

export function prepareTransportAwareSimpleModel<TApi extends Api>(model: Model<TApi>): Model<Api> {
  const streamFn = createTransportAwareStreamFnForModel(model as Model<Api>);
  const alias = resolveTransportAwareSimpleApi(model.api);
  if (!streamFn || !alias) {
    return model;
  }
  return {
    ...model,
    api: alias,
  };
}

export function buildTransportAwareSimpleStreamFn(model: Model<Api>): StreamFn | undefined {
  return createTransportAwareStreamFnForModel(model);
}
