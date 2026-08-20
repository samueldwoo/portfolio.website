import { useEffect, useState } from 'react';

/**
 * Visually-inert React island. Exists purely to prove the @astrojs/react
 * integration is wired up and actually hydrating in the browser — it is the
 * beachhead for react-bits components later.
 *
 * Deliberately zero visual footprint: 1x1px, fully transparent, fixed at the
 * viewport corner, pointer-events off, aria-hidden. It is inside the initial
 * viewport so `client:visible` fires immediately.
 *
 * Post-hydration it flips `data-hydrated` from "false" to "true" and sets
 * `window.__reactIslandHydrated`, which is what the verification suite asserts
 * on. Both are impossible to observe from the static SSR'd HTML alone.
 */
export default function ReactProbe() {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
    (window as unknown as Record<string, unknown>).__reactIslandHydrated = true;
  }, []);

  return (
    <span
      aria-hidden="true"
      data-react-probe=""
      data-hydrated={hydrated ? 'true' : 'false'}
      style={{
        position: 'fixed',
        left: 0,
        bottom: 0,
        width: '1px',
        height: '1px',
        opacity: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
