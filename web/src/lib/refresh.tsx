import { createContext, useContext } from "react";

export const RefreshContext = createContext<{ token: number; refresh: () => void }>({
  token: 0,
  refresh: () => undefined,
});

export function useRefresh() {
  return useContext(RefreshContext);
}