import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type Logger, silentLogger } from "../utils/logger.js";
import { buildNote, type ParsedNote, parseNote } from "./frontmatter.js";

/**
 * A thin, safe wrapper over an Obsidian vault (a folder of markdown files on the
 * local filesystem). Every path is resolved relative to the vault root and is
 * refused if it escapes that root, so user-supplied note names cannot reach
 * outside the vault.
 */
export class Vault {
  readonly root: string;
  private readonly logger: Logger;

  constructor(root: string, logger: Logger = silentLogger) {
    this.root = resolve(expandHome(root));
    this.logger = logger;
    this.logger.debug("vault ready", { root: this.root });
  }

  /** Resolves a vault-relative path, throwing if it would escape the vault root. */
  resolve(relPath: string): string {
    const full = resolve(this.root, relPath);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`Path escapes the vault: ${relPath}`);
    }
    return full;
  }

  exists(relPath: string): boolean {
    return existsSync(this.resolve(relPath));
  }

  read(relPath: string): string {
    return readFileSync(this.resolve(relPath), "utf8");
  }

  write(relPath: string, content: string): void {
    const full = this.resolve(relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  writeBinary(relPath: string, data: Buffer): void {
    const full = this.resolve(relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }

  ensureDir(relPath: string): void {
    mkdirSync(this.resolve(relPath), { recursive: true });
  }

  /** Lists file names directly inside `subdir`, optionally filtered by extension. */
  list(subdir: string, ext?: string): string[] {
    const full = this.resolve(subdir);
    if (!existsSync(full)) return [];
    return readdirSync(full)
      .filter((f) => (ext ? f.endsWith(ext) : true))
      .sort();
  }

  /** Reads a markdown note and splits its frontmatter from its body. */
  readNote(relPath: string): ParsedNote {
    return parseNote(this.read(relPath));
  }

  /** Writes a markdown note from frontmatter data + body. */
  writeNote(relPath: string, data: Record<string, unknown>, body: string): void {
    this.write(relPath, buildNote(data, body));
  }
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(homedir(), p.slice(2));
  return p;
}
