// GraphQL v4: a small parser and executor for the operations the trial sends
// (viewer, repository, issues and pull requests with cursor paging, node, __type,
// and the five mutations). Unknown fields are reported as errors with HTTP 200,
// the way GitHub does it; unknown repositories resolve to null without errors.

import type { IncomingMessage } from 'node:http';
import {
  globalId,
  parseCommit,
  parseGlobalId,
} from './store.ts';
import type { Forge, Issue, PullRequest, Repo } from './store.ts';
import { mergePullRequest, pullFiles, pullMergeable } from './app.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const escaped = input[i + 1] as string;
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else if (escaped === '"') value += '"';
          else if (escaped === '\\') value += '\\';
          else value += escaped;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let value = '';
      let isFloat = false;
      if (ch === '-') {
        value += '-';
        i += 1;
      }
      while (i < input.length && /[0-9]/.test(input[i] as string)) {
        value += input[i];
        i += 1;
      }
      if (input[i] === '.') {
        isFloat = true;
        value += '.';
        i += 1;
        while (i < input.length && /[0-9]/.test(input[i] as string)) {
          value += input[i];
          i += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i] as string)) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  readonly name: string;
  readonly value: ValueNode;
}

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: ArgumentNode[];
  readonly selectionSet: SelectionNode[] | null;
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string;
  readonly selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  readonly operation: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selectionSet: SelectionNode[];
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' | 'subscription' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && ['query', 'mutation', 'subscription'].includes(token.value)) {
      operation = this.next().value as 'query' | 'mutation' | 'subscription';
      if (this.peek().kind === 'name') name = this.next().value;
    }
    const variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selectionSet = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selectionSet };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selectionSet };
      }
      throw new Error('named fragment spreads are not supported');
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: ArgumentNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => evaluateValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluateValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (arg === undefined) return undefined;
  return evaluateValue(arg.value, variables);
}

// ---------------------------------------------------------------------------
// Typed values: every resolved object carries its GraphQL type name.
// ---------------------------------------------------------------------------

type Typed = { readonly __typename: string; readonly [key: string]: unknown };

function typed(typename: string, fields: Record<string, unknown>): Typed {
  return { __typename: typename, ...fields };
}

function repoTyped(forge: Forge, repo: Repo): Typed {
  return typed('Repository', { repo, forge });
}

function issueTyped(forge: Forge, repo: Repo, issue: Issue): Typed {
  return typed('Issue', { repo, forge, issue });
}

function pullTyped(forge: Forge, repo: Repo, pull: PullRequest): Typed {
  return typed('PullRequest', { repo, forge, pull });
}

function userTyped(forge: Forge): Typed {
  return typed('User', { forge });
}

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1] as string, 10) : 0;
  } catch {
    return 0;
  }
}

interface PageArgs {
  first: number | null;
  after: number;
}

function pageArgs(field: FieldNode, variables: Record<string, unknown>): PageArgs {
  const first = argValue(field, 'first', variables);
  const after = argValue(field, 'after', variables);
  return {
    first: typeof first === 'number' ? first : null,
    after: typeof after === 'string' ? decodeCursor(after) : 0,
  };
}

function connection<T>(items: readonly T[], args: PageArgs, wrap: (item: T) => Typed): Typed {
  const start = args.after;
  const end = args.first === null ? items.length : Math.min(items.length, start + args.first);
  const nodes = items.slice(start, end).map(wrap);
  return typed('Connection', {
    nodes,
    totalCount: items.length,
    pageInfo: typed('PageInfo', {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? encodeCursor(start) : null,
      // The end cursor names the offset after the last node, so paging resumes after it.
      endCursor: nodes.length > 0 ? encodeCursor(end) : null,
    }),
  });
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'private', 'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  SearchType: [],
  IssueState: [],
  PullRequestState: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE', 'MILESTONE', 'PROJECT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Context {
  readonly forge: Forge;
  readonly req: IncomingMessage;
  readonly variables: Record<string, unknown>;
  readonly errors: Array<{ message: string }>;
}

function resolveField(ctx: Context, parent: Typed | null, field: FieldNode): unknown {
  if (field.name === '__typename') return parent?.__typename ?? 'Query';
  if (parent === null) return resolveRootField(ctx, field);
  const typeName = parent.__typename;
  switch (typeName) {
    case 'Repository': return resolveRepositoryField(ctx, parent, field);
    case 'Issue': return resolveIssueField(ctx, parent, field);
    case 'PullRequest': return resolvePullField(ctx, parent, field);
    case 'User': return resolveUserField(ctx, parent, field);
    case 'Ref': return resolveRefField(ctx, parent, field);
    case 'Commit': return resolveCommitField(ctx, parent, field);
    case 'IssueComment': return resolveCommentField(ctx, parent, field);
    case 'Connection': return resolveConnectionField(ctx, parent, field);
    case 'PageInfo': return parent[field.name] ?? null;
    case '__Type': return resolveTypeField(ctx, parent, field);
    case '__Field': return parent.fieldName ?? null;
    case '__EnumValue': return parent.enumValueName ?? null;
    case '__Schema': return parent[field.name] ?? null;
    default: {
      const value = parent[field.name];
      if (value !== undefined) return value;
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
  }
}

function resolveRootField(ctx: Context, field: FieldNode): unknown {
  const forge = ctx.forge;
  if (field.name === 'viewer') {
    return userTyped(forge);
  }
  if (field.name === 'repository') {
    const owner = argValue(field, 'owner', ctx.variables);
    const name = argValue(field, 'name', ctx.variables);
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = forge.getRepo(owner, name);
    return repo === undefined ? null : repoTyped(forge, repo);
  }
  if (field.name === 'node') {
    const id = argValue(field, 'id', ctx.variables);
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    if (parsed.type === 'Repository') {
      const repo = forge.reposById.get(Number.parseInt(parsed.key, 10));
      return repo === undefined ? null : repoTyped(forge, repo);
    }
    if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
      const [repoId, number] = parsed.key.split(':');
      const repo = forge.reposById.get(Number.parseInt(repoId ?? '', 10));
      if (repo === undefined) return null;
      if (parsed.type === 'Issue') {
        const issue = repo.issues.get(Number.parseInt(number ?? '', 10));
        return issue === undefined ? null : issueTyped(forge, repo, issue);
      }
      const pull = repo.pulls.get(Number.parseInt(number ?? '', 10));
      return pull === undefined ? null : pullTyped(forge, repo, pull);
    }
    if (parsed.type === 'IssueComment') {
      const [repoId, issueNumber, commentId] = parsed.key.split(':');
      const repo = forge.reposById.get(Number.parseInt(repoId ?? '', 10));
      const issue = repo?.issues.get(Number.parseInt(issueNumber ?? '', 10));
      const comment = issue?.comments.find((c) => c.id === Number.parseInt(commentId ?? '', 10));
      if (repo === undefined || issue === undefined || comment === undefined) return null;
      return typed('IssueComment', { forge, repo, issue, comment });
    }
    return null;
  }
  if (field.name === '__type') {
    const name = argValue(field, 'name', ctx.variables);
    if (typeof name !== 'string') return null;
    const fields = TYPE_FIELDS[name];
    if (fields === undefined) return null;
    return typed('__Type', { typeName: name, fields, enumValues: ENUM_VALUES[name] ?? null });
  }
  if (field.name === '__schema') {
    return typed('__Schema', { types: [] });
  }
  if (field.name === 'createIssue') return createIssueMutation(ctx, field);
  if (field.name === 'closeIssue') return closeIssueMutation(ctx, field);
  if (field.name === 'createPullRequest') return createPullRequestMutation(ctx, field);
  if (field.name === 'mergePullRequest') return mergePullRequestMutation(ctx, field);
  if (field.name === 'addComment') return addCommentMutation(ctx, field);
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
  return null;
}

function resolveRepositoryField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  const forge = ctx.forge;
  const repo = parent.repo as Repo;
  switch (field.name) {
    case 'id': return globalId('Repository', String(repo.id));
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'owner': return userTyped(forge);
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return typed('Ref', { forge, repo, name: repo.defaultBranch, oid: tip });
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'description': return repo.description;
    case 'private': return repo.isPrivate;
    case 'createdAt': return forge.isoFor(repo.createdSeq);
    case 'updatedAt': return forge.isoFor(repo.createdSeq);
    case 'url': return `http://${ctx.req.headers.host ?? 'localhost'}/${repo.owner}/${repo.name}`;
    case 'issue': {
      const number = argValue(field, 'number', ctx.variables);
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueTyped(forge, repo, issue);
    }
    case 'issues': {
      const args = pageArgs(field, ctx.variables);
      const states = argValue(field, 'states', ctx.variables);
      const orderBy = argValue(field, 'orderBy', ctx.variables);
      let issues = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      issues = sortIssues(issues, orderBy);
      return connection(issues, args, (i) => issueTyped(forge, repo, i));
    }
    case 'pullRequest': {
      const number = argValue(field, 'number', ctx.variables);
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullTyped(forge, repo, pull);
    }
    case 'pullRequests': {
      const args = pageArgs(field, ctx.variables);
      const states = argValue(field, 'states', ctx.variables);
      let pulls = [...repo.pulls.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        pulls = pulls.filter((p) => wanted.has(pullStateGql(p)));
      }
      pulls.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      return connection(pulls, args, (p) => pullTyped(forge, repo, p));
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
      return null;
  }
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  let direction = 'DESC';
  if (orderBy !== null && typeof orderBy === 'object') {
    const dir = (orderBy as Record<string, unknown>).direction;
    if (typeof dir === 'string') direction = dir;
  }
  const sorted = [...issues];
  sorted.sort((a, b) => {
    const diff = a.createdSeq - b.createdSeq || a.number - b.number;
    return direction === 'ASC' ? diff : -diff;
  });
  return sorted;
}

function issueStateGql(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveIssueField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  const forge = ctx.forge;
  const repo = parent.repo as Repo;
  const issue = parent.issue as Issue;
  switch (field.name) {
    case 'id': return globalId('Issue', `${repo.id}:${issue.number}`);
    case 'databaseId': return issue.number;
    case 'number': return issue.number;
    case 'title': return issue.title;
    case 'body': return issue.body;
    case 'state': return issueStateGql(issue);
    case 'createdAt': return forge.isoFor(issue.createdSeq);
    case 'updatedAt': return forge.isoFor(issue.updatedSeq);
    case 'author': return userTyped(forge);
    case 'url': return `http://${ctx.req.headers.host ?? 'localhost'}/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'repository': return repoTyped(forge, repo);
    case 'labels': {
      const args = pageArgs(field, ctx.variables);
      const nodes = issue.labels.map((name) => typed('Label', { name, color: repo.labels.get(name)?.color ?? '000000' }));
      return connection(nodes, args, (n) => n);
    }
    case 'comments': {
      const args = pageArgs(field, ctx.variables);
      return connection(issue.comments, args, (c) => typed('IssueComment', { forge, repo, issue, comment: c }));
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
      return null;
  }
}

function resolvePullField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  const forge = ctx.forge;
  const repo = parent.repo as Repo;
  const pull = parent.pull as PullRequest;
  switch (field.name) {
    case 'id': return globalId('PullRequest', `${repo.id}:${pull.number}`);
    case 'databaseId': return pull.number;
    case 'number': return pull.number;
    case 'title': return pull.title;
    case 'body': return pull.body;
    case 'state': return pullStateGql(pull);
    case 'merged': return pull.merged;
    case 'mergeable': return pullMergeable(forge, repo, pull);
    case 'headRefName': return pull.headRef;
    case 'baseRefName': return pull.baseRef;
    case 'headRefOid': return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    case 'baseRefOid': return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    case 'createdAt': return forge.isoFor(pull.createdSeq);
    case 'updatedAt': return forge.isoFor(pull.createdSeq);
    case 'author': return userTyped(forge);
    case 'repository': return repoTyped(forge, repo);
    case 'files': {
      const args = pageArgs(field, ctx.variables);
      const files = pullFiles(forge, ctx.req, repo, pull).map((f) => typed('PullRequestChangedFile', {
        path: f.filename as string,
        additions: f.additions as number,
        deletions: f.deletions as number,
        changeType: String(f.status).toUpperCase(),
      }));
      return connection(files, args, (f) => f);
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
      return null;
  }
}

function resolveUserField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  const forge = ctx.forge;
  void ctx;
  switch (field.name) {
    case 'id': return globalId('User', String(forge.viewerId));
    case 'databaseId': return forge.viewerId;
    case 'login': return forge.viewerLogin;
    case 'name': return forge.viewerName;
    case 'email': return forge.viewerEmail;
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "User".` });
      return null;
  }
}

function resolveRefField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  const repo = parent.repo as Repo;
  switch (field.name) {
    case 'name': return parent.name as string;
    case 'target': {
      const oid = parent.oid as string;
      return typed('Commit', { forge: ctx.forge, repo, oid });
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Ref".` });
      return null;
  }
}

function resolveCommitField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  switch (field.name) {
    case 'oid': return parent.oid as string;
    case 'message': {
      const repo = parent.repo as Repo;
      const object = repo.objects.get(parent.oid as string);
      if (!object || object.type !== 'commit') return '';
      return parseCommit(object.data).message;
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Commit".` });
      return null;
  }
}

function resolveCommentField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  const forge = ctx.forge;
  const comment = parent.comment as { id: number; body: string; createdSeq: number };
  switch (field.name) {
    case 'id': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      return globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
    }
    case 'databaseId': return comment.id;
    case 'body': return comment.body;
    case 'createdAt': return forge.isoFor(comment.createdSeq);
    case 'updatedAt': return forge.isoFor(comment.createdSeq);
    case 'author': return userTyped(forge);
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "IssueComment".` });
      return null;
  }
}

function resolveConnectionField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  switch (field.name) {
    case 'nodes': return parent.nodes;
    case 'edges': {
      const nodes = parent.nodes as Typed[];
      return nodes.map((n) => typed('Edge', { node: n, cursor: encodeCursor(0) }));
    }
    case 'totalCount': return parent.totalCount;
    case 'pageInfo': return parent.pageInfo;
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Connection".` });
      return null;
  }
}

function resolveTypeField(ctx: Context, parent: Typed, field: FieldNode): unknown {
  const typeName = parent.typeName as string;
  switch (field.name) {
    case 'name': return typeName;
    case 'kind': return (parent.enumValues as string[] | null) !== null ? 'ENUM' : 'OBJECT';
    case 'fields': {
      const fields = parent.fields as string[];
      return fields.map((name) => typed('__Field', { fieldName: name }));
    }
    case 'enumValues': {
      const values = parent.enumValues as string[] | null;
      if (values === null) return null;
      return values.map((name) => typed('__EnumValue', { enumValueName: name }));
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "__Type".` });
      return null;
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function inputObject(field: FieldNode, ctx: Context): Record<string, unknown> {
  const value = argValue(field, 'input', ctx.variables);
  return (value !== null && typeof value === 'object' && !Array.isArray(value)) ? value as Record<string, unknown> : {};
}

function createIssueMutation(ctx: Context, field: FieldNode): Typed {
  const forge = ctx.forge;
  const input = inputObject(field, ctx);
  const repoId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
  const title = typeof input.title === 'string' ? input.title : '';
  const body = typeof input.body === 'string' ? input.body : '';
  if (repoId === null || repoId.type !== 'Repository' || title === '') {
    ctx.errors.push({ message: 'createIssue requires a repositoryId and a title' });
    return typed('CreateIssuePayload', { issue: null });
  }
  const repo = forge.reposById.get(Number.parseInt(repoId.key, 10));
  if (repo === undefined) {
    ctx.errors.push({ message: 'repository not found' });
    return typed('CreateIssuePayload', { issue: null });
  }
  const seq = forge.nextSeq();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    id: forge.newObjectId(),
    number,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    createdSeq: seq,
    updatedSeq: seq,
  };
  repo.issues.set(number, issue);
  return typed('CreateIssuePayload', { issue: issueTyped(forge, repo, issue) });
}

function closeIssueMutation(ctx: Context, field: FieldNode): Typed {
  const forge = ctx.forge;
  const input = inputObject(field, ctx);
  const issueId = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
  if (issueId === null || issueId.type !== 'Issue') {
    ctx.errors.push({ message: 'closeIssue requires an issueId' });
    return typed('CloseIssuePayload', { issue: null });
  }
  const [repoId, number] = issueId.key.split(':');
  const repo = forge.reposById.get(Number.parseInt(repoId ?? '', 10));
  const issue = repo?.issues.get(Number.parseInt(number ?? '', 10));
  if (issue === undefined) {
    ctx.errors.push({ message: 'issue not found' });
    return typed('CloseIssuePayload', { issue: null });
  }
  issue.state = 'closed';
  issue.updatedSeq = forge.nextSeq();
  return typed('CloseIssuePayload', { issue: issueTyped(forge, repo as Repo, issue) });
}

function createPullRequestMutation(ctx: Context, field: FieldNode): Typed {
  const forge = ctx.forge;
  const input = inputObject(field, ctx);
  const repoId = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
  const title = typeof input.title === 'string' ? input.title : '';
  const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
  const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
  const body = typeof input.body === 'string' ? input.body : '';
  if (repoId === null || repoId.type !== 'Repository' || title === '' || headRef === '' || baseRef === '') {
    ctx.errors.push({ message: 'createPullRequest requires repositoryId, title, headRefName and baseRefName' });
    return typed('CreatePullRequestPayload', { pullRequest: null });
  }
  const repo = forge.reposById.get(Number.parseInt(repoId.key, 10));
  if (repo === undefined) {
    ctx.errors.push({ message: 'repository not found' });
    return typed('CreatePullRequestPayload', { pullRequest: null });
  }
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (headTip === undefined || baseTip === undefined) {
    ctx.errors.push({ message: 'head or base branch does not exist' });
    return typed('CreatePullRequestPayload', { pullRequest: null });
  }
  const seq = forge.nextSeq();
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRequest = {
    id: forge.newObjectId(),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    headRef,
    baseRef,
    headSha: headTip,
    baseSha: baseTip,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: seq,
  };
  repo.pulls.set(number, pull);
  return typed('CreatePullRequestPayload', { pullRequest: pullTyped(forge, repo, pull) });
}

function mergePullRequestMutation(ctx: Context, field: FieldNode): Typed {
  const forge = ctx.forge;
  const input = inputObject(field, ctx);
  const pullId = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
  if (pullId === null || pullId.type !== 'PullRequest') {
    ctx.errors.push({ message: 'mergePullRequest requires a pullRequestId' });
    return typed('MergePullRequestPayload', { pullRequest: null });
  }
  const [repoId, number] = pullId.key.split(':');
  const repo = forge.reposById.get(Number.parseInt(repoId ?? '', 10));
  const pull = repo?.pulls.get(Number.parseInt(number ?? '', 10));
  if (pull === undefined || repo === undefined) {
    ctx.errors.push({ message: 'pull request not found' });
    return typed('MergePullRequestPayload', { pullRequest: null });
  }
  const result = mergePullRequest(forge, ctx.req, repo, pull);
  if (result.error !== null) {
    ctx.errors.push({ message: result.error });
    return typed('MergePullRequestPayload', { pullRequest: null });
  }
  return typed('MergePullRequestPayload', { pullRequest: pullTyped(forge, repo, pull) });
}

function addCommentMutation(ctx: Context, field: FieldNode): Typed {
  const forge = ctx.forge;
  const input = inputObject(field, ctx);
  const subjectId = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
  const body = typeof input.body === 'string' ? input.body : '';
  if (subjectId === null || subjectId.type !== 'Issue' || body === '') {
    ctx.errors.push({ message: 'addComment requires a subjectId and a body' });
    return typed('AddCommentPayload', { commentEdge: null });
  }
  const [repoId, number] = subjectId.key.split(':');
  const repo = forge.reposById.get(Number.parseInt(repoId ?? '', 10));
  const issue = repo?.issues.get(Number.parseInt(number ?? '', 10));
  if (issue === undefined || repo === undefined) {
    ctx.errors.push({ message: 'issue not found' });
    return typed('AddCommentPayload', { commentEdge: null });
  }
  const seq = forge.nextSeq();
  const comment = { id: forge.newCommentId(), body, createdSeq: seq };
  issue.comments.push(comment);
  issue.updatedSeq = seq;
  const node = typed('IssueComment', { forge, repo, issue, comment });
  return typed('AddCommentPayload', {
    commentEdge: typed('IssueCommentEdge', { node, cursor: encodeCursor(issue.comments.length - 1) }),
    subject: issueTyped(forge, repo, issue),
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function executeSelection(ctx: Context, parent: Typed | null, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (parent !== null && parent.__typename !== selection.typeCondition) continue;
      Object.assign(out, executeSelection(ctx, parent, selection.selectionSet));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, parent, selection);
    if (selection.selectionSet === null || value === null || value === undefined) {
      out[key] = value === undefined ? null : value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => (item !== null && typeof item === 'object' && '__typename' in (item as object)
        ? executeSelection(ctx, item as Typed, selection.selectionSet as SelectionNode[])
        : item));
      continue;
    }
    if (typeof value === 'object') {
      out[key] = executeSelection(ctx, value as Typed, selection.selectionSet);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(ctx: Context, operation: OperationNode, operationName: string | null): Record<string, unknown> {
  void operationName;
  const variables: Record<string, unknown> = {};
  for (const def of operation.variableDefinitions) {
    if (ctx.variables[def.name] !== undefined) variables[def.name] = ctx.variables[def.name];
    else if (def.defaultValue !== null) variables[def.name] = evaluateValue(def.defaultValue, ctx.variables);
  }
  const opCtx: Context = { ...ctx, variables };
  const data = executeSelection(opCtx, null, operation.selectionSet);
  const result: Record<string, unknown> = { data };
  if (opCtx.errors.length > 0) result.errors = opCtx.errors;
  return result;
}

export function handleGraphQL(forge: Forge, payload: unknown, req: IncomingMessage): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => handleSingleGraphQL(forge, item, req));
  }
  return handleSingleGraphQL(forge, payload, req);
}

function handleSingleGraphQL(forge: Forge, payload: unknown, req: IncomingMessage): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { errors: [{ message: 'GraphQL request must be an object' }] };
  }
  const body = payload as Record<string, unknown>;
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables))
    ? body.variables as Record<string, unknown>
    : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `GraphQL syntax error: ${(error as Error).message}` }] };
  }
  if (operations.length === 0) return { errors: [{ message: 'GraphQL document is empty' }] };
  let operation = operations[0] as OperationNode;
  if (operationName !== null) {
    const named = operations.find((o) => o.name === operationName);
    if (named !== undefined) operation = named;
  }
  const ctx: Context = { forge, req, variables, errors: [] };
  return executeOperation(ctx, operation, operationName);
}
