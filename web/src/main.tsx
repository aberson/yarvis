import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// A data router (one splat route; App keeps its own <Routes>) so pages can use `useBlocker`
// to warn before an in-app navigation drops unsaved edits (S1 Step 11).
const router = createBrowserRouter([{ path: "*", element: <App /> }]);

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
