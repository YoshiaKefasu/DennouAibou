import { type Api, type Model } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { OpenClawConfig } from "../config/config.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import {
  buildTransportAwareSimpleStreamFn,
  prepareTransportAwareSimpleModel,
} from "./provider-transport-stream.js";

export function prepareModelForSimpleCompletion<TApi extends Api>(params: {
  model: Model<TApi>;
  cfg?: OpenClawConfig;
}): Model<Api> {
  const { model, cfg } = params;
  // Only provider-owned custom APIs need runtime stream registration here.
  if (!getApiProvider(model.api) && registerProviderStreamForModel({ model, cfg })) {
    return model;
  }

  const transportAwareModel = prepareTransportAwareSimpleModel(model);
  if (transportAwareModel !== model) {
    const streamFn = buildTransportAwareSimpleStreamFn(model);
    if (streamFn) {
      ensureCustomApiRegistered(transportAwareModel.api, streamFn);
      return transportAwareModel;
    }
  }

  return model;
}
