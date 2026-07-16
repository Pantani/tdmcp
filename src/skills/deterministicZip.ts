import { compareUtf8Bytewise } from "./catalog.js";
import { SkillManagerError } from "./types.js";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const DOS_TIME = 0;
const DOS_DATE_1980_01_01 = 0x0021;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY_UNIX = 0x0314;
const REGULAR_FILE_MODE = 0o100644;
const MAX_ZIP_ENTRIES = 0xffff;
const MAX_ZIP_UINT32 = 0xffffffff;

export interface DeterministicZipEntry {
  path: string;
  data: Buffer;
}

interface PreparedZipEntry extends DeterministicZipEntry {
  name: Buffer;
  crc32: number;
  localOffset: number;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = createCrcTable();

export function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    const tableIndex = (value ^ byte) & 0xff;
    const tableValue = CRC_TABLE[tableIndex];
    if (tableValue === undefined) {
      throw new SkillManagerError("ZIP_CRC_FAILED", "Unable to calculate archive CRC-32.");
    }
    value = tableValue ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function assertArchivePath(path: string): void {
  const bytes = Buffer.byteLength(path, "utf8");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    bytes > 0xffff
  ) {
    throw new SkillManagerError("ZIP_UNSAFE_PATH", `Unsafe archive path: ${path}`);
  }
}

function localHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_NEEDED, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(STORE_METHOD, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 12);
  header.writeUInt32LE(entry.crc32, 14);
  header.writeUInt32LE(entry.data.byteLength, 18);
  header.writeUInt32LE(entry.data.byteLength, 22);
  header.writeUInt16LE(entry.name.byteLength, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_FILE_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
  header.writeUInt16LE(VERSION_NEEDED, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(STORE_METHOD, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.data.byteLength, 20);
  header.writeUInt32LE(entry.data.byteLength, 24);
  header.writeUInt16LE(entry.name.byteLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((REGULAR_FILE_MODE << 16) >>> 0, 38);
  header.writeUInt32LE(entry.localOffset, 42);
  return header;
}

function endOfCentralDirectory(
  entryCount: number,
  centralSize: number,
  centralOffset: number,
): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

/**
 * Creates the intentionally small `.skill` ZIP dialect: STORE only, fixed metadata, no
 * directories, extras, comments, ZIP64, or platform-dependent attributes.
 */
export function createDeterministicSkillZip(entries: readonly DeterministicZipEntry[]): Buffer {
  if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES) {
    throw new SkillManagerError("ZIP_ENTRY_COUNT", "Archive entry count is out of bounds.");
  }
  const paths = new Set<string>();
  const sorted = [...entries].sort((left, right) => compareUtf8Bytewise(left.path, right.path));
  let localOffset = 0;
  const prepared: PreparedZipEntry[] = sorted.map((entry) => {
    assertArchivePath(entry.path);
    if (paths.has(entry.path)) {
      throw new SkillManagerError("ZIP_DUPLICATE_PATH", `Duplicate archive path: ${entry.path}`);
    }
    paths.add(entry.path);
    if (entry.data.byteLength > MAX_ZIP_UINT32) {
      throw new SkillManagerError(
        "ZIP_ENTRY_TOO_LARGE",
        `Archive entry is too large: ${entry.path}`,
      );
    }
    const preparedEntry: PreparedZipEntry = {
      path: entry.path,
      data: entry.data,
      name: Buffer.from(entry.path, "utf8"),
      crc32: crc32(entry.data),
      localOffset,
    };
    localOffset += 30 + preparedEntry.name.byteLength + preparedEntry.data.byteLength;
    if (localOffset > MAX_ZIP_UINT32) {
      throw new SkillManagerError("ZIP_TOO_LARGE", "Archive exceeds classic ZIP limits.");
    }
    return preparedEntry;
  });

  const localParts = prepared.flatMap((entry) => [localHeader(entry), entry.name, entry.data]);
  const centralParts = prepared.flatMap((entry) => [centralHeader(entry), entry.name]);
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  if (centralSize > MAX_ZIP_UINT32 || localOffset + centralSize > MAX_ZIP_UINT32) {
    throw new SkillManagerError("ZIP_TOO_LARGE", "Archive exceeds classic ZIP limits.");
  }
  return Buffer.concat([
    ...localParts,
    ...centralParts,
    endOfCentralDirectory(prepared.length, centralSize, localOffset),
  ]);
}
