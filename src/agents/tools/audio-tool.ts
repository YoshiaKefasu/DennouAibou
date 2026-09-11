import path from "node:path";
import { Type } from "typebox";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/config.js";
import { runAudioTranscription } from "../../media-understanding/audio-transcription-runner.js";
import type { MediaUnderstandingProvider } from "../../media-understanding/types.js";
import { resolveUserPath } from "../../utils.js";
import { resolveMediaToolLocalRoots } from "./media-tool-shared.js";
import {
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxedBridgeMediaPathConfig,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_PROMPT = "Transcribe and describe the audio content.";

type AudioSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

/**
 * `audio` tool: actively listen to an audio file (path or URL).
 *
 * Mirrors the `image`/`pdf` tool design but routes through the existing
 * media-understanding audio engine (`runAudioTranscription`), so the same
 * providers/language/maxBytes policies apply as for inbound audio.
 * Attachments that were already part of the user's message are handled by
 * the normal inbound media pipeline — this tool exists for audio the agent
 * needs to go listen to itself (e.g. a file it just downloaded or a path the
 * user pointed at).
 */
export function createAudioTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sandbox?: AudioSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  /** Provider overrides for the media-understanding audio engine. */
  providers?: Record<string, MediaUnderstandingProvider>;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  if (!agentDir) {
    return null;
  }
  // Explicitly disabled audio understanding: there is no engine to listen with.
  if (options?.config?.tools?.media?.audio?.enabled === false) {
    return null;
  }

  return {
    label: "Audio",
    name: "audio",
    description:
      "Listen to an audio file (path or URL) and transcribe/describe its content using the configured audio transcription engine. Use this to actively listen to voice notes, recordings, or audio files the user references but did not attach to the message. Audio attached to the user's message is transcribed automatically and visible in the prompt.",
    parameters: Type.Object({
      path: Type.String({ description: "Audio file path or URL." }),
      prompt: Type.Optional(
        Type.String({
          description:
            "What to listen for or how to describe the audio. Defaults to transcribing and describing the content.",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const rawPath = typeof record.path === "string" ? record.path.trim() : "";
      if (!rawPath) {
        throw new Error("path required: provide a path or URL to an audio file");
      }
      const prompt =
        typeof record.prompt === "string" && record.prompt.trim()
          ? record.prompt.trim()
          : DEFAULT_PROMPT;

      // `@`-prefixed references are the sandbox inbound convention used by the
      // read/image/pdf tools.
      const pathRaw = rawPath.startsWith("@") ? rawPath.slice(1).trim() : rawPath;
      if (!pathRaw) {
        throw new Error("path required: provide a path or URL to an audio file");
      }

      const isHttpUrl = /^https?:\/\//i.test(pathRaw);
      const isFileUrl = /^file:/i.test(pathRaw);
      const looksLikeWindowsDrive = /^[a-zA-Z]:[\\/]/.test(pathRaw);
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(pathRaw);
      if (hasScheme && !looksLikeWindowsDrive && !isFileUrl && !isHttpUrl) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported audio reference: ${rawPath}. Use a file path, a file:// URL, or an http(s) URL.`,
            },
          ],
          details: { error: "unsupported_audio_reference", path: rawPath },
        };
      }

      const sandboxRoot = options?.sandbox?.root.trim() ?? "";
      const sandboxConfig: SandboxedBridgeMediaPathConfig | null =
        options?.sandbox && sandboxRoot
          ? {
              root: sandboxRoot,
              bridge: options.sandbox.bridge,
              workspaceOnly: options.fsPolicy?.workspaceOnly === true,
            }
          : null;

      if (sandboxConfig && isHttpUrl) {
        throw new Error("Sandboxed audio tool does not allow remote URLs.");
      }

      const resolvedAudio = (() => {
        if (sandboxConfig) {
          return pathRaw;
        }
        if (pathRaw.startsWith("~")) {
          return resolveUserPath(pathRaw);
        }
        // Resolve relative paths against workspaceDir (matching the read tool)
        // so agents can reference workspace-relative audio (e.g. "recordings/note.mp3").
        if (
          !isFileUrl &&
          !isHttpUrl &&
          !looksLikeWindowsDrive &&
          !path.isAbsolute(pathRaw) &&
          options?.workspaceDir
        ) {
          return path.resolve(options.workspaceDir, pathRaw);
        }
        return pathRaw;
      })();

      const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            sandbox: sandboxConfig,
            mediaPath: resolvedAudio,
            inboundFallbackDir: "media/inbound",
          })
        : {
            resolved: resolvedAudio.startsWith("file://")
              ? resolvedAudio.slice("file://".length)
              : resolvedAudio,
          };
      const resolvedPath = resolvedPathInfo.resolved;

      // The media-understanding attachment cache enforces the inbound path
      // policy. Sandboxed paths were already validated through the bridge, so
      // the sandbox root is the allowed root; otherwise reuse the shared
      // local-roots resolution (which honors fsPolicy.workspaceOnly).
      const localPathRoots = sandboxConfig
        ? [sandboxRoot]
        : resolveMediaToolLocalRoots(options?.workspaceDir, {
            workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
          });

      const ctx: MsgContext = isHttpUrl ? { MediaUrl: pathRaw } : { MediaPath: resolvedPath };

      const { transcript, provider, model } = await runAudioTranscription({
        ctx,
        cfg: options?.config ?? {},
        agentDir,
        providers: options?.providers,
        localPathRoots,
        config: {
          ...(options?.config?.tools?.media?.audio ?? {}),
          prompt,
        },
      });

      if (!transcript) {
        return {
          content: [
            {
              type: "text",
              text: "No transcript was produced. The audio could not be transcribed — check that the file is a supported audio format and that an audio transcription provider is configured.",
            },
          ],
          details: {
            error: "no_transcript",
            path: resolvedPath,
            ...(resolvedPathInfo.rewrittenFrom
              ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
              : {}),
          },
        };
      }

      return {
        content: [{ type: "text", text: transcript }],
        details: {
          path: resolvedPath,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
        },
      };
    },
  };
}
