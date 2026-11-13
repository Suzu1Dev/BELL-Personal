import { useSyncExternalStore } from "react";

/** Live `matchMedia(query).matches`; false where matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Breakpoints from SPEC-ux §3.2 / brief B4. */
export const MEDIA = {
  /** Drawer + quickbar. */
  mobile: "(max-width: 720px)",
  /** Icon rail by default. */
  rail: "(max-width: 980px)",
  /** Today's two-column layout (capture field in the side column). */
  wide: "(min-width: 1081px)",
  dark: "(prefers-color-scheme: dark)",
} as const;
