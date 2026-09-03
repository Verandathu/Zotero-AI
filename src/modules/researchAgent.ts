import { getPref } from "../utils/prefs";
import { ContextProvider, ItemContext } from "./contextProvider";

export interface ResolvedWork {
  /** The reference string the user wrote. */
  reference: string;
  source: "library" | "web" | "none";
  title: string;
  creators?: string;
  year?: string;
  abstract?: string;
  fullText?: string;
}

export interface ResearchResult {
  /** A context block to append to the system prompt. */
  context: string;
  works: ResolvedWork[];
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "or",
  "in",
  "on",
  "for",
  "with",
  "to",
  "from",
  "by",
  "at",
  "as",
  "is",
  "are",
  "was",
  "were",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "their",
  "they",
  "we",
  "you",
  "about",
  "into",
  "over",
  "under",
  "between",
  "among",
  "et",
  "al",
]);

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalize(value: string): string {
  return stripDiacritics(value.toLocaleLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function yearIn(query: string): number | null {
  const match = query.match(/\b(1[89]\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function itemYear(item: Zotero.Item): string {
  try {
    const date = item.getField("date");
    const match = date?.match(/\b(1[89]\d{2}|20\d{2})\b/);
    return match ? match[1] : date || "";
  } catch {
    return "";
  }
}

/**
 * Extracts candidate bibliographic references from a free-form user message:
 * quoted titles, "Author et al. (Year)" citations, and Title-Case (Year).
 */
export function extractReferences(message: string): string[] {
  const found = new Set<string>();
  for (const match of message.matchAll(/["“”]([^"“”\n]{4,160})["“”]/g)) {
    const ref = match[1].trim();
    if (ref) found.add(ref);
  }
  for (const match of message.matchAll(
    /([A-Z][A-Za-z'’-]{1,24})\s+(?:and\s+[A-Z][A-Za-z'’-]{1,24}\s+)?et\s+al\.?,?\s*\(?(\d{4})\)?/g,
  )) {
    found.add(`${match[1]} et al. (${match[2]})`);
  }
  for (const match of message.matchAll(
    /\b([A-Z][A-Za-z0-9'’&:-]+(?:\s+[A-Z][A-Za-z0-9'’&:-]+){2,})\s*\((\d{4})\)/g,
  )) {
    const title = match[1].trim();
    if (title.split(/\s+/).length <= 12) found.add(`${title} (${match[2]})`);
  }
  return [...found].slice(0, 8);
}

interface LibraryMatch {
  item: Zotero.Item;
  score: number;
}

/**
 * Cross-document "agentic" research: resolve papers a user mentions by first
 * searching their Zotero library (injecting title/abstract/full text when
 * found), then falling back to Crossref for anything the library lacks.
 */
export class ResearchAgent {
  constructor(private contextProvider: ContextProvider) {}

  async research(message: string): Promise<ResearchResult> {
    const references = extractReferences(message);
    if (!references.length) {
      return { context: "", works: [] };
    }
    const maxWorks = Math.max(1, Number(getPref("agenticMaxWorks")) || 5);
    const jobs = references.slice(0, maxWorks).map((reference) => {
      const local = this.searchLibrary(reference);
      return local
        ? this.resolveFromLibrary(reference, local)
        : this.resolveFromWeb(reference);
    });
    const works = (await Promise.all(jobs)).filter(Boolean) as ResolvedWork[];

    return {
      context: this.renderContextBlock(works),
      works,
    };
  }

  private searchLibrary(reference: string): LibraryMatch | null {
    const qYear = yearIn(reference);
    const qTokens = tokens(reference);
    const qNorm = normalize(reference);
    let best: LibraryMatch | null = null;
    try {
      const items = (Zotero.Items as any).getAll?.() as
        | Zotero.Item[]
        | undefined;
      if (!items?.length) return null;
      for (const item of items) {
        if (!item.isRegularItem() || item.deleted) continue;
        const title = item.getField("title");
        if (!title) continue;
        const titleNorm = normalize(title);
        const creatorsNorm = normalize(
          (item.getCreators?.() || [])
            .map((c: any) => c.lastName || "")
            .join(" "),
        );
        let score = 0;
        if (qNorm && titleNorm) {
          if (titleNorm === qNorm) score += 40;
          else if (titleNorm.includes(qNorm) || qNorm.includes(titleNorm))
            score += 24;
        }
        const titleTokens = tokens(title);
        const overlap = qTokens.filter((t) =>
          titleTokens.some(
            (tt) => tt === t || tt.includes(t) || t.includes(tt),
          ),
        );
        score += overlap.length * 6;
        score +=
          qTokens.filter((t) =>
            creatorsNorm.split(/\s+/).some((ct) => ct === t),
          ).length * 4;
        if (qYear != null && itemYear(item).startsWith(String(qYear))) {
          score += 3;
        }
        // Require a meaningful match to avoid firing on stopword-only queries
        if (score >= 12 && (!best || score > best.score)) {
          best = { item, score };
        }
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: library research search failed", e);
    }
    return best;
  }

  private async resolveFromLibrary(
    reference: string,
    match: LibraryMatch,
  ): Promise<ResolvedWork> {
    try {
      const ctx: ItemContext = await this.contextProvider.buildReferenceContext(
        match.item,
      );
      return {
        reference,
        source: "library",
        title: ctx.title,
        creators: this.creatorsOf(match.item),
        year: itemYear(match.item),
        abstract: this.abstractOf(match.item),
        fullText: ctx.fullText,
      };
    } catch (e) {
      ztoolkit.log("Zotero AI: resolveFromLibrary failed", e);
      return {
        reference,
        source: "none",
        title: match.item.getField("title") || reference,
      };
    }
  }

  private async resolveFromWeb(reference: string): Promise<ResolvedWork> {
    try {
      const record = await this.crossrefLookup(reference);
      if (record) {
        return { reference, source: "web", ...record };
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: crossref lookup failed", e);
    }
    return { reference, source: "none", title: reference };
  }

  private async crossrefLookup(
    reference: string,
  ): Promise<Omit<ResolvedWork, "reference" | "source"> | null> {
    const url =
      "https://api.crossref.org/works?rows=3&select=title,author,abstract,DOI,container-title,issued&query.bibliographic=" +
      encodeURIComponent(reference);
    const data = await this.fetchJSON(url);
    const items = data?.message?.items as any[] | undefined;
    if (!items?.length) return null;
    const top = items[0];
    const title = Array.isArray(top?.title) ? top.title[0] : top?.title;
    if (!title) return null;
    const creators = (top?.author || [])
      .map((a: any) => `${a?.given || ""} ${a?.family || ""}`.trim())
      .filter(Boolean)
      .join(", ");
    let abstract = "";
    if (typeof top?.abstract === "string") {
      abstract = top.abstract
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    const year =
      top?.issued?.["date-parts"]?.[0]?.[0]?.toString() ||
      (typeof top?.issued?.raw === "string"
        ? yearIn(top.issued.raw)?.toString()
        : "") ||
      "";
    return {
      title,
      creators: creators || undefined,
      year: year || undefined,
      abstract: abstract || undefined,
    };
  }

  private async fetchJSON(url: string): Promise<any> {
    const win =
      Zotero.getMainWindow() || (Zotero as any).getActiveZoteroPane?.()?.window;
    const doFetch =
      win?.fetch?.bind(win) || (globalThis as any).fetch?.bind(globalThis);
    if (!doFetch) return null;
    const response = await doFetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return await response.json();
  }

  private creatorsOf(item: Zotero.Item): string {
    try {
      return (item.getCreators?.() || [])
        .map((c: any) => `${c.firstName || ""} ${c.lastName || ""}`.trim())
        .filter(Boolean)
        .join(", ");
    } catch {
      return "";
    }
  }

  private abstractOf(item: Zotero.Item): string {
    try {
      return item.getField("abstractNote") || "";
    } catch {
      return "";
    }
  }

  private renderContextBlock(works: ResolvedWork[]): string {
    const sections: string[] = [];
    const library = works.filter((w) => w.source === "library");
    const web = works.filter((w) => w.source === "web");
    const missing = works.filter((w) => w.source === "none");

    if (library.length) {
      sections.push(
        "The user's query mentions other papers. The following were found in their Zotero library; use their details (and full text where provided) to ground the comparison:",
      );
      for (const work of library) {
        sections.push(this.formatWork(work));
      }
    }
    if (web.length) {
      sections.push(
        "These references were not in the user's library; their public metadata was retrieved from the web (Crossref). Note they are approximate and may not be full papers:",
      );
      for (const work of web) {
        sections.push(this.formatWork(work));
      }
    }
    if (missing.length) {
      sections.push(
        "These references could not be located either in the user's library or on the web. If the answer depends on them, say so explicitly rather than guessing: " +
          missing.map((w) => `"${w.reference}"`).join(", "),
      );
    }
    return sections.join("\n\n");
  }

  private formatWork(work: ResolvedWork): string {
    const lines = [`## ${work.title}`];
    if (work.creators) lines.push(`Creators: ${work.creators}`);
    if (work.year) lines.push(`Year: ${work.year}`);
    if (work.abstract) lines.push(`Abstract: ${work.abstract}`);
    if (work.fullText)
      lines.push(`Full text (excerpt):\n"""\n${work.fullText}\n"""`);
    return lines.join("\n");
  }
}
