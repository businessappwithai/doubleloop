// src/components/shell/index.ts — barrel for the Astryx UI shell (m16): the application frame,
// its chrome components, and the theme toggle. src/routes/__root.tsx and later modules import
// from here rather than reaching into individual files.
export { AppFrame, type AppFrameProps } from "./AppFrame";
export { SidebarChrome, type SidebarChromeProps } from "./SidebarChrome";
export {
  DocumentHeader,
  type DocumentHeaderProps,
  type DocumentHeaderBreadcrumbEntry,
} from "./DocumentHeader";
export { ToolbarShell, type ToolbarShellProps } from "./ToolbarShell";
export { ThemeToggle } from "./ThemeToggle";
