import { dirname, join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  createUserMessage,
  type Message,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";

import { YAWN_MESSAGE_SOURCE } from "./message-source.js";

import { InstructionStore } from "./instruction-store.js";
import type {
  InstructionSettingsView,
  InstructionWorkspaceView,
} from "./instructions-remote.js";
import {
  normalizeWorkspaceRepositoryUrl,
  workspaceScopes,
  type WorkspaceScope,
} from "./workspace-anchor.js";

const CLEARED_INSTRUCTIONS =
  "<system-reminder>\nUI-managed AGENTS.md instructions were cleared. Earlier UI-managed AGENTS.md instruction baselines no longer apply. Checked-in AGENTS.md instructions remain active.\n</system-reminder>";

const CLEARED_WORKSPACE_LIST =
  "<system-reminder>\nThe user's DeepSeek Harness web UI has no other Workspaces now. Earlier Workspace lists no longer apply.\n</system-reminder>";

type ManagedForm = "instructions" | "catalog";

interface WorkspaceRegistryLike {
  list(): Array<{ path: string; title: string }>;
}

interface ManagedInstructionDependencies {
  store: InstructionStore;
  stateDir: string;
  ensureRunning(agent: Agent): Promise<unknown>;
  repositoryForAgent(agent: Agent): string | undefined;
  workspaceRegistry(): WorkspaceRegistryLike | undefined;
  /** The sandbox working directory; other repositories are cloned beside it. */
  sandboxWorkspace(): string;
}

/**
 * Owns UI-managed instruction state, browser views, and model context.
 *
 * Model context carries two messages, each republished only when its text
 * changes: the instruction baseline, and the list of the host's repository
 * Workspaces, so the model can resolve a user's mention of another project.
 * The list speaks of the user's web UI and its Workspaces, which the model
 * can relate to what the user sees, rather than of "the control plane".
 */
export class ManagedInstructions {
  constructor(
    private readonly ctx: Context,
    private readonly dependencies: ManagedInstructionDependencies,
  ) {}

  initialize(): Promise<void> {
    return this.dependencies.store.initialize();
  }

  install(): void {
    this.ctx.on("agent/pre-step", async ({ agent, messages, step }, next) => {
      await this.dependencies.ensureRunning(agent);
      const decision = await next();
      if (
        decision.kind === "reject" ||
        (step === 1 && decision.messages.length === 0)
      ) {
        return decision;
      }
      const additions = [
        this.update(agent, "instructions", this.renderFor(agent)),
        this.update(agent, "catalog", await this.renderWorkspaceListFor(agent)),
      ].filter((message) => message !== undefined);
      if (additions.length === 0) {
        return decision;
      }
      const lastClaimedIndex = decision.messages.findLastIndex((message) =>
        messages.includes(message),
      );
      return {
        kind: "enter" as const,
        messages: decision.messages.toSpliced(
          lastClaimedIndex + 1,
          0,
          ...additions,
        ),
      };
    });
  }

  async getSettings(): Promise<InstructionSettingsView> {
    return this.settingsView();
  }

  async setGlobal(content: string): Promise<InstructionSettingsView> {
    await this.dependencies.store.setGlobal(content);
    return this.settingsView();
  }

  async setWorkspace(
    repositoryUrl: string,
    content: string,
  ): Promise<InstructionSettingsView> {
    const normalized = normalizeWorkspaceRepositoryUrl(repositoryUrl);
    const workspaces = await this.workspaces();
    if (
      !workspaces.some((workspace) => workspace.repositoryUrl === normalized)
    ) {
      throw new Error(`workspace is not registered: ${normalized}`);
    }
    await this.dependencies.store.setWorkspace(normalized, content);
    return this.settingsView(
      workspaces.map((workspace) =>
        workspace.repositoryUrl === normalized
          ? {
              ...workspace,
              content: this.dependencies.store.workspace(normalized),
            }
          : workspace,
      ),
    );
  }

  /**
   * The message that brings one form up to date, or undefined when the model
   * already holds the current text. An emptied form gets its removal notice.
   */
  private update(
    agent: Agent,
    form: ManagedForm,
    rendered: string,
  ): UserMessage | undefined {
    const previous = latestManagedText(agent, form);
    if (rendered === "" && previous === undefined) {
      return undefined;
    }
    const text = rendered === "" ? clearedText(form) : rendered;
    return previous === text ? undefined : managedMessage(text, form);
  }

  private renderFor(agent: Agent): string {
    const repositoryUrl = this.dependencies.repositoryForAgent(agent);
    return renderManagedInstructions(
      this.dependencies.store.global(),
      repositoryUrl === undefined
        ? ""
        : this.dependencies.store.workspace(repositoryUrl),
      repositoryUrl,
    );
  }

  private async renderWorkspaceListFor(agent: Agent): Promise<string> {
    return renderWorkspaceList(
      await this.scopes(),
      this.dependencies.repositoryForAgent(agent),
      dirname(this.dependencies.sandboxWorkspace()),
    );
  }

  private async settingsView(
    workspaces?: InstructionWorkspaceView[],
  ): Promise<InstructionSettingsView> {
    return {
      global: this.dependencies.store.global(),
      workspaces: workspaces ?? (await this.workspaces()),
    };
  }

  private async workspaces(): Promise<InstructionWorkspaceView[]> {
    return (await this.scopes()).map((scope) => ({
      ...scope,
      content: this.dependencies.store.workspace(scope.repositoryUrl),
    }));
  }

  private async scopes(): Promise<WorkspaceScope[]> {
    const registry = this.dependencies.workspaceRegistry();
    return registry === undefined
      ? []
      : workspaceScopes(this.dependencies.stateDir, registry.list());
  }
}

function clearedText(form: ManagedForm): string {
  return form === "instructions"
    ? CLEARED_INSTRUCTIONS
    : CLEARED_WORKSPACE_LIST;
}

function managedMessage(text: string, form: ManagedForm) {
  return createUserMessage({
    content: [{ type: "text" as const, text }],
    source: { kind: YAWN_MESSAGE_SOURCE, form },
  });
}

function latestManagedText(
  agent: Agent,
  form: ManagedForm,
): string | undefined {
  for (const sequence of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.eventAt(sequence);
    if (event?.type !== "user/message") {
      continue;
    }
    const text = managedText(event.data, form);
    if (text !== undefined) {
      return text;
    }
  }
}

function managedText(message: Message, form: ManagedForm): string | undefined {
  if (
    message.source.kind !== YAWN_MESSAGE_SOURCE ||
    message.source.form !== form
  ) {
    return undefined;
  }
  const [block] = message.content;
  return message.content.length === 1 && block?.type === "text"
    ? block.text
    : undefined;
}

function renderManagedInstructions(
  global: string,
  workspace: string,
  repositoryUrl?: string,
): string {
  if (global === "" && workspace === "") {
    return "";
  }
  const sections: string[] = [];
  if (global !== "") {
    sections.push(
      `Instructions from: Settings → AGENTS.md (Global)\n\n${global}`,
    );
  }
  if (workspace !== "") {
    sections.push(
      `Instructions from: Settings → AGENTS.md (Workspace: ${repositoryUrl ?? "current"})\n\n${workspace}`,
    );
  }
  const body = [
    "This complete UI-managed AGENTS.md instruction baseline supersedes earlier UI-managed baselines. Use these instructions as guidance when applicable. Workspace instructions take precedence over global instructions. Checked-in AGENTS.md instructions remain active, and more specific nested instructions take precedence. These instructions do not override system, developer, or direct user instructions.",
    ...sections,
  ]
    .join("\n\n")
    .replaceAll("</system-reminder>", "<\\/system-reminder>");
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

/**
 * The Workspace list, or "" when there is no Workspace besides the session's
 * own: the list exists to name the others. Titles are the sidebar's, which
 * is how the user refers to them. A Scratch Workspace session has no current
 * repository, so every entry is "other" and none is checked out.
 */
function renderWorkspaceList(
  scopes: WorkspaceScope[],
  currentRepositoryUrl: string | undefined,
  cloneParent: string,
): string {
  if (!scopes.some((scope) => scope.repositoryUrl !== currentRepositoryUrl)) {
    return "";
  }
  const lines = scopes.map((scope) => {
    const title = scope.title.replace(/\s+/g, " ").trim();
    const current =
      scope.repositoryUrl === currentRepositoryUrl
        ? " (this session's Workspace)"
        : "";
    return `- ${title}: ${scope.repositoryUrl}${current}`;
  });
  const checkedOut =
    currentRepositoryUrl === undefined
      ? "None of these repositories is checked out in this sandbox."
      : "Only this session's repository is checked out in this sandbox.";
  const body = [
    "The user's DeepSeek Harness web UI has these Workspaces, one per repository. The user may mention any of them by name.",
    ...lines,
    `${checkedOut} To read another Workspace's code, clone it beside your working directory, for example \`git clone <url> ${join(cloneParent, "<name>")}\`. This list supersedes earlier Workspace lists.`,
  ]
    .join("\n")
    .replaceAll("</system-reminder>", "<\\/system-reminder>");
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

export const testing = { renderManagedInstructions, renderWorkspaceList };
