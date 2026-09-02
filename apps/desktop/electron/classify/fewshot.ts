// Builds the text the local classifier sees: the message excerpt, the custom
// category list, and the nearest corrections rendered as few-shot examples.

import type { CategoryRow, CorrectionRow } from "@arcforma/store";

export const EXCERPT_CHARS = 1500;

export interface ExcerptInput {
  fromEmail: string;
  fromName?: string;
  subject: string;
  to?: string[];
  body: string;
}

/** The excerpt used for classification and stored with corrections. Headers first, then the body, trimmed. */
export function buildExcerpt(m: ExcerptInput): string {
  // Everything here is data the model reads, never instructions it follows. Each
  // field is flattened to one line so a crafted header or body cannot open a
  // new "Answer:" or "Example N:" line inside the few-shot block.
  const line = (s: string) => s.replace(/\s+/g, " ").trim();
  const from = m.fromName ? `${line(m.fromName)} <${line(m.fromEmail)}>` : line(m.fromEmail);
  const lines = [`From: ${from}`];
  if (m.to && m.to.length) lines.push(`To: ${m.to.map(line).join(", ")}`);
  lines.push(`Subject: ${line(m.subject)}`, "", line(m.body));
  const text = lines.join("\n");
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)} [cut]` : text;
}

/** "Name: description" lines for the classify prompt's {{categories}} slot. */
export function categoriesText(categories: CategoryRow[]): string {
  const custom = categories.filter((c) => c.kind === "custom");
  if (custom.length === 0) return "(none)";
  return custom.map((c) => `${c.name}: ${c.prompt || "no description"}`).join("\n");
}

function label(c: CorrectionRow, categories: CategoryRow[]): string {
  const cat = c.to_category ? categories.find((x) => x.id === c.to_category)?.name ?? c.to_category : null;
  const parts = [`split=${c.to_split ?? "other"}`];
  if (c.to_type) parts.push(`type=${c.to_type}`);
  if (cat) parts.push(`category=${cat}`);
  return parts.join(", ");
}

/** Numbered few-shot examples for the {{examples}} slot, each an excerpt plus the verdict the user chose. */
export function examplesText(corrections: CorrectionRow[], categories: CategoryRow[]): string {
  if (corrections.length === 0) return "(none yet)";
  return corrections
    .map((c, i) => {
      // Older corrections may carry raw excerpts; re-flatten so a stored line can never read as a verdict.
      const flat = c.text_excerpt.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
      const excerpt = flat.length > 400 ? `${flat.slice(0, 400)} [cut]` : flat;
      return `Example ${i + 1}:\n${excerpt}\nAnswer: ${label(c, categories)}`;
    })
    .join("\n\n");
}

/** The JSON schema the local model is constrained to. Type values mirror the prompt's singular names. */
export function classifySchema(categoryNames: string[]): unknown {
  return {
    type: "object",
    properties: {
      split: { type: "string", enum: ["important", "other"] },
      type: { type: "string", enum: ["newsletter", "calendar", "notification", "receipt", "none"] },
      category: { type: "string", enum: ["none", ...categoryNames] },
      confidence: { type: "number" },
    },
    required: ["split", "type", "category", "confidence"],
    additionalProperties: false,
  };
}
