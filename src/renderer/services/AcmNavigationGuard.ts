export type AcmNavigationGuard = () => boolean | Promise<boolean>;

let activeGuard: AcmNavigationGuard | null = null;

export function isAcmNavigationGuardActive(): boolean {
  return activeGuard !== null;
}

export function registerAcmNavigationGuard(
  guard: AcmNavigationGuard,
): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

export async function confirmAcmNavigation(): Promise<boolean> {
  const guard = activeGuard;
  return guard ? guard() : true;
}
