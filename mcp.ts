// MCP: JSON-RPC 2.0 over POST /mcp, the 2026-07-28 era (server/discover) with the
// legacy initialize handshake as a fallback. Six tools, all on the same Forge as REST.

import type { IncomingMessage } from 'node:http';
import { globalId } from './store.ts';
import type { Forge, Issue, PullRequest, Repo } from './store.ts';
import { issueView, mergePullRequest, pullView, repoView } from './app.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch the changes merge into.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function findTool(name: string): ToolDef | undefined {
  const lower = name.toLowerCase();
  for (const tool of TOOLS) {
    if (lower === tool.name) return tool;
    if (lower.endsWith(`_${tool.name}`) || lower.endsWith(`__${tool.name}`)) return tool;
  }
  return undefined;
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return key;
  }
  return null;
}

function toolResult(data: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function resolveRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  return forge.getRepo(owner, repoName) ?? null;
}

function callTool(forge: Forge, req: IncomingMessage, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (tool === undefined) {
    return { error: { code: -32601, message: `Method not found: ${name}` } };
  }
  const missing = missingRequired(tool, args);
  if (missing !== null) {
    return { error: { code: -32602, message: `Missing required argument: ${missing}` } };
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      if (repo === null) return toolError(`Repository ${repoName} already exists`);
      return toolResult(repoView(forge, req, repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      return toolResult(repoView(forge, req, repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const seq = forge.nextSeq();
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        id: forge.newObjectId(),
        number,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdSeq: seq,
        updatedSeq: seq,
      };
      repo.issues.set(number, issue);
      return toolResult(issueView(forge, req, repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const views = issues.map((i) => issueView(forge, req, repo, i));
      return toolResult({ issues: views });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (headTip === undefined || baseTip === undefined) return toolError('head or base branch does not exist');
      const seq = forge.nextSeq();
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRequest = {
        id: forge.newObjectId(),
        number,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullView(forge, req, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(forge, args);
      if (repo === null) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) return toolError(`Pull request #${pullNumber} not found`);
      const result = mergePullRequest(forge, req, repo, pull);
      if (result.error !== null) return toolError(result.error);
      return toolResult({ ...pullView(forge, req, repo, pull), merged: true, sha: result.sha });
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${name}` } };
  }
}

export function handleMcp(
  forge: Forge,
  req: IncomingMessage,
  body: Buffer,
): { status: number; body: Record<string, unknown> | null } {
  if (!forge.authorized(req.headers.authorization)) {
    return { status: 401, body: { message: 'Requires authentication' } };
  }
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
    }
    request = parsed as Record<string, unknown>;
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params))
    ? request.params as Record<string, unknown>
    : {};
  // A notification has no id: answer 202 with an empty body.
  if (request.id === undefined) {
    return { status: 202, body: null };
  }
  const respond = (result: unknown): { status: number; body: Record<string, unknown> } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result },
  });
  const respondError = (code: number, message: string): { status: number; body: Record<string, unknown> } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });
  switch (method) {
    case 'server/discover':
      return respond({
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    case 'initialize': {
      const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      return respond({
        protocolVersion: clientVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
        ? params.arguments as Record<string, unknown>
        : {};
      const outcome = callTool(forge, req, toolName, args);
      if ('error' in outcome && outcome.error !== null && typeof outcome.error === 'object') {
        const error = outcome.error as { code: number; message: string };
        return respondError(error.code, error.message);
      }
      return respond(outcome);
    }
    default:
      return respondError(-32601, `Method not found: ${method}`);
  }
}

export { globalId };
