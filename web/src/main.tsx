import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { ThemeProvider } from "./app/theme.js";
import { ErrorBoundary } from "./components/overlays.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </ErrorBoundary>,
);
