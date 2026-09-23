import type { PageKind, SearchHit, WikiPage } from '../types.js';
import type { WikiStore, ParseFailure } from '../storage/markdown-store.js';
import { freshnessOf, freshnessWeight } from './freshness.js';

/**
 * Phase-1 retriever: tokenized keyword matching over the Markdown corpus
 * (the blueprint's grep/find/read-file tier, kept dependency-free and
 * explainable). BM25/embedding retrieval can replace this module later
 * without touching tool contracts.
 *
 * Scoring: per query token — title 4, tag 3, body 1; an exact phrase match
 * in title or body adds a bonus. Status and freshness modulate the score;
 * merged pages are never returned.
 *
 * @module dsh-llm-wiki/retrieval/grep-retriever
 */

const ASCII_WORD = /[a-z0-9]+/g;
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;

/** Lowercase word tokens plus CJK unigram+bigram tokens. */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const words = lower.match(ASCII_WORD);
  if (words !== null) tokens.push(...words);
  const runs = lower.match(CJK_RUN);
  if (runs !== null) {
    for (const run of runs) {
      for (const char of run) tokens.push(char);
      for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

/** Unique tokens preserving first-seen order — query side. */
export function queryTokens(query: string): string[] {
  return [...new Set(tokenize(query))];
}

const SNIPPET_RADIUS = 90;

function buildSnippet(page: WikiPage, needle: string): string {
  const body = page.body.replace(/\s+/g, ' ').trim();
  const lower = body.toLowerCase();
  const at = needle.length > 0 ? lower.indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return body.slice(0, SNIPPET_RADIUS * 2) + (body.length > SNIPPET_RADIUS * 2 ? '…' : '');
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(body.length, at + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

interface CachedCorpus {
  version: number;
  pages: WikiPage[];
  failures: ParseFailure[];
}

/** Score one page against a query; 0 means "not a hit". */
export function scorePage(page: WikiPage, query: string, qTokens: string[], agingAfterDays: number, staleAfterDays: number): { score: number; freshness: SearchHit['freshness']; snippet: string } | undefined {
  if (page.status === 'merged') return undefined;
  const freshness = freshnessOf(page, agingAfterDays, staleAfterDays);
  const titleLower = page.title.toLowerCase();
  const tagLower = page.tags.map((tag) => tag.toLowerCase());
  const bodyLower = page.body.toLowerCase();
  const queryLower = query.trim().toLowerCase();

  let score = 0;
  let firstBodyToken = '';
  for (const token of qTokens) {
    if (titleLower.includes(token)) score += 4;
    else if (tagLower.some((tag) => tag.includes(token))) score += 3;
    else if (bodyLower.includes(token)) {
      score += 1;
      if (firstBodyToken.length === 0) firstBodyToken = token;
    }
  }
  if (score === 0) return undefined;

  // Phrase bonus: a literal query match is strong evidence of coverage.
  if (queryLower.length > 3 && titleLower.includes(queryLower)) score += 6;
  else if (queryLower.length > 3 && bodyLower.includes(queryLower)) score += 4;

  score *= freshnessWeight(freshness);
  if (page.status === 'deprecated') score *= 0.5;

  const needle = queryLower.length > 3 && bodyLower.includes(queryLower) ? queryLower : firstBodyToken;
  return { score: Math.round(score * 100) / 100, freshness, snippet: buildSnippet(page, needle) };
}

export interface SearchOptions {
  query: string;
  kinds?: PageKind[];
  limit: number;
  includeDeprecated: boolean;
  agingAfterDays: number;
  staleAfterDays: number;
}

export interface SearchResult {
  hits: SearchHit[];
  scanned: number;
  failures: ParseFailure[];
}

/** Corpus cache per store instance, invalidated by `store.version`. */
const corpusCache = new WeakMap<WikiStore, CachedCorpus>();

/** Run a ranked search over the wiki. */
export async function searchWiki(store: WikiStore, options: SearchOptions): Promise<SearchResult> {
  const kinds = options.kinds ?? ['concept', 'entity'];
  let cached = corpusCache.get(store);
  if (cached === undefined || cached.version !== store.version) {
    cached = (await store.listPages(['concept', 'entity', 'source'])) as CachedCorpus;
    corpusCache.set(store, cached);
  }
  const qTokens = queryTokens(options.query);
  if (qTokens.length === 0) return { hits: [], scanned: cached.pages.length, failures: cached.failures };

  const hits: SearchHit[] = [];
  for (const page of cached.pages) {
    if (!kinds.includes(page.kind)) continue;
    if (!options.includeDeprecated && page.status === 'deprecated') continue;
    const scored = scorePage(page, options.query, qTokens, options.agingAfterDays, options.staleAfterDays);
    if (scored === undefined) continue;
    hits.push({
      id: page.id,
      kind: page.kind,
      title: page.title,
      status: page.status,
      score: scored.score,
      freshness: scored.freshness,
      snippet: scored.snippet,
      updated: page.updated,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { hits: hits.slice(0, options.limit), scanned: cached.pages.length, failures: cached.failures };
}
