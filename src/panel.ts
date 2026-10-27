import * as vscode from "vscode";
import { AccountSnapshot } from "./gateway";
import { quotaLabel, rubles } from "./account";
import {
  ReasoningLevel,
  REASONING_CHOICES,
  normalizeReasoning,
} from "./reasoning";
const MODEL_STATE_KEY = "vrata.panelModel";
const REASONING_STATE_KEY = "vrata.panelReasoning";
export class VrataPanel implements vscode.Disposable {
  private readonly tree = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.tree.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly credentials: {
      readonly connected: boolean;
      readonly accountInvalid: boolean;
      readonly accountUnavailable: boolean;
      readonly account?: AccountSnapshot;
    },
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
    this.onExternalChange?.();
  }

  async setReasoning(level: ReasoningLevel | undefined): Promise<void> {
    await this.context.globalState.update(REASONING_STATE_KEY, level);
    this.refresh();
    this.onExternalChange?.();
  }

  onExternalChange?: () => void;

  refresh(): void {
    this.tree.fire();
  }

  private state() {
    const c = this.credentials;
    if (!c.connected) return "not_connected";
    if (c.accountInvalid) return "invalid_key";
    if (c.accountUnavailable) return "unavailable";
    if (!c.account) return "loading";
    return "connected";
  }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }
  async getChildren(): Promise<vscode.TreeItem[]> {
    const c = this.credentials;
    const state = this.state();
    const [label, icon] = {
      not_connected: ["нет ключа", "plug"],
      invalid_key: ["неверный ключ", "warning"],
      unavailable: ["нет связи", "wifi-off"],
      loading: ["загрузка баланса…", "sync~spin"],
      connected: ["подключено", "check"],
    }[state];
    const items: vscode.TreeItem[] = [];
    if (state !== "connected")
      items.push({
        label: `Подключение: ${label}`,
        iconPath: new vscode.ThemeIcon(icon),
        contextValue: "connection",
      });
    const account = c.account;
    if (account) {
      items.push({
        label: `Баланс: ${rubles(account.balance.spendable)}`,
        iconPath: new vscode.ThemeIcon("credit-card"),
        command: { command: "vrata.getApiKey", title: "Открыть бота Врата AI" },
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
    items.push(...this.actions(state === "connected"));
    return items;
  }
  private actions(connected: boolean): vscode.TreeItem[] {
    const keyName = this.credentials.account?.key?.name;
    const actions: vscode.TreeItem[] = [
      {
        label: keyName ? `Ключ: ${keyName}` : "Подключить / заменить ключ",
        tooltip: "Вставить / заменить API-ключ",
        iconPath: new vscode.ThemeIcon("key"),
        command: {
          command: "vrata.setApiKey",
          title: "Вставить / заменить API-ключ",
        },
        contextValue: "action.vrata.setApiKey",
      },
    ];
    const add = (label: string, command: string, icon: string): void => {
      actions.push({
        label,
        iconPath: new vscode.ThemeIcon(icon),
        command: { command, title: label },
        contextValue: `action.${command}`,
      });
    };
    add(
      connected ? "Выбрать модель в чате" : "Открыть чат",
      connected ? "vrata.openModelPicker" : "vrata.openChat",
      connected ? "list-selection" : "comment-discussion",
    );
    add("Открыть бота", "vrata.getApiKey", "globe");
    return actions;
  }
}

async function pickModel(
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

async function pickReasoning(panel: VrataPanel): Promise<void> {
  const current = panel.reasoning;
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "По умолчанию",
        description: "",
        value: null as ReasoningLevel | null,
      },
      ...REASONING_CHOICES.map((item) => ({
        label: item.label,
        description: item.description,
        value: item.value as ReasoningLevel | null,
      })),
    ],
    {
      title: "Врата AI: выбор уровня размышлений",
      placeHolder:
        "Текущий: " +
        (current
          ? (REASONING_CHOICES.find((item) => item.value === current)?.label ??
            current)
          : "по умолчанию"),
    },
  );
  if (choice) await panel.setReasoning(choice.value ?? undefined);
}

async function openChat(modelSelector?: {
  vendor: string;
  id?: string;
}): Promise<void> {
  let failure: unknown;
  for (const command of [
    "workbench.action.chat.open",
    "workbench.panel.chat.view.copilot",
  ]) {
    try {
      if (modelSelector)
        await vscode.commands.executeCommand(command, { modelSelector });
      else await vscode.commands.executeCommand(command);
      return;
    } catch (error) {
      failure = error;
    }
  }
  if (failure) throw failure;
  throw new Error("Встроенный чат недоступен в этой версии редактора.");
}

async function openModelPicker(modelId?: string): Promise<void> {
  const newLocalChat = "workbench.action.chat.newLocalChat";
  if ((await vscode.commands.getCommands(true)).includes(newLocalChat))
    await vscode.commands.executeCommand(newLocalChat);
  await openChat({ vendor: "vrata", ...(modelId ? { id: modelId } : {}) });
  await vscode.commands.executeCommand("workbench.action.chat.openModelPicker");
}

async function suggestCopilotChat(): Promise<void> {
  if (vscode.extensions.getExtension("GitHub.copilot-chat")) return;
  const action = await vscode.window.showWarningMessage(
    "GitHub Copilot Chat недоступен расширению Врата AI в этом окне. Для работы чата проверьте, что он установлен и включён.",
    "Открыть Copilot Chat",
    "Инструкция",
  );
  if (action === "Открыть Copilot Chat")
    await vscode.commands.executeCommand(
      "extension.open",
      "GitHub.copilot-chat",
    );
  else if (action === "Инструкция")
    await vscode.commands.executeCommand("vrata.openWalkthrough");
}

export function registerPanelCommands(
  panel: VrataPanel,
  catalog: () => readonly { id: string }[],
  command: (id: string, action: () => Promise<void>) => void,
): void {
  command("vrata.selectModel", () => pickModel(panel, catalog()));
  command("vrata.selectReasoning", () => pickReasoning(panel));
  command("vrata.openChat", async () => {
    await suggestCopilotChat();
    await openChat();
  });
  command("vrata.openModelPicker", async () => {
    await suggestCopilotChat();
    const models = catalog();
    const modelId =
      models.find((model) => model.id === panel.modelId)?.id ?? models[0]?.id;
    await openModelPicker(modelId);
  });
}
