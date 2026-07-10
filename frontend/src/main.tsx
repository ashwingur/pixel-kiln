import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import "./index.css";
import { WorkbenchPage } from "./pages/Workbench";
import { BatchPage } from "./pages/Batch";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const rootRoute = createRootRoute({
  component: () => (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-6 border-b border-edge bg-panel px-4 py-2">
        <h1 className="text-lg font-bold tracking-wide text-accent">
          Pixel Kiln
        </h1>
        <nav className="flex gap-1 text-sm">
          {[
            { to: "/", label: "Workbench" },
            { to: "/batch", label: "Batch" },
          ].map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className="rounded px-3 py-1 text-zinc-400 hover:text-zinc-100 [&.active]:bg-panel-2 [&.active]:text-accent"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  ),
});

const workbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkbenchPage,
});

const batchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/batch",
  component: BatchPage,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([workbenchRoute, batchRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
