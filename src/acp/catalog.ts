import type {
  SessionConfigOption,
  SessionConfigSelect,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "@agentclientprotocol/sdk"

/** One thinking level the agent offers for a model. */
export type CatalogThought = {
  readonly value: string
  readonly name: string
}

/** One model the agent offers, with the thinking levels observed for it. */
export type CatalogModel = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly thoughts: readonly CatalogThought[]
  /** `thought_level.currentValue` after selecting this model on a fresh session. */
  readonly defaultThought?: string
}

/** The model catalog learned from an ACP session. */
export type Catalog = {
  readonly models: readonly CatalogModel[]
  /** Model the agent selected when the discovery session was created. */
  readonly defaultModel?: string
}

/** A select-type config option, narrowed from the protocol union. */
export type SelectOption = SessionConfigSelect & {
  readonly id: string
  readonly name: string
  readonly category?: string | null
}

/** Finds a `select` option by semantic category, such as `model` or `thought_level`. */
export function selectOption(
  options: readonly SessionConfigOption[] | null | undefined,
  category: string,
): SelectOption | undefined {
  for (const option of options ?? []) {
    if (option.type !== "select" || option.category !== category) continue
    return option as SelectOption
  }
  return undefined
}

/** Flattens a select option's flat or grouped value list. */
export function valuesOf(option: SessionConfigSelect | undefined): readonly SessionConfigSelectOption[] {
  if (option === undefined) return []

  const values: SessionConfigSelectOption[] = []
  for (const item of option.options as ReadonlyArray<SessionConfigSelectOption | SessionConfigSelectGroup>) {
    if ("group" in item) values.push(...item.options)
    else values.push(item)
  }
  return values
}
