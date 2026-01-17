import { defaultTheme, extendTheme, ThemeProvider } from "@inkjs/ui";
import { Box, useInput } from "ink";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { useSnapshot } from "valtio";
import { BoxTitle } from "./boxTitle.tsx";
import { Messages } from "./message.tsx";
import { theme } from "./theme.ts";
import { uiStore } from "./ui.store.ts";
import { UserInput } from "./userInput.tsx";
import { UserUsage } from "./userUsage.tsx";

const store = {
  subscribe: (callback: () => void) => {
    process.stdout.on("resize", callback);
    return () => process.stdout.off("resize", callback);
  },
  getRows: (): number => process.stdout.rows,
};

const customTheme = extendTheme(defaultTheme, {
  components: {
    ProgressBar: {
      styles: {
        container: () => ({ flexGrow: 1, minWidth: 15 }),
        completed: () => ({ color: theme.primaryBright }),
      },
    },
    Spinner: { styles: { frame: () => ({ color: theme.primary }) } },
  },
});

export function App(): ReactNode {
  const rows = useSyncExternalStore(store.subscribe, store.getRows);
  const snap = useSnapshot(uiStore);

  // Keep stdin open to prevent process from exiting
  useInput(() => {});

  return (
    <ThemeProvider theme={customTheme}>
      <Box flexDirection="column" minHeight={rows - 1} gap={1}>
        <BoxTitle />
        <Messages />
        {!snap.approval && (
          <>
            <UserUsage />
            <UserInput />
          </>
        )}
      </Box>
    </ThemeProvider>
  );
}
