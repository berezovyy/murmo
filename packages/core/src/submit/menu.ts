// Menu state as the submit pipeline sees it. Phase 06's `Menu` implements
// this; `noMenu` remains for pipeline unit tests that do not build a session.

export interface MenuSurface {
  /** A plugin menu is showing for this draft version. */
  visibleAt(version: number): boolean;
  /** Close the menu; a dismissal is not a submit attempt. */
  dismiss(): void;
}

/** Phase 06 replaces this with the merged menu. */
export const noMenu: MenuSurface = {
  visibleAt: () => false,
  dismiss: () => {},
};
