import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { App } from "./App";
import { useApp } from "./state/store";
import "./app.css";

declare global {
  interface Window {
    /** Store actions for the smoke walk (scripts/smoke.mjs). Harmless in a sandboxed renderer. */
    __arcmail: ReturnType<typeof useApp.getState>;
  }
}
window.__arcmail = useApp.getState();
useApp.subscribe((state) => {
  window.__arcmail = state;
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
