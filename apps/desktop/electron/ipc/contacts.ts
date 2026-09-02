import { ipcMain } from "electron";
import type { Contacts } from "../contacts.js";
import { requireEmail } from "./guard.js";

export function registerContactIpc(contacts: Contacts): void {
  ipcMain.handle("contacts:get", (_e, email: string) => contacts.card(requireEmail(email)));
  ipcMain.handle("contacts:photo", (_e, email: string) => contacts.photo(requireEmail(email)));
  ipcMain.handle("contacts:lookupWeb", (_e, email: string) => contacts.lookupWeb(requireEmail(email)));
}
