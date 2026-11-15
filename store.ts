// The forge's store: every object, ref, issue, label, pull request and comment lives here,
// in memory, behind one Forge instance. No filesystem, no clock: every timestamp derives from
// a fixed epoch plus a monotonic sequence, so two runs on the same requests behave identically.

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** SHA-1 over `<type> <size>\0` + bytes: git's object id. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. The message is stored verbatim. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${tz}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${tz}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export const ZERO_OID = '0'.repeat(40);

/** Every object reachable from `roots`: commits, trees, tags and blobs. */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (/^[0-9a-f]{40}$/.test(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Like collectReachable, but the parents of commits in `cutoff` are not followed: the objects a
 * client with a shallow clone holds. A shallow tip's commit, tree and blobs are held; its parents
 * are not.
 */
export function collectReachableCutoff(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  cutoff: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (/^[0-9a-f]{40}$/.test(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!cutoff.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a tag chain to its commit, or return the oid unchanged when it is not a tag. */
export function peelToCommit(lookup: (oid: string) => GitObject | undefined, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** True when `ancestor` is `tip` itself or reachable from it through commit parents. */
export function isAncestor(lookup: (oid: string) => GitObject | undefined, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const start = peelToCommit(lookup, tip);
  const want = peelToCommit(lookup, ancestor);
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (oid === want) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The scenario's viewer: derived from the contest's one fixed public seed, the
// same pure generator the kit ships (wire.ts). The bearer token names this login.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

class SeedRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

/** The login the trial's bearer token names (the scenario's viewer, users[0]). */
export function scenarioViewerLogin(): { login: string; name: string; email: string; id: number } {
  const rng = new SeedRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let first = { login: '', name: '', email: '', id: 1000 };
  for (let i = 0; i < 12; i += 1) {
    const firstName = rng.pick(FIRST_NAMES);
    const lastName = rng.pick(LAST_NAMES);
    const base = `${firstName}${lastName}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    if (i === 0) first = { login, name: `${firstName} ${lastName}`, email: `${login}@example.invalid`, id: 1000 };
  }
  return first;
}

// ---------------------------------------------------------------------------
// The forge's data model
// ---------------------------------------------------------------------------

/** 2025-01-01T00:00:00Z: every timestamp is this plus a monotonic sequence, never a clock. */
export const FIXED_EPOCH_SEC = 1_735_689_600;

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly comments: IssueComment[];
  readonly createdSeq: number;
  updatedSeq: number;
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  readonly isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdSeq: number;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  /** Insertion order of commits, for GET /commits (newest first). */
  readonly commitSeq: Map<string, number>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  nextNumber: number;
}

export class Forge {
  readonly token: string;
  readonly viewerLogin: string;
  readonly viewerName: string;
  readonly viewerEmail: string;
  readonly viewerId = 1000;
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private seq = 0;
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;
  private requestCounter = 0;

  constructor(token: string) {
    this.token = token;
    const viewer = scenarioViewerLogin();
    this.viewerLogin = viewer.login;
    this.viewerName = viewer.name;
    this.viewerEmail = viewer.email;
  }

  /** The next monotonic sequence number (timestamps and ordering). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An ISO timestamp for a sequence number. */
  isoFor(seq: number): string {
    return new Date((FIXED_EPOCH_SEC + seq) * 1000).toISOString();
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  newRepoId(): number {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    return id;
  }

  newObjectId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  newCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /** The bearer token check: exact match when one is configured; any non-empty token otherwise. */
  authorized(header: string | undefined): boolean {
    if (header === undefined) return false;
    const match = /^Bearer (.+)$/.exec(header.trim());
    if (match === null) return false;
    const presented = match[1] as string;
    if (this.token === '') return presented !== '';
    return presented === this.token;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** A repository only when it belongs to the token's login; anything else is a 404. */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewerLogin) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.repoKey(this.viewerLogin, name))) return null;
    const seq = this.nextSeq();
    const repo: Repo = {
      id: this.newRepoId(),
      owner: this.viewerLogin,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: seq,
      objects: new Map(),
      refs: new Map(),
      commitSeq: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.id);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** Store an object, returning its id; records commit insertion order. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    if (type === 'commit' && !repo.commitSeq.has(oid)) repo.commitSeq.set(oid, this.nextSeq());
    return oid;
  }

  /** The tip of a ref, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** The tip of a branch name, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** The commit graph reachable from `tip`, newest first (by insertion order). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const queue = [tip];
    const found: string[] = [];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      found.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    found.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
    return found;
  }

  /** The merge-base of two commits: the newest commit reachable from both. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = new Set(this.commitsFrom(repo, peelToCommit(this.lookup(repo), a)));
    for (const oid of this.commitsFrom(repo, peelToCommit(this.lookup(repo), b))) {
      if (fromA.has(oid)) return oid;
    }
    return null;
  }
}

/** The identity a server-made commit carries. */
export function serverIdentity(forge: Forge): string {
  return `${forge.viewerName} <${forge.viewerEmail}>`;
}

// ---------------------------------------------------------------------------
// Trees: read and write paths inside a commit's tree, bottom-up.
// ---------------------------------------------------------------------------

/** The entry for `path` inside the tree at `treeOid`, or null. */
export function treeEntryAt(repo: Repo, treeOid: string | null, path: string): TreeEntry | null {
  if (treeOid === null) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** List the direct entries of the directory `dirPath` ('' for the root) in a tree. */
export function treeDirEntries(repo: Repo, treeOid: string | null, dirPath: string): TreeEntry[] | null {
  if (treeOid === null) return null;
  const segments = dirPath.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/**
 * Return a new root tree oid with `path` set to `blobOid` (or removed when null), building the
 * intermediate trees. `forge.putObject` is used through `store` so the tree objects land in the repo.
 */
export function setPathInTree(
  forge: Forge,
  repo: Repo,
  treeOid: string | null,
  path: string,
  blobOid: string | null,
): string {
  const segments = path.split('/').filter((s) => s !== '');
  const build = (currentOid: string | null, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    if (currentOid !== null) {
      const object = repo.objects.get(currentOid);
      if (object && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth] as string;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const childOid = child && child.mode === '40000' ? child.oid : null;
      const next = build(childOid, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    return forge.putObject(repo, 'tree', buildTree([...entries.values()]));
  };
  const root = build(treeOid, 0);
  if (root === null) {
    // An empty tree: git's well-known empty tree object.
    return forge.putObject(repo, 'tree', Buffer.alloc(0));
  }
  return root;
}

/** All paths (files and dirs) of a tree, flattened, with their entries. */
export function flattenTree(repo: Repo, treeOid: string | null, prefix = ''): Array<{ path: string; entry: TreeEntry }> {
  const out: Array<{ path: string; entry: TreeEntry }> = [];
  if (treeOid === null) return out;
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    out.push({ path, entry });
    if (entry.mode === '40000') out.push(...flattenTree(repo, entry.oid, path));
  }
  return out;
}

/** The blob bytes at `path` in the tree of `commitOid`, or null. */
export function blobAtPath(repo: Repo, commitOid: string, path: string): Buffer | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const entry = treeEntryAt(repo, parseCommit(commit.data).tree, path);
  if (!entry || entry.mode !== '100644') return null;
  const blob = repo.objects.get(entry.oid);
  if (!blob || blob.type !== 'blob') return null;
  return blob.data;
}

/** Create a commit on `branch` (creating the branch from the default tip when missing). */
export function commitOnBranch(
  forge: Forge,
  repo: Repo,
  branch: string,
  message: string,
  mutateTree: (treeOid: string | null) => string,
): { commitSha: string; parent: string | null } {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref) ?? null;
  let parentTree: string | null = null;
  if (parent !== null) {
    const object = repo.objects.get(parent);
    if (object && object.type === 'commit') parentTree = parseCommit(object.data).tree;
  }
  const tree = mutateTree(parentTree);
  const seq = forge.nextSeq();
  const identity = serverIdentity(forge);
  const commit = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    message,
    author: identity,
    committer: identity,
    timestamp: FIXED_EPOCH_SEC + seq,
  });
  const commitSha = forge.putObject(repo, 'commit', commit);
  repo.refs.set(ref, commitSha);
  return { commitSha, parent };
}

// ---------------------------------------------------------------------------
// Three-way tree merge (for squash merges and mergeability), plus a line diff.
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  /** The merged tree oid, or null when the merge conflicts. */
  tree: string | null;
  /** Paths that conflicted. */
  conflicts: string[];
}

/** Merge `headTree` onto `baseTree` with `mergeBaseTree` as the common ancestor. */
export function mergeTrees(forge: Forge, repo: Repo, baseTree: string | null, mergeBaseTree: string | null, headTree: string | null): MergeOutcome {
  const baseFiles = new Map<string, string>();
  const ancestorFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  for (const { path, entry } of flattenTree(repo, baseTree)) if (entry.mode !== '40000') baseFiles.set(path, entry.oid);
  for (const { path, entry } of flattenTree(repo, mergeBaseTree)) if (entry.mode !== '40000') ancestorFiles.set(path, entry.oid);
  for (const { path, entry } of flattenTree(repo, headTree)) if (entry.mode !== '40000') headFiles.set(path, entry.oid);
  const conflicts: string[] = [];
  let resultTree = baseTree;
  const allPaths = new Set([...baseFiles.keys(), ...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of allPaths) {
    const base = baseFiles.get(path);
    const ancestor = ancestorFiles.get(path);
    const head = headFiles.get(path);
    if (head === ancestor) continue; // head did not change it: keep base
    if (base === ancestor) {
      // base did not change it: take head's version (or delete when head removed it)
      resultTree = setPathInTree(forge, repo, resultTree, path, head ?? null);
      continue;
    }
    if (head === base) continue; // both changed it the same way
    conflicts.push(path);
  }
  if (conflicts.length > 0) return { tree: null, conflicts };
  return { tree: resultTree, conflicts: [] };
}

/** A simple line diff (LCS) between two texts: counts of added and removed lines. */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  // LCS length via a rolling DP; files here are small.
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const common = prev[m];
  return { additions: m - common, deletions: n - common };
}

/** Global (Relay) ids: opaque base64 of `Type:key`, never the plain database id. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

export function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
