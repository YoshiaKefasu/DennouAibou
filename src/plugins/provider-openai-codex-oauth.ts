import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
// Relative path required: pi-ai exports map does not expose this subpath.
// TODO(pi-sdk): move to public export once pi-ai exposes openaiCodexOAuth in the exports map.
import { openaiCodexOAuth } from "../../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js";
import { ensureGlobalUndiciEnvProxyDispatcher } from "../infra/net/undici-global-dispatcher.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./provider-openai-codex-oauth-tls.js";

const manualInputPromptMessage = "Paste the authorization code (or full redirect URL):";

export async function loginOpenAICodexOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  // Ensure env-based proxy dispatcher is active before any outbound fetch calls,
  // including the TLS preflight check.
  ensureGlobalUndiciEnvProxyDispatcher();

  const preflight = await runOpenAIOAuthTlsPreflight();
  if (!preflight.ok && preflight.kind === "tls-cert") {
    const hint = formatOpenAIOAuthTlsPreflightFix(preflight);
    runtime.error(hint);
    await prompter.note(hint, "OAuth prerequisites");
    throw new Error(preflight.message);
  }

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the redirect URL back here.",
        ].join("\n")
      : [
          "Browser will open for OpenAI authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "OpenAI OAuth uses localhost:1455 for the callback.",
        ].join("\n"),
    "OpenAI Codex OAuth",
  );

  const spin = prompter.progress("Starting OAuth flow…");
  const abortController = new AbortController();
  let manualCodePromise: Promise<string | undefined> | undefined;

  try {
    const interaction: ProviderAuthInteraction = {
      signal: abortController.signal,
      prompt: async (prompt: AuthPrompt): Promise<string> => {
        if (prompt.type === "select") {
          // Always select browser login (consistent with pre-0.84.2 behavior).
          return "browser";
        }
        if (prompt.type === "manual_code") {
          // On remote/VPS: show URL in terminal, get manual input from prompter.
          if (isRemote && manualCodePromise) {
            const code = await manualCodePromise;
            if (!code) throw new Error("Manual code input cancelled");
            return code;
          }
          return await prompter.text({
            message: prompt.message,
            placeholder: prompt.placeholder,
          });
        }
        return await prompter.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
        });
      },
      notify: (event: AuthEvent): void => {
        if (event.type === "auth_url") {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${event.url}\n`);
            manualCodePromise = prompter
              .text({
                message: manualInputPromptMessage,
              })
              .then((value) => String(value));
          } else {
            spin.update(localBrowserMessage ?? "Complete sign-in in browser…");
            void openUrl(event.url);
            runtime.log(`Open: ${event.url}`);
          }
        } else if (event.type === "progress") {
          spin.update(event.message);
        }
      },
    };

    const creds = await openaiCodexOAuth.login(interaction);
    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("OpenAI OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  } finally {
    abortController.abort();
  }
}
