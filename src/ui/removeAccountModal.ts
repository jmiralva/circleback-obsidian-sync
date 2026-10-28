// The question asked before an account is removed. Removing deletes the account from data.json,
// which every device sharing the vault reads, so it is not a click to make by accident.
import { Modal } from "obsidian";
import type { App } from "obsidian";
import { REMOVE_ACCOUNT_TEXT, removeAccountTitle } from "./settingsView";

export class RemoveAccountModal extends Modal {
  constructor(
    app: App,
    private readonly label: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(removeAccountTitle(this.label));
    this.contentEl.createEl("p", { text: REMOVE_ACCOUNT_TEXT });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    const remove = buttons.createEl("button", { text: "Remove", cls: "mod-warning" });
    remove.addEventListener("click", () => {
      this.close();
      this.onConfirm();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
