import * as vscode from "vscode";
import { AccountSnapshot } from "./gateway";
import { rubles } from "./account";
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
  private refreshing = false;

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
  }

  async setReasoning(level: ReasoningLevel | undefined): Promise<void> {
    await this.context.globalState.update(REASONING_STATE_KEY, level);
    this.refresh();
  }

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

  async refreshBalance(): Promise<void> {
    if (!this.credentials.connected || this.refreshing) return;
    this.refreshing = true;
    this.refresh();
    try {
      await this.credentials.loadAccount();
    } catch (error) {
      this.logError(error);
    } finally {
      this.refreshing = false;
      this.refresh();
    }
  }

  /** TTL auto-refresh keeps the balance live without a polling loop. */
  maybeAutoRefresh(): void {
    if (!this.credentials.connected || this.credentials.account) return;
    void this.refreshBalance();
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
    const model: TreeItem = {
      label: `Модель: ${this.modelId ?? "по умолчанию чата"}`,
      tooltip:
        "Модель агента @vrata: применяется к его следующему запросу. Меняется кнопкой «Выбрать модель».",
      contextValue: "model",
    };
    const reasoning: TreeItem = {
      label: `Reasoning: ${this.reasoning ?? "по умолчанию сервера"}`,
      tooltip: "Передаётся как reasoning_effort в payload каждого запроса.",
      contextValue: "reasoning",
    };
    const items = [connection, model, reasoning];
    const account = c.account;
    if (account) {
      const age = this.balanceAge(account);
      const suffix = c.accountStale ? " (устарело)" : "";
      items.push({
        label: `Баланс: ${rubles(account.balance.spendable)}${suffix}`,
        iconPath: new vscode.ThemeIcon("credit-card"),
        contextValue: "balance",
      });
      items.push({
        label: `Остаток лимита ключа: ${
          account.quota.remaining === null
            ? "не задан"
            : rubles(account.quota.remaining)
        }`,
        iconPath: new vscode.ThemeIcon("mirror"),
        contextValue: "quota",
      });
      if (age !== undefined)
        items.push({
          label: `Данные от: ${age}`,
          iconPath: new vscode.ThemeIcon("clock"),
          contextValue: "checked",
        });
    } else if (state === "not_connected") {
      items.push({
        label: "Вставьте API-ключ, чтобы видеть баланс",
        iconPath: new vscode.ThemeIcon("info"),
        contextValue: "hint",
      });
    }
    for (const action of this.actions(state)) items.push(action);
    return items;
  }

  private balanceAge(account: AccountSnapshot): string | undefined {
    const checked = Date.parse(account.checked_at);
    if (!Number.isFinite(checked)) return undefined;
    // Server timestamp, shown in the device's time zone, minute precision.
    const when = new Date(checked);
    const hhmm = when.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const today = new Date();
    const sameDay =
      when.getFullYear() === today.getFullYear() &&
      when.getMonth() === today.getMonth() &&
      when.getDate() === today.getDate();
    const date = sameDay
      ? "сегодня"
      : when.toLocaleDateString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
        });
    const minutes = Math.max(0, Math.floor((Date.now() - checked) / 60_000));
    return `${date} ${hhmm} (${minutes} мин назад)`;
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

  private actions(state: string): TreeItem[] {
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
    add("Выбрать модель", "vrata.selectModel", "symbol-class");
    add("Выбрать reasoning level", "vrata.selectReasoning", "layers");
    if (state !== "not_connected")
      add("Обновить", "vrata.refreshBalance", "refresh");
    add("Открыть агента Врата в чате", "vrata.openAgentChat", "sparkle");
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
  await vscode.window.showInformationMessage(
    `Модель Врат AI: ${choice.label}. Агент @vrata будет использовать её в следующем запросе.`,
  );
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

const COPILOT_CHAT_EXTENSION = "GitHub.copilot-chat";

export async function copilotChatAvailable(): Promise<boolean> {
  return vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION) !== undefined;
}

export async function openCopilotChat(): Promise<boolean> {
  if (!(await copilotChatAvailable())) return false;
  await vscode.commands.executeCommand("workbench.action.chat.open");
  return true;
}

/** Opens the built-in chat view. The agent must be picked manually. */
export async function openAgentChat(): Promise<boolean> {
  let failure: unknown;
  for (const command of [
    "workbench.action.chat.open",
    "workbench.panel.chat.view.copilot",
  ]) {
    try {
      await vscode.commands.executeCommand(command);
      return true;
    } catch (error) {
      failure = error;
    }
  }
  if (failure) throw failure;
  return false;
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
    vscode.commands.registerCommand("vrata.openCopilotChat", async () => {
      if (await openCopilotChat()) return;
      const install = await vscode.window.showInformationMessage(
        "Расширение GitHub Copilot Chat не установлено или недоступно. Откроем его страницу на Marketplace?",
        "Открыть Marketplace",
      );
      if (install === "Открыть Marketplace")
        await vscode.env.openExternal(
          vscode.Uri.parse(
            "https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat",
          ),
        );
    }),
    vscode.commands.registerCommand("vrata.openAgentChat", () =>
      openAgentChatCommand(panel),
    ),
  ];
}

async function openAgentChatCommand(panel: VrataPanel): Promise<void> {
  try {
    if (await openAgentChat()) return;
  } catch (error) {
    // A missing built-in chat command is expected on older editors.
    panel.report(error);
    return;
  }
  panel.report(
    new Error(
      "Встроенный чат недоступен в этой версии редактора. Откройте панель чата вручную и выберите агента @vrata в меню участников.",
    ),
  );
}
