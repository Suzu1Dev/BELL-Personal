/**
 * Shell actions any page may trigger: open the command palette (go or
 * capture mode, optionally prefilled) and the shortcut help dialog.
 *
 *   const shell = useShell();
 *   shell.openPalette("capture");          // 「＋ 記下一件事」, N, ＋捕捉
 *   shell.openPalette("capture", "明天 ");  // 新增行程 prefilled
 */
import { createContext, useContext } from "react";

export type PaletteMode = "go" | "capture";

export interface ShellApi {
  openPalette(mode?: PaletteMode, text?: string): void;
  closePalette(): void;
  openHelp(): void;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const context = useContext(ShellContext);
  if (!context) throw new Error("useShell 需要在 App 之內使用。");
  return context;
}
