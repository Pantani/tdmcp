/**
 * Project RAG — source-adapter contracts.
 *
 * A {@link SourceAdapter} pulls a batch of {@link RawProjectItem}s from a single
 * source (GitHub repo, GitHub topic, local TD install, …). The service turns
 * each raw item into a fully-formed {@link ProjectRagCard} (id + contentHash +
 * provenance + license).
 *
 * Hard rule: an adapter NEVER touches the TouchDesigner bridge, DMX, or Python
 * exec. F3's bridge-quarantine extractor is a SEPARATE module.
 */

import type { LicenseConfidence, ProjectRagLicense, ProjectRagType } from "../types.js";

/**
 * One raw item discovered by a source — enough metadata to mint a card. The
 * service computes `id`/`contentHash`/`fetchedAt` and writes the card file.
 */
export interface RawProjectItem {
  /** Stable source label, e.g. "github:torinmb/mediapipe-touchdesigner". */
  sourceName: string;
  /** Human-clickable canonical URL (used as `provenance.sourceUrl`). */
  sourceUrl: string;
  /** Hashing base for the card id — usually `sourceUrl` + `pathInRepo`. */
  canonical: string;
  title: string;
  type: ProjectRagType;
  tags: string[];
  license: ProjectRagLicense;
  licenseConfidence: LicenseConfidence;
  licenseFile?: string;
  commitOrVersion?: string;
  pathInRepo?: string;
  body?: string;
  rightsNotes?: string;
  authors?: string[];
  /**
   * Filenames discovered inside the source (e.g. top-level `.tox`/`.toe`).
   * Used as a coarse signal for embedding text and the `technical` score axis.
   */
  files?: string[];
  /**
   * Optional binary download URL (the raw `.tox`/`.toe`). The service downloads
   * it only when `licensePolicy.shouldStoreProjectBinary` permits.
   */
  binaryUrl?: string;
}

export interface SourceAdapterContext {
  /** Optional GitHub token (lifts unauthenticated rate-limit to 5000 req/h). */
  ghToken?: string;
  fetchImpl?: typeof fetch;
}

export interface SourceAdapter {
  /** Adapter identity (matches `--source <name>`). */
  readonly name: string;
  readonly displayName: string;
  /**
   * Pull up to `limit` items. Throws {@link SourceSkippedError} when a hard
   * pre-condition is missing (e.g. unauthenticated rate-limit hit AND no token);
   * the service catches and leaves existing cards untouched (no tombstone).
   */
  fetchItems(limit: number, ctx: SourceAdapterContext): Promise<RawProjectItem[]>;
}
