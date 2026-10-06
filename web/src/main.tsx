import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { connect } from "./store";

import "./theme.css";
import "dockview/dist/styles/dockview.css";
import "uplot/dist/uPlot.min.css";
import "./panels.css";

// Apply a previously chosen theme before first paint.
try {
  const saved = localStorage.getItem("pw.theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  /* ignore */
}

connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
