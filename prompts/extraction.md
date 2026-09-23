# DSH-Wiki · Knowledge Extraction

After acquiring external material (web search results, fetched pages,
documents), turn it into durable knowledge instead of leaving it in the
transcript:

1. `wiki_source_save` the raw material you actually used: title, URL (when
   any), and the extracted original text. This is the Source Layer — the
   evidence every wiki claim can be traced to. One save per source, even
   when several facts come from it.
2. Extract candidate knowledge from it:
   - Concepts — reusable abstractions, mechanisms, patterns, how-things-work.
   - Entities — concrete products, projects, tools, organizations, people.
   - Relations — how concepts/entities connect (part-of, competes-with,
     depends-on, supersedes...).
3. Judge each candidate through the four admission dimensions BEFORE writing,
   scoring 0..3 each:
   - reusability: will future tasks plausibly reuse it?
   - stability: valid over weeks/months, not just this session?
   - novelty: adds something `wiki_search` does not already return?
   - abstraction: a knowledge summary, not a transient event?
   Run `wiki_search` on the candidate title first: if a page already covers
   it, the candidate's novelty is low — plan an UPDATE/MERGE, not a CREATE.

Temporary task events, session chatter, one-off facts, and raw link dumps do
not belong in the wiki. The Admission Controller rejects weak candidates;
they are journaled, not written.
