import { controlStyle } from "./settings-shared.js";

/**
 * The scope value that means "every workspace". A workspace scope uses its
 * repository URL, which cannot collide with this sentinel.
 */
export const GLOBAL_SCOPE = "__global__";

interface ScopeSelectorProps {
  /** Input id, so the page's label connects to the select. */
  id: string;
  /** Registered workspaces offered beside the global scope. */
  workspaces: Array<{ repositoryUrl: string; title: string }>;
  scope: string;
  disabled: boolean;
  onScopeChange: (scope: string) => void;
}

/**
 * The Global/Workspace dropdown the settings pages share. The stock settings
 * shell offers no per-workspace pages (every settings slot is root-scoped), so
 * a scope selector inside the section is how one page edits both layers.
 */
export function ScopeSelector({
  id,
  workspaces,
  scope,
  disabled,
  onScopeChange,
}: ScopeSelectorProps) {
  return (
    <select
      id={id}
      value={scope}
      disabled={disabled}
      onChange={(event) => onScopeChange(event.currentTarget.value)}
      style={controlStyle}
    >
      <option value={GLOBAL_SCOPE}>Global · All workspaces</option>
      {workspaces.map((workspace) => (
        <option key={workspace.repositoryUrl} value={workspace.repositoryUrl}>
          Workspace · {workspace.title}
        </option>
      ))}
    </select>
  );
}
