import type { Context } from "@deepseek-ai/cordis";
import {
  IconAlarmClockOutlineMedium,
  IconBranchOutlineMedium,
  IconChecklistOutlineMedium,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { SettingsSectionIconOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";

import { KeyIcon, PlugIcon, SandboxIcon } from "./icons.js";

/**
 * Navigation icons for this bundle's settings pages, keyed by section id. The
 * settings shell renders an icon only when its id matches a section; without
 * one it keeps its own glyph.
 */
const SECTION_ICONS = [
  ["dsh-yawn.instructions", IconChecklistOutlineMedium],
  ["dsh-yawn.secrets", KeyIcon],
  ["dsh-yawn.git-credentials", IconBranchOutlineMedium],
  ["dsh-yawn.mcp", PlugIcon],
  ["dsh-yawn.sandboxes", SandboxIcon],
  ["dsh-yawn.notifications", IconAlarmClockOutlineMedium],
] as const;

/** Give every settings section this bundle adds its own navigation icon. */
export function registerSettingsIcons(ctx: Context) {
  ctx.slots.inject("settings.section.icon", function* registerIcons() {
    for (const [id, Icon] of SECTION_ICONS) {
      yield ctx.slots.register(
        { name: "settings.section.icon", id },
        ({ size }: SettingsSectionIconOwnerProps) => <Icon size={size} />,
      );
    }
  });
}
