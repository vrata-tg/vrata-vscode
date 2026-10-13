import * as vscode from "vscode";
import { AccountSnapshot } from "./gateway";
import { quotaLabel, rubles } from "./account";
import {
  ReasoningLevel,
  REASONING_CHOICES,
  normalizeReasoning,
} from "./reasoning";

export const MODEL_STATE_KEY = "vrata.panelModel";
export const REASONING_STATE_KEY = "vrata.panelReasoning";

/**
 * The bot does not expose profile or history over the API, so the panel shows
 * exactly what /v1/account and /v1/models return plus the local choices.
 */
export class VrataPanel implements vscode.Disposable {
  private readonly tree: vscode.EventEmitter<void | TreeItem | null[]> =
    new vscode.EventEmitter();
  readonly onDidChangeTreeData = this.tree.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly credentials: {
      readonly connected: boolean;
      readonly accountInvalid: boolean;
      readonly accountStale: boolean;
      readonly accountUnavailable: boolean;
      readonly account?: AccountSnapshot;
      loadAccount(): Promise<void>;
    },
    private readonly logError: (error: unknown) => void,
  ) {}

  dispose(): void {
    this.tree.dispose();
  }

  get modelId(): string | undefined {
    return this.context.globalState.get<string>(MODEL_STATE_KEY);
  }

  get reasoning(): ReasoningLevel | undefined {
    return normalizeReasoning(
      this.context.globalState.get<string>(REASONING_STATE_KEY),
    );
  }

  async setModel(id: string): Promise<void> {
    await this.context.globalState.update(MODEL_STATE_KEY, id);
    this.refresh();
    // The routed chat entry advertises the new target in its detail line.
    this.onExternalChange?.();
  }

  async setReasoning(level: ReasoningLevel | undefined): Promise<void> {
    await this.context.globalState.update(REASONING_STATE_KEY, level);
    this.refresh();
    this.onExternalChange?.();
  }

  /** Wired by the extension: fires the provider's change event. */
  onExternalChange?: () => void;

  refresh(): void {
    this.tree.fire();
  }

  /** Surface panel-level failures through the editor's notification UI. */
  report(error: unknown): void {
    void Promise.resolve(
      vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      ),
    ).then(undefined, this.logError);
  }

  private state(): string {
    const c = this.credentials;
    if (!c.connected) return "not_connected";
    if (c.accountInvalid) return "invalid_key";
    if (c.accountUnavailable) return "unavailable";
    if (!c.account) return "loading";
    return "connected";
  }

  getTreeItem(item: TreeItem): TreeItem {
    return item;
  }

  async getChildren(): Promise<TreeItem[]> {
    const c = this.credentials;
    const state = this.state();
    const connection: TreeItem = {
      label: `Подключение: ${this.stateLabel(state)}`,
      iconPath: this.stateIcon(state),
      contextValue: "connection",
    };
    const items = [connection];
    const account = c.account;
    if (account) {
      const suffix = c.accountStale ? " (устарело)" : "";
      items.push({
        label: `Баланс: ${rubles(account.balance.spendable)}${suffix}`,
        iconPath: new vscode.ThemeIcon("credit-card"),
        contextValue: "balance",
      });
      const quota = quotaLabel(account.quota);
      if (quota)
        items.push({
          label: quota,
          iconPath: new vscode.ThemeIcon("mirror"),
          contextValue: "quota",
        });
    } else if (state === "not_connected") {
      items.push({
        label: "Вставьте API-ключ, чтобы видеть баланс",
        iconPath: new vscode.ThemeIcon("info"),
        contextValue: "hint",
      });
    }
    for (const action of this.actions()) items.push(action);
    return items;
  }

  private stateLabel(state: string): string {
    return {
      not_connected: "нет ключа",
      invalid_key: "неверный ключ",
      unavailable: "нет связи",
      loading: "загрузка баланса…",
      connected: "подключено",
    }[state]!;
  }

  private stateIcon(state: string): vscode.ThemeIcon {
    return {
      not_connected: new vscode.ThemeIcon("plug"),
      invalid_key: new vscode.ThemeIcon("warning"),
      unavailable: new vscode.ThemeIcon("wifi-off"),
      loading: new vscode.ThemeIcon("sync~spin"),
      connected: new vscode.ThemeIcon("check"),
    }[state]!;
  }

  private actions(): TreeItem[] {
    const actions: TreeItem[] = [];
    const add = (label: string, command: string, icon: string): void => {
      actions.push({
        label,
        iconPath: new vscode.ThemeIcon(icon),
        command: { command, title: label },
        contextValue: `action.${command}`,
      });
    };
    add("Подключить / заменить ключ", "vrata.setApiKey", "key");
    add(
      this.state() === "connected" ? "Выбрать модель в чате" : "Открыть чат",
      this.state() === "connected" ? "vrata.openModelPicker" : "vrata.openChat",
      this.state() === "connected" ? "list-selection" : "comment-discussion",
    );
    add("Открыть бота", "vrata.getApiKey", "globe");
    return actions;
  }
}

export interface TreeItem {
  label: string;
  tooltip?: string;
  iconPath?: vscode.ThemeIcon;
  command?: { command: string; title: string };
  contextValue?: string;
}

/** Quick Pick over confirmed catalog models; the panel keeps the last choice. */
export async function pickModel(
  panel: VrataPanel,
  catalog: readonly { id: string }[],
): Promise<void> {
  const current = panel.modelId;
  const items = catalog.map((model) => ({
    label: model.id,
    picked: model.id === current,
  }));
  if (current && !catalog.some((model) => model.id === current))
    items.push({ label: current, picked: true });
  const choice = await vscode.window.showQuickPick(items, {
    title: "Врата AI: предпочитаемая модель",
    placeHolder: "Модель из списка моделей чата",
  });
  if (!choice) return;
  await panel.setModel(choice.label);
}

export async function pickReasoning(panel: VrataPanel): Promise<void> {
  const current = panel.reasoning;
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "По умолчанию сервера",
        description: "не отправлять reasoning_effort",
        value: null as ReasoningLevel | null,
      },
      ...REASONING_CHOICES.map((item) => ({
        label: item.label,
        description: item.description,
        value: item.value as ReasoningLevel | null,
      })),
    ],
    {
      title: "Врата AI: reasoning level",
      placeHolder:
        "Текущий: " +
        (current
          ? (REASONING_CHOICES.find((item) => item.value === current)?.label ??
            current)
          : "по умолчанию сервера"),
    },
  );
  if (choice) await panel.setReasoning(choice.value ?? undefined);
}

/** Opens the editor's built-in chat view. Never types into the input. */
export async function openChat(): Promise<void> {
  let failure: unknown;
  for (const command of [
    "workbench.action.chat.open",
    "workbench.panel.chat.view.copilot",
  ]) {
    try {
      await vscode.commands.executeCommand(command);
      return;
    } catch (error) {
      failure = error;
    }
  }
  if (failure) throw failure;
  throw new Error("Встроенный чат недоступен в этой версии редактора.");
}

/** Opens the native chat model picker without submitting a chat message. */
export async function openModelPicker(): Promise<void> {
  await openChat();
  await vscode.commands.executeCommand("workbench.action.chat.openModelPicker");
}

export function registerPanelCommands(
  panel: VrataPanel,
  catalog: () => readonly { id: string }[],
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vrata.selectModel", () =>
      pickModel(panel, catalog()),
    ),
    vscode.commands.registerCommand("vrata.selectReasoning", () =>
      pickReasoning(panel),
    ),
    vscode.commands.registerCommand("vrata.openChat", async () => {
      try {
        await openChat();
      } catch (error) {
        // A missing built-in chat command is expected on older editors.
        panel.report(error);
      }
    }),
    vscode.commands.registerCommand("vrata.openModelPicker", async () => {
      try {
        await openModelPicker();
      } catch (error) {
        panel.report(error);
      }
    }),
  ];
}
