import { z } from "zod";

// @deprecated ClawHub is retired in Phase F Slim Kernel (Wave 2). Kept for config backwards compatibility (KASOU 本番 config 保護のため受容のみ・挙動なし).
export const InstallSourceSchema = z.union([
  z.literal("npm"),
  z.literal("archive"),
  z.literal("path"),
  z.literal("clawhub"),
]);

export const PluginInstallSourceSchema = z.union([InstallSourceSchema, z.literal("marketplace")]);

export const InstallRecordShape = {
  source: InstallSourceSchema,
  spec: z.string().optional(),
  sourcePath: z.string().optional(),
  installPath: z.string().optional(),
  version: z.string().optional(),
  resolvedName: z.string().optional(),
  resolvedVersion: z.string().optional(),
  resolvedSpec: z.string().optional(),
  integrity: z.string().optional(),
  shasum: z.string().optional(),
  resolvedAt: z.string().optional(),
  installedAt: z.string().optional(),
  // @deprecated ClawHub is retired in Phase F Slim Kernel (Wave 2). Kept for config backwards compatibility (KASOU 本番 config 保護のため受容のみ・挙動なし).
  clawhubUrl: z.string().optional(),
  clawhubPackage: z.string().optional(),
  clawhubFamily: z.union([z.literal("code-plugin"), z.literal("bundle-plugin")]).optional(),
  clawhubChannel: z
    .union([z.literal("official"), z.literal("community"), z.literal("private")])
    .optional(),
} as const;

export const PluginInstallRecordShape = {
  ...InstallRecordShape,
  source: PluginInstallSourceSchema,
  marketplaceName: z.string().optional(),
  marketplaceSource: z.string().optional(),
  marketplacePlugin: z.string().optional(),
} as const;
