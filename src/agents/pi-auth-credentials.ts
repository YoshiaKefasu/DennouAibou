export type PiApiKeyCredential = { type: "api_key"; key: string };
export type PiOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

export type PiCredential = PiApiKeyCredential | PiOAuthCredential;
export type PiCredentialMap = Record<string, PiCredential>;

// Note: auth-profiles store converters (convertAuthProfileCredentialToPi /
// resolvePiCredentialMapFromStore) were removed with the auth-profiles DEBLOAT.
// PiCredential/PiCredentialMap remain as the env-backed credential shape used by
// pi-model-discovery.
