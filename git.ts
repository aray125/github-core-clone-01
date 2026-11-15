// Git smart HTTP: pkt-line framing, packfiles, upload-pack (protocol v2 and v0) and
// receive-pack (v0). Objects are stored plain — no deltas are ever produced — which the
// trial client accepts: it verifies every object's SHA-1 and the pack trailer.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  buildTree,
  collectReachable,
  collectReachableCutoff,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  ZERO_OID,
} from './store.ts';
import type { Forge, GitObjectType, Repo } from './store.ts';

export const AGENT = 'forge/1.0';

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktChunk {
  readonly type: 'data' | 'flush' | 'delim' | 'end';
  readonly payload: string | null;
}

/** Split a buffer into pkt-line chunks; throws on malformed framing. */
export function parsePktLines(buffer: Buffer): { chunks: PktChunk[] } {
  const chunks: PktChunk[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) throw new Error('truncated pkt-line');
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length > 65524) throw new Error('invalid pkt-line length');
    if (length === 0) {
      chunks.push({ type: 'flush', payload: null });
      offset += 4;
    } else if (length === 1) {
      chunks.push({ type: 'delim', payload: null });
      offset += 4;
    } else if (length === 2) {
      chunks.push({ type: 'end', payload: null });
      offset += 4;
    } else {
      if (buffer.length - offset < length) throw new Error('truncated pkt-line payload');
      const payload = buffer.subarray(offset + 4, offset + length).toString('utf8');
      chunks.push({ type: 'data', payload });
      offset += length;
    }
  }
  return { chunks };
}

/** Split a buffer at the first flush packet; the rest (the pack) follows it. */
export function splitAtFlush(buffer: Buffer): { chunks: PktChunk[]; rest: Buffer } {
  const chunks: PktChunk[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) throw new Error('truncated pkt-line');
    const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length) || length < 0 || length > 65524) throw new Error('invalid pkt-line length');
    if (length === 0) {
      chunks.push({ type: 'flush', payload: null });
      offset += 4;
      return { chunks, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      chunks.push({ type: 'delim', payload: null });
      offset += 4;
    } else if (length === 2) {
      chunks.push({ type: 'end', payload: null });
      offset += 4;
    } else {
      if (buffer.length - offset < length) throw new Error('truncated pkt-line payload');
      chunks.push({ type: 'data', payload: buffer.subarray(offset + 4, offset + length).toString('utf8') });
      offset += length;
    }
  }
  return { chunks, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Serialize objects as a PACK v2 file (plain objects, no deltas), deterministically ordered. */
export function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const sorted = [...oids].sort();
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of sorted) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    const compressed = deflateSync(object.data);
    const size = object.data.length;
    const typeId = TYPE_IDS[object.type];
    const first = (size & 0x0f) | (typeId << 4);
    const bytes: number[] = [];
    let rest = size >>> 4;
    if (rest === 0) bytes.push(first);
    else bytes.push(first | 0x80);
    while (rest > 0) {
      const chunk = rest & 0x7f;
      rest >>>= 7;
      bytes.push(rest === 0 ? chunk : chunk | 0x80);
    }
    parts.push(Buffer.from(bytes), compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface PackEntry {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** Read a packfile; returns the objects it carries, or throws on a bad checksum or framing. */
export function readPack(pack: Buffer): PackEntry[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const stored = pack.subarray(pack.length - 20);
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!stored.equals(actual)) throw new Error('pack checksum mismatch');
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeId === 6) {
      // OFS_DELTA: a negative offset to the base object.
      byte = pack[offset] as number;
      offset += 1;
      let delta = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        delta = ((delta + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - delta;
    } else if (typeId === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    if (typeId !== 6 && typeId !== 7 && ID_TYPES[typeId] === undefined) {
      throw new Error(`unknown pack object type ${typeId}`);
    }
    const dataEnd = inflateEnd(pack, offset);
    const data = inflateSync(pack.subarray(offset, dataEnd));
    offset = dataEnd;
    let resolved: PackEntry;
    if (typeId === 6 || typeId === 7) {
      const base = baseOffset !== null
        ? byOffset.get(baseOffset)
        : entries.find((e) => hashObject(e.type, e.data) === baseOid);
      if (!base) throw new Error('delta base not found in pack');
      resolved = { type: base.type, data: applyDelta(base.data, data) };
    } else {
      resolved = { type: ID_TYPES[typeId] as GitObjectType, data };
    }
    if (resolved.data.length !== size) throw new Error('object size mismatch in pack');
    entries.push(resolved);
    byOffset.set(entryOffset, resolved);
  }
  return entries;
}

function inflateEnd(pack: Buffer, start: number): number {
  // inflateSync ignores trailing bytes, so "it inflates" is monotonic in the slice length:
  // truncated slices fail with Z_BUF_ERROR, the exact end (and anything past it) succeeds.
  // Binary-search the smallest length that inflates.
  try {
    inflateSync(pack.subarray(start, pack.length));
  } catch {
    throw new Error('unterminated zlib stream in pack');
  }
  let lo = start + 1;
  let hi = pack.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(pack.subarray(start, mid));
      hi = mid;
    } catch (error) {
      if ((error as { code?: string }).code === 'Z_BUF_ERROR') lo = mid + 1;
      else throw error;
    }
  }
  return lo;
}

/** Apply a git delta to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { copyOffset |= (delta[offset] as number) << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { copySize |= (delta[offset] as number) << (8 * i); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

interface RefRow {
  readonly oid: string;
  readonly name: string;
  readonly peeled: string | null;
  readonly symrefTarget: string | null;
}

/** All advertised refs, in git's order (HEAD first, then heads, then tags), with peeled tags. */
export function advertisedRefs(repo: Repo): RefRow[] {
  const rows: RefRow[] = [];
  const heads = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/heads/')).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const tags = [...repo.refs.entries()].filter(([name]) => name.startsWith('refs/tags/')).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (defaultTip !== null) rows.push({ oid: defaultTip, name: 'HEAD', peeled: null, symrefTarget: `refs/heads/${repo.defaultBranch}` });
  for (const [name, oid] of heads) rows.push({ oid, name, peeled: null, symrefTarget: null });
  for (const [name, oid] of tags) {
    const object = repo.objects.get(oid);
    const peeled = object && object.type === 'tag' ? peelToCommit((id) => repo.objects.get(id), oid) : null;
    rows.push({ oid, name, peeled, symrefTarget: null });
  }
  return rows;
}

export function uploadPackV2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    FLUSH,
  ]);
}

const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT}`;

export function uploadPackV0Advertisement(repo: Repo): Buffer {
  const rows = advertisedRefs(repo);
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n')];
  if (rows.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`));
  } else {
    const head = rows[0] as RefRow;
    parts.push(pktLine(`${head.oid} HEAD\0${UPLOAD_V0_CAPS}\n`));
    for (const row of rows.slice(1)) {
      parts.push(pktLine(`${row.oid} ${row.name}\n`));
      if (row.peeled !== null) parts.push(pktLine(`${row.peeled} ${row.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;

export function receivePackV0Advertisement(repo: Repo): Buffer {
  const rows = advertisedRefs(repo);
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n')];
  if (rows.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_V0_CAPS}\n`));
  } else {
    const head = rows[0] as RefRow;
    parts.push(pktLine(`${head.oid} HEAD\0${RECEIVE_V0_CAPS}\n`));
    for (const row of rows.slice(1)) {
      parts.push(pktLine(`${row.oid} ${row.name}\n`));
      if (row.peeled !== null) parts.push(pktLine(`${row.peeled} ${row.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch: which objects to send for a set of wants, haves and an optional depth.
// ---------------------------------------------------------------------------

export interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly deepen: number | null;
  readonly shallow: string[];
}

export interface FetchResult {
  readonly pack: Buffer;
  readonly shallowBoundary: string[];
  readonly unshallow: string[];
}

/** The tree and blob objects under a tree (no commits, no parents). */
export function collectTreeOnly(repo: Repo, treeOid: string): Set<string> {
  const seen = new Set<string>();
  const queue = [treeOid];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return seen;
}

export function computeFetch(forge: Forge, repo: Repo, req: FetchRequest): FetchResult {
  const lookup = forge.lookup(repo);
  const wantCommits = req.wants.map((oid) => peelToCommit(lookup, oid));
  const haveCommits = new Set(req.haves.map((oid) => peelToCommit(lookup, oid)));
  // The client's shallow tips are held as commits, trees and blobs — but not their parents.
  const haveReachable = collectReachableCutoff([...haveCommits], lookup, new Set(req.shallow.map((oid) => peelToCommit(lookup, oid))));
  let send: Set<string>;
  let shallowBoundary: string[] = [];
  let unshallow: string[] = [];
  if (req.deepen !== null) {
    const depth = req.deepen;
    const generations = new Map<string, number>();
    const queue: string[] = [];
    for (const want of wantCommits) {
      if (!generations.has(want)) {
        generations.set(want, 0);
        queue.push(want);
      }
    }
    while (queue.length) {
      const oid = queue.shift() as string;
      const gen = generations.get(oid) as number;
      if (gen >= depth) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!generations.has(parent)) {
          generations.set(parent, gen + 1);
          queue.push(parent);
        }
      }
    }
    // Included commits: the first `depth` generations. The shallow boundary is the deepest
    // included commits — those with a parent outside the included set — the way git lists them.
    const included = new Set<string>();
    for (const [oid, gen] of generations) if (gen < depth) included.add(oid);
    const boundary = new Set<string>();
    send = new Set<string>();
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      send.add(oid);
      for (const entryOid of collectTreeOnly(repo, parseCommit(object.data).tree)) send.add(entryOid);
      for (const parent of parseCommit(object.data).parents) {
        if (!included.has(parent)) boundary.add(oid);
      }
    }
    shallowBoundary = [...boundary].sort();
    // An old shallow tip stops being shallow once it is included with its parents.
    for (const old of req.shallow) {
      const peeled = peelToCommit(lookup, old);
      if (included.has(peeled) && !boundary.has(peeled)) unshallow.push(peeled);
    }
    unshallow = [...new Set(unshallow)].sort();
    send = new Set([...send].filter((oid) => !haveReachable.has(oid)));
  } else {
    // Wants are followed unpeeled, so a wanted tag object travels with its target.
    const wantReachable = collectReachable([...req.wants, ...wantCommits], lookup);
    send = new Set([...wantReachable].filter((oid) => !haveReachable.has(oid)));
  }
  return { pack: writePack(repo, send), shallowBoundary, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // A pkt-line is at most 65520 bytes including its 4-byte length, so a sideband frame
  // (1 band byte + payload) carries at most 65515 bytes of pack.
  const maxChunk = 65515;
  for (let offset = 0; offset < pack.length; offset += maxChunk) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxChunk));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const length = payload.length + 4;
    parts.push(Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Upload-pack
// ---------------------------------------------------------------------------

function parseV2Request(buffer: Buffer): { command: string; args: string[] } {
  const { chunks } = parsePktLines(buffer);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const chunk of chunks) {
    if (chunk.type === 'flush') break;
    if (chunk.type === 'delim') {
      seenDelim = true;
      continue;
    }
    if (chunk.type !== 'data' || chunk.payload === null) continue;
    const line = chunk.payload.replace(/\n$/, '');
    if (!seenDelim) {
      const match = /^command=(\S+)$/.exec(line);
      if (match) command = match[1] as string;
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const rows: RefRow[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef) ?? null;
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (defaultTip !== null) {
    if (matches('HEAD')) rows.push({ oid: defaultTip, name: 'HEAD', peeled: null, symrefTarget: symrefs ? defaultRef : null });
  } else if (unborn && matches('HEAD')) {
    rows.push({ oid: '', name: 'HEAD', peeled: null, symrefTarget: symrefs ? defaultRef : null });
  }
  for (const row of advertisedRefs(repo).slice(1)) {
    if (!matches(row.name)) continue;
    rows.push({ oid: row.oid, name: row.name, peeled: peel ? row.peeled : null, symrefTarget: null });
  }
  const lines: string[] = [];
  for (const row of rows) {
    let line: string;
    if (row.oid === '') {
      line = `unborn ${row.name}`;
      if (row.symrefTarget !== null) line += ` symref-target:${row.symrefTarget}`;
    } else {
      line = `${row.oid} ${row.name}`;
      if (row.symrefTarget !== null) line += ` symref-target:${row.symrefTarget}`;
      if (row.peeled !== null) line += ` peeled:${row.peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), FLUSH]);
}

function handleV2Fetch(forge: Forge, repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  const shallow: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5));
    else if (arg.startsWith('have ')) haves.push(arg.slice(5));
    else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8));
  }
  const result = computeFetch(forge, repo, { wants, haves, deepen, shallow });
  const sections: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM];
  if (deepen !== null) {
    sections.push(pktLine('shallow-info\n'));
    for (const oid of result.shallowBoundary) sections.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) sections.push(pktLine(`unshallow ${oid}\n`));
    sections.push(DELIM);
  }
  sections.push(pktLine('packfile\n'));
  sections.push(sidebandPack(result.pack));
  sections.push(FLUSH);
  return Buffer.concat(sections);
}

/** Handle a POST to git-upload-pack. `isV2` is true when the client sent Git-Protocol: version=2. */
export function handleUploadPack(forge: Forge, repo: Repo, body: Buffer, isV2: boolean): { status: number; body: Buffer } {
  try {
    if (isV2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') return { status: 200, body: handleLsRefs(repo, args) };
      if (command === 'fetch') return { status: 200, body: handleV2Fetch(forge, repo, args) };
      return { status: 400, body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` }), 'utf8') };
    }
    // v0 fetch: wants/haves, a flush, then `done` (and maybe `deepen`).
    const { chunks } = parsePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    let deepen: number | null = null;
    const shallow: string[] = [];
    for (const chunk of chunks) {
      if (chunk.type !== 'data' || chunk.payload === null) continue;
      const line = chunk.payload.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8));
    }
    const result = computeFetch(forge, repo, { wants, haves, deepen, shallow });
    const parts: Buffer[] = [pktLine('NAK\n')];
    for (const oid of result.shallowBoundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(sidebandPack(result.pack));
    return { status: 200, body: Buffer.concat(parts) };
  } catch (error) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: `bad request: ${(error as Error).message}` }), 'utf8') };
  }
}

// ---------------------------------------------------------------------------
// Receive-pack (v0)
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Handle a POST to git-receive-pack. Returns the report as sideband band 1 when requested. */
export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): { status: number; body: Buffer } {
  try {
    const { chunks, rest: packBytes } = splitAtFlush(body);
    const commands: PushCommand[] = [];
    let wantsSideBand = false;
    for (const chunk of chunks) {
      if (chunk.type !== 'data' || chunk.payload === null) continue;
      const line = chunk.payload.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const head = nul < 0 ? line : line.slice(0, nul);
      const caps = nul < 0 ? '' : line.slice(nul + 1);
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head);
      if (match) {
        commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
      }
      if (caps.includes('side-band-64k')) wantsSideBand = true;
    }
    // Unpack the pack first: a rejected push still unpacks.
    let unpackOk = true;
    if (packBytes.length > 0) {
      try {
        const entries = readPack(packBytes);
        for (const entry of entries) {
          const oid = hashObject(entry.type, entry.data);
          if (!repo.objects.has(oid)) repo.objects.set(oid, { type: entry.type, data: entry.data });
          if (entry.type === 'commit' && !repo.commitSeq.has(oid)) repo.commitSeq.set(oid, forge.nextSeq());
        }
      } catch {
        unpackOk = false;
      }
    }
    const reportLines: string[] = [];
    reportLines.push(unpackOk ? 'unpack ok' : 'unpack error');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (command.oldOid === ZERO_OID || current === command.oldOid) {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        } else {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined && current !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} missing object`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      if (current === undefined || current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (!isAncestor(forge.lookup(repo), command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
    const report = Buffer.concat([...reportLines.map((l) => pktLine(`${l}\n`)), FLUSH]);
    if (wantsSideBand) {
      const payload = Buffer.concat([Buffer.from([1]), report]);
      const length = payload.length + 4;
      const frame = Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]);
      return { status: 200, body: Buffer.concat([frame, FLUSH]) };
    }
    return { status: 200, body: report };
  } catch (error) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: `bad request: ${(error as Error).message}` }), 'utf8') };
  }
}

/** The empty tree's oid, handy when building a first commit. */
export function emptyTreeOid(): string {
  return hashObject('tree', Buffer.alloc(0));
}

export { buildTree };
