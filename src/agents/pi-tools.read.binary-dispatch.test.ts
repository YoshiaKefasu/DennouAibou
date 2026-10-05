/**
 * DEBLOAT §38: read ツールへの image/pdf/audio 一本化の単体テスト。
 *
 * - テキスト/画像は従来通り base ツールへ委譲する
 * - PDF は pdf-extract による直接テキスト抽出になる
 * - 音声は modelSupportsAudio=true なら base64 パススルー、
 *   false なら transcribeAudio（Whisper）に回る
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createOpenClawReadTool } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

function makeStubBase(calls: string[][]) {
  return {
    name: "read",
    label: "read",
    description: "stub base read",
    parameters: { type: "object", properties: {} },
    execute: async (_toolCallId: string, args: unknown) => {
      const rawPath = (args as Record<string, unknown>)?.path;
      calls.push([typeof rawPath === "string" ? rawPath : ""]);
      return {
        content: [{ type: "text", text: "base-result" }],
        details: {},
      };
    },
  } as unknown as AnyAgentTool;
}

function getBlocks(result: unknown): ContentBlock[] {
  const content = (result as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function getDetails(result: unknown): Record<string, unknown> {
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" ? (details as Record<string, unknown>) : {};
}

/** 最小の有効な WAV（44.1kHz mono 16bit, 無音 0.1s）を組み立てる */
function buildMinimalWav(): Buffer {
  const sampleRate = 44100;
  const samples = Math.floor(sampleRate * 0.1);
  const dataSize = samples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

/** テキスト抽出可能な最小 PDF（xref なしでも pdfjs が読める形式）を組み立てる */
function buildMinimalPdf(): Buffer {
  const line = "Hello PDF world. This is a test document for extraction. ";
  const text = line.repeat(8).trim();
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = "%PDF-1.4\n";
  for (const n of [1, 2, 3, 5]) {
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const streamBytes = Buffer.byteLength(stream, "utf-8");
  pdf += `4 0 obj\n<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream\nendobj\n`;
  pdf += "trailer\n<< /Root 1 0 R >>\n";
  return Buffer.from(pdf, "utf-8");
}

describe("createOpenClawReadTool binary pre-dispatch (DEBLOAT §38)", () => {
  it("delegates text files to the base tool and records details.readPath", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-text-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello text", "utf-8");
      const calls: string[][] = [];
      const tool = createOpenClawReadTool(makeStubBase(calls), { workspaceDir });
      const result = await tool.execute("t1", { path: "note.txt" });
      expect(calls).toEqual([["note.txt"]]);
      expect(getBlocks(result)[0]?.text).toBe("base-result");
      expect(getDetails(result).readPath).toBe("note.txt");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("delegates images to the base tool (existing image pipeline)", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-img-"));
    try {
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: "#00ff00" },
      })
        .png()
        .toBuffer();
      await fs.writeFile(path.join(workspaceDir, "pic.png"), png);
      const calls: string[][] = [];
      const tool = createOpenClawReadTool(makeStubBase(calls), { workspaceDir });
      const result = await tool.execute("t1", { path: "pic.png" });
      expect(calls).toEqual([["pic.png"]]);
      expect(getDetails(result).readPath).toBe("pic.png");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("extracts PDF text locally without calling the base tool", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-pdf-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "doc.pdf"), buildMinimalPdf());
      const calls: string[][] = [];
      const tool = createOpenClawReadTool(makeStubBase(calls), { workspaceDir });
      const result = await tool.execute("t1", { path: "doc.pdf" });
      expect(calls).toEqual([]);
      const blocks = getBlocks(result);
      expect(blocks[0]?.type).toBe("text");
      expect(blocks[0]?.text).toContain("Hello PDF world.");
      expect(getDetails(result)).toMatchObject({ format: "pdf" });
      expect(getDetails(result).readPath).toBe("doc.pdf");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("passes audio through as base64 when the model supports audio", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-aud-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "note.wav"), buildMinimalWav());
      const calls: string[][] = [];
      const tool = createOpenClawReadTool(makeStubBase(calls), {
        workspaceDir,
        modelSupportsAudio: true,
      });
      const result = await tool.execute("t1", { path: "note.wav" });
      expect(calls).toEqual([]);
      const blocks = getBlocks(result);
      const audio = blocks.find((b) => b.type === "audio");
      expect(audio?.mimeType).toBe("audio/wav");
      expect(typeof audio?.data).toBe("string");
      expect((audio?.data ?? "").length).toBeGreaterThan(0);
      expect(getDetails(result)).toMatchObject({ format: "audio" });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("transcribes audio when the model lacks audio support", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-tr-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "note.wav"), buildMinimalWav());
      const calls: string[][] = [];
      const tool = createOpenClawReadTool(makeStubBase(calls), {
        workspaceDir,
        modelSupportsAudio: false,
        transcribeAudio: async () => ({
          transcript: "hello transcribed",
          provider: "groq",
          model: "whisper-large-v3-turbo",
        }),
      });
      const result = await tool.execute("t1", { path: "note.wav" });
      expect(calls).toEqual([]);
      expect(getBlocks(result)[0]?.text).toBe("hello transcribed");
      expect(getDetails(result)).toMatchObject({ format: "audio", transcribed: true });
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("returns an explanatory error for audio without a transcriber", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-notr-"));
    try {
      await fs.writeFile(path.join(workspaceDir, "note.wav"), buildMinimalWav());
      const calls: string[][] = [];
      const tool = createOpenClawReadTool(makeStubBase(calls), {
        workspaceDir,
        modelSupportsAudio: false,
      });
      const result = await tool.execute("t1", { path: "note.wav" });
      expect(calls).toEqual([]);
      expect(getBlocks(result)[0]?.text).toContain("no transcription engine");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
