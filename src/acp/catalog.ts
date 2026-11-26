import type { SessionConfigOption, SessionConfigSelect, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import { z } from "zod";

const CatalogThoughtSchema = z
  .object({
    value: z.string(),
    name: z.string(),
  })
  .readonly();

const CatalogModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    thoughts: z.array(CatalogThoughtSchema).readonly(),
    /** `thought_level.currentValue` after selecting this model on a fresh session. */
    defaultThought: z.string().optional(),
  })
  .readonly();

/** The model catalog learned from an ACP session. */
export const CatalogSchema = z
  .object({
    models: z.array(CatalogModelSchema).readonly(),
    /** Model the agent selected when the discovery session was created. */
    defaultModel: z.string().optional(),
  })
  .readonly();

export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

export type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

export function optionById(options: readonly SessionConfigOption[], id: string): SessionConfigOption | undefined {
  return options.find((option) => option.id === id);
}

/** Finds a `select` option by semantic category, such as `model` or `thought_level`. */
export function optionByCategory(options: readonly SessionConfigOption[], category: string): SelectOption | undefined {
  for (const option of options) {
    if (option.type === "select" && option.category === category) return option;
  }
  return undefined;
}

/**
 * Finds a `select` option by semantic category, falling back to its ID for
 * agents that do not report categories.
 */
export function selectOption(options: readonly SessionConfigOption[], category: string): SelectOption | undefined {
  const byCategory = optionByCategory(options, category);
  if (byCategory !== undefined) return byCategory;

  const byId = optionById(options, category);
  return byId?.type === "select" ? byId : undefined;
}

/** Flattens a select option's flat or grouped value list. */
export function valuesOf(option: SessionConfigSelect | undefined): readonly SessionConfigSelectOption[] {
  if (option === undefined) return [];

  const values: SessionConfigSelectOption[] = [];
  for (const item of option.options) {
    if ("group" in item) values.push(...item.options);
    else values.push(item);
  }
  return values;
}
