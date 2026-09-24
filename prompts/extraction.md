# DSH-Wiki · Knowledge Extraction

After acquiring external material (web search results, fetched pages,
documents), turn it into durable knowledge instead of leaving it in the
transcript:

1. `wiki_source_save` the material you actually used: title, URL, retrieval
   time. That is all a source card holds — the wiki stores no original text,
   so never paste page content into it. The card answers one later question:
   where did this claim come from. One card per source, even when several
   facts come from it; the same URL deduplicates to the existing card. If the
   material has no URL (a colleague's answer, a private document), say what
   it was in the title and accept that the claim will be harder to re-verify.
2. Extract candidate knowledge from what you read, while it is still in
   context — after this turn the original is gone and only your notes remain:
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
4. Write the knowledge into the page body and cite the card id in `sources`.
   A page is where the summary lives; the card only proves it. A claim with no
   card behind it is an opinion, so leave it out or mark it as your own
   inference.

Temporary task events, session chatter, one-off facts, and raw link dumps do
not belong in the wiki. The Admission Controller rejects weak candidates;
they are journaled, not written.
