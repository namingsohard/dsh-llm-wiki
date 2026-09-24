/*
 * dsh-llm-wiki — browser half: the sidebar Wiki browser.
 *
 * Hand-written in the lazy-CJS factory format the DSH client module system
 * consumes (`dsh.client` manifest in package.json; the build copies this file
 * to lib/client.js verbatim). It registers one right-Sidebar tab type with a
 * guide-page entry — the same public seats the built-in files/terminal/browser
 * tabs use — and draws two views inside the pane:
 *
 *   list    the wiki root as sections (concepts / entities / sources / staging)
 *   reader  one page rendered from Markdown, or one staged proposal as JSON
 *
 * Data comes from this plugin's own read-only routes (`GET /wiki/tree`,
 * `/wiki/page`, `/wiki/staged`) served by the host half — the wiki root lives
 * outside every session workspace, so `remote.workspaceFiles` cannot list it.
 *
 * Dependencies stay on the platform baseline: `react` and
 * `@deepseek-ai/dsh-client-store` resolve from the shell's frozen module
 * table; nothing else is required, and the bundle vendors its own styles and
 * Markdown renderer (no raw HTML anywhere — text stays text nodes).
 */
window.__ModuleLoader__.load({
	id: "dsh-llm-wiki",
	factory(require) {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const { defineStore } = require("@deepseek-ai/dsh-client-store");
		const h = React.createElement;

		/** This implementation's identity in the tab system, and the key its body registers under. */
		const WIKI_ID = "dsh-llm-wiki";
		/** The tab kind this package owns. */
		const WIKI_KIND = "wiki";
		/** This package's copy namespace. */
		const NS = "wikiBrowser";

		/* ------------------------------------------------------------- copy */

		const zh = {
			"type.label": "Wiki",
			"guide.title": "Wiki 记忆库",
			"guide.description": "浏览智能体的语义记忆",
			loading: "正在读取…",
			reload: "重新读取",
			back: "返回列表",
			retry: "重试",
			empty: "wiki 还是空的。让智能体用 wiki_mutate 写入第一条知识。",
			"section.concept": "概念",
			"section.entity": "实体",
			"section.source": "来源",
			"section.staging": "待审写入",
			"empty.section": "暂无条目",
			"status.deprecated": "已弃用",
			"status.merged": "已合并",
			"staging.type.source": "来源卡片",
			"staging.type.mutation": "页面变更",
			"error.unreachable": "读取 wiki 失败：{detail}",
			"error.notFound": "这个页面不在了，可能已被合并或删除。",
			"error.invalid": "请求被宿主拒绝：{detail}",
			"error.offline": "wiki 路由不可用：这个宿主没有启用 Web 界面。",
			"meta.updated": "更新",
			"meta.revision": "修订",
			"meta.staged": "提交于",
			"meta.tags": "标签",
			"meta.sources": "来源",
			"meta.truncated": "正文过长，仅显示前一部分。",
			"meta.payload": "提议内容",
			"failures": "{count} 个文件解析失败",
		};
		const en = {
			"type.label": "Wiki",
			"guide.title": "Wiki memory",
			"guide.description": "Browse the agent's semantic memory",
			loading: "Reading…",
			reload: "Reload",
			back: "Back to list",
			retry: "Retry",
			empty: "The wiki is empty. Ask the agent to save its first page with wiki_mutate.",
			"section.concept": "Concepts",
			"section.entity": "Entities",
			"section.source": "Sources",
			"section.staging": "Staged writes",
			"empty.section": "Nothing here yet",
			"status.deprecated": "deprecated",
			"status.merged": "merged",
			"staging.type.source": "Source card",
			"staging.type.mutation": "Page mutation",
			"error.unreachable": "Reading the wiki failed: {detail}",
			"error.notFound": "This page is gone. It may have been merged or deleted.",
			"error.invalid": "The host rejected the request: {detail}",
			"error.offline": "The wiki routes are unavailable: this host has no web surface.",
			"meta.updated": "updated",
			"meta.revision": "rev",
			"meta.staged": "staged",
			"meta.tags": "tags",
			"meta.sources": "sources",
			"meta.truncated": "The body is long; only the first part is shown.",
			"meta.payload": "proposed content",
			"failures": "{count} file(s) failed to parse",
		};

		/* ----------------------------------------------------- definitions */

		/** A quiet open book at the guide capsule's glyph size. */
		function WikiGlyph({ size }) {
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.7,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": true,
					style: { display: "block" },
				},
				h("path", { d: "M12 6.5C10.5 5 8.5 4.2 5.5 4.2c-.8 0-1.6.06-2.5.2v13.2c.9-.14 1.7-.2 2.5-.2 3 0 5 .8 6.5 2.3" }),
				h("path", { d: "M12 6.5C13.5 5 15.5 4.2 18.5 4.2c.8 0 1.6.06 2.5.2v13.2c-.9-.14-1.7-.2-2.5-.2-3 0-5 .8-6.5 2.3" }),
				h("path", { d: "M12 6.5v13.2" }),
			);
		}

		/**
		 * The wiki type's registry definition.
		 * @param t - namespace-bound translate, read fresh on every label call.
		 * @returns the definition to register.
		 */
		function wikiDefinition(t) {
			return {
				id: WIKI_ID,
				kind: WIKI_KIND,
				priority: "extension",
				title: () => t("type.label"),
				guide: [
					{
						id: "memory",
						order: 15,
						title: () => t("guide.title"),
						description: () => t("guide.description"),
						icon: (props) => h(WikiGlyph, props),
					},
				],
			};
		}

		/* --------------------------------------------------------- fetching */

		/** Fetch one wiki route; failures carry the server's error code. */
		async function fetchJson(url, signal) {
			let response;
			try {
				response = await fetch(url, { signal, headers: { accept: "application/json" } });
			} catch (error) {
				if (error && error.name === "AbortError") throw error;
				throw new Error("unreachable");
			}
			if (!response.ok) {
				let code = `http/${String(response.status)}`;
				try {
					const body = await response.json();
					if (body && typeof body.error === "string") code = body.error;
				} catch {
					/* keep the status code */
				}
				throw new Error(code);
			}
			return await response.json();
		}

		/** The reader URL for one tree reference. */
		function refUrl(ref) {
			return ref.section === "staging"
				? `/wiki/staged?id=${encodeURIComponent(ref.id)}`
				: `/wiki/page?kind=${encodeURIComponent(ref.section)}&id=${encodeURIComponent(ref.id)}`;
		}

		/**
		 * Bind the pane's face to the wiki routes.
		 * @returns the Slot `inject` factory: session and bound actions in, face out.
		 */
		function wikiFace() {
			return (sessionId, actions) => {
				/** Per tab: the load generation a settlement must match; the latest request wins. */
				const generations = new Map();
				const loadTree = (tabId, signal) => {
					if (signal.aborted) return;
					const generation = (generations.get(tabId) ?? 0) + 1;
					generations.set(tabId, generation);
					actions.treeLoading(tabId);
					fetchJson("/wiki/tree", signal).then(
						(tree) => {
							if (signal.aborted || generations.get(tabId) !== generation) return;
							actions.treeLoaded(tabId, tree);
						},
						(error) => {
							if (signal.aborted || generations.get(tabId) !== generation) return;
							actions.treeFailed(tabId, error && error.name === "AbortError" ? "aborted" : String(error && error.message ? error.message : error));
						},
					);
				};
				return {
					start(tabId, signal) {
						actions.start(tabId);
						signal.addEventListener(
							"abort",
							() => {
								generations.delete(tabId);
								actions.forget(tabId);
							},
							{ once: true },
						);
						loadTree(tabId, signal);
					},
					reload(tabId, signal) {
						loadTree(tabId, signal);
					},
					open(tabId, ref, signal) {
						actions.opened(tabId, ref);
						if (ref === null) return;
						fetchJson(refUrl(ref), signal).then(
							(body) => {
								if (signal.aborted) return;
								actions.pageLoaded(tabId, ref, body);
							},
							(error) => {
								if (signal.aborted) return;
								actions.pageFailed(tabId, ref, String(error && error.message ? error.message : error));
							},
						);
					},
				};
			};
		}

		/* ------------------------------------------------------------ store */

		/**
		 * The browser's view state: the tree, which sections are collapsed,
		 * what the reader holds — bucketed per tab in a Slot-standard
		 * exclusive store (one instance per session), so switching sidebar
		 * tabs and coming back restores the pane where it was.
		 */
		function createWikiStore() {
			return defineStore({
				init: () => ({ byTab: {} }),
				actions: {
					start: (d, tabId) => {
						d.byTab[tabId] = { status: "loading", error: null, tree: null, collapsed: [], open: null, page: null };
					},
					/** Dim-for-reload only when nothing is on screen yet; a refetch keeps the old tree. */
					treeLoading: (d, tabId) => {
						const bucket = d.byTab[tabId];
						if (bucket !== undefined && bucket.tree === null) bucket.status = "loading";
					},
					treeLoaded: (d, tabId, tree) => {
						const bucket = d.byTab[tabId];
						if (bucket === undefined) return;
						bucket.status = "ready";
						bucket.error = null;
						bucket.tree = tree;
					},
					treeFailed: (d, tabId, error) => {
						const bucket = d.byTab[tabId];
						if (bucket === undefined) return;
						bucket.status = bucket.tree === null ? "error" : "ready";
						bucket.error = error;
					},
					toggled: (d, tabId, section) => {
						const bucket = d.byTab[tabId];
						if (bucket === undefined) return;
						const at = bucket.collapsed.indexOf(section);
						if (at >= 0) bucket.collapsed.splice(at, 1);
						else bucket.collapsed.push(section);
					},
					opened: (d, tabId, ref) => {
						const bucket = d.byTab[tabId];
						if (bucket === undefined) return;
						bucket.open = ref;
						bucket.page = ref === null ? null : { status: "loading" };
					},
					pageLoaded: (d, tabId, ref, body) => {
						const bucket = d.byTab[tabId];
						if (bucket === undefined || bucket.open === null || bucket.open.id !== ref.id || bucket.open.section !== ref.section) return;
						bucket.page = { status: "ready", body };
					},
					pageFailed: (d, tabId, ref, error) => {
						const bucket = d.byTab[tabId];
						if (bucket === undefined || bucket.open === null || bucket.open.id !== ref.id || bucket.open.section !== ref.section) return;
						bucket.page = { status: "error", error };
					},
					forget: (d, tabId) => {
						const next = {};
						for (const id of Object.keys(d.byTab)) if (id !== tabId) next[id] = d.byTab[id];
						d.byTab = next;
					},
				},
			});
		}

		/* ------------------------------------------------ markdown renderer */

		/** Inline tokens: code, strong, em, strike, links. Text stays text. */
		const INLINE_RE = /(`[^`\n]+`)|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)|(~~([^~\n]+)~~)|(\[([^\]\n]*)\]\(([^)\s]+)\))/g;

		/** Turn one line of Markdown text into React nodes (no raw HTML). */
		function inlineNodes(text, keyBase) {
			const nodes = [];
			let cursor = 0;
			let index = 0;
			let match;
			INLINE_RE.lastIndex = 0;
			while ((match = INLINE_RE.exec(text)) !== null) {
				if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
				const key = `${keyBase}-${String(index++)}`;
				if (match[1] !== undefined) nodes.push(h("code", { key }, match[1].slice(1, -1)));
				else if (match[2] !== undefined) nodes.push(h("strong", { key }, inlineNodes(match[3], key)));
				else if (match[4] !== undefined) nodes.push(h("em", { key }, inlineNodes(match[5], key)));
				else if (match[6] !== undefined) nodes.push(h("del", { key }, inlineNodes(match[7], key)));
				else if (match[8] !== undefined) {
					const label = match[9];
					const href = match[10];
					nodes.push(
						/^https?:/i.test(href)
							? h("a", { key, href, target: "_blank", rel: "noreferrer noopener" }, inlineNodes(label === "" ? href : label, key))
							: h("span", { key, className: "dshwiki-deadlink", title: href }, label.length > 0 ? label : href),
					);
				}
				cursor = match.index + match[0].length;
			}
			if (cursor < text.length) nodes.push(text.slice(cursor));
			return nodes;
		}

		const HEADING_RE = /^(#{1,6})\s+(.*)$/;
		const FENCE_RE = /^\s*```/;
		const RULE_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
		const QUOTE_RE = /^\s*>/;
		const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

		/** A tiny line-based Markdown renderer: headings, code, lists, quotes, rules, paragraphs. */
		function renderMarkdown(md) {
			const lines = md.split(/\r?\n/);
			const out = [];
			let i = 0;
			let key = 0;
			const isBlockStart = (line) =>
				HEADING_RE.test(line) || FENCE_RE.test(line) || QUOTE_RE.test(line) || RULE_RE.test(line) || ITEM_RE.test(line);
			while (i < lines.length) {
				const line = lines[i];
				if (/^\s*$/.test(line)) {
					i += 1;
					continue;
				}
				if (FENCE_RE.test(line)) {
					const body = [];
					i += 1;
					while (i < lines.length && !FENCE_RE.test(lines[i])) {
						body.push(lines[i]);
						i += 1;
					}
					i += 1;
					out.push(h("pre", { key: `b${String(key++)}` }, h("code", null, body.join("\n"))));
					continue;
				}
				const heading = HEADING_RE.exec(line);
				if (heading !== null) {
					// h1 in the file becomes h2: the reader title owns h1.
					const level = String(Math.min(heading[1].length + 1, 6));
					const nodeKey = `b${String(key++)}`;
					out.push(h(`h${level}`, { key: nodeKey }, inlineNodes(heading[2], nodeKey)));
					i += 1;
					continue;
				}
				if (RULE_RE.test(line)) {
					out.push(h("hr", { key: `b${String(key++)}` }));
					i += 1;
					continue;
				}
				if (QUOTE_RE.test(line)) {
					const inner = [];
					while (i < lines.length && QUOTE_RE.test(lines[i])) {
						inner.push(lines[i].replace(/^\s*>\s?/, ""));
						i += 1;
					}
					out.push(h("blockquote", { key: `b${String(key++)}` }, ...renderMarkdown(inner.join("\n"))));
					continue;
				}
				if (ITEM_RE.test(line)) {
					const ordered = /^\s*\d+[.)]/.test(line);
					const items = [];
					while (i < lines.length && ITEM_RE.test(lines[i])) {
						const itemKey = `li${String(key++)}`;
						// A checkbox survives as a plain marker; phase 1 does not track state.
						items.push(h("li", { key: itemKey }, inlineNodes(ITEM_RE.exec(lines[i])[1].replace(/^\[[ xX]\]\s+/, ""), itemKey)));
						i += 1;
					}
					out.push(h(ordered ? "ol" : "ul", { key: `b${String(key++)}` }, ...items));
					continue;
				}
				const paragraph = [];
				while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
					paragraph.push(lines[i].trim());
					i += 1;
				}
				const nodeKey = `b${String(key++)}`;
				out.push(h("p", { key: nodeKey }, ...inlineNodes(paragraph.join(" "), nodeKey)));
			}
			return out;
		}

		/* -------------------------------------------------------------- views */

		const DAY = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "");

		/** Split an absolute path into the dimmed directory and the plain last segment. */
		function pathParts(absolute) {
			const at = Math.max(absolute.lastIndexOf("/"), absolute.lastIndexOf("\\"));
			return at <= 0 ? { directory: "", name: absolute } : { directory: absolute.slice(0, at + 1), name: absolute.slice(at + 1) };
		}

		/** One page row in a section list. */
		function PageRow({ row, onOpen }) {
			return h(
				"button",
				{ type: "button", className: "dshwiki-row", onClick: onOpen, title: `${row.title}\n${row.id}` },
				h("span", { className: "dshwiki-row-title" }, row.title),
				row.status !== "active" ? h("span", { className: "dshwiki-badge" }, row.status) : null,
				h("span", { className: "dshwiki-row-date" }, DAY(row.updated)),
			);
		}

		/** One staged proposal row: the pitch is the identity line. */
		function StagedRow({ row, onOpen }) {
			return h(
				"button",
				{ type: "button", className: "dshwiki-row", onClick: onOpen, title: row.pitch },
				h("span", { className: "dshwiki-row-title" }, row.pitch),
				h("span", { className: "dshwiki-badge" }, row.kind),
				h("span", { className: "dshwiki-row-date" }, DAY(row.staged_at)),
			);
		}

		/** A collapsible section of the list. */
		function Section({ label, count, collapsed, emptyText, onToggle, children }) {
			return h(
				"section",
				{ className: "dshwiki-section" },
				h(
					"button",
					{ type: "button", className: "dshwiki-section-head", onClick: onToggle, "aria-expanded": String(!collapsed) },
					h("span", { className: `dshwiki-caret${collapsed ? "" : " dshwiki-caret-open"}`, "aria-hidden": true }, "▸"),
					h("span", { className: "dshwiki-section-label" }, label),
					h("span", { className: "dshwiki-section-count" }, String(count)),
				),
				collapsed ? null : count === 0 ? h("p", { className: "dshwiki-note" }, emptyText) : children,
			);
		}

		/** Meta chips under a reader title. */
		function MetaRow({ items }) {
			const shown = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== "" && !(Array.isArray(item.value) && item.value.length === 0));
			if (shown.length === 0) return null;
			return h(
				"div",
				{ className: "dshwiki-meta" },
				shown.map((item) =>
					h("span", { key: item.label, className: "dshwiki-chip" }, `${item.label} ${Array.isArray(item.value) ? item.value.join(", ") : String(item.value)}`),
				),
			);
		}

		/** The reader for one live page. */
		function PageReader({ page, t }) {
			return h(
				"article",
				{ className: "dshwiki-article" },
				h("h1", { className: "dshwiki-h1" }, page.title),
				MetaRow({
					items: [
						{ label: t("meta.updated"), value: DAY(page.updated) },
						{ label: t("meta.revision"), value: page.revision },
						{ label: "status", value: page.status === "active" ? undefined : t(`status.${page.status}`) },
						{ label: t("meta.tags"), value: page.tags },
						{ label: t("meta.sources"), value: (page.sources ?? []).length === 0 ? undefined : (page.sources ?? []).length },
					],
				}),
				page.url !== undefined ? h("a", { className: "dshwiki-link", href: page.url, target: "_blank", rel: "noreferrer noopener" }, page.url) : null,
				h("div", { className: "dshwiki-markdown" }, ...renderMarkdown(page.body)),
				page.truncated ? h("p", { className: "dshwiki-note" }, t("meta.truncated")) : null,
			);
		}

		/** The reader for one staged proposal (read-only; approval stays in chat). */
		function StagedReader({ entry, t }) {
			return h(
				"article",
				{ className: "dshwiki-article" },
				h("h1", { className: "dshwiki-h1" }, t(entry.type === "source" ? "staging.type.source" : "staging.type.mutation")),
				MetaRow({
					items: [
						{ label: t("meta.staged"), value: DAY(entry.staged_at) },
						{ label: "id", value: entry.id },
						{ label: "kind", value: entry.kind },
					],
				}),
				entry.pitch ? h("p", { className: "dshwiki-pitch" }, entry.pitch) : null,
				h("h2", { className: "dshwiki-h2" }, t("meta.payload")),
				h("pre", { className: "dshwiki-json" }, JSON.stringify(entry.payload, null, 2)),
			);
		}

		/** Error text for one failure code, through the copy table. */
		function errorText(error, t) {
			if (error === "wiki-http/not-found") return t("error.notFound");
			if (error === "unreachable") return t("error.offline");
			if (typeof error === "string" && error.startsWith("wiki-http/")) return t("error.invalid", { detail: error });
			return t("error.unreachable", { detail: String(error ?? "unknown") });
		}

		/**
		 * The wiki browser's body: the section list, or the reader for one
		 * open reference. State is per tab and survives sidebar switches.
		 */
		function WikiBody({ useTabInfo, useStore, actions, start, reload, open, t }) {
			const { tab } = useTabInfo();
			const { signal } = tab;
			const state = useStore((store) => store.byTab[tab.id]);
			React.useEffect(() => {
				if (state === undefined && !signal.aborted) start(tab.id, signal);
			}, [state, tab.id, signal, start]);

			if (state === undefined) return null;

			// The pane styles ship as a component-local element so unmounting
			// removes them; every view shares one root wrapper.
			const root = (children) => h("div", { className: "dshwiki-root" }, h("style", null, CSS), ...children.flat());

			const header = (titleNode) =>
				h(
					"div",
					{ className: "dshwiki-header" },
					titleNode,
					h(
						"button",
						{
							type: "button",
							className: "dshwiki-tool",
							"aria-label": t("reload"),
							title: t("reload"),
							disabled: state.status === "loading",
							onClick: () => {
								actions.opened(tab.id, null);
								reload(tab.id, signal);
							},
						},
						h(
							"svg",
							{ width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", "aria-hidden": true },
							h("path", { d: "M20 12a8 8 0 1 1-2.34-5.66" }),
							h("path", { d: "M20 4v5h-5" }),
						),
					),
				);

			if (state.status === "loading" && state.tree === null) {
				return root([h("p", { className: "dshwiki-note dshwiki-centered" }, t("loading"))]);
			}
			if (state.status === "error") {
				return root([
					h("div", { className: "dshwiki-centered" }, h("p", { className: "dshwiki-note" }, errorText(state.error, t))),
					h("button", { type: "button", className: "dshwiki-tool", onClick: () => start(tab.id, signal) }, t("retry")),
				]);
			}

			// Reader view.
			if (state.open !== null) {
				const ref = state.open;
				const back = h(
					"button",
					{ type: "button", className: "dshwiki-back", onClick: () => actions.opened(tab.id, null) },
					h("span", { "aria-hidden": true }, "‹"),
					t("back"),
				);
				let content;
				if (state.page === null || state.page.status === "loading") content = h("p", { className: "dshwiki-note dshwiki-centered" }, t("loading"));
				else if (state.page.status === "error")
					content = h(
						"div",
						{ className: "dshwiki-centered" },
						h("p", { className: "dshwiki-note" }, errorText(state.page.error, t)),
						h("button", { type: "button", className: "dshwiki-tool", onClick: () => open(tab.id, ref, signal) }, t("retry")),
					);
				else if (ref.section === "staging") content = h(StagedReader, { entry: state.page.body.staged, t });
				else content = h(PageReader, { page: state.page.body.page, t });
				return root([header(back), h("div", { className: "dshwiki-body" }, content)]);
			}

			// List view.
			const tree = state.tree;
			const rootPath = pathParts(tree.root);
			const hasAny = tree.sections.some((section) => section.pages.length > 0) || tree.staging.length > 0;
			const openRef = (section, id) => open(tab.id, { section, id }, signal);
			const list = h(
				"div",
				{ className: "dshwiki-body" },
				!hasAny
					? h("p", { className: "dshwiki-note dshwiki-centered" }, t("empty"))
					: h(
						React.Fragment,
						null,
						...tree.sections.map((section) =>
							h(
								Section,
								{
									key: section.kind,
									label: t(`section.${section.kind}`),
									count: section.pages.length,
									collapsed: state.collapsed.includes(section.kind),
									emptyText: t("empty.section"),
									onToggle: () => actions.toggled(tab.id, section.kind),
								},
								h(
									"div",
									{ className: "dshwiki-rows" },
									...section.pages.map((row) => h(PageRow, { key: row.id, row, onOpen: () => openRef(section.kind, row.id) })),
								),
							),
						),
						tree.staging.length > 0
							? h(
								Section,
								{
									label: t("section.staging"),
									count: tree.staging.length,
									collapsed: state.collapsed.includes("staging"),
									emptyText: "",
									onToggle: () => actions.toggled(tab.id, "staging"),
								},
								h(
									"div",
									{ className: "dshwiki-rows" },
									...tree.staging.map((row) => h(StagedRow, { key: row.id, row, onOpen: () => openRef("staging", row.id) })),
								),
							)
							: null,
						tree.failures.length > 0
							? h(
								"div",
								{ className: "dshwiki-failures" },
								h("p", { className: "dshwiki-note" }, t("failures", { count: String(tree.failures.length) })),
								...tree.failures.map((failure) => h("p", { key: failure.path, className: "dshwiki-note" }, failure.path)),
							)
							: null,
					),
			);
			return root([
				header(
					h(
						"span",
						{ className: "dshwiki-rootpath", title: tree.root },
						h("span", { className: "dshwiki-rootpath-dir" }, rootPath.directory),
						rootPath.name,
					),
				),
				state.error !== null ? h("p", { className: "dshwiki-note" }, errorText(state.error, t)) : null,
				list,
			]);
		}

		/** The chip title: the book glyph, then whatever title the tab opened with. */
		function WikiTitle({ useTabInfo }) {
			const { tab } = useTabInfo();
			return h(React.Fragment, null, h(WikiGlyph, { size: 16 }), tab.title);
		}

		/* ------------------------------------------------------------- styles */

		/** Pane styles; theme tokens match the built-in sidebar panes. */
		const CSS = [
			".dshwiki-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.55;color:var(--dsw-alias-label-primary,inherit)}",
			".dshwiki-header{display:flex;align-items:center;gap:8px;flex:none;height:38px;padding:0 10px 0 16px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.25));box-sizing:border-box}",
			".dshwiki-rootpath{flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshwiki-rootpath-dir{color:var(--dsw-alias-label-tertiary,inherit)}",
			".dshwiki-tool{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;padding:0;font:inherit}",
			".dshwiki-tool:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
			".dshwiki-tool:disabled{opacity:.35;cursor:default}",
			".dshwiki-back{display:inline-flex;align-items:center;gap:4px;border:0;border-radius:8px;background:none;color:inherit;cursor:pointer;padding:3px 8px;font:inherit}",
			".dshwiki-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
			".dshwiki-back span{font-size:16px;line-height:1}",
			".dshwiki-body{flex:1;min-height:0;overflow-y:auto;padding:8px 8px 24px;scrollbar-gutter:stable}",
			".dshwiki-section{margin-bottom:4px}",
			".dshwiki-section-head{display:flex;align-items:center;gap:6px;width:100%;border:0;border-radius:10px;background:none;color:inherit;cursor:pointer;padding:6px 10px;font:inherit;font-weight:600;text-align:left}",
			".dshwiki-section-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
			".dshwiki-caret{display:inline-block;font-size:11px;opacity:.55;transition:transform .12s ease}",
			".dshwiki-caret-open{transform:rotate(90deg)}",
			".dshwiki-section-label{flex:1}",
			".dshwiki-section-count{font-weight:400;font-size:11px;opacity:.5}",
			".dshwiki-rows{display:flex;flex-direction:column}",
			".dshwiki-row{display:flex;align-items:baseline;gap:8px;width:100%;border:0;border-radius:10px;background:none;color:inherit;cursor:pointer;text-align:left;padding:5px 10px 5px 26px;font:inherit}",
			".dshwiki-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}",
			".dshwiki-row-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshwiki-row-date{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}",
			".dshwiki-badge{flex:none;font-size:10px;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));border-radius:999px;padding:0 6px;opacity:.8}",
			".dshwiki-note{margin:0;padding:4px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}",
			".dshwiki-centered{display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 16px;text-align:center}",
			".dshwiki-failures{margin-top:12px;border-top:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.3))}",
			".dshwiki-article{padding:8px 6px}",
			".dshwiki-h1{font-size:17px;line-height:1.35;margin:2px 0 8px}",
			".dshwiki-h2{font-size:14px;margin:16px 0 6px}",
			".dshwiki-meta{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}",
			".dshwiki-chip{font-size:11px;opacity:.7;border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));border-radius:999px;padding:1px 8px}",
			".dshwiki-pitch{opacity:.9;margin:0 0 8px}",
			".dshwiki-link{display:inline-block;margin-bottom:8px;font-size:12px;overflow-wrap:anywhere}",
			".dshwiki-markdown h2,.dshwiki-markdown h3,.dshwiki-markdown h4,.dshwiki-markdown h5,.dshwiki-markdown h6{margin:14px 0 6px;line-height:1.4}",
			".dshwiki-markdown p{margin:8px 0}",
			".dshwiki-markdown ul,.dshwiki-markdown ol{margin:8px 0;padding-left:22px}",
			".dshwiki-markdown li{margin:3px 0}",
			".dshwiki-markdown blockquote{margin:8px 0;padding:2px 12px;border-left:2px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));opacity:.85}",
			".dshwiki-markdown hr{border:0;border-top:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));margin:12px 0}",
			".dshwiki-markdown code,.dshwiki-json{background:rgba(128,128,128,.14);border-radius:5px;padding:1px 5px;font-family:ui-monospace,Consolas,monospace;font-size:12px}",
			".dshwiki-markdown pre,.dshwiki-json{display:block;padding:10px 12px;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}",
			".dshwiki-markdown pre code{background:none;padding:0}",
			".dshwiki-markdown a{text-decoration:underline;text-underline-offset:2px}",
			".dshwiki-deadlink{opacity:.7;border-bottom:1px dotted currentColor}",
		].join("\n");

		/* -------------------------------------------------------------- wiring */

		/** Required browser services: the tab registry and the keyed seats. */
		const inject = ["slots", "locale", "sidebarRightTabs"];

		/**
		 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
		 * @param ctx - client root context carrying the registry, the slots, and the locale.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.sidebarRightTabs.register(wikiDefinition(t)), "dsh-llm-wiki: wiki type");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-llm-wiki: dictionaries");
			const store = createWikiStore();
			const face = wikiFace();
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab", () =>
						ctx.slots.register(
							{
								name: "sidebar.right.pane.tab",
								key: WIKI_ID,
								locale: NS,
								store,
								inject: face,
							},
							WikiBody,
						),
					),
				"dsh-llm-wiki: wiki tab body",
			);
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.right.pane.tab.title", () =>
						ctx.slots.register(
							{
								name: "sidebar.right.pane.tab.title",
								key: WIKI_ID,
							},
							WikiTitle,
						),
					),
				"dsh-llm-wiki: wiki tab title",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
