// REST v3 (the GitHub API surface the trial exercises) plus the git smart-HTTP routes,
// /healthz and the GraphQL and MCP mounts. One in-memory Forge backs every surface.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  FIXED_EPOCH_SEC,
  blobAtPath,
  buildCommit,
  commitOnBranch,
  flattenTree,
  globalId,
  lineDiffCounts,
  mergeTrees,
  parseCommit,
  parseGlobalId,
  parseTree,
  peelToCommit,
  serverIdentity,
  setPathInTree,
  treeDirEntries,
  treeEntryAt,
} from './store.ts';
import type { Forge, Issue, Label, PullRequest, Repo } from './store.ts';
import {
  handleReceivePack,
  handleUploadPack,
  receivePackV0Advertisement,
  uploadPackV0Advertisement,
  uploadPackV2Advertisement,
} from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const VERSION = '1.0.0';

type Json = Record<string, unknown> | unknown[];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, forge: Forge, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': forge.nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, forge: Forge, status: number, message: string): void {
  sendJson(res, forge, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8'));
}

function pagination(req: IncomingMessage): { perPage: number; page: number } {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function linkHeader(req: IncomingMessage, total: number, perPage: number, page: number): string {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const withPage = (p: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${base}?${params.toString()}`;
  };
  if (page < lastPage) links.push(`<${withPage(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${withPage(page - 1)}>; rel="prev"`);
  links.push(`<${withPage(1)}>; rel="first"`);
  links.push(`<${withPage(lastPage)}>; rel="last"`);
  return links.join(', ');
}

function paginate<T>(items: readonly T[], req: IncomingMessage): { items: T[]; link: string } {
  const { perPage, page } = pagination(req);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), link: linkHeader(req, items.length, perPage, page) };
}

// ---------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------

function baseUrl(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

function userView(forge: Forge, req: IncomingMessage): Record<string, unknown> {
  return {
    login: forge.viewerLogin,
    id: forge.viewerId,
    node_id: globalId('User', String(forge.viewerId)),
    avatar_url: `${baseUrl(req)}/avatars/${forge.viewerLogin}`,
    gravatar_id: '',
    url: `${baseUrl(req)}/api/v3/users/${forge.viewerLogin}`,
    html_url: `${baseUrl(req)}/${forge.viewerLogin}`,
    type: 'User',
    site_admin: false,
    name: forge.viewerName,
    email: forge.viewerEmail,
    created_at: forge.isoFor(0),
    updated_at: forge.isoFor(0),
  };
}

export function repoView(forge: Forge, req: IncomingMessage, repo: Repo): Record<string, unknown> {
  const base = baseUrl(req);
  const fullName = `${repo.owner}/${repo.name}`;
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length
    + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: fullName,
    owner: userView(forge, req),
    private: repo.isPrivate,
    html_url: `${base}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${fullName}`,
    archive_url: `${base}/api/v3/repos/${fullName}/{archive_format}{/ref}`,
    assignees_url: `${base}/api/v3/repos/${fullName}/assignees{/user}`,
    blobs_url: `${base}/api/v3/repos/${fullName}/git/blobs{/sha}`,
    branches_url: `${base}/api/v3/repos/${fullName}/branches{/branch}`,
    clone_url: `${base}/${fullName}.git`,
    collaborators_url: `${base}/api/v3/repos/${fullName}/collaborators{/collaborator}`,
    comments_url: `${base}/api/v3/repos/${fullName}/comments{/number}`,
    commits_url: `${base}/api/v3/repos/${fullName}/commits{/sha}`,
    compare_url: `${base}/api/v3/repos/${fullName}/compare/{base}...{head}`,
    contents_url: `${base}/api/v3/repos/${fullName}/contents/{+path}`,
    contributors_url: `${base}/api/v3/repos/${fullName}/contributors`,
    deployments_url: `${base}/api/v3/repos/${fullName}/deployments`,
    downloads_url: `${base}/api/v3/repos/${fullName}/downloads`,
    events_url: `${base}/api/v3/repos/${fullName}/events`,
    forks_url: `${base}/api/v3/repos/${fullName}/forks`,
    git_commits_url: `${base}/api/v3/repos/${fullName}/git/commits{/sha}`,
    git_refs_url: `${base}/api/v3/repos/${fullName}/git/refs{/sha}`,
    git_tags_url: `${base}/api/v3/repos/${fullName}/git/tags{/sha}`,
    git_url: `${base}/${fullName}.git`,
    issue_comment_url: `${base}/api/v3/repos/${fullName}/issues/comments{/number}`,
    issue_events_url: `${base}/api/v3/repos/${fullName}/issues/events{/number}`,
    issues_url: `${base}/api/v3/repos/${fullName}/issues{/number}`,
    keys_url: `${base}/api/v3/repos/${fullName}/keys{/key_id}`,
    labels_url: `${base}/api/v3/repos/${fullName}/labels{/name}`,
    languages_url: `${base}/api/v3/repos/${fullName}/languages`,
    merges_url: `${base}/api/v3/repos/${fullName}/merges`,
    milestones_url: `${base}/api/v3/repos/${fullName}/milestones{/number}`,
    notifications_url: `${base}/api/v3/repos/${fullName}/notifications{?since,all,participating}`,
    pulls_url: `${base}/api/v3/repos/${fullName}/pulls{/number}`,
    releases_url: `${base}/api/v3/repos/${fullName}/releases{/id}`,
    ssh_url: `git@localhost:${fullName}.git`,
    stargazers_url: `${base}/api/v3/repos/${fullName}/stargazers`,
    statuses_url: `${base}/api/v3/repos/${fullName}/statuses/{sha}`,
    subscribers_url: `${base}/api/v3/repos/${fullName}/subscribers`,
    subscription_url: `${base}/api/v3/repos/${fullName}/subscription`,
    tags_url: `${base}/api/v3/repos/${fullName}/tags`,
    teams_url: `${base}/api/v3/repos/${fullName}/teams`,
    trees_url: `${base}/api/v3/repos/${fullName}/git/trees{/sha}`,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    created_at: forge.isoFor(repo.createdSeq),
    updated_at: forge.isoFor(repo.createdSeq),
    pushed_at: forge.isoFor(repo.createdSeq),
  };
}

function labelView(forge: Forge, req: IncomingMessage, repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: forge.newObjectId(),
    node_id: globalId('Label', `${repo.id}:${label.name}`),
    url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: null,
  };
}

export function issueView(forge: Forge, req: IncomingMessage, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = baseUrl(req);
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    url: `${base}/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${fullName}`,
    labels_url: `${base}/api/v3/repos/${fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${fullName}/issues/${issue.number}/comments`,
    events_url: `${base}/api/v3/repos/${fullName}/issues/${issue.number}/events`,
    html_url: `${base}/${fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userView(forge, req),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelView(forge, req, repo, label) : { name, color: '000000', description: null };
    }),
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: forge.isoFor(issue.createdSeq),
    updated_at: forge.isoFor(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? forge.isoFor(issue.updatedSeq) : null,
    author_association: 'OWNER',
    active_lock_reason: null,
    draft: false,
    pull_request: undefined,
    body_html: undefined,
    body_text: undefined,
    timeline_url: `${base}/api/v3/repos/${fullName}/issues/${issue.number}/timeline`,
    performed_via_github_app: null,
    state_reason: null,
  };
}

/** Does the three-way merge conflict? (Pure: builds no objects.) */
export function mergeConflicts(forge: Forge, repo: Repo, baseTip: string, mergeBaseTip: string | null, headTip: string): string[] {
  const lookup = forge.lookup(repo);
  const baseTree = treeOf(forge, repo, baseTip);
  const ancestorTree = mergeBaseTip === null ? null : treeOf(forge, repo, mergeBaseTip);
  const headTree = treeOf(forge, repo, headTip);
  const baseFiles = new Map<string, string>();
  const ancestorFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  for (const { path, entry } of flattenTree(repo, baseTree)) if (entry.mode !== '40000') baseFiles.set(path, entry.oid);
  for (const { path, entry } of flattenTree(repo, ancestorTree)) if (entry.mode !== '40000') ancestorFiles.set(path, entry.oid);
  for (const { path, entry } of flattenTree(repo, headTree)) if (entry.mode !== '40000') headFiles.set(path, entry.oid);
  const conflicts: string[] = [];
  const allPaths = new Set([...baseFiles.keys(), ...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of allPaths) {
    const base = baseFiles.get(path);
    const ancestor = ancestorFiles.get(path);
    const head = headFiles.get(path);
    if (head === ancestor) continue;
    if (base === ancestor) continue;
    if (head === base) continue;
    conflicts.push(path);
  }
  void lookup;
  return conflicts;
}

function treeOf(forge: Forge, repo: Repo, tip: string): string | null {
  const commitOid = peelToCommit(forge.lookup(repo), tip);
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

export function pullMergeable(forge: Forge, repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = forge.mergeBase(repo, baseTip, headTip);
  if (base === null) return 'UNKNOWN';
  return mergeConflicts(forge, repo, baseTip, base, headTip).length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

export function pullView(forge: Forge, req: IncomingMessage, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const base = baseUrl(req);
  const fullName = `${repo.owner}/${repo.name}`;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    url: `${base}/api/v3/repos/${fullName}/pulls/${pull.number}`,
    html_url: `${base}/${fullName}/pull/${pull.number}`,
    diff_url: `${base}/${fullName}/pull/${pull.number}.diff`,
    patch_url: `${base}/${fullName}/pull/${pull.number}.patch`,
    issue_url: `${base}/api/v3/repos/${fullName}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userView(forge, req),
    body: pull.body,
    created_at: forge.isoFor(pull.createdSeq),
    updated_at: forge.isoFor(pull.createdSeq),
    closed_at: pull.state === 'closed' ? forge.isoFor(pull.createdSeq) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${base}/api/v3/repos/${fullName}/pulls/${pull.number}/commits`,
    review_comments_url: `${base}/api/v3/repos/${fullName}/pulls/${pull.number}/comments`,
    review_comment_url: `${base}/api/v3/repos/${fullName}/pulls/comments{/number}`,
    comments_url: `${base}/api/v3/repos/${fullName}/issues/${pull.number}/comments`,
    statuses_url: `${base}/api/v3/repos/${fullName}/statuses/${pull.headSha}`,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headTip,
      user: userView(forge, req),
      repo: repoView(forge, req, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseTip,
      user: userView(forge, req),
      repo: repoView(forge, req, repo),
    },
    _links: {
      self: { href: `${base}/api/v3/repos/${fullName}/pulls/${pull.number}` },
      html: { href: `${base}/${fullName}/pull/${pull.number}` },
      issue: { href: `${base}/api/v3/repos/${fullName}/issues/${pull.number}` },
      comments: { href: `${base}/api/v3/repos/${fullName}/issues/${pull.number}/comments` },
      review_comments: { href: `${base}/api/v3/repos/${fullName}/pulls/${pull.number}/comments` },
      review_comment: { href: `${base}/api/v3/repos/${fullName}/pulls/comments{/number}` },
      commits: { href: `${base}/api/v3/repos/${fullName}/pulls/${pull.number}/commits` },
      statuses: { href: `${base}/api/v3/repos/${fullName}/statuses/${pull.headSha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? pullMergeable(forge, repo, pull) === 'MERGEABLE' : null,
    rebaseable: null,
    mergeable_state: pull.state === 'open'
      ? (pullMergeable(forge, repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty')
      : 'unknown',
    merged_by: pull.merged ? userView(forge, req) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commitView(forge: Forge, req: IncomingMessage, repo: Repo, oid: string): Record<string, unknown> {
  const base = baseUrl(req);
  const fullName = `${repo.owner}/${repo.name}`;
  const object = repo.objects.get(oid);
  const commit = object && object.type === 'commit' ? parseCommit(object.data) : null;
  const message = commit?.message ?? '';
  const authorLine = commit?.author ?? '';
  const committerLine = commit?.committer ?? '';
  const authorName = authorLine.slice(0, authorLine.lastIndexOf(' <'));
  const authorEmail = authorLine.slice(authorLine.lastIndexOf(' <') + 2, authorLine.lastIndexOf('>'));
  const committerName = committerLine.slice(0, committerLine.lastIndexOf(' <'));
  const committerEmail = committerLine.slice(committerLine.lastIndexOf(' <') + 2, committerLine.lastIndexOf('>'));
  const date = forge.isoFor(repo.commitSeq.get(oid) ?? repo.createdSeq);
  return {
    sha: oid,
    node_id: globalId('Commit', `${repo.id}:${oid}`),
    commit: {
      author: { name: authorName, email: authorEmail, date },
      committer: { name: committerName, email: committerEmail, date },
      message,
      tree: { sha: commit?.tree ?? '', url: `${base}/api/v3/repos/${fullName}/git/trees/${commit?.tree ?? ''}` },
      url: `${base}/api/v3/repos/${fullName}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${base}/api/v3/repos/${fullName}/commits/${oid}`,
    html_url: `${base}/${fullName}/commit/${oid}`,
    comments_url: `${base}/api/v3/repos/${fullName}/commits/${oid}/comments`,
    author: userView(forge, req),
    committer: userView(forge, req),
    parents: (commit?.parents ?? []).map((sha) => ({ sha, url: `${base}/api/v3/repos/${fullName}/commits/${sha}`, html_url: `${base}/${fullName}/commit/${sha}` })),
  };
}

function contentsFileView(forge: Forge, req: IncomingMessage, repo: Repo, path: string, blobOid: string, size: number): Record<string, unknown> {
  const base = baseUrl(req);
  const fullName = `${repo.owner}/${repo.name}`;
  const blob = repo.objects.get(blobOid);
  const content = blob && blob.type === 'blob' ? blob.data.toString('base64') : '';
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    content,
    sha: blobOid,
    url: `${base}/api/v3/repos/${fullName}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${fullName}/git/blobs/${blobOid}`,
    html_url: `${base}/${fullName}/blob/main/${path}`,
    download_url: `${base}/api/v3/repos/${fullName}/contents/${path}`,
    _links: {
      git: `${base}/api/v3/repos/${fullName}/git/blobs/${blobOid}`,
      self: `${base}/api/v3/repos/${fullName}/contents/${path}`,
      html: `${base}/${fullName}/blob/main/${path}`,
    },
  };
}

function contentsDirEntryView(forge: Forge, req: IncomingMessage, repo: Repo, path: string, entry: { mode: string; name: string; oid: string }): Record<string, unknown> {
  const base = baseUrl(req);
  const fullName = `${repo.owner}/${repo.name}`;
  const isDir = entry.mode === '40000';
  const blob = isDir ? null : repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : (blob?.data.length ?? 0),
    name: entry.name,
    path,
    sha: entry.oid,
    url: `${base}/api/v3/repos/${fullName}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `${base}/${fullName}/${isDir ? 'tree' : 'blob'}/main/${path}`,
    download_url: isDir ? null : `${base}/api/v3/repos/${fullName}/contents/${path}`,
    _links: {
      git: `${base}/api/v3/repos/${fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      self: `${base}/api/v3/repos/${fullName}/contents/${path}`,
      html: `${base}/${fullName}/${isDir ? 'tree' : 'blob'}/main/${path}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------

function resolveRef(forge: Forge, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return repo.objects.has(ref) ? ref : null;
  }
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? null;
}

function stripBranchPrefix(value: string, owner: string): string {
  if (value.includes(':')) return value.split(':').slice(1).join(':');
  void owner;
  return value;
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function createApp(forge: Forge): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await handleRequest(forge, req, res);
      } catch (error) {
        if (!res.writableEnded) sendError(res, forge, 500, (error as Error).message);
      }
    })();
  });
  return server;
}

async function handleRequest(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  const segments = path.split('/').filter((s) => s !== '');
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, forge, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/info/refs and /<owner>/<repo>.git/git-*-pack
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (gitMatch) {
    await handleGit(forge, req, res, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] as string, url);
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendError(res, forge, 405, 'Method Not Allowed');
      return;
    }
    if (!forge.authorized(req.headers.authorization)) {
      sendError(res, forge, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    let payload: unknown;
    try {
      payload = parseJsonBody(body);
    } catch {
      sendJson(res, forge, 400, { errors: [{ message: 'malformed JSON body' }] });
      return;
    }
    const result = handleGraphQL(forge, payload, req);
    sendJson(res, forge, 200, result);
    return;
  }

  if (segments[0] === 'mcp') {
    if (method !== 'POST') {
      sendError(res, forge, 405, 'Method Not Allowed');
      return;
    }
    const body = await readBody(req);
    const result = handleMcp(forge, req, body);
    if (result.status === 202) {
      res.writeHead(202, { 'x-github-request-id': forge.nextRequestId() });
      res.end();
      return;
    }
    sendJson(res, forge, result.status, result.body);
    return;
  }

  if (segments[0] !== 'api' || segments[1] !== 'v3') {
    sendError(res, forge, 404, 'Not Found');
    return;
  }

  if (!forge.authorized(req.headers.authorization)) {
    sendError(res, forge, 401, 'Requires authentication');
    return;
  }

  const rest = segments.slice(2);
  await handleRest(forge, req, res, rest, url, method);
}

async function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  tail: string,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (!forge.authorized(req.headers.authorization)) {
    sendError(res, forge, 401, 'Requires authentication');
    return;
  }
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, forge, 404, 'Not Found');
    return;
  }
  if (method === 'GET' && tail === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const isV2 = req.headers['git-protocol'] === 'version=2';
      const body = isV2 ? uploadPackV2Advertisement() : uploadPackV0Advertisement(repo);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'x-github-request-id': forge.nextRequestId() });
      res.end(body);
      return;
    }
    if (service === 'git-receive-pack') {
      const body = receivePackV0Advertisement(repo);
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'x-github-request-id': forge.nextRequestId() });
      res.end(body);
      return;
    }
    sendError(res, forge, 400, 'unknown service');
    return;
  }
  if (method === 'POST' && tail === 'git-upload-pack') {
    const body = await readBody(req);
    const isV2 = req.headers['git-protocol'] === 'version=2';
    const result = handleUploadPack(forge, repo, body, isV2);
    res.writeHead(result.status, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': forge.nextRequestId() });
    res.end(result.body);
    return;
  }
  if (method === 'POST' && tail === 'git-receive-pack') {
    const body = await readBody(req);
    const result = handleReceivePack(forge, repo, body);
    res.writeHead(result.status, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': forge.nextRequestId() });
    res.end(result.body);
    return;
  }
  sendError(res, forge, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

async function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  rest: string[],
  url: URL,
  method: string,
): Promise<void> {
  const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' && (req.headers['content-length'] === '0' || req.headers['content-length'] === undefined)
    ? Buffer.alloc(0)
    : await readBody(req);
  let payload: unknown = {};
  if (body.length > 0) {
    try {
      payload = parseJsonBody(body);
    } catch {
      sendError(res, forge, 400, 'Problems parsing JSON');
      return;
    }
  }
  const input = isJsonObject(payload) ? payload : {};

  // GET /api/v3/
  if (rest.length === 0 && method === 'GET') {
    const base = baseUrl(req);
    sendJson(res, forge, 200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_authorizations_html_url: `${base}/settings/applications`,
      authorizations_url: `${base}/api/v3/authorizations`,
      code_search_url: `${base}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${base}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${base}/api/v3/user/emails`,
      emojis_url: `${base}/api/v3/emojis`,
      events_url: `${base}/api/v3/events`,
      feeds_url: `${base}/api/v3/feeds`,
      followers_url: `${base}/api/v3/user/followers`,
      following_url: `${base}/api/v3/user/following{/target}`,
      gists_url: `${base}/api/v3/gists{/gist_id}`,
      hub_url: `${base}/api/v3/hub`,
      issue_search_url: `${base}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${base}/api/v3/issues`,
      keys_url: `${base}/api/v3/user/keys`,
      label_search_url: `${base}/api/v3/search/labels?repository_id={repository_id}&q={query}`,
      notifications_url: `${base}/api/v3/notifications{?since,all,participating}`,
      organization_repositories_url: `${base}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_url: `${base}/api/v3/orgs/{org}`,
      public_gists_url: `${base}/api/v3/gists/public`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${base}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${base}/api/v3/gists/starred`,
      topic_search_url: `${base}/api/v3/search/topics?q={query}{&page,per_page}`,
      user_url: `${base}/api/v3/users/{user}`,
      user_organizations_url: `${base}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      user_search_url: `${base}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, forge, 200, { installed_version: VERSION });
    return;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    sendJson(res, forge, 200, userView(forge, req));
    return;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        sendError(res, forge, 422, 'Invalid repository name');
        return;
      }
      const repo = forge.createRepo(name, input.private === true, typeof input.description === 'string' ? input.description : '');
      if (repo === null) {
        sendError(res, forge, 422, `Repository creation failed. name already exists on this account`);
        return;
      }
      sendJson(res, forge, 201, repoView(forge, req, repo));
      return;
    }
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const { items, link } = paginate(all, req);
      sendJson(res, forge, 200, items.map((r) => repoView(forge, req, r)), { link });
      return;
    }
  }

  // /api/v3/repos/:owner/:repo/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) {
      sendError(res, forge, 404, 'Not Found');
      return;
    }
    await handleRepoRoutes(forge, req, res, repo, rest.slice(3), url, method, input, body);
    return;
  }

  sendError(res, forge, 404, 'Not Found');
}

async function handleRepoRoutes(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  url: URL,
  method: string,
  input: Record<string, unknown>,
  body: Buffer,
): Promise<void> {
  // GET/PATCH/DELETE /repos/:owner/:repo
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, forge, 200, repoView(forge, req, repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof input.description === 'string') repo.description = input.description;
      sendJson(res, forge, 200, repoView(forge, req, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': forge.nextRequestId() });
      res.end();
      return;
    }
    sendError(res, forge, 405, 'Method Not Allowed');
    return;
  }

  const head = tail[0] as string;

  // Branches
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}` }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, forge, 200, branches);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const tip = repo.refs.get(`refs/heads/${tail[1]}`);
      if (tip === undefined) {
        sendError(res, forge, 404, 'Branch not found');
        return;
      }
      sendJson(res, forge, 200, {
        name: tail[1],
        commit: { sha: tip, url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${tip}` },
        protected: false,
        protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
        protection_url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/branches/${tail[1]}/protection`,
      });
      return;
    }
  }

  // Commits
  if (head === 'commits' && tail.length === 1 && method === 'GET') {
    const sha = url.searchParams.get('sha');
    const tip = resolveRef(forge, repo, sha);
    if (tip === null) {
      sendError(res, forge, 404, 'Not Found');
      return;
    }
    const commits = forge.commitsFrom(repo, peelToCommit(forge.lookup(repo), tip));
    const { items, link } = paginate(commits, req);
    sendJson(res, forge, 200, items.map((oid) => commitView(forge, req, repo, oid)), { link });
    return;
  }

  // git refs
  if (head === 'git' && tail[1] === 'refs') {
    if (tail.length >= 4 && tail[2] === 'heads' && method === 'GET') {
      const branch = tail.slice(3).join('/');
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        sendError(res, forge, 404, 'Not Found');
        return;
      }
      sendJson(res, forge, 200, {
        ref: `refs/heads/${branch}`,
        node_id: globalId('Ref', `${repo.id}:refs/heads/${branch}`),
        url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`,
        object: { sha: tip, type: 'commit', url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${tip}` },
      });
      return;
    }
    if (tail.length === 2 && method === 'POST') {
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
        sendError(res, forge, 422, 'Invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, forge, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, forge, 201, {
        ref,
        node_id: globalId('Ref', `${repo.id}:${ref}`),
        url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice('refs/'.length)}`,
        object: { sha, type: 'commit', url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
      });
      return;
    }
  }

  // Contents
  if (head === 'contents') {
    const contentPath = tail.slice(1).join('/');
    await handleContents(forge, req, res, repo, contentPath, url, method, input);
    return;
  }

  // Labels
  if (head === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, forge, 200, [...repo.labels.values()].map((l) => labelView(forge, req, repo, l)));
      return;
    }
    if (method === 'POST' && tail.length === 1) {
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color.replace(/^#/, '') : '000000';
      if (name === '') {
        sendError(res, forge, 422, 'Invalid label name');
        return;
      }
      if (repo.labels.has(name)) {
        sendError(res, forge, 422, 'Label already exists');
        return;
      }
      const label: Label = { name, color };
      repo.labels.set(name, label);
      sendJson(res, forge, 201, labelView(forge, req, repo, label));
      return;
    }
  }

  // Issues
  if (head === 'issues') {
    await handleIssues(forge, req, res, repo, tail.slice(1), url, method, input);
    return;
  }

  // Pulls
  if (head === 'pulls') {
    await handlePulls(forge, req, res, repo, tail.slice(1), url, method, input);
    return;
  }

  sendError(res, forge, 404, 'Not Found');
}

async function handleContents(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  contentPath: string,
  url: URL,
  method: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (contentPath === '') {
    sendError(res, forge, 404, 'Not Found');
    return;
  }
  const ref = url.searchParams.get('ref');
  if (method === 'GET') {
    const tip = resolveRef(forge, repo, ref);
    if (tip === null) {
      sendError(res, forge, 404, 'Not Found');
      return;
    }
    const commitOid = peelToCommit(forge.lookup(repo), tip);
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') {
      sendError(res, forge, 404, 'Not Found');
      return;
    }
    const tree = parseCommit(commit.data).tree;
    const entry = treeEntryAt(repo, tree, contentPath);
    if (entry === null) {
      // Maybe a directory.
      const entries = treeDirEntries(repo, tree, contentPath);
      if (entries === null) {
        sendError(res, forge, 404, 'Not Found');
        return;
      }
      sendJson(res, forge, 200, entries.map((e) => contentsDirEntryView(forge, req, repo, `${contentPath}/${e.name}`, e)));
      return;
    }
    if (entry.mode === '40000') {
      const entries = treeDirEntries(repo, tree, contentPath);
      if (entries === null) {
        sendError(res, forge, 404, 'Not Found');
        return;
      }
      sendJson(res, forge, 200, entries.map((e) => contentsDirEntryView(forge, req, repo, `${contentPath}/${e.name}`, e)));
      return;
    }
    const blob = repo.objects.get(entry.oid);
    sendJson(res, forge, 200, contentsFileView(forge, req, repo, contentPath, entry.oid, blob?.data.length ?? 0));
    return;
  }

  if (method === 'PUT') {
    const message = typeof input.message === 'string' ? input.message : '';
    const contentB64 = typeof input.content === 'string' ? input.content : '';
    const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
    const sha = typeof input.sha === 'string' ? input.sha : undefined;
    if (message === '' || contentB64 === '' || !/^[A-Za-z0-9+/=\r\n]+$/.test(contentB64)) {
      sendError(res, forge, 400, 'Invalid content');
      return;
    }
    const content = Buffer.from(contentB64, 'base64');
    // Ensure the branch exists (from the default tip when it does not).
    if (!repo.refs.has(`refs/heads/${branch}`)) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) repo.refs.set(`refs/heads/${branch}`, defaultTip);
    }
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
    let currentTree: string | null = null;
    let existing: { mode: string; name: string; oid: string } | null = null;
    if (tip !== null) {
      const commit = repo.objects.get(tip);
      if (commit && commit.type === 'commit') {
        currentTree = parseCommit(commit.data).tree;
        existing = treeEntryAt(repo, currentTree, contentPath);
      }
    }
    if (existing !== null && existing.mode === '40000') {
      sendError(res, forge, 422, 'Is a directory');
      return;
    }
    if (existing !== null) {
      if (sha === undefined || sha !== existing.oid) {
        sendError(res, forge, 409, 'sha does not match the current blob');
        return;
      }
    } else if (sha !== undefined) {
      sendError(res, forge, 422, 'sha was supplied for a file that does not exist');
      return;
    }
    const blobOid = forge.putObject(repo, 'blob', content);
    const { commitSha } = commitOnBranch(forge, repo, branch, message, (tree) => setPathInTree(forge, repo, tree, contentPath, blobOid));
    sendJson(res, forge, existing !== null ? 200 : 201, {
      content: contentsFileView(forge, req, repo, contentPath, blobOid, content.length),
      commit: { sha: commitSha, message, author: { name: forge.viewerName, email: forge.viewerEmail }, committer: { name: forge.viewerName, email: forge.viewerEmail } },
    });
    return;
  }

  if (method === 'DELETE') {
    const message = typeof input.message === 'string' ? input.message : '';
    const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
    const sha = typeof input.sha === 'string' ? input.sha : undefined;
    const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
    if (tip === null) {
      sendError(res, forge, 404, 'Not Found');
      return;
    }
    const commit = repo.objects.get(tip);
    if (!commit || commit.type !== 'commit') {
      sendError(res, forge, 404, 'Not Found');
      return;
    }
    const tree = parseCommit(commit.data).tree;
    const existing = treeEntryAt(repo, tree, contentPath);
    if (existing === null || existing.mode === '40000') {
      sendError(res, forge, 404, 'Not Found');
      return;
    }
    if (sha !== undefined && sha !== existing.oid) {
      sendError(res, forge, 409, 'sha does not match the current blob');
      return;
    }
    const { commitSha } = commitOnBranch(forge, repo, branch, message, (t) => setPathInTree(forge, repo, t, contentPath, null));
    sendJson(res, forge, 200, {
      content: null,
      commit: { sha: commitSha, message, author: { name: forge.viewerName, email: forge.viewerEmail }, committer: { name: forge.viewerName, email: forge.viewerEmail } },
    });
    return;
  }

  sendError(res, forge, 405, 'Method Not Allowed');
}

async function handleIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  url: URL,
  method: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      if (title === '') {
        sendError(res, forge, 422, 'title is required');
        return;
      }
      const labelNames: string[] = [];
      if (Array.isArray(input.labels)) {
        for (const label of input.labels) {
          if (typeof label === 'string') labelNames.push(label);
          else if (isJsonObject(label) && typeof label.name === 'string') labelNames.push(label.name);
        }
      }
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          sendError(res, forge, 422, `Label "${name}" does not exist`);
          return;
        }
      }
      const seq = forge.nextSeq();
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        id: forge.newObjectId(),
        number,
        title,
        body: bodyText,
        state: 'open',
        labels: labelNames,
        comments: [],
        createdSeq: seq,
        updatedSeq: seq,
      };
      repo.issues.set(number, issue);
      sendJson(res, forge, 201, issueView(forge, req, repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => {
        const diff = sort === 'created' ? a.createdSeq - b.createdSeq : a.number - b.number;
        return direction === 'asc' ? diff : -diff;
      });
      const { items, link } = paginate(issues, req);
      sendJson(res, forge, 200, items.map((i) => issueView(forge, req, repo, i)), { link });
      return;
    }
  }
  const number = Number.parseInt(tail[0] as string, 10);
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(res, forge, 404, 'Not Found');
    return;
  }
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, forge, 200, issueView(forge, req, repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
      issue.updatedSeq = forge.nextSeq();
      sendJson(res, forge, 200, issueView(forge, req, repo, issue));
      return;
    }
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const bodyText = typeof input.body === 'string' ? input.body : '';
      if (bodyText === '') {
        sendError(res, forge, 422, 'body is required');
        return;
      }
      const seq = forge.nextSeq();
      const comment = { id: forge.newCommentId(), body: bodyText, createdSeq: seq };
      issue.comments.push(comment);
      issue.updatedSeq = seq;
      sendJson(res, forge, 201, {
        id: comment.id,
        node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
        url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
        html_url: `${baseUrl(req)}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
        body: comment.body,
        user: userView(forge, req),
        created_at: forge.isoFor(seq),
        updated_at: forge.isoFor(seq),
        issue_url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
        author_association: 'OWNER',
      });
      return;
    }
    if (method === 'GET') {
      const { items, link } = paginate(issue.comments, req);
      sendJson(res, forge, 200, items.map((c) => ({
        id: c.id,
        node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${c.id}`),
        url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
        html_url: `${baseUrl(req)}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
        body: c.body,
        user: userView(forge, req),
        created_at: forge.isoFor(c.createdSeq),
        updated_at: forge.isoFor(c.createdSeq),
        issue_url: `${baseUrl(req)}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
        author_association: 'OWNER',
      })), { link });
      return;
    }
  }
  sendError(res, forge, 404, 'Not Found');
}

async function handlePulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  tail: string[],
  url: URL,
  method: string,
  input: Record<string, unknown>,
): Promise<void> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof input.title === 'string' ? input.title : '';
      const bodyText = typeof input.body === 'string' ? input.body : '';
      const head = typeof input.head === 'string' ? stripBranchPrefix(input.head, repo.owner) : '';
      const base = typeof input.base === 'string' ? stripBranchPrefix(input.base, repo.owner) : '';
      if (title === '' || head === '' || base === '') {
        sendError(res, forge, 422, 'title, head and base are required');
        return;
      }
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) {
        sendError(res, forge, 422, 'head or base branch does not exist');
        return;
      }
      const seq = forge.nextSeq();
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRequest = {
        id: forge.newObjectId(),
        number,
        title,
        body: bodyText,
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha: headTip,
        baseSha: baseTip,
        mergedAt: null,
        mergeCommitSha: null,
        createdSeq: seq,
      };
      repo.pulls.set(number, pull);
      sendJson(res, forge, 201, pullView(forge, req, repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => {
        const diff = sort === 'created' ? a.createdSeq - b.createdSeq : a.number - b.number;
        return direction === 'asc' ? diff : -diff;
      });
      const { items, link } = paginate(pulls, req);
      sendJson(res, forge, 200, items.map((p) => pullView(forge, req, repo, p)), { link });
      return;
    }
  }
  const number = Number.parseInt(tail[0] as string, 10);
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(res, forge, 404, 'Not Found');
    return;
  }
  if (tail.length === 1 && method === 'GET') {
    sendJson(res, forge, 200, pullView(forge, req, repo, pull));
    return;
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    sendJson(res, forge, 200, pullFiles(forge, req, repo, pull));
    return;
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const result = mergePullRequest(forge, req, repo, pull);
    if (result.error !== null) {
      sendError(res, forge, result.status, result.error);
      return;
    }
    sendJson(res, forge, 200, { sha: result.sha as string, merged: true, message: 'Pull request successfully merged' });
    return;
  }
  sendError(res, forge, 404, 'Not Found');
}

/** The files a pull request changes, merge-base to head. */
export function pullFiles(forge: Forge, req: IncomingMessage, repo: Repo, pull: PullRequest): Record<string, unknown>[] {
  const base = baseUrl(req);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeBase = forge.mergeBase(repo, baseTip, headTip);
  const ancestorTree = mergeBase === null ? null : treeOf(forge, repo, mergeBase);
  const headTree = treeOf(forge, repo, headTip);
  const ancestorFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  for (const { path, entry } of flattenTree(repo, ancestorTree)) if (entry.mode !== '40000') ancestorFiles.set(path, entry.oid);
  for (const { path, entry } of flattenTree(repo, headTree)) if (entry.mode !== '40000') headFiles.set(path, entry.oid);
  const out: Record<string, unknown>[] = [];
  const allPaths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of [...allPaths].sort()) {
    const oldOid = ancestorFiles.get(path);
    const newOid = headFiles.get(path);
    if (oldOid === newOid) continue;
    const oldText = oldOid === undefined ? '' : (repo.objects.get(oldOid)?.data.toString('utf8') ?? '');
    const newText = newOid === undefined ? '' : (repo.objects.get(newOid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    out.push({
      sha: newOid ?? oldOid ?? '',
      filename: path,
      status: oldOid === undefined ? 'added' : newOid === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${newOid ?? oldOid ?? ''}`,
      raw_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      contents_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      patch: undefined,
    });
  }
  return out;
}

/** Squash-merge a pull request onto its base branch. Returns the new commit sha or an error. */
export function mergePullRequest(
  forge: Forge,
  req: IncomingMessage,
  repo: Repo,
  pull: PullRequest,
): { status: number; error: string | null; sha: string | null } {
  void req;
  if (pull.state !== 'open' || pull.merged) {
    return { status: 405, error: 'Pull request is already merged or closed', sha: null };
  }
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) {
    return { status: 405, error: 'head or base branch is missing', sha: null };
  }
  const mergeBase = forge.mergeBase(repo, baseTip, headTip);
  const baseTree = treeOf(forge, repo, baseTip);
  const ancestorTree = mergeBase === null ? null : treeOf(forge, repo, mergeBase);
  const headTree = treeOf(forge, repo, headTip);
  const outcome = mergeTrees(forge, repo, baseTree, ancestorTree, headTree);
  if (outcome.tree === null) {
    return { status: 405, error: `Merge conflict: ${outcome.conflicts.join(', ')}`, sha: null };
  }
  const seq = forge.nextSeq();
  const identity = serverIdentity(forge);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
  const commit = buildCommit({
    tree: outcome.tree,
    parents: [baseTip],
    message,
    author: identity,
    committer: identity,
    timestamp: FIXED_EPOCH_SEC + seq,
  });
  const commitSha = forge.putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.isoFor(seq);
  pull.mergeCommitSha = commitSha;
  return { status: 200, error: null, sha: commitSha };
}
