export function getDesktopPath(): string {
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME");
  if (!home) {
    throw new Error("Could not resolve home directory for Desktop export.");
  }
  return Deno.build.os === "windows" ? `${home}\\Desktop` : `${home}/Desktop`;
}

export function sanitizeFileName(name: string): string {
  const clean = name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, "_");
  return clean || "session";
}

export function ensureTxtExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith(".txt") ? fileName : `${fileName}.txt`;
}
