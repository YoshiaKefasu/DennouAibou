// @deprecated ClawHub is retired in Phase F Slim Kernel (Wave 2). Kept for backwards compatibility (KASOU 本番 config 保護のため受容のみ・挙動なし).
export type InstallRecordBase = {
  source: "npm" | "archive" | "path" | "clawhub";
  spec?: string;
  sourcePath?: string;
  installPath?: string;
  version?: string;
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
  installedAt?: string;
  // @deprecated ClawHub is retired in Phase F Slim Kernel (Wave 2). Kept for backwards compatibility (KASOU 本番 config 保護のため受容のみ・挙動なし).
  clawhubUrl?: string;
  clawhubPackage?: string;
  clawhubFamily?: "code-plugin" | "bundle-plugin";
  clawhubChannel?: "official" | "community" | "private";
};
