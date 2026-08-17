import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { ThemeProvider } from "./app/theme.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
