import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { loadNativeAudioBlocks, MAX_NATIVE_AUDIO_BYTES } from "./native-audio.js";

function makeAudioPath(dir: string, name = "voice.ogg"): string {
  return path.join(dir, name);
}

describe("loadNativeAudioBlocks", () => {
  it("returns an empty list when no audio paths are provided", async () => {
    expect(await loadNativeAudioBlocks({ paths: undefined })).toEqual([]);
  });

  it("loads an audio attachment into a base64 content block", async () => {
    await withTempDir("openclaw-native-audio-", async (dir) => {
      const audioPath = makeAudioPath(dir);
      await fs.writeFile(audioPath, Buffer.from([1, 2, 3]));
      const blocks = await loadNativeAudioBlocks({
        paths: [audioPath],
        types: ["audio/ogg"],
        localRoots: [dir],
      });
      expect(blocks).toEqual([
        {
          type: "audio",
          data: Buffer.from([1, 2, 3]).toString("base64"),
          mimeType: "audio/ogg",
        },
      ]);
    });
  });

  it("returns an empty list when the file exceeds the 10MB safety cap", async () => {
    await withTempDir("openclaw-native-audio-cap-", async (dir) => {
      const audioPath = makeAudioPath(dir, "large.mp3");
      await fs.writeFile(audioPath, Buffer.alloc(MAX_NATIVE_AUDIO_BYTES + 1));
      const blocks = await loadNativeAudioBlocks({
        paths: [audioPath],
        types: ["audio/mpeg"],
        localRoots: [dir],
      });
      expect(blocks).toEqual([]);
    });
  });

  it("skips missing files without failing the turn", async () => {
    await withTempDir("openclaw-native-audio-missing-", async (dir) => {
      const blocks = await loadNativeAudioBlocks({
        paths: [path.join(dir, "nope.ogg")],
        types: ["audio/ogg"],
        localRoots: [dir],
      });
      expect(blocks).toEqual([]);
    });
  });

  it("skips non-audio attachments", async () => {
    await withTempDir("openclaw-native-audio-img-", async (dir) => {
      const imagePath = path.join(dir, "note.png");
      await fs.writeFile(imagePath, Buffer.from("png"));
      const blocks = await loadNativeAudioBlocks({
        paths: [imagePath],
        types: ["image/png"],
        localRoots: [dir],
      });
      expect(blocks).toEqual([]);
    });
  });
});