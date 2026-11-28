import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionModeState,
} from "@agentclientprotocol/sdk";

import type {
  ConfigOption,
  ConfigSelectGroup,
  ConfigSelectOption,
} from "../types/public.js";

function textOrNull(value: string | null | undefined): string | null {
  return value ?? null;
}

function normalizeSelectOption(
  option: { value: string; name: string; description?: string | null },
  group: { id: string; name: string } | null,
): ConfigSelectOption {
  return {
    value: option.value,
    name: option.name,
    description: textOrNull(option.description),
    group,
  };
}

export function normalizeConfigOptions(
  options: readonly SessionConfigOption[] | null | undefined,
): ConfigOption[] {
  const normalized: ConfigOption[] = [];

  for (const option of options ?? []) {
    if (option.type === "boolean") {
      normalized.push({
        id: option.id,
        name: option.name,
        description: textOrNull(option.description),
        category: option.category ?? null,
        type: "boolean",
        currentValue: option.currentValue,
      });
      continue;
    }

    if (option.type !== "select") {
      continue;
    }

    const first = option.options[0];
    if (first !== undefined && "group" in first) {
      const rawGroups = option.options as SessionConfigSelectGroup[];
      const groups: ConfigSelectGroup[] = rawGroups.map((group) => ({
        id: group.group,
        name: group.name,
        options: group.options.map((entry) =>
          normalizeSelectOption(entry, { id: group.group, name: group.name }),
        ),
      }));
      normalized.push({
        id: option.id,
        name: option.name,
        description: textOrNull(option.description),
        category: option.category ?? null,
        type: "select",
        currentValue: option.currentValue,
        options: groups.flatMap((group) => group.options),
        groups,
      });
      continue;
    }

    normalized.push({
      id: option.id,
      name: option.name,
      description: textOrNull(option.description),
      category: option.category ?? null,
      type: "select",
      currentValue: option.currentValue,
      options: (option.options as import("@agentclientprotocol/sdk").SessionConfigSelectOption[]).map(
        (entry) => normalizeSelectOption(entry, null),
      ),
      groups: null,
    });
  }

  return normalized;
}

export function findConfigOption(
  options: readonly ConfigOption[],
  configId: string,
): ConfigOption | undefined {
  return options.find((option) => option.id === configId);
}

export function findConfigOptionByCategory(
  options: readonly ConfigOption[],
  category: string,
): ConfigOption | undefined {
  return options.find((option) => option.category === category);
}

export function findSelectOptionByCategory(
  options: readonly ConfigOption[],
  category: string,
): Extract<ConfigOption, { type: "select" }> | undefined {
  const option = findConfigOptionByCategory(options, category);
  return option?.type === "select" ? option : undefined;
}

export function deriveMode(
  hasConfigOptions: boolean,
  configOptions: readonly ConfigOption[],
  modes: SessionModeState | null,
): string | null {
  if (hasConfigOptions) {
    return findSelectOptionByCategory(configOptions, "mode")?.currentValue ?? null;
  }
  return modes?.currentModeId ?? null;
}

export function deriveModel(
  hasConfigOptions: boolean,
  configOptions: readonly ConfigOption[],
): string | null {
  if (!hasConfigOptions) {
    return null;
  }
  return findSelectOptionByCategory(configOptions, "model")?.currentValue ?? null;
}
