/**
 * A reproducible tar.
 *
 * Everything a tar would otherwise pick up from the machine is fixed here, so an
 * identical tree and an identical timestamp give an identical digest.
 *
 * The layer is NOT compressed, and that is the decision this file rests on.
 * Compressed output would depend on which deflate implementation ran: zlib,
 * zlib-ng and libdeflate produce different streams at the same level, and zlib's
 * own output has changed between versions. A digest that depends on the runtime
 * that built it cannot be reproduced by anyone else, which is the whole point of
 * pinning one. Registries compress in transport, and a Worker bundle is a few
 * megabytes, so the storage difference buys nothing worth that.
 *
 * Format is ustar. Only regular files are written, at mode 0644:
 *
 *   - Directory entries are left out. Extractors create parents, and emitting
 *     them adds ordering and mode questions with no benefit.
 *   - The executable bit is dropped rather than preserved. It survives neither a
 *     zip download nor a Windows checkout nor a clone with core.fileMode=false,
 *     so reading it off the filesystem would make the digest depend on how the
 *     tree was obtained. Nothing in a Worker bundle is executed directly.
 *   - Symlinks, hardlinks and device nodes are never written, so no inode order
 *     or link-detection heuristic can reach the digest.
 *
 * Paths that do not fit a ustar header are rejected rather than promoted to a
 * PAX or GNU extension, since the promotion is automatic in most writers and
 * would silently change the header format when one file gets a deeper path.
 */

export type Entry = {
  /** Path inside the archive, with forward slashes and no leading `./`. */
  readonly path: string;
  readonly data: Uint8Array;
};

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Octal, NUL-terminated, left-padded with zeroes. The classic tar number. */
const octal = (value: number, width: number): Uint8Array => {
  // A negative or fractional value has no octal spelling here. `(-1).toString(8)`
  // is `"-1"`, which pads to `000000000-1`: not a number any reader accepts, and
  // written without complaint. Reachable from `--created` with a date before 1970.
  if (!Number.isInteger(value) || value < 0) throw new Error(`not a whole number of at least zero: ${value}`);
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length > width - 1) throw new Error(`value ${value} does not fit in ${width} octal bytes`);
  return ascii(`${text}\0`);
};

const put = (buf: Uint8Array, at: number, bytes: Uint8Array): void => {
  buf.set(bytes, at);
};

/**
 * ustar splits a long path across `prefix` and `name` at a slash. Anything that
 * cannot be split is rejected rather than silently truncated or promoted to a
 * GNU extension, which would make the archive non-reproducible across writers.
 *
 * MEASURED IN BYTES, and it used to be measured in `String.length`. The two
 * agree only for ASCII: a 63-character path of `ä` is 123 bytes, passed the
 * 100-character check, and was written into a 100-byte field, so mode, uid, gid,
 * size and mtime were overwritten by the tail of the name and the rest spilled
 * into `linkname`. The checksum is computed afterwards, so the header came out
 * self-consistent and no reader complained: GNU tar listed a truncated name and
 * the missing bytes were simply gone. Two paths differing only past byte 100
 * also collided on unpack, and the duplicate check compares JS strings so it did
 * not catch them.
 *
 * THE SPLIT TAKES THE LONGEST PREFIX, which is what GNU tar, libarchive and
 * Go's `archive/tar` all do. Taking the shortest is equally valid ustar and
 * produces different header bytes for the same logical path, so a second
 * implementation using its standard library's tar writer would compute a
 * different layer digest for identical content. For a format whose premise is
 * that anybody can rebuild the artifact and get the same digest, agreeing with
 * the existing writers is the requirement.
 */
const splitPath = (path: string): { name: string; prefix: string } => {
  const bytes = ascii(path);
  if (bytes.length <= NAME_MAX) return { name: path, prefix: "" };

  // Byte indices of every slash, so the search below is over the encoding rather
  // than over code units.
  const slashes: number[] = [];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x2f) slashes.push(i);

  for (let k = slashes.length - 1; k >= 0; k--) {
    const at = slashes[k] as number;
    if (at > PREFIX_MAX) continue;
    if (bytes.length - at - 1 > NAME_MAX) break;
    const decoder = new TextDecoder();
    return {
      prefix: decoder.decode(bytes.subarray(0, at)),
      name: decoder.decode(bytes.subarray(at + 1)),
    };
  }

  throw new Error(`path is too long for a ustar header and cannot be split: ${path}`);
};

const header = (entry: Entry, mtime: number): Uint8Array => {
  const buf = new Uint8Array(BLOCK);
  const { name, prefix } = splitPath(entry.path);

  put(buf, 0, ascii(name));
  put(buf, 100, octal(0o644, 8));
  put(buf, 108, octal(0, 8)); // uid
  put(buf, 116, octal(0, 8)); // gid
  put(buf, 124, octal(entry.data.length, 12));
  put(buf, 136, octal(mtime, 12));
  put(buf, 148, ascii("        ")); // checksum placeholder, spaces per the spec
  buf[156] = 0x30; // typeflag '0', regular file
  put(buf, 257, ascii("ustar\0"));
  put(buf, 263, ascii("00"));
  // uname and gname stay empty, so no machine's user list leaks into the digest.
  put(buf, 329, octal(0, 8)); // devmajor
  put(buf, 337, octal(0, 8)); // devminor
  put(buf, 345, ascii(prefix));

  let sum = 0;
  for (const byte of buf) sum += byte;
  put(buf, 148, ascii(`${sum.toString(8).padStart(6, "0")}\0 `));

  return buf;
};

const pad = (length: number): number => (BLOCK - (length % BLOCK)) % BLOCK;

/**
 * Entries are sorted by the bytes of their path, so neither filesystem order nor
 * a locale-aware collation can reach the digest.
 */
export const tar = (entries: readonly Entry[], mtime: number): Uint8Array => {
  const bytes = new TextEncoder();
  const sorted = [...entries].sort((a, b) => Buffer.compare(bytes.encode(a.path), bytes.encode(b.path)));

  const seen = new Set<string>();
  for (const e of sorted) {
    if (seen.has(e.path)) throw new Error(`duplicate path in archive: ${e.path}`);
    seen.add(e.path);
  }

  const parts: Uint8Array[] = [];
  let size = 0;
  const push = (b: Uint8Array): void => {
    parts.push(b);
    size += b.length;
  };

  for (const entry of sorted) {
    push(header(entry, mtime));
    push(entry.data);
    push(new Uint8Array(pad(entry.data.length)));
  }

  // Two zero blocks end the archive, then padding to a 20-block record.
  push(new Uint8Array(BLOCK * 2));
  const record = BLOCK * 20;
  push(new Uint8Array((record - (size % record)) % record));

  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** Reads a ustar archive back. Only the entry kinds `tar` above writes. */
export const untar = (data: Uint8Array): Entry[] => {
  const out: Entry[] = [];
  const decoder = new TextDecoder();
  const str = (at: number, len: number): string => {
    const slice = data.subarray(at, at + len);
    const end = slice.indexOf(0);
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
  };

  for (let at = 0; at + BLOCK <= data.length; ) {
    const name = str(at, NAME_MAX);
    if (name === "") break; // end-of-archive blocks

    const size = parseInt(str(at + 124, 12).trim() || "0", 8);
    const type = data[at + 156];
    const prefix = str(at + 345, PREFIX_MAX);
    const path = prefix === "" ? name : `${prefix}/${name}`;

    at += BLOCK;
    if (type === 0x30 || type === 0x00) out.push({ path, data: data.slice(at, at + size) });
    at += size + pad(size);
  }

  return out;
};
