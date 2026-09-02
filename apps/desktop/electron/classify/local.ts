// Local-model layer: only the residue the rules could not decide reaches it.
// Calls the daemon's /v1/classify with a constrained schema and the eight
// nearest corrections as few-shot examples. Below 0.55 confidence the thread
// stays Other with no category rather than guessing.

import { listCategories, nearestCorrections, type CategoryRow, type Db } from "@arcforma/store";
import type { AiClient } from "../ai/client.js";
import { categoriesText, classifySchema, examplesText } from "./fewshot.js";
import type { Split } from "./rules.js";

export const CONFIDENCE_FLOOR = 0.55;
export const FEW_SHOT_K = 8;

export interface LocalRaw {
  split: string;
  type: string;
  category: string;
  confidence: number;
}

export interface LocalVerdict {
  split: Split;
  type: string | null;
  categoryId: string | null;
  confidence: number;
}

const TYPE_IDS: Record<string, string> = { newsletter: "newsletters", calendar: "calendar", notification: "notifications", receipt: "receipts" };

/** Applies the confidence floor and maps the prompt's names onto store ids. Pure, so it is tested without a model. */
export function interpretLocal(raw: LocalRaw, categories: CategoryRow[]): LocalVerdict {
  const confidence = Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  const type = TYPE_IDS[raw.type] ?? null;
  if (confidence < CONFIDENCE_FLOOR) return { split: "other", type, categoryId: null, confidence };
  const split: Split = raw.split === "important" ? "important" : "other";
  const match = raw.category && raw.category !== "none" ? categories.find((c) => c.kind === "custom" && c.name.toLowerCase() === raw.category.toLowerCase()) : null;
  return { split, type, categoryId: match?.id ?? null, confidence };
}

export async function classifyLocally(db: Db, ai: AiClient, excerpt: string): Promise<LocalVerdict> {
  const categories = listCategories(db);
  const custom = categories.filter((c) => c.kind === "custom");
  const examples = nearestCorrections(db, excerpt, FEW_SHOT_K);
  const res = await ai.classify<LocalRaw>({
    text: excerpt,
    schema: classifySchema(custom.map((c) => c.name)),
    vars: { categories: categoriesText(categories), examples: examplesText(examples, categories) },
    timeoutMs: 60_000,
  });
  return interpretLocal(res.json, categories);
}
